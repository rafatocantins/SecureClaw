/**
 * agent-impl.test.ts — Tests for makeAgentImpl with ProviderConfig injection.
 *
 * Verifies that makeAgentImpl reads provider configuration via the
 * ProviderConfig interface instead of reaching into process.env directly,
 * and that the Harness Self-Evolution RPCs delegate correctly to the
 * HarnessEvolutionService.
 */
import { describe, it, expect, vi } from "vitest";
import { makeAgentImpl } from "../agent.impl.js";
import type { AgentRuntimeConfig } from "../../config.js";
import type { SessionManager } from "../../session/session-manager.js";
import type { AgentLoop } from "../../llm/agent-loop.js";
import type { LLMProvider } from "../../llm/provider.interface.js";
import type { HarnessEvolutionService } from "../../harness-evolution/evolution-service.js";
import type {
  GrpcCreateSessionResponse,
  GrpcListHarnessPatchesResponse,
  GrpcApplyHarnessPatchResponse,
  GrpcRunHarnessEvolutionResponse,
} from "@tessera/shared";
import type * as grpc from "@grpc/grpc-js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentRuntimeAddr: "0.0.0.0:19001",
    webhookUrl: "",
    webhookSecret: "",
    providerApiKeys: {},
    providerModels: {},
    providerBaseUrls: {},
    harnessEvolutionSchedule: false,
    ...overrides,
  };
}

function makeSessionManager(): SessionManager {
  return {
    createSession: vi.fn().mockReturnValue({
      session_id: "sess-1",
      user_id: "user-1",
      provider: {} as LLMProvider,
      status: "active",
      created_at: Date.now(),
      last_activity_at: Date.now(),
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      tool_call_count: 0,
      messages: [],
      delimiters: { session_id: "sess-1", open_tag: "<S>", close_tag: "</S>" },
    }),
    getSession: vi.fn(),
    terminateSession: vi.fn(),
    getActiveSessions: vi.fn().mockReturnValue([]),
    approvalGate: { respond: vi.fn(), getAllPending: vi.fn().mockReturnValue([]) },
  } as unknown as SessionManager;
}

function makeAgentLoop(): AgentLoop {
  return {
    run: vi.fn(),
  } as unknown as AgentLoop;
}

function makeHarnessEvolution(
  overrides: Record<string, unknown> = {}
): HarnessEvolutionService {
  return {
    getStoredPatches: vi.fn().mockReturnValue([]),
    applyPatch: vi
      .fn()
      .mockResolvedValue({ id: "", applied: false, reason: "not found" }),
    evolve: vi.fn().mockResolvedValue({
      sessionsAnalyzed: 0,
      patchesGenerated: 0,
      patchesApplied: 0,
      patchesRejected: 0,
      summary: [],
    }),
    ...overrides,
  } as unknown as HarnessEvolutionService;
}

type CreateSessionCallback = grpc.sendUnaryData<GrpcCreateSessionResponse>;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("makeAgentImpl — ProviderConfig injection", () => {
  it("makeAgentImpl: uses providerApiKeys and providerModels from config for anthropic", () => {
    const config = makeConfig({
      providerApiKeys: { anthropic: "sk-ant-test" },
      providerModels: { anthropic: "claude-sonnet-4-20250514" },
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, config, makeHarnessEvolution());

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "anthropic", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(callback).toHaveBeenCalled();
    const resp = callback.mock.calls[0]?.[1] as GrpcCreateSessionResponse | undefined;
    expect(resp?.success).toBe(true);
  });

  it("makeAgentImpl: uses providerApiKeys and providerModels from config for openai", () => {
    const config = makeConfig({
      providerApiKeys: { openai: "***" },
      providerModels: { openai: "gpt-4o" },
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, config, makeHarnessEvolution());

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "openai", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(callback).toHaveBeenCalled();
  });

  it("makeAgentImpl: uses providerBaseUrls from config for ollama provider", () => {
    const config = makeConfig({
      providerApiKeys: { ollama: undefined },
      providerModels: { ollama: "llama3.2" },
      providerBaseUrls: { ollama: "http://localhost:11434" },
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, config, makeHarnessEvolution());

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "ollama", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(callback).toHaveBeenCalled();
  });

  it("makeAgentImpl: returns error when provider creation fails (missing API key)", () => {
    const config = makeConfig({
      providerApiKeys: {},
      providerModels: {},
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, config, makeHarnessEvolution());

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "anthropic", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(callback).toHaveBeenCalled();
    const resp = callback.mock.calls[0]?.[1] as GrpcCreateSessionResponse | undefined;
    expect(resp?.success).toBe(false);
    expect(resp?.error_message).toContain("Failed to create provider");
  });
});

describe("makeAgentImpl — Harness Self-Evolution RPCs", () => {
  it("ListHarnessPatches: returns stored patches mapped to wire shape", () => {
    const harness = makeHarnessEvolution({
      getStoredPatches: vi.fn().mockReturnValue([
        {
          id: "patch-1",
          type: "system_instruction",
          target: "system-prompt",
          proposedChange: "add guard clause",
          confidence: 0.85,
          applied: false,
        },
      ]),
    });
    const impl = makeAgentImpl(
      makeSessionManager(),
      makeAgentLoop(),
      makeConfig(),
      harness
    );

    const callback = vi.fn();
    impl.ListHarnessPatches({ request: {} } as never, callback as never);

    const resp = callback.mock.calls[0]?.[1] as GrpcListHarnessPatchesResponse;
    expect(resp.patches).toHaveLength(1);
    expect(resp.patches[0]?.id).toBe("patch-1");
    expect(resp.patches[0]?.proposed_change).toBe("add guard clause");
    expect(resp.patches[0]?.recommendation).toBe("apply");
    expect(resp.patches[0]?.applied).toBe(false);
  });

  it("ListHarnessPatches: returns empty list when nothing stored", () => {
    const impl = makeAgentImpl(
      makeSessionManager(),
      makeAgentLoop(),
      makeConfig(),
      makeHarnessEvolution()
    );

    const callback = vi.fn();
    impl.ListHarnessPatches({ request: {} } as never, callback as never);

    const resp = callback.mock.calls[0]?.[1] as GrpcListHarnessPatchesResponse;
    expect(resp.patches).toHaveLength(0);
  });

  it("ApplyHarnessPatch: delegates to applyPatch and returns result", async () => {
    const harness = makeHarnessEvolution({
      getStoredPatches: vi.fn().mockReturnValue([
        {
          id: "patch-1",
          type: "system_instruction",
          target: "t",
          proposedChange: "x",
          confidence: 0.9,
          applied: false,
        },
      ]),
      applyPatch: vi
        .fn()
        .mockResolvedValue({ id: "patch-1", applied: true, reason: "ok" }),
    });
    const impl = makeAgentImpl(
      makeSessionManager(),
      makeAgentLoop(),
      makeConfig(),
      harness
    );

    const callback = vi.fn();
    impl.ApplyHarnessPatch(
      { request: { patch_id: "patch-1" } } as never,
      callback as never
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(harness.applyPatch).toHaveBeenCalled();
    const resp = callback.mock.calls[0]?.[1] as GrpcApplyHarnessPatchResponse;
    expect(resp.applied).toBe(true);
    expect(resp.id).toBe("patch-1");
  });

  it("ApplyHarnessPatch: returns not-found when patch id is unknown", async () => {
    const impl = makeAgentImpl(
      makeSessionManager(),
      makeAgentLoop(),
      makeConfig(),
      makeHarnessEvolution()
    );

    const callback = vi.fn();
    impl.ApplyHarnessPatch(
      { request: { patch_id: "missing" } } as never,
      callback as never
    );
    await new Promise((r) => setTimeout(r, 0));

    const resp = callback.mock.calls[0]?.[1] as GrpcApplyHarnessPatchResponse;
    expect(resp.applied).toBe(false);
    expect(resp.reason).toContain("not found");
  });

  it("RunHarnessEvolution: returns evolve result mapped to wire shape", async () => {
    const harness = makeHarnessEvolution({
      evolve: vi.fn().mockResolvedValue({
        sessionsAnalyzed: 3,
        patchesGenerated: 2,
        patchesApplied: 1,
        patchesRejected: 1,
        summary: [
          { patternType: "tool_failure", totalOccurrences: 4, affectedSessions: 2 },
        ],
      }),
    });
    const impl = makeAgentImpl(
      makeSessionManager(),
      makeAgentLoop(),
      makeConfig(),
      harness
    );

    const callback = vi.fn();
    impl.RunHarnessEvolution({ request: { limit: 10 } } as never, callback as never);
    await new Promise((r) => setTimeout(r, 0));

    const resp = callback.mock.calls[0]?.[1] as GrpcRunHarnessEvolutionResponse;
    expect(resp.sessions_analyzed).toBe(3);
    expect(resp.patches_generated).toBe(2);
    expect(resp.patches_applied).toBe(1);
    expect(resp.patches_rejected).toBe(1);
    expect(resp.summary[0]?.pattern_type).toBe("tool_failure");
    expect(resp.summary[0]?.total_occurrences).toBe(4);
  });

  it("RunHarnessEvolution: returns zeros on evolve error", async () => {
    const harness = makeHarnessEvolution({
      evolve: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const impl = makeAgentImpl(
      makeSessionManager(),
      makeAgentLoop(),
      makeConfig(),
      harness
    );

    const callback = vi.fn();
    impl.RunHarnessEvolution({ request: { limit: 0 } } as never, callback as never);
    await new Promise((r) => setTimeout(r, 0));

    const resp = callback.mock.calls[0]?.[1] as GrpcRunHarnessEvolutionResponse;
    expect(resp.sessions_analyzed).toBe(0);
    expect(resp.patches_generated).toBe(0);
    expect(resp.summary).toHaveLength(0);
  });
});
