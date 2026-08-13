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
import type { HarnessPatchPrompt } from "../prompt/system-prompt-builder.js";
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
import {
  prepareToolCalls,
  executeToolCallsParallel,
  type PreparedToolCall,
  type PendingToolCall,
  type SkillToolRoute,
} from "./tool-executor.js";

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
// SkillToolRoute is now exported from ./tool-executor.js

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
    private readonly alertingService?: AlertingService,
    /** Optional — called when a session ends (normal completion or error) */
    private readonly onSessionEnd?: (sessionId: string, reason: string) => void | Promise<void>
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
      }, (_e: AlertAuditEvent) => this.auditClient.logEvent(toLogEventParams(_e)));
      yield {
        injection_warning: {
          excerpt: content.slice(0, 200),
          pattern_matched: sanitizeResult.injection_scan.matches[0]?.pattern_id ?? "unknown",
        },
      };
      void this.onSessionEnd?.(ctx.session_id, "Injection detected in user input");
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
        void this.onSessionEnd?.(ctx.session_id, "Daily cost cap exceeded");
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
        }, (_e: AlertAuditEvent) => this.auditClient.logEvent(toLogEventParams(_e)));
        yield {
          error: {
            code: "QUOTA_EXCEEDED",
            message: `Team quota of $${quotaStatus.quota_usd.toFixed(2)} USD exceeded`,
          },
        };
        void this.onSessionEnd?.(ctx.session_id, "Team quota exceeded");
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
    const maxTurns = ((): number => {
      const val = process.env["AGENT_MAX_TURNS_PER_SESSION"];
      if (val) {
        const n = parseInt(val, 10);
        if (!isNaN(n) && n >= 1 && n <= 500) return n;
      }
      return 20; // default
    })();

    let endReason = "complete";
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

      // Query active harness patches for prompt injection
      let activePatches: HarnessPatchPrompt[] = [];
      try {
        const rawPatches = await this.memoryClient.getActivePatches(ctx.user_id);
        activePatches = rawPatches
          .map((p) => ({
            id: p.id,
            proposedChange:
              p.proposed_change.length > 500
                ? p.proposed_change.slice(0, 500) + "..."
                : p.proposed_change,
            confidence: p.confidence,
          }))
          .slice(0, 5);
      } catch {
        // memory store offline — graceful degradation
      }
      ctx.activePatches = activePatches;
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
        }, (_e: AlertAuditEvent) => this.auditClient.logEvent(toLogEventParams(_e)));
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
        ...(ctx.activePatches && ctx.activePatches.length > 0 ? { activePatches: ctx.activePatches } : {}),
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

      // ── Parallel execution: collect prepared calls + approval promises ──
      // Policy checks & approval gates are started per-tool during streaming.
      // Actual sandbox/skills execution happens in parallel after the stream.
      const preparedCalls: PreparedToolCall[] = [];
      const approvalPromises: Array<{
        call_id: string;
        tool_id: string;
        promise: Promise<boolean>;
        approvalSpanStarted: number;
        approvalSpan: ReturnType<typeof tracer.startSpan>;
      }> = [];

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

          const inputPreview = JSON.stringify(input).slice(0, 300);
          const skillRoute = skillRoutes.get(tool_id);

          // ── Policy check (sync) ─────────────────────────────────────
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
              }, (_e: AlertAuditEvent) => this.auditClient.logEvent(toLogEventParams(_e)));
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

          // ── Approval gate (start per-tool, don't await) ─────────────
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
            }, (_e: AlertAuditEvent) => this.auditClient.logEvent(toLogEventParams(_e)));

            // Start approval span + promise — don't await yet
            const approvalSpan = tracer.startSpan("tessera.approval.wait", { kind: SpanKind.INTERNAL }, otelCtx);
            approvalSpan.setAttributes({ "tessera.tool.id": tool_id, "tessera.call.id": call_id });
            const approvalPromise = this.approvalGate.waitForApproval({
              call_id,
              tool_id,
              session_id: ctx.session_id,
              input_preview: inputPreview,
            });
            approvalPromises.push({
              call_id, tool_id, promise: approvalPromise,
              approvalSpanStarted: Date.now(),
              approvalSpan,
            });
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

          // Store for parallel execution after the stream
          preparedCalls.push({
            call_id,
            tool_id,
            input,
            inputPreview,
            decision,
            ...(skillRoute !== undefined && { skillRoute }),
            policyDenied: false,
          });
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

      // ── Phase 2: Resolve all approval promises ──────────────────────
      // All approval requests were started during streaming — now await them.
      // Per-tool approval (no batch auto-approve): each tool independently
      // waits for the user's decision.
      for (const ap of approvalPromises) {
        let approved: boolean;
        try {
          approved = await ap.promise;
          ap.approvalSpan.setAttributes({
            "tessera.approval.decision": approved ? "granted" : "denied",
            "tessera.approval.duration_ms": Date.now() - ap.approvalSpanStarted,
          });
        } catch (err) {
          ap.approvalSpan.recordException(err instanceof Error ? err : new Error(String(err)));
          ap.approvalSpan.setStatus({ code: SpanStatusCode.ERROR });
          approved = false;
        } finally {
          ap.approvalSpan.end();
        }

        this.auditClient.logEvent({
          event_type: approved ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          payload: { call_id: ap.call_id, tool_id: ap.tool_id },
          severity: approved ? "INFO" : "WARN",
        });

        if (!approved) {
          toolResultsBuffer.push({ call_id: ap.call_id, tool_id: ap.tool_id, result: "[TOOL EXECUTION DENIED BY USER]" });
          yield {
            error: {
              code: "APPROVAL_DENIED",
              message: `Tool '${ap.tool_id}' was denied by the user`,
            },
          };
        }
      }
      ctx.status = "active";

      // ── Phase 3: Execute approved tools in parallel ─────────────────
      // Build PendingToolCall list — only approved calls get executed.
      // Approval-decision map for O(1) lookup.
      const approvalResults = new Map(
        approvalPromises.map((ap) => [ap.call_id, ap])
      );
      const pendingCalls: PendingToolCall[] = [];
      for (const pc of preparedCalls) {
        const approvalPromise = approvalResults.get(pc.call_id);
        // approved=true if no approval was needed, or if approval was granted
        const approved = approvalPromise
          ? // Need to check the promise result — but we already resolved them above.
            // For denied calls we already pushed to toolResultsBuffer, so skip them here.
            !toolResultsBuffer.some((tr) => tr.call_id === pc.call_id && tr.result === "[TOOL EXECUTION DENIED BY USER]")
          : true;

        if (!approved) continue;

        pendingCalls.push({
          call_id: pc.call_id,
          tool_id: pc.tool_id,
          input: pc.input,
          inputPreview: pc.inputPreview,
          decision: pc.decision,
          approved: true,
          ...(pc.skillRoute !== undefined && { skillRoute: pc.skillRoute }),
        });
      }

      // Execute all pending (approved) tools in parallel via Promise.all
      if (pendingCalls.length > 0) {
        const results = await executeToolCallsParallel(
          pendingCalls,
          {
            sandboxClient: this.sandboxClient,
            vaultClient: this.vaultClient,
            auditClient: this.auditClient,
            sanitizer: this.sanitizer,
            ...(this.skillsClient !== undefined && { skillsClient: this.skillsClient }),
            ...(this.alertingService !== undefined && { alertingService: this.alertingService }),
          },
          ctx,
          otelCtx,
          tracer,
        );

        // ── Process results in original order ────────────────────────
        for (const r of results) {
          // Track tool failures for lesson extraction at session end
          if (!r.success) ctx.hadToolFailure = true;

          // Yield tool_result to the gateway
          yield {
            tool_result: {
              call_id: r.call_id,
              tool_id: r.tool_id,
              success: r.success,
              duration_ms: r.durationMs,
              error_message: r.errorMessage ?? "",
            },
          };

          toolResultsBuffer.push({ call_id: r.call_id, tool_id: r.tool_id, result: r.result });
          toolCallsExecuted++;
        }
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
      endReason = err instanceof Error ? err.message : String(err);
      sessionSpan.recordException(err instanceof Error ? err : new Error(String(err)));
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      sessionSpan.end();
      void this.onSessionEnd?.(ctx.session_id, endReason);
    }
  }
}
