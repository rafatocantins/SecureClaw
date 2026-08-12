/**
 * agent.impl.ts — AgentService gRPC handler implementations.
 *
 * Implements: CreateSession, SendMessage (streaming), ApproveToolCall,
 * TerminateSession, GetSessionStatus
 */
import type * as grpc from "@grpc/grpc-js";
import type { SessionManager } from "../session/session-manager.js";
import type { AgentLoop } from "../llm/agent-loop.js";
import { createProvider } from "../llm/provider-factory.js";
import type { AgentRuntimeConfig } from "../config.js";
import { getProviderSecrets } from "../config.js";
import type {
  GrpcCreateSessionRequest,
  GrpcCreateSessionResponse,
  GrpcSendMessageRequest,
  GrpcAgentChunk,
  GrpcApproveToolCallRequest,
  GrpcApproveToolCallResponse,
  GrpcTerminateSessionRequest,
  GrpcTerminateSessionResponse,
  GrpcGetSessionStatusRequest,
  GrpcGetSessionStatusResponse,
  GrpcListSessionsRequest,
  GrpcListSessionsResponse,
  GrpcListPendingApprovalsRequest,
  GrpcListPendingApprovalsResponse,
} from "@tessera/shared";

type UnaryCall<Req, Res> = grpc.ServerUnaryCall<Req, Res>;
type StreamCall<Req, Res> = grpc.ServerWritableStream<Req, Res>;
type Callback<Res> = grpc.sendUnaryData<Res>;

/**
 * @deprecated Use AgentRuntimeConfig (from config.ts) instead.
 * ProviderConfig with lazy getters is replaced by pre-loaded values
 * to eliminate process.env reads during request handling (PATT-002).
 */
export interface ProviderConfig {
  getApiKey(provider: string): string | undefined;
  getModel(provider: string): string | undefined;
  getBaseUrl(provider: string): string | undefined;
}

export function makeAgentImpl(
  sessionManager: SessionManager,
  agentLoop: AgentLoop,
  config: AgentRuntimeConfig
) {
  return {
    CreateSession(
      call: UnaryCall<GrpcCreateSessionRequest, GrpcCreateSessionResponse>,
      callback: Callback<GrpcCreateSessionResponse>
    ): void {
      try {
        const req = call.request;

        // Create the LLM provider from the request
        let provider;
        try {
          const providerName = req.provider as "anthropic" | "openai" | "gemini" | "ollama";
          const secrets = getProviderSecrets(config, req.provider);

          if (providerName === "ollama") {
            provider = createProvider({
              provider: "ollama",
              model: secrets.model ?? "llama3.2",
              base_url: secrets.baseUrl ?? "http://127.0.0.1:11434",
              max_tokens: 4096,
            });
          } else if (providerName === "anthropic") {
            provider = createProvider({ provider: "anthropic", model: secrets.model ?? "claude-opus-4-6", credential_ref: "", max_tokens: 4096 }, secrets.apiKey);
          } else if (providerName === "openai") {
            provider = createProvider({ provider: "openai", model: secrets.model ?? "gpt-4o", credential_ref: "", max_tokens: 4096 }, secrets.apiKey);
          } else {
            provider = createProvider({ provider: "gemini", model: secrets.model ?? "gemini-2.0-flash", credential_ref: "", max_tokens: 4096 }, secrets.apiKey);
          }
        } catch (err) {
          callback(null, {
            session_id: "",
            success: false,
            error_message: `Failed to create provider '${req.provider}': ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }

        const ctx = sessionManager.createSession({
          user_id: req.user_id || "anonymous",
          provider,
        });

        callback(null, { session_id: ctx.session_id, success: true, error_message: "" });
      } catch (err) {
        callback(null, {
          session_id: "",
          success: false,
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    SendMessage(call: StreamCall<GrpcSendMessageRequest, GrpcAgentChunk>): void {
      const req = call.request;
      const ctx = sessionManager.getSession(req.session_id);

      if (!ctx) {
        call.write({
          error: { code: "SESSION_NOT_FOUND", message: `Session '${req.session_id}' not found` },
        });
        call.end();
        return;
      }

      // Run the agent loop asynchronously, streaming chunks back
      void (async () => {
        try {
          for await (const chunk of agentLoop.run(ctx, req.content)) {
            call.write(chunk);
          }
        } catch (err) {
          call.write({
            error: {
              code: "AGENT_ERROR",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        } finally {
          call.end();
        }
      })();
    },

    ApproveToolCall(
      call: UnaryCall<GrpcApproveToolCallRequest, GrpcApproveToolCallResponse>,
      callback: Callback<GrpcApproveToolCallResponse>
    ): void {
      const req = call.request;
      const responded = sessionManager.approvalGate.respond(req.call_id, req.approved);
      callback(null, {
        success: responded,
        error_message: responded ? "" : `Approval request '${req.call_id}' not found or already resolved`,
      });
    },

    TerminateSession(
      call: UnaryCall<GrpcTerminateSessionRequest, GrpcTerminateSessionResponse>,
      callback: Callback<GrpcTerminateSessionResponse>
    ): void {
      const ctx = sessionManager.terminateSession(call.request.session_id);
      callback(null, {
        success: ctx !== null,
        total_cost_usd: ctx?.total_cost_usd ?? 0,
      });
    },

    GetSessionStatus(
      call: UnaryCall<GrpcGetSessionStatusRequest, GrpcGetSessionStatusResponse>,
      callback: Callback<GrpcGetSessionStatusResponse>
    ): void {
      const ctx = sessionManager.getSession(call.request.session_id);
      if (!ctx) {
        callback(null, {
          session_id: call.request.session_id,
          status: "not_found",
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd: 0,
          tool_call_count: 0,
        });
        return;
      }
      callback(null, {
        session_id: ctx.session_id,
        status: ctx.status,
        total_input_tokens: ctx.total_input_tokens,
        total_output_tokens: ctx.total_output_tokens,
        total_cost_usd: ctx.total_cost_usd,
        tool_call_count: ctx.tool_call_count,
      });
    },

    ListSessions(
      _call: UnaryCall<GrpcListSessionsRequest, GrpcListSessionsResponse>,
      callback: Callback<GrpcListSessionsResponse>
    ): void {
      try {
        const sessions = sessionManager.getActiveSessions().map((ctx) => ({
          session_id: ctx.session_id,
          user_id: ctx.user_id,
          // LLMProvider is an object; try to read a name property if present
          provider: (ctx.provider as { name?: string }).name ?? "",
          status: ctx.status,
          created_at: ctx.created_at,
          last_activity_at: ctx.last_activity_at,
          total_input_tokens: ctx.total_input_tokens,
          total_output_tokens: ctx.total_output_tokens,
          total_cost_usd: ctx.total_cost_usd,
          tool_call_count: ctx.tool_call_count,
        }));
        callback(null, { sessions });
      } catch (err) {
        process.stderr.write(
          `[agent.impl] ListSessions error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        callback(null, { sessions: [] });
      }
    },

    ListPendingApprovals(
      _call: UnaryCall<GrpcListPendingApprovalsRequest, GrpcListPendingApprovalsResponse>,
      callback: Callback<GrpcListPendingApprovalsResponse>
    ): void {
      const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
      try {
        const approvals = sessionManager.approvalGate.getAllPending().map((p) => ({
          call_id: p.call_id,
          session_id: p.session_id,
          user_id: sessionManager.getSession(p.session_id)?.user_id ?? "",
          tool_id: p.tool_id,
          input_preview: p.input_preview,
          requested_at: p.requested_at,
          expires_at: p.requested_at + APPROVAL_TIMEOUT_MS,
        }));
        callback(null, { approvals });
      } catch (err) {
        process.stderr.write(
          `[agent.impl] ListPendingApprovals error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        callback(null, { approvals: [] });
      }
    },
  };
}
