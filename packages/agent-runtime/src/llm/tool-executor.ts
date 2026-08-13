/**
 * tool-executor.ts — Parallel tool execution engine.
 *
 * Executes independent tool calls concurrently via Promise.all.
 * Each tool call gets its own OTEL span sharing the same parent.
 * Approval decisions are respected per-tool (no batch auto-approve).
 * Audit events are emitted with correct call_id ordering.
 */
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Context, Tracer } from "@opentelemetry/api";
import type { SanitizerService } from "@tessera/input-sanitizer";
import type { SessionContext } from "../session/session-context.js";
import type { ToolPolicyEngine, PolicyDecisionResult } from "../tools/policy-engine.js";
import type { VaultGrpcClient } from "../grpc/clients/vault.client.js";
import type { AuditGrpcClient } from "../grpc/clients/audit.client.js";
import type { SandboxGrpcClient } from "../grpc/clients/sandbox.client.js";
import type { SkillsGrpcClient } from "../grpc/clients/skills.client.js";
import type { AlertingService, AlertAuditEvent } from "@tessera/alerting";
import { stripVaultRefs, TESSERA_VERSION } from "@tessera/alerting";

/** Maps tool_id → route info for skill-backed tools */
export interface SkillToolRoute {
  skill_id: string;
  skill_version: string;
  requires_approval: boolean;
  credential_refs: string[];
}

/** A tool call pending execution after policy and approval checks. */
export interface PendingToolCall {
  call_id: string;
  tool_id: string;
  input: Record<string, unknown>;
  inputPreview: string;
  decision: PolicyDecisionResult;
  approved: boolean; // false if approval was denied or policy denied
  skillRoute?: SkillToolRoute;
}

/** Result of executing a single tool call. */
export interface ToolCallResult {
  call_id: string;
  tool_id: string;
  success: boolean;
  result: string; // wrapped/safe content for LLM context
  durationMs: number;
  errorMessage?: string;
  isDenied: boolean; // true if policy-denied or approval-denied
}

/** Dependencies needed by the tool executor. */
export interface ToolExecutionDeps {
  sandboxClient: SandboxGrpcClient;
  vaultClient: VaultGrpcClient;
  auditClient: AuditGrpcClient;
  sanitizer: SanitizerService;
  skillsClient?: SkillsGrpcClient;
  alertingService?: AlertingService;
}

/** Docker images for each tool (pre-approved images only) */
const TOOL_IMAGES: Record<string, string> = {
  shell_exec: "tessera/shell-exec:latest",
  http_request: "tessera/http-request:latest",
  file_read: "tessera/file-read:latest",
  file_write: "tessera/file-write:latest",
};

/**
 * Execute multiple independent tool calls in parallel.
 *
 * Each tool gets its own OTEL span as a child of the given parent context.
 * If a tool was denied (policy or approval), its denied result is returned
 * synchronously without sandbox/network involvement.
 *
 * Ordering: results are returned in the same order as `pendingCalls`.
 * Audit events are emitted per-tool with correct call_id ordering.
 */
export async function executeToolCallsParallel(
  pendingCalls: PendingToolCall[],
  deps: ToolExecutionDeps,
  sessionCtx: SessionContext,
  otelCtx: Context,
  tracer: Tracer,
): Promise<ToolCallResult[]> {
  if (pendingCalls.length === 0) return [];

  // Run all executions in parallel. Each runs independently — a failure
  // in one does NOT abort the others.
  const results = await Promise.all(
    pendingCalls.map((pc) =>
      executeSingleToolCall(pc, deps, sessionCtx, otelCtx, tracer)
    )
  );

  return results;
}

/**
 * Execute a single tool call with its own OTEL span.
 * Handles credential injection, URL safety checks, sandbox/skills routing,
 * output sanitization, and audit logging.
 */
export async function executeSingleToolCall(
  pc: PendingToolCall,
  deps: ToolExecutionDeps,
  sessionCtx: SessionContext,
  otelCtx: Context,
  tracer: Tracer,
): Promise<ToolCallResult> {
  // ── Denied tools: return immediately ───────────────────────────────
  if (!pc.approved) {
    // Determine denial reason from the decision
    const denialResult = pc.decision.reason
      ? `[TOOL DENIED BY POLICY: ${pc.decision.reason}]`
      : "[TOOL EXECUTION DENIED BY USER]";

    deps.auditClient.logEvent({
      event_type: "TOOL_RESULT",
      session_id: sessionCtx.session_id,
      user_id: sessionCtx.user_id,
      payload: { call_id: pc.call_id, tool_id: pc.tool_id, result: denialResult, duration_ms: 0 },
      severity: "WARN",
    });

    return {
      call_id: pc.call_id,
      tool_id: pc.tool_id,
      success: false,
      result: denialResult,
      durationMs: 0,
      isDenied: true,
    };
  }

  const startMs = Date.now();

  // Create individual tool span as child of parent context
  const toolSpan = tracer.startSpan("tessera.tool.run", { kind: SpanKind.INTERNAL }, otelCtx);
  toolSpan.setAttributes({
    "tessera.tool.id": pc.tool_id,
    "tessera.call.id": pc.call_id,
    "tessera.tool.image": pc.skillRoute
      ? `skill:${pc.skillRoute.skill_id}@${pc.skillRoute.skill_version}`
      : (TOOL_IMAGES[pc.tool_id] ?? `tessera/${pc.tool_id}:latest`),
  });

  // ── Prepare tool input (credentials + URL safety) ──────────────────
  let toolInputJson = JSON.stringify(pc.input);

  // Inject vault credentials for skill tools that declare credential_refs
  if (pc.skillRoute && pc.skillRoute.credential_refs.length > 0) {
    try {
      const enriched = JSON.parse(toolInputJson) as Record<string, unknown>;
      let firstRefId: string | null = null;
      for (const refName of pc.skillRoute.credential_refs) {
        const refId = await deps.vaultClient.getSecretRef("skill-creds", refName);
        if (refId) {
          enriched[refName] = `__VAULT_REF:${refId}__`;
          if (!firstRefId) firstRefId = refId;
        }
      }
      if (firstRefId) {
        toolInputJson = await deps.vaultClient.injectCredential(
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
  if (pc.tool_id === "http_request") {
    const parsedInput = JSON.parse(toolInputJson) as { url?: string };
    const urlCheck = await deps.sanitizer.checkUrlSafetyResolved(parsedInput.url ?? "");
    if (!urlCheck.safe) {
      const durationMs = Date.now() - startMs;
      toolSpan.setAttributes({ "tessera.tool.duration_ms": durationMs });
      toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: `URL blocked: ${urlCheck.reason}` });
      toolSpan.end();

      // Log POLICY_DENIED for SSRF blocks
      deps.auditClient.logEvent({
        event_type: "POLICY_DENIED",
        session_id: sessionCtx.session_id,
        user_id: sessionCtx.user_id,
        payload: { call_id: pc.call_id, tool_id: pc.tool_id, reason: urlCheck.reason, category: urlCheck.category },
        severity: "WARN",
      });

      // Trigger 5c — POLICY_DENIED (SSRF block). Fire-and-forget.
      void deps.alertingService?.fireAlert({
        event_type: "POLICY_DENIED",
        timestamp: new Date().toISOString(),
        tessera_version: TESSERA_VERSION,
        session_id: sessionCtx.session_id,
        user_id: sessionCtx.user_id,
        reason: "ssrf_block",
        tool_id: pc.tool_id,
      }, (_e: AlertAuditEvent) => {
        deps.auditClient.logEvent({
          event_type: "ALERT_SENT",
          session_id: sessionCtx.session_id,
          user_id: sessionCtx.user_id,
          payload: {
            alert_event_type: _e.alert_event_type,
            delivery_success: _e.delivery_success,
            ...(_e.status_code !== undefined ? { status_code: _e.status_code } : {}),
            ...(_e.error !== undefined ? { error: _e.error } : {}),
          },
          severity: _e.delivery_success ? "INFO" : "WARN",
        });
      });

      deps.auditClient.logEvent({
        event_type: "TOOL_RESULT",
        session_id: sessionCtx.session_id,
        user_id: sessionCtx.user_id,
        payload: {
          call_id: pc.call_id, tool_id: pc.tool_id,
          error: `URL blocked: ${urlCheck.reason ?? urlCheck.category}`,
          duration_ms: durationMs,
        },
        severity: "WARN",
      });

      return {
        call_id: pc.call_id,
        tool_id: pc.tool_id,
        success: false,
        result: `[URL BLOCKED: ${urlCheck.reason ?? urlCheck.category}]`,
        durationMs,
        errorMessage: `URL blocked: ${urlCheck.reason}`,
        isDenied: true,
      };
    }
  }

  const image = TOOL_IMAGES[pc.tool_id] ?? `tessera/${pc.tool_id}:latest`;

  deps.auditClient.logEvent({
    event_type: "TOOL_CALL",
    session_id: sessionCtx.session_id,
    user_id: sessionCtx.user_id,
    payload: {
      call_id: pc.call_id,
      tool_id: pc.tool_id,
      image: pc.skillRoute
        ? `skill:${pc.skillRoute.skill_id}@${pc.skillRoute.skill_version}`
        : image,
      input_preview: pc.inputPreview,
    },
    severity: "INFO",
  });

  // ── Execute tool ───────────────────────────────────────────────────
  let toolResult: string;
  let toolSuccess = false;

  try {
    // Skill tool: delegate to skills-engine gRPC
    if (pc.skillRoute && deps.skillsClient) {
      const result = await deps.skillsClient.executeSkillTool({
        skill_id: pc.skillRoute.skill_id,
        skill_version: pc.skillRoute.skill_version,
        tool_id: pc.tool_id,
        input_json: toolInputJson,
        call_id: pc.call_id,
        session_id: sessionCtx.session_id,
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

      deps.auditClient.logEvent({
        event_type: "TOOL_RESULT",
        session_id: sessionCtx.session_id,
        user_id: sessionCtx.user_id,
        payload: {
          call_id: pc.call_id,
          tool_id: pc.tool_id,
          skill_id: pc.skillRoute.skill_id,
          exit_code: result.exit_code,
          duration_ms: durationMs,
          timed_out: result.timed_out,
          oom_killed: result.oom_killed,
          success: toolSuccess,
        },
        severity: toolSuccess ? "INFO" : "WARN",
      });
    } else {
      // Built-in tool: execute via sandbox directly
      const result = await deps.sandboxClient.runTool({
        call_id: pc.call_id,
        tool_id: pc.tool_id,
        image,
        input_json: toolInputJson,
        timeout_seconds: pc.decision.resource_limits.timeout_seconds,
        memory_bytes: pc.decision.resource_limits.memory_bytes,
        cpu_shares: pc.decision.resource_limits.cpu_shares,
        pids_limit: pc.decision.resource_limits.pids_limit,
        network_mode: pc.tool_id === "http_request" ? "restricted" : "none",
        workspace_volume: `tessera-workspace-${sessionCtx.session_id}`,
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

      deps.auditClient.logEvent({
        event_type: "TOOL_RESULT",
        session_id: sessionCtx.session_id,
        user_id: sessionCtx.user_id,
        payload: {
          call_id: pc.call_id,
          tool_id: pc.tool_id,
          exit_code: result.exit_code,
          duration_ms: durationMs,
          timed_out: result.timed_out,
          oom_killed: result.oom_killed,
          success: toolSuccess,
        },
        severity: toolSuccess ? "INFO" : "WARN",
      });
    }
  } catch (err) {
    const durationMs = Date.now() - startMs;
    toolResult = `[SANDBOX ERROR: ${err instanceof Error ? err.message : String(err)}]`;
    toolSpan.recordException(err instanceof Error ? err : new Error(String(err)));
    toolSpan.setStatus({ code: SpanStatusCode.ERROR });

    deps.auditClient.logEvent({
      event_type: "TOOL_RESULT",
      session_id: sessionCtx.session_id,
      user_id: sessionCtx.user_id,
      payload: { call_id: pc.call_id, tool_id: pc.tool_id, error: toolResult, duration_ms: durationMs },
      severity: "ERROR",
    });
  } finally {
    toolSpan.end();
  }

  // ── Output sanitization ────────────────────────────────────────────
  const outputScan = await deps.sanitizer.sanitizeExternalContent(
    toolResult, sessionCtx.session_id, `tool:${pc.tool_id}`
  );

  const isInjection =
    outputScan.injection_scan.is_suspicious &&
    outputScan.injection_scan.highest_severity === "critical";

  if (isInjection) {
    // Log the injection detection
    deps.auditClient.logEvent({
      event_type: "INJECTION_DETECTED",
      session_id: sessionCtx.session_id,
      user_id: sessionCtx.user_id,
      payload: {
        call_id: pc.call_id,
        tool_id: pc.tool_id,
        pattern: outputScan.injection_scan.matches[0]?.pattern_id,
        source: `tool:${pc.tool_id}`,
      },
      severity: "CRITICAL",
    });

    // Trigger 2 — INJECTION_DETECTED (tool output). Fire-and-forget.
    void deps.alertingService?.fireAlert({
      event_type: "INJECTION_DETECTED",
      timestamp: new Date().toISOString(),
      tessera_version: TESSERA_VERSION,
      session_id: sessionCtx.session_id,
      user_id: sessionCtx.user_id,
      source: "tool_output",
      excerpt: stripVaultRefs(toolResult.slice(0, 256)),
    }, (_e: AlertAuditEvent) => {
      deps.auditClient.logEvent({
        event_type: "ALERT_SENT",
        session_id: sessionCtx.session_id,
        user_id: sessionCtx.user_id,
        payload: {
          alert_event_type: _e.alert_event_type,
          delivery_success: _e.delivery_success,
          ...(_e.status_code !== undefined ? { status_code: _e.status_code } : {}),
          ...(_e.error !== undefined ? { error: _e.error } : {}),
        },
        severity: _e.delivery_success ? "INFO" : "WARN",
      });
    });
  }

  const safeResult = isInjection
    ? "[TOOL OUTPUT SUPPRESSED: Prompt injection attempt detected]"
    : outputScan.wrapped_content;

  return {
    call_id: pc.call_id,
    tool_id: pc.tool_id,
    success: toolSuccess,
    result: safeResult,
    durationMs: Date.now() - startMs,
    isDenied: false,
  };
}

/**
 * Run policy checks and approval-gate startup for a batch of tool calls.
 * Returns pending tool calls with approvalPromises set for tools that
 * require approval. Policy-denied tools have `approved: false`.
 *
 * This is a pure preparation step — no sandbox execution happens here.
 */
export interface ApprovalGateInterface {
  waitForApproval(params: {
    call_id: string;
    tool_id: string;
    session_id: string;
    input_preview: string;
    timeout_ms?: number;
  }): Promise<boolean>;
}

export interface PreparedToolCall {
  call_id: string;
  tool_id: string;
  input: Record<string, unknown>;
  inputPreview: string;
  decision: PolicyDecisionResult;
  skillRoute?: SkillToolRoute;
  /** Present if the tool requires human approval. */
  approvalPromise?: Promise<boolean>;
  /** True if policy check denied the tool. */
  policyDenied: boolean;
}

export function prepareToolCalls(
  toolCalls: Array<{
    call_id: string;
    tool_id: string;
    input: Record<string, unknown>;
  }>,
  policyEngine: ToolPolicyEngine,
  approvalGate: ApprovalGateInterface,
  sessionId: string,
  skillRoutes: Map<string, SkillToolRoute>,
): PreparedToolCall[] {
  return toolCalls.map((tc) => {
    const inputPreview = JSON.stringify(tc.input).slice(0, 300);
    const skillRoute = skillRoutes.get(tc.tool_id);

    // Policy check — sync
    let decision: PolicyDecisionResult;
    try {
      decision = policyEngine.evaluate(tc.tool_id);
    } catch {
      return {
        call_id: tc.call_id,
        tool_id: tc.tool_id,
        input: tc.input,
        inputPreview,
        decision: {
          allowed: false,
          requires_approval: false,
          sandbox_required: true,
          resource_limits: { memory_bytes: 0, cpu_shares: 0, pids_limit: 0, timeout_seconds: 0 },
          reason: "Tool is not in the allowlist. Deny-by-default policy.",
        },
        ...(skillRoute !== undefined && { skillRoute }),
        policyDenied: true,
      };
    }

    // Approval gate — start approval if required (don't await yet)
    if (decision.requires_approval) {
      return {
        call_id: tc.call_id,
        tool_id: tc.tool_id,
        input: tc.input,
        inputPreview,
        decision,
        ...(skillRoute !== undefined && { skillRoute }),
        approvalPromise: approvalGate.waitForApproval({
          call_id: tc.call_id,
          tool_id: tc.tool_id,
          session_id: sessionId,
          input_preview: inputPreview,
        }),
        policyDenied: false,
      };
    }

    return {
      call_id: tc.call_id,
      tool_id: tc.tool_id,
      input: tc.input,
      inputPreview,
      decision,
      ...(skillRoute !== undefined && { skillRoute }),
      policyDenied: false,
    };
  });
}
