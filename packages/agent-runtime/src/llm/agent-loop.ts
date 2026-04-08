/**
 * agent-loop.ts — Core agentic LLM ↔ tool execution loop.
 *
 * SECURITY:
 * - All tool calls pass through the policy engine (deny-by-default)
 * - High-risk tools require human approval before execution
 * - Credentials injected by vault (never seen by LLM)
 * - All tool executions sandboxed in gVisor containers
 * - Every tool call and result logged to the audit system
 */
import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { PolicyDeniedError, CostCapError } from "@tessera/shared";
import type { SanitizerService } from "@tessera/input-sanitizer";
import type { GrpcAgentChunk } from "@tessera/shared";
import { AlertingService, stripVaultRefs, TESSERA_VERSION } from "@tessera/alerting";
import type { AlertAuditEvent } from "@tessera/alerting";
import type { SessionContext } from "../session/session-context.js";
import {
  addUserMessage,
  addAssistantMessage,
  addToolResult,
  recordUsage,
} from "../session/session-context.js";
import { buildSecuritySystemPrompt } from "../prompt/system-prompt-builder.js";
import type { ToolPolicyEngine } from "../tools/policy-engine.js";
import type { ApprovalGate } from "../tools/approval-gate.js";
import type { LLMTool } from "./provider.interface.js";
import type { VaultGrpcClient } from "../grpc/clients/vault.client.js";
import type { AuditGrpcClient } from "../grpc/clients/audit.client.js";
import type { LogEventParams } from "../grpc/clients/audit.client.js";
import type { SandboxGrpcClient } from "../grpc/clients/sandbox.client.js";
import type { SkillsGrpcClient } from "../grpc/clients/skills.client.js";
import type { MemoryGrpcClient, StoredMemoryMessage } from "../grpc/clients/memory.client.js";
import { LessonExtractor } from "../lessons/lesson-extractor.js";

/**
 * Convert an AlertAuditEvent into LogEventParams for the audit client.
 * Called fire-and-forget after each webhook delivery attempt.
 */
function toLogEventParams(e: AlertAuditEvent): LogEventParams {
  return {
    event_type: "ALERT_SENT",
    session_id: e.session_id,
    user_id: e.user_id,
    payload: {
      alert_event_type: e.alert_event_type,
      delivery_success: e.delivery_success,
      ...(e.status_code !== undefined ? { status_code: e.status_code } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
    },
    severity: e.delivery_success ? "INFO" : "WARN",
  };
}

// Tool definitions exposed to the LLM — must match TOOL_REGISTRY
const TOOL_DEFINITIONS: LLMTool[] = [
  {
    id: "shell_exec",
    description: "Execute a shell command in a sandboxed gVisor container. Network access disabled by default.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout_seconds: { type: "number", description: "Maximum execution time in seconds (default 60)" },
      },
      required: ["command"],
    },
  },
  {
    id: "http_request",
    description: "Make an HTTP request from a sandboxed container. Allowed domains must be specified.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to request" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], default: "GET" },
        headers: { type: "object", description: "HTTP headers to send" },
        body: { type: "string", description: "Request body (for POST/PUT)" },
      },
      required: ["url"],
    },
  },
  {
    id: "file_read",
    description: "Read the contents of a file. Path must be within the allowed workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to read" },
        encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" },
      },
      required: ["path"],
    },
  },
  {
    id: "file_write",
    description: "Write content to a file. Path must be within the allowed workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write to" },
        content: { type: "string", description: "Content to write" },
        append: { type: "boolean", description: "Append to existing file (default false)" },
      },
      required: ["path", "content"],
    },
  },
];

// Docker images for each tool (pre-approved images only)
const TOOL_IMAGES: Record<string, string> = {
  shell_exec: "tessera/shell-exec:latest",
  http_request: "tessera/http-request:latest",
  file_read: "tessera/file-read:latest",
  file_write: "tessera/file-write:latest",
};

/** Maps tool_id → route info for skill-backed tools */
interface SkillToolRoute {
  skill_id: string;
  skill_version: string;
  requires_approval: boolean;
  /** Vault credential names the skill needs — auto-injected before execution. */
  credential_refs: string[];
}

export class AgentLoop {
  constructor(
    private readonly sanitizer: SanitizerService,
    private readonly policyEngine: ToolPolicyEngine,
    private readonly approvalGate: ApprovalGate,
    private readonly vaultClient: VaultGrpcClient,
    private readonly auditClient: AuditGrpcClient,
    private readonly sandboxClient: SandboxGrpcClient,
    /** Optional — when absent, only built-in tools are available */
    private readonly skillsClient?: SkillsGrpcClient,
    /** Optional — when absent, conversation history is not persisted across sessions */
    private readonly memoryClient?: MemoryGrpcClient,
    /** Optional — when absent, webhook alerting is disabled */
    private readonly alertingService?: AlertingService
  ) {}

  /**
   * Run one user message through the LLM loop.
   * Yields AgentChunk messages that are forwarded to the gateway.
   */
  async *run(ctx: SessionContext, content: string): AsyncGenerator<GrpcAgentChunk> {
    // Sanitize user input for injection
    const sanitizeResult = this.sanitizer.sanitizeUserInput(content, ctx.session_id);

    if (sanitizeResult.injection_scan.highest_severity === "critical" && sanitizeResult.injection_scan.is_suspicious) {
      this.auditClient.logEvent({
        event_type: "INJECTION_DETECTED",
        session_id: ctx.session_id,
        user_id: ctx.user_id,
        payload: { excerpt: content.slice(0, 200), source: "user_input" },
        severity: "CRITICAL",
      });
      // Trigger 1 — INJECTION_DETECTED (user input). Fire-and-forget.
      void this.alertingService?.fireAlert({
        event_type: "INJECTION_DETECTED",
        timestamp: new Date().toISOString(),
        tessera_version: TESSERA_VERSION,
        session_id: ctx.session_id,
        user_id: ctx.user_id,
        source: "user_input",
        excerpt: stripVaultRefs(content.slice(0, 256)),
      }, (e) => this.auditClient.logEvent(toLogEventParams(e)));
      yield {
        injection_warning: {
          excerpt: content.slice(0, 200),
          pattern_matched: sanitizeResult.injection_scan.matches[0]?.pattern_id ?? "unknown",
        },
      };
      return; // Reject the message
    }

    // Check daily cost cap before doing any work
    try {
      const summary = await this.auditClient.getCostSummary(ctx.user_id);
      if (summary.cap_exceeded) {
        this.auditClient.logEvent({
          event_type: "COST_CAP_EXCEEDED",
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          payload: { current_usd: summary.total_cost_usd, cap_usd: summary.cap_usd },
          severity: "WARN",
        });
        yield {
          error: {
            code: "COST_CAP_EXCEEDED",
            message: new CostCapError(summary.total_cost_usd, summary.cap_usd).message,
          },
        };
        return;
      }
    } catch {
      // Audit service unreachable — fail open with a warning (do not block the user)
      process.stderr.write(`[agent-loop] Could not check cost cap for user ${ctx.user_id} — proceeding\n`);
    }

    // Team-level quota check (T-2-01A enforcement path).
    // Derive team_id by convention: "org/user" → "org"; bare userId → itself.
    // TODO(future): replace with ctx.team_id once team_id is added to SessionContext proto.
    const teamId = ctx.user_id.split("/")[0] ?? ctx.user_id;
    try {
      const quotaStatus = await this.auditClient.checkQuotaExceeded(teamId);
      if (quotaStatus.exceeded) {
        this.auditClient.logEvent({
          event_type: "QUOTA_BREACH",
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          payload: {
            team_id: teamId,
            spent_usd: quotaStatus.spent_usd,
            quota_usd: quotaStatus.quota_usd,
          },
          severity: "WARN",
        });
        // Trigger 4 — QUOTA_BREACH. Fire-and-forget.
        void this.alertingService?.fireAlert({
          event_type: "QUOTA_BREACH",
          timestamp: new Date().toISOString(),
          tessera_version: TESSERA_VERSION,
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          team_id: teamId,
          spent_usd: quotaStatus.spent_usd,
          quota_usd: quotaStatus.quota_usd,
        }, (e) => this.auditClient.logEvent(toLogEventParams(e)));
        yield {
          error: {
            code: "QUOTA_EXCEEDED",
            message: `Team quota of $${quotaStatus.quota_usd.toFixed(2)} USD exceeded`,
          },
        };
        return;
      }
    } catch {
      // Quota service unreachable — fail open with a warning, do not block the user
      process.stderr.write(`[agent-loop] Could not check team quota for ${teamId} — proceeding\n`);
    }

    const tracer = trace.getTracer("tessera-agent-runtime", "0.1.0");

    // Outer span covering the entire session — all child spans inherit this as parent
    const sessionSpan = tracer.startSpan("agent.session", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "tessera.session.id": ctx.session_id,
        "tessera.user.id": ctx.user_id,
        "gen_ai.system": ctx.provider.provider_name,
        "gen_ai.request.model": ctx.provider.model_name,
      },
    });
    const otelCtx = trace.setSpan(context.active(), sessionSpan);

    // LLM loop: may iterate multiple turns if tools are called
    let continueLoop = true;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsExecuted = 0;
    let turnCount = 0;

    // Configurable turn cap — prevents runaway agents from burning API budget.
    // Each "turn" is one round-trip to the LLM (streaming response).
    const maxTurns = (() => {
      const val = process.env["AGENT_MAX_TURNS_PER_SESSION"];
      if (val) {
        const n = parseInt(val, 10);
        if (!isNaN(n) && n >= 1 && n <= 500) return n;
      }
      return 20; // default
    })();

    try {
    // ── Memory: load prior conversation history and lessons on first turn ────────
    if (this.memoryClient && ctx.messages.length === 0) {
      // Register session (fire-and-forget — must happen before appendMessage calls)
      this.memoryClient.storeSession(ctx);

      // Fetch prior messages and lessons in parallel — both resolve [] on failure
      const [prior, priorLessonRows] = await Promise.all([
        this.memoryClient.getRecentMessages(ctx.user_id, 30),
        this.memoryClient.getRelevantLessons(ctx.user_id, "", 5),
      ]);

      if (prior.length > 0) {
        for (const m of prior as StoredMemoryMessage[]) {
          if (m.role === "user") {
            ctx.messages.push({ role: "user", content: m.content });
          } else if (m.role === "assistant") {
            ctx.messages.push({
              role: "assistant",
              content: m.content,
              tool_calls:
                m.tool_calls_json
                  ? JSON.parse(m.tool_calls_json) as Array<{ call_id: string; tool_id: string; input: Record<string, unknown> }>
                  : undefined,
            });
          } else if (m.role === "tool") {
            ctx.messages.push({
              role: "tool",
              content: m.content,
              tool_call_id: m.tool_call_id,
              tool_name: m.tool_name,
            });
          }
        }
      }

      // Store lesson texts in context so they can be injected into the system prompt
      if (priorLessonRows.length > 0) {
        ctx.priorLessons = priorLessonRows.map((l) => l.lesson_text);
      }
    }

    addUserMessage(ctx, sanitizeResult.safe_content);
    // Memory: persist the user message (fire-and-forget)
    this.memoryClient?.appendMessage(ctx.session_id, ctx.user_id, {
      role: "user",
      content: sanitizeResult.safe_content,
    });
    ctx.status = "active";

    this.auditClient.logEvent({
      event_type: "SESSION_START",
      session_id: ctx.session_id,
      user_id: ctx.user_id,
      payload: { content_length: content.length },
      severity: "INFO",
    });

    while (continueLoop) {
      // Turn cap — prevent runaway loops from burning API budget
      turnCount++;
      if (turnCount > maxTurns) {
        this.auditClient.logEvent({
          event_type: "POLICY_DENIED",
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          payload: { reason: "agent_turn_cap_exceeded", max_turns: maxTurns },
          severity: "WARN",
        });
        // Trigger 5a — POLICY_DENIED (turn cap). Fire-and-forget.
        void this.alertingService?.fireAlert({
          event_type: "POLICY_DENIED",
          timestamp: new Date().toISOString(),
          tessera_version: TESSERA_VERSION,
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          reason: "turn_cap_exceeded",
        }, (e) => this.auditClient.logEvent(toLogEventParams(e)));
        yield {
          error: {
            code: "TURN_CAP_EXCEEDED",
            message: `Agent stopped: maximum ${maxTurns} turns per session reached (set AGENT_MAX_TURNS_PER_SESSION to adjust)`,
          },
        };
        break;
      }

      // Load skill tools once per turn (skills can be installed between turns)
      const skillRoutes = new Map<string, SkillToolRoute>();
      const skillToolDefs: LLMTool[] = [];

      if (this.skillsClient) {
        try {
          const summaries = await this.skillsClient.listSkills();
          for (const summary of summaries) {
            // Fetch each skill's full manifest to get tool definitions
            const skillDetail = await this.skillsClient.getSkill(summary.id, summary.version);
            if (!skillDetail.found) continue;
            const manifest = JSON.parse(skillDetail.manifest_json) as {
              tools?: Array<{
                tool_id: string;
                description: string;
                input_schema: Record<string, unknown>;
                requires_approval: boolean;
              }>;
              permissions?: { credential_refs?: string[] };
            };
            for (const tool of manifest.tools ?? []) {
              skillRoutes.set(tool.tool_id, {
                skill_id: summary.id,
                skill_version: summary.version,
                requires_approval: tool.requires_approval,
                credential_refs: manifest.permissions?.credential_refs ?? [],
              });
              skillToolDefs.push({
                id: tool.tool_id,
                description: `[Skill: ${summary.id}] ${tool.description}`,
                input_schema: tool.input_schema,
              });
            }
          }
        } catch {
          // Skills engine unreachable — proceed with built-in tools only
          process.stderr.write(`[agent-loop] Skills engine unavailable — using built-in tools only\n`);
        }
      }

      const systemPrompt = buildSecuritySystemPrompt({
        agentName: "Tessera",
        sessionId: ctx.session_id,
        sessionDelimiter: ctx.delimiters.open_tag,
        allowedToolIds: this.policyEngine.getAllowedToolIds(),
        costCapUsd: 5.0,
        ...(ctx.priorLessons.length > 0 ? { priorLessons: ctx.priorLessons } : {}),
      });

      // Merge: built-in tools (policy-filtered) + skill tools
      // Skill tools that share a tool_id with a built-in take precedence.
      const allowedBuiltins = TOOL_DEFINITIONS.filter((t) =>
        this.policyEngine.isAllowed(t.id)
      );
      const builtinIds = new Set(allowedBuiltins.map((t) => t.id));
      const allowedTools = [
        ...allowedBuiltins,
        // Add skill tools that don't shadow built-ins
        ...skillToolDefs.filter((t) => !builtinIds.has(t.id)),
      ];

      let accumulatedText = "";
      let hadToolCallsThisTurn = false;

      // Accumulate tool calls and buffer results so we can write to ctx.messages
      // in the correct order: assistant-with-tool-calls THEN tool-results.
      // (Adding tool results inside the for-await would produce the wrong order.)
      const toolCallsThisTurn: Array<{ call_id: string; tool_id: string; input: Record<string, unknown> }> = [];
      const toolResultsBuffer: Array<{ call_id: string; tool_id: string; result: string }> = [];

      const genAiSpan = tracer.startSpan("gen_ai.chat", { kind: SpanKind.INTERNAL }, otelCtx);
      genAiSpan.setAttributes({
        "gen_ai.system": ctx.provider.provider_name,
        "gen_ai.request.model": ctx.provider.model_name,
      });

      let streamError: unknown = undefined;
      try {
      for await (const chunk of ctx.provider.streamCompletion(
        ctx.messages,
        allowedTools,
        systemPrompt
      )) {
        if (chunk.type === "text") {
          accumulatedText += chunk.text;
          yield { text: { delta: chunk.text, is_final: false } };
        } else if (chunk.type === "tool_call") {
          hadToolCallsThisTurn = true;
          const { call_id, tool_id, input } = chunk.tool_call;

          // Track the tool call regardless of outcome so the assistant message is correct
          toolCallsThisTurn.push({ call_id, tool_id, input });

          // Policy check — throws PolicyDeniedError if denied
          let decision;
          try {
            decision = this.policyEngine.evaluate(tool_id);
          } catch (err) {
            if (err instanceof PolicyDeniedError) {
              this.auditClient.logEvent({
                event_type: "POLICY_DENIED",
                session_id: ctx.session_id,
                user_id: ctx.user_id,
                payload: { tool_id, reason: err.message },
                severity: "WARN",
              });
              // Trigger 5b — POLICY_DENIED (policy engine). Fire-and-forget.
              void this.alertingService?.fireAlert({
                event_type: "POLICY_DENIED",
                timestamp: new Date().toISOString(),
                tessera_version: TESSERA_VERSION,
                session_id: ctx.session_id,
                user_id: ctx.user_id,
                reason: "policy_engine_denied",
                tool_id,
              }, (e) => this.auditClient.logEvent(toLogEventParams(e)));
              yield {
                error: {
                  code: "POLICY_DENIED",
                  message: `Tool '${tool_id}' is not allowed by policy`,
                },
              };
              toolResultsBuffer.push({ call_id, tool_id, result: "[TOOL DENIED BY POLICY]" });
              continue;
            }
            throw err;
          }

          const inputPreview = JSON.stringify(input).slice(0, 300);

          // Human approval gate (if required)
          if (decision.requires_approval) {
            ctx.status = "awaiting_approval";
            yield {
              tool_pending: {
                call_id,
                tool_id,
                input_preview: inputPreview,
                requires_approval: true,
                approval_timeout_seconds: 300,
              },
            };

            this.auditClient.logEvent({
              event_type: "APPROVAL_REQUESTED",
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              payload: { call_id, tool_id, input_preview: inputPreview },
              severity: "INFO",
            });
            // Trigger 3 — APPROVAL_REQUESTED. Fire-and-forget.
            void this.alertingService?.fireAlert({
              event_type: "APPROVAL_REQUESTED",
              timestamp: new Date().toISOString(),
              tessera_version: TESSERA_VERSION,
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              call_id,
              tool_id,
              input_preview: stripVaultRefs(inputPreview.slice(0, 300)),
            }, (e) => this.auditClient.logEvent(toLogEventParams(e)));

            const approvalStart = Date.now();
            const approvalSpan = tracer.startSpan("tessera.approval.wait", { kind: SpanKind.INTERNAL }, otelCtx);
            approvalSpan.setAttributes({ "tessera.tool.id": tool_id, "tessera.call.id": call_id });
            let approved: boolean;
            try {
              approved = await this.approvalGate.waitForApproval({
                call_id,
                tool_id,
                session_id: ctx.session_id,
                input_preview: inputPreview,
              });
              approvalSpan.setAttributes({
                "tessera.approval.decision": approved ? "granted" : "denied",
                "tessera.approval.duration_ms": Date.now() - approvalStart,
              });
            } catch (err) {
              approvalSpan.recordException(err instanceof Error ? err : new Error(String(err)));
              approvalSpan.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              approvalSpan.end();
            }

            ctx.status = "active";

            this.auditClient.logEvent({
              event_type: approved ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              payload: { call_id, tool_id },
              severity: approved ? "INFO" : "WARN",
            });

            if (!approved) {
              toolResultsBuffer.push({ call_id, tool_id, result: "[TOOL EXECUTION DENIED BY USER]" });
              yield {
                error: {
                  code: "APPROVAL_DENIED",
                  message: `Tool '${tool_id}' was denied by the user`,
                },
              };
              continue;
            }
          } else {
            yield {
              tool_pending: {
                call_id,
                tool_id,
                input_preview: inputPreview,
                requires_approval: false,
                approval_timeout_seconds: 0,
              },
            };
          }

          // Execute the tool — route to skills engine or built-in sandbox
          let toolInputJson = JSON.stringify(input);

          const skillRoute = skillRoutes.get(tool_id);

          // Inject vault credentials for skill tools that declare credential_refs.
          // For each ref name, resolve the vault UUID, enrich the input JSON with
          // __VAULT_REF:uuid__ placeholders, then call injectCredential to substitute
          // real values — the LLM and sandbox never see raw secret material.
          if (skillRoute && skillRoute.credential_refs.length > 0) {
            try {
              const enriched = JSON.parse(toolInputJson) as Record<string, unknown>;
              let firstRefId: string | null = null;
              for (const refName of skillRoute.credential_refs) {
                const refId = await this.vaultClient.getSecretRef("skill-creds", refName);
                if (refId) {
                  enriched[refName] = `__VAULT_REF:${refId}__`;
                  if (!firstRefId) firstRefId = refId;
                }
              }
              if (firstRefId) {
                // Any valid refId lets the vault resolve ALL __VAULT_REF:*__ patterns
                toolInputJson = await this.vaultClient.injectCredential(
                  firstRefId, JSON.stringify(enriched), ""
                );
              } else {
                toolInputJson = JSON.stringify(enriched);
              }
            } catch {
              // Vault unreachable or credential not found — skill will fail at runtime
            }
          }

          // URL safety check for http_request tools (SSRF + DNS rebinding prevention)
          if (tool_id === "http_request") {
            const parsedInput = JSON.parse(toolInputJson) as { url?: string };
            // checkUrlSafetyResolved: sync string checks + DNS resolution to catch
            // rebinding attacks where hostname re-maps to a private IP at fetch time
            const urlCheck = await this.sanitizer.checkUrlSafetyResolved(parsedInput.url ?? "");
            if (!urlCheck.safe) {
              this.auditClient.logEvent({
                event_type: "POLICY_DENIED",
                session_id: ctx.session_id,
                user_id: ctx.user_id,
                payload: { call_id, tool_id, reason: urlCheck.reason, category: urlCheck.category },
                severity: "WARN",
              });
              // Trigger 5c — POLICY_DENIED (SSRF block). Fire-and-forget.
              void this.alertingService?.fireAlert({
                event_type: "POLICY_DENIED",
                timestamp: new Date().toISOString(),
                tessera_version: TESSERA_VERSION,
                session_id: ctx.session_id,
                user_id: ctx.user_id,
                reason: "ssrf_block",
                tool_id,
              }, (e) => this.auditClient.logEvent(toLogEventParams(e)));
              yield { error: { code: "POLICY_DENIED", message: `URL blocked: ${urlCheck.reason}` } };
              toolResultsBuffer.push({
                call_id, tool_id,
                result: `[URL BLOCKED: ${urlCheck.reason ?? urlCheck.category}]`,
              });
              continue;
            }
          }

          const image = TOOL_IMAGES[tool_id] ?? `tessera/${tool_id}:latest`;

          this.auditClient.logEvent({
            event_type: "TOOL_CALL",
            session_id: ctx.session_id,
            user_id: ctx.user_id,
            payload: {
              call_id,
              tool_id,
              image: skillRoute ? `skill:${skillRoute.skill_id}@${skillRoute.skill_version}` : image,
              input_preview: inputPreview,
            },
            severity: "INFO",
          });

          const startMs = Date.now();
          let toolResult: string;
          let toolSuccess = false;
          const toolSpan = tracer.startSpan("tessera.tool.run", { kind: SpanKind.INTERNAL }, otelCtx);
          toolSpan.setAttributes({
            "tessera.tool.id": tool_id,
            "tessera.tool.image": skillRoute
              ? `skill:${skillRoute.skill_id}@${skillRoute.skill_version}`
              : (TOOL_IMAGES[tool_id] ?? `tessera/${tool_id}:latest`),
          });

          try {
            // Skill tool: delegate to skills-engine gRPC
            if (skillRoute && this.skillsClient) {
              const result = await this.skillsClient.executeSkillTool({
                skill_id: skillRoute.skill_id,
                skill_version: skillRoute.skill_version,
                tool_id,
                input_json: toolInputJson,
                call_id,
                session_id: ctx.session_id,
              });
              const durationMs = Date.now() - startMs;
              toolSuccess = result.success;
              toolSpan.setAttributes({
                "tessera.tool.exit_code": result.exit_code,
                "tessera.tool.duration_ms": durationMs,
                "tessera.tool.timed_out": result.timed_out,
              });
              toolResult = result.timed_out
                ? `[TIMEOUT after ${durationMs}ms]`
                : result.stdout || result.stderr || `[Exit code: ${result.exit_code}]`;

              this.auditClient.logEvent({
                event_type: "TOOL_RESULT",
                session_id: ctx.session_id,
                user_id: ctx.user_id,
                payload: {
                  call_id,
                  tool_id,
                  skill_id: skillRoute.skill_id,
                  exit_code: result.exit_code,
                  duration_ms: durationMs,
                  timed_out: result.timed_out,
                  oom_killed: result.oom_killed,
                  success: toolSuccess,
                },
                severity: toolSuccess ? "INFO" : "WARN",
              });

              yield {
                tool_result: {
                  call_id,
                  tool_id,
                  success: toolSuccess,
                  duration_ms: durationMs,
                  error_message: toolSuccess ? "" : result.stderr,
                },
              };
            } else {
            // Built-in tool: execute via sandbox directly
            const result = await this.sandboxClient.runTool({
              call_id,
              tool_id,
              image,
              input_json: toolInputJson,
              timeout_seconds: decision.resource_limits.timeout_seconds,
              memory_bytes: decision.resource_limits.memory_bytes,
              cpu_shares: decision.resource_limits.cpu_shares,
              pids_limit: decision.resource_limits.pids_limit,
              network_mode: tool_id === "http_request" ? "restricted" : "none",
              // Named Docker volume: persists file_read/file_write data across tool calls
              workspace_volume: `tessera-workspace-${ctx.session_id}`,
            });

            const durationMs = Date.now() - startMs;
            toolSuccess = result.exit_code === 0 && !result.timed_out;
            toolSpan.setAttributes({
              "tessera.tool.exit_code": result.exit_code,
              "tessera.tool.duration_ms": durationMs,
              "tessera.tool.timed_out": result.timed_out,
            });
            toolResult = result.timed_out
              ? `[TIMEOUT after ${durationMs}ms]`
              : result.stdout || result.stderr || `[Exit code: ${result.exit_code}]`;

            this.auditClient.logEvent({
              event_type: "TOOL_RESULT",
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              payload: {
                call_id,
                tool_id,
                exit_code: result.exit_code,
                duration_ms: durationMs,
                timed_out: result.timed_out,
                oom_killed: result.oom_killed,
                success: toolSuccess,
              },
              severity: toolSuccess ? "INFO" : "WARN",
            });

            yield {
              tool_result: {
                call_id,
                tool_id,
                success: toolSuccess,
                duration_ms: durationMs,
                error_message: toolSuccess ? "" : result.stderr,
              },
            };
            } // end else (built-in tool)
          } catch (err) {
            const durationMs = Date.now() - startMs;
            toolResult = `[SANDBOX ERROR: ${err instanceof Error ? err.message : String(err)}]`;
            toolSpan.recordException(err instanceof Error ? err : new Error(String(err)));
            toolSpan.setStatus({ code: SpanStatusCode.ERROR });

            this.auditClient.logEvent({
              event_type: "TOOL_RESULT",
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              payload: { call_id, tool_id, error: toolResult, duration_ms: durationMs },
              severity: "ERROR",
            });

            yield {
              tool_result: {
                call_id,
                tool_id,
                success: false,
                duration_ms: durationMs,
                error_message: toolResult,
              },
            };
          } finally {
            toolSpan.end();
          }

          // Track tool failures for lesson extraction at session end
          if (!toolSuccess) ctx.hadToolFailure = true;

          // Scan tool output for prompt injection before handing it to the LLM
          const outputScan = await this.sanitizer.sanitizeExternalContent(
            toolResult, ctx.session_id, `tool:${tool_id}`
          );
          if (
            outputScan.injection_scan.is_suspicious &&
            outputScan.injection_scan.highest_severity === "critical"
          ) {
            this.auditClient.logEvent({
              event_type: "INJECTION_DETECTED",
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              payload: {
                call_id,
                tool_id,
                pattern: outputScan.injection_scan.matches[0]?.pattern_id,
                source: `tool:${tool_id}`,
              },
              severity: "CRITICAL",
            });
            // Trigger 2 — INJECTION_DETECTED (tool output). Fire-and-forget.
            void this.alertingService?.fireAlert({
              event_type: "INJECTION_DETECTED",
              timestamp: new Date().toISOString(),
              tessera_version: TESSERA_VERSION,
              session_id: ctx.session_id,
              user_id: ctx.user_id,
              source: "tool_output",
              excerpt: stripVaultRefs(toolResult.slice(0, 256)),
            }, (e) => this.auditClient.logEvent(toLogEventParams(e)));
            toolResultsBuffer.push({
              call_id, tool_id,
              result: "[TOOL OUTPUT SUPPRESSED: Prompt injection attempt detected]",
            });
          } else {
            // Use session-delimited wrapped content (mitigates indirect injection)
            toolResultsBuffer.push({ call_id, tool_id, result: outputScan.wrapped_content });
          }
          toolCallsExecuted++;
        } else if (chunk.type === "finish") {
          totalInputTokens += chunk.usage.input_tokens;
          totalOutputTokens += chunk.usage.output_tokens;
          genAiSpan.setAttributes({
            "gen_ai.usage.input_tokens": chunk.usage.input_tokens,
            "gen_ai.usage.output_tokens": chunk.usage.output_tokens,
          });

          if (chunk.finish_reason !== "tool_use") {
            continueLoop = false;
          }
        } else if (chunk.type === "error") {
          genAiSpan.setStatus({ code: SpanStatusCode.ERROR, message: chunk.error });
          yield { error: { code: "LLM_ERROR", message: chunk.error } };
          continueLoop = false;
        }
      }
      } catch (err) {
        streamError = err;
        genAiSpan.recordException(err instanceof Error ? err : new Error(String(err)));
        genAiSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        genAiSpan.end();
        void streamError; // suppress unused warning
      }

      // Write to conversation history in the correct order:
      //   1. Assistant message (with tool_calls if any) — must come first
      //   2. Tool results — each provider maps role:"tool" to its native format
      if (accumulatedText || toolCallsThisTurn.length > 0) {
        addAssistantMessage(
          ctx,
          accumulatedText,
          toolCallsThisTurn.length > 0 ? toolCallsThisTurn : undefined
        );
        // Memory: persist assistant message (fire-and-forget)
        this.memoryClient?.appendMessage(ctx.session_id, ctx.user_id, {
          role: "assistant",
          content: accumulatedText,
          tool_calls: toolCallsThisTurn.length > 0 ? toolCallsThisTurn : undefined,
        });
      }
      for (const tr of toolResultsBuffer) {
        addToolResult(ctx, tr.call_id, tr.tool_id, tr.result);
        // Memory: persist tool result (fire-and-forget)
        this.memoryClient?.appendMessage(ctx.session_id, ctx.user_id, {
          role: "tool",
          content: tr.result,
          tool_call_id: tr.call_id,
          tool_name: tr.tool_id,
        });
      }

      // If no tool calls were made this turn, we're done
      if (!hadToolCallsThisTurn) {
        continueLoop = false;
      }
    }

    // Record final usage
    const costUsd = ctx.provider.estimateCostUsd(totalInputTokens, totalOutputTokens);
    recordUsage(ctx, totalInputTokens, totalOutputTokens, costUsd);

    // Persist cost to the ledger (fire-and-forget — must not crash the agent)
    this.auditClient.recordCost({
      session_id: ctx.session_id,
      user_id: ctx.user_id,
      provider: ctx.provider.provider_name,
      model: ctx.provider.model_name,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cost_usd: costUsd,
    });

    this.auditClient.logEvent({
      event_type: "SESSION_END",
      session_id: ctx.session_id,
      user_id: ctx.user_id,
      payload: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: costUsd,
        tool_calls_executed: toolCallsExecuted,
      },
      severity: "INFO",
    });

    ctx.status = "idle";

    // Memory: finalize session with final token/cost counts (fire-and-forget)
    this.memoryClient?.finalizeSession(ctx);

    // ── Reflection: extract lessons from this session and store them ──────────
    // Best-effort — never throws. Only runs when memory is connected and the
    // session had meaningful content (tool failures or multi-turn exchanges).
    if (this.memoryClient && ctx.messages.length > 1) {
      const extractor = new LessonExtractor(ctx.provider);
      extractor.extract(ctx.messages).then((lessons) => {
        if (lessons.length > 0) {
          this.memoryClient!.storeLessons(ctx.user_id, ctx.session_id, lessons);
        }
      }).catch(() => {
        // Lesson extraction is best-effort — ignore all errors
      });
    }

    yield {
      complete: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: costUsd,
        tool_calls_executed: toolCallsExecuted,
      },
    };
    } catch (err) {
      sessionSpan.recordException(err instanceof Error ? err : new Error(String(err)));
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      sessionSpan.end();
    }
  }
}
