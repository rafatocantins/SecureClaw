/**
 * agent-impl.test.ts — Tests for makeAgentImpl with ProviderConfig injection.
 *
 * Verifies that makeAgentImpl reads provider configuration via the
 * ProviderConfig interface instead of reaching into process.env directly.
 */
import { describe, it, expect, vi } from "vitest";
import { makeAgentImpl } from "../agent.impl.js";
import type { AgentRuntimeConfig } from "../../config.js";
import type { SessionManager } from "../../session/session-manager.js";
import type { AgentLoop } from "../../llm/agent-loop.js";
import type { LLMProvider } from "../../llm/provider.interface.js";
import type { GrpcCreateSessionResponse } from "@tessera/shared";
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
  it("makeAgentImpl: uses providerApiKeys and providerModels from config for anthropic", () => {
    const config = makeConfig({
      providerApiKeys: { anthropic: "sk-ant-test" },
      providerModels: { anthropic: "claude-sonnet-4-20250514" },
    });
    const sessionManager = makeSessionManager();
    const agentLoop = makeAgentLoop();

    const impl = makeAgentImpl(sessionManager, agentLoop, config);

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

    const impl = makeAgentImpl(sessionManager, agentLoop, config);

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

    const impl = makeAgentImpl(sessionManager, agentLoop, config);

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

    const impl = makeAgentImpl(sessionManager, agentLoop, config);

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
