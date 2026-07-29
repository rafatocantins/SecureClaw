/**
 * agent-impl.test.ts — Tests for makeAgentImpl with ProviderConfig injection.
 *
 * Verifies that makeAgentImpl reads provider configuration via the
 * ProviderConfig interface instead of reaching into process.env directly.
 */
import { describe, it, expect, vi } from "vitest";
import { makeAgentImpl, type ProviderConfig } from "../agent.impl.js";
import type { SessionManager } from "../../session/session-manager.js";
import type { AgentLoop } from "../../llm/agent-loop.js";
import type { LLMProvider } from "../../llm/provider.interface.js";
import type { GrpcCreateSessionResponse } from "@tessera/shared";
import type * as grpc from "@grpc/grpc-js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    getApiKey: vi.fn().mockReturnValue(undefined),
    getModel: vi.fn().mockReturnValue(undefined),
    getBaseUrl: vi.fn().mockReturnValue(undefined),
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

type CreateSessionCallback = grpc.sendUnaryData<GrpcCreateSessionResponse>;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("makeAgentImpl — ProviderConfig injection", () => {
  it("makeAgentImpl: calls providerConfig.getApiKey with req.provider for anthropic", () => {
    const providerConfig = makeProviderConfig({
      getApiKey: vi.fn().mockReturnValue("sk-ant-test"),
      getModel: vi.fn().mockReturnValue("claude-sonnet-4-20250514"),
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, providerConfig);

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "anthropic", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(providerConfig.getApiKey).toHaveBeenCalledWith("anthropic");
    expect(providerConfig.getModel).toHaveBeenCalledWith("anthropic");
    expect(callback).toHaveBeenCalled();
    const resp = callback.mock.calls[0]?.[1] as GrpcCreateSessionResponse | undefined;
    expect(resp?.success).toBe(true);
  });

  it("makeAgentImpl: calls providerConfig.getApiKey with req.provider for openai", () => {
    const providerConfig = makeProviderConfig({
      getApiKey: vi.fn().mockReturnValue("***"),
      getModel: vi.fn().mockReturnValue("gpt-4o"),
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, providerConfig);

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "openai", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(providerConfig.getApiKey).toHaveBeenCalledWith("openai");
    expect(providerConfig.getModel).toHaveBeenCalledWith("openai");
    expect(callback).toHaveBeenCalled();
  });

  it("makeAgentImpl: calls providerConfig.getBaseUrl for ollama provider", () => {
    const providerConfig = makeProviderConfig({
      getApiKey: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue("llama3.2"),
      getBaseUrl: vi.fn().mockReturnValue("http://localhost:11434"),
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, providerConfig);

    const callback = vi.fn() as unknown as CreateSessionCallback;
    const call = {
      request: { provider: "ollama", user_id: "user-1" },
    } as unknown as Parameters<typeof impl.CreateSession>[0];

    impl.CreateSession(call, callback);

    expect(providerConfig.getBaseUrl).toHaveBeenCalledWith("ollama");
    expect(providerConfig.getApiKey).toHaveBeenCalledWith("ollama");
    expect(providerConfig.getModel).toHaveBeenCalledWith("ollama");
    expect(callback).toHaveBeenCalled();
  });

  it("makeAgentImpl: returns error when provider creation fails (missing API key)", () => {
    const providerConfig = makeProviderConfig({
      getApiKey: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue(undefined),
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, providerConfig);

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
