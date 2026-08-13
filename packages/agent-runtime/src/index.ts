export { SessionManager } from "./session/session-manager.js";
export { createSessionContext } from "./session/session-context.js";
export { ToolPolicyEngine } from "./tools/policy-engine.js";
export { ApprovalGate } from "./tools/approval-gate.js";
export { buildSecuritySystemPrompt } from "./prompt/system-prompt-builder.js";
export { createProvider } from "./llm/provider-factory.js";
export { AgentLoop } from "./llm/agent-loop.js";
export { AnthropicProvider } from "./llm/anthropic.provider.js";
export { OpenAIProvider } from "./llm/openai.provider.js";
export { GeminiProvider } from "./llm/gemini.provider.js";
export { OllamaProvider } from "./llm/ollama.provider.js";
export { startAgentGrpcServer } from "./grpc/server.js";
export type { ProviderConfig } from "./grpc/agent.impl.js";
export type { LLMProvider, LLMMessage, LLMTool, LLMStreamChunk } from "./llm/provider.interface.js";
export type { SessionContext } from "./session/session-context.js";
export type { PolicyDecisionResult } from "./tools/policy-engine.js";
export type { SystemPromptParams } from "./prompt/system-prompt-builder.js";

// ── Phase 3D: Multi-Model Orchestrator ────────────────────────────────────
export { Orchestrator, loadConfigFromEnv } from "./orchestrator/orchestrator.js";
export type { OrchestratorProviders } from "./orchestrator/orchestrator.js";
export { classifyComplexity } from "./orchestrator/triage-classifier.js";
export { routeModel } from "./orchestrator/model-router.js";
export { decompose } from "./orchestrator/task-decomposer.js";
export { verify, verifyWithFeedback } from "./orchestrator/output-verifier.js";
export type { TaskComplexity, OrchestratorConfig, Task, TaskResult, VerifierFeedback } from "./orchestrator/types.js";


// ── Harness Evolution ──────────────────────────────────────────────────────
export { SessionAnalyzer } from "./harness-evolution/session-analyzer.js";
export { HarnessPatchGenerator } from "./harness-evolution/patch-generator.js";
export { HarnessEvolutionService } from "./harness-evolution/evolution-service.js";
export {
  detectToolFailures,
  detectLoops,
  detectInjectionPatterns,
  detectApprovalBottlenecks,
} from "./harness-evolution/pattern-detectors.js";
export type {
  FailurePattern,
  SessionAnalysis,
  HarnessPatch,
  ConfidenceScore,
  GeneratedPatch,
  AuditService,
  AuditSession,
  AuditEvent,
  PatchValidationResult,
  PendingPatch,
} from "./harness-evolution/types.js";
export type { PatternSummary } from "./harness-evolution/session-analyzer.js";
export type { EvolutionResult, ApplyResult } from "./harness-evolution/evolution-service.js";

// ── Verifier Gate ──────────────────────────────────────────────────────────
export { OutputVerifier } from "./verifier/output-verifier.js";
export type {
  VerificationResult,
  VerificationCheck,
  VerificationInput,
} from "./verifier/types.js";

// ── Configuration (PATT-002) ───────────────────────────────────────────────
export { loadConfig, getProviderSecrets } from "./config.js";
export type { AgentRuntimeConfig, ProviderSecrets } from "./config.js";
// ── Standalone server entry point ─────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const { loadDotenv } = await import("@tessera/shared");
  loadDotenv();

  const { loadConfig } = await import("./config.js");
  const config = loadConfig();

  const { initTelemetry, shutdownTelemetry } = await import("./telemetry.js");
  initTelemetry();
  const { SanitizerService } = await import("@tessera/input-sanitizer");
  const { SessionManager: Mgr } = await import("./session/session-manager.js");
  const { ToolPolicyEngine: Policy } = await import("./tools/policy-engine.js");
  const { AgentLoop: Loop } = await import("./llm/agent-loop.js");
  const { VaultGrpcClient } = await import("./grpc/clients/vault.client.js");
  const { AuditGrpcClient } = await import("./grpc/clients/audit.client.js");
  const { SandboxGrpcClient } = await import("./grpc/clients/sandbox.client.js");
  const { SkillsGrpcClient } = await import("./grpc/clients/skills.client.js");
  const { MemoryGrpcClient } = await import("./grpc/clients/memory.client.js");
  const { AlertingService } = await import("@tessera/alerting");
  const { startAgentGrpcServer: start } = await import("./grpc/server.js");

  // Build default tool allowlist: shell_exec, http_request, file_read, file_write
  const toolAllowlist = [
    { tool_id: "shell_exec", allowed: true, requires_approval: true, sandbox_required: true, memory_bytes: 256 * 1024 * 1024, pids_limit: 64, timeout_seconds: 60, max_executions_per_session: 10 },
    { tool_id: "http_request", allowed: true, requires_approval: true, sandbox_required: true, memory_bytes: 128 * 1024 * 1024, pids_limit: 32, timeout_seconds: 30, max_executions_per_session: 20 },
    { tool_id: "file_read", allowed: true, requires_approval: false, sandbox_required: true, memory_bytes: 64 * 1024 * 1024, pids_limit: 16, timeout_seconds: 10, max_executions_per_session: 50 },
    { tool_id: "file_write", allowed: true, requires_approval: true, sandbox_required: true, memory_bytes: 64 * 1024 * 1024, pids_limit: 16, timeout_seconds: 10, max_executions_per_session: 10 },
  ];
  const securityConfig = {
    sandbox_mode: "always_on" as const,
    tool_policy: "deny_all_except_allowlist" as const,
    gateway_bind: "loopback_only" as const,
    gateway_auth: "required_always" as const,
    credential_storage: "os_native_vault" as const,
    session_isolation: "strict" as const,
    cost_cap_daily_usd: 5.0,
    audit_logging: "all_tool_calls" as const,
    telemetry: "off" as const,
    injection_detection: "both" as const,
    human_approval_required_for: ["file_write", "shell_exec", "http_request"],
    mdns_discovery: "minimal_no_paths" as const,
  };

  const sanitizer = new SanitizerService();
  const policyEngine = new Policy(securityConfig, toolAllowlist);
  const sessionManager = new Mgr(sanitizer);

  const vaultClient = new VaultGrpcClient();
  const auditClient = new AuditGrpcClient();
  const sandboxClient = new SandboxGrpcClient();
  const skillsClient = new SkillsGrpcClient();
  const memoryClient = new MemoryGrpcClient();

  // Webhook alerting — enabled when TESSERA_WEBHOOK_URL is set.
  // Both URL and secret must be present to activate (secret enables HMAC signing).
  // TESSERA_WEBHOOK_SECRET is optional — if absent, no X-Webhook-Signature header is sent.
  let alertingService: InstanceType<typeof AlertingService> | undefined;
  if (config.webhookUrl) {
    try {
      alertingService = new AlertingService({ webhookUrl: config.webhookUrl, webhookSecret: config.webhookSecret });
      process.stdout.write("[agent-runtime] Webhook alerting enabled\n");
    } catch (err) {
      process.stderr.write(`[agent-runtime] Webhook alerting DISABLED — invalid TESSERA_WEBHOOK_URL: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const agentLoop = new Loop(sanitizer, policyEngine, sessionManager.approvalGate, vaultClient, auditClient, sandboxClient, skillsClient, memoryClient, alertingService);

  // Provider configuration is now pre-loaded via loadConfig() above (PATT-002).
  // No lazy process.env reads remain — all values were resolved at startup.

  await start(sessionManager, agentLoop, config, config.agentRuntimeAddr);
  process.stdout.write("[agent-runtime] Service ready\n");

  // Graceful shutdown: flush OTel spans before exit
  const shutdown = (signal: string): void => {
    process.stdout.write(`[agent-runtime] Received ${signal} — shutting down\n`);
    shutdownTelemetry().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
