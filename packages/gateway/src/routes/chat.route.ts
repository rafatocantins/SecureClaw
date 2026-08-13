/**
 * chat.route.ts — WebSocket chat endpoint.
 *
 * SECURITY:
 * - Auth token validated during WebSocket upgrade
 * - Messages validated with Zod before processing
 * - Each connection is tied to a specific session
 * - All message content forwarded to agent-runtime via gRPC
 * - Per-session message rate limiting (sliding 60-second window)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ClientMessageSchema, type ServerMessage } from "@tessera/shared";
import { verifyToken } from "../plugins/auth.plugin.js";
import type { AgentGrpcClient } from "../grpc/agent.client.js";
import type { AuditGrpcClient } from "../grpc/audit.client.js";

declare module "fastify" {
  interface FastifyInstance {
    agentClient: AgentGrpcClient;
  }
}

export interface ChatRouteOptions {
  /** Max user chat messages per session per 60-second window. Default: 30. */
  maxMsgsPerMinute?: number;
  /** Audit gRPC client for cost cap pre-flight checks. Optional — missing means no gateway-level cap check. */
  auditClient?: AuditGrpcClient;
}

// ── Per-session message rate limiting ──────────────────────────────────────
// Keyed by sessionId. Entries are removed when the WebSocket closes.
// Uses a sliding 60-second window: if >N messages arrive within any 60s span,
// the connection receives a RATE_LIMITED error and the message is dropped.

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const sessionMsgCounters = new Map<string, RateLimitEntry>();

function checkMsgRateLimit(sessionId: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const WINDOW_MS = 60_000;
  const entry = sessionMsgCounters.get(sessionId);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    // Start a fresh window
    sessionMsgCounters.set(sessionId, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= maxPerMinute) {
    return false; // Over limit
  }

  entry.count++;
  return true;
}

// ───────────────────────────────────────────────────────────────────────────

export async function chatRoute(
  fastify: FastifyInstance,
  opts: ChatRouteOptions
): Promise<void> {
  const maxMsgsPerMinute = opts.maxMsgsPerMinute ?? 30;
  const auditClient = opts.auditClient;

  fastify.get(
    "/:sessionId",
    {
      websocket: true,
      preHandler: [verifyToken],
    },
    (socket, req: FastifyRequest) => {
      const params = req.params as { sessionId: string };
      const sessionId = params.sessionId ?? "";
      const userId = req.userId ?? "unknown";

      fastify.log.info({ sessionId, userId }, "WebSocket connection established");

      const sendMsg = (msg: ServerMessage): void => {
        socket.send(JSON.stringify(msg));
      };

      // Acknowledge connection
      sendMsg({ type: "pong" });

      socket.on("message", (raw: Buffer) => {
        let text: string;
        try {
          text = raw.toString("utf-8");
        } catch {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          sendMsg({ type: "error", code: "PARSE_ERROR", message: "Invalid JSON" });
          return;
        }

        const result = ClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          sendMsg({ type: "error", code: "VALIDATION_ERROR", message: "Invalid message format" });
          return;
        }

        const msg = result.data;

        if (msg.type === "ping") {
          sendMsg({ type: "pong" });
          return;
        }

        if (msg.type === "message") {
          if (msg.session_id !== sessionId) {
            sendMsg({ type: "error", code: "SESSION_MISMATCH", message: "Session ID mismatch" });
            return;
          }

          // Per-session message rate limit (synchronous — runs before any async work)
          if (!checkMsgRateLimit(sessionId, maxMsgsPerMinute)) {
            sendMsg({
              type: "error",
              code: "RATE_LIMITED",
              message: `Message rate limit exceeded: max ${maxMsgsPerMinute} messages per minute per session`,
            });
            return;
          }

          // Cost cap check + gRPC forwarding — all async, captured in a single IIFE
          void (async (): Promise<void> => {
            // Gateway-level cost cap pre-flight check.
            // Blocks the message before it reaches agent-runtime if the daily cap is exceeded.
            // Fail-open if the audit service is unreachable (do not block the user).
            if (auditClient) {
              try {
                const summary = await auditClient.getCostSummary(userId);
                if (summary.cap_exceeded) {
                  sendMsg({
                    type: "error",
                    code: "COST_CAP_EXCEEDED",
                    message: `Daily cost cap exceeded: $${summary.total_cost_usd.toFixed(4)} spent / $${summary.cap_usd.toFixed(2)} cap`,
                  });
                  return;
                }
              } catch (err) {
                fastify.log.warn({ err, userId }, "Audit service unreachable — proceeding without cost cap check");
              }
            }

            try {
              for await (const chunk of fastify.agentClient.sendMessage(sessionId, msg.content)) {
                // Map GrpcAgentChunk → ServerMessage
                if (chunk.text) {
                  sendMsg({
                    type: "chunk",
                    session_id: sessionId,
                    delta: chunk.text.delta,
                  });
                } else if (chunk.tool_pending) {
                  sendMsg({
                    type: "tool_pending",
                    session_id: sessionId,
                    call_id: chunk.tool_pending.call_id,
                    tool_id: chunk.tool_pending.tool_id,
                    description: chunk.tool_pending.input_preview,
                    requires_approval: chunk.tool_pending.requires_approval,
                  });
                } else if (chunk.tool_result) {
                  sendMsg({
                    type: "tool_result",
                    session_id: sessionId,
                    call_id: chunk.tool_result.call_id,
                    success: chunk.tool_result.success,
                    duration_ms: chunk.tool_result.duration_ms,
                  });
                } else if (chunk.injection_warning) {
                  sendMsg({
                    type: "injection_warning",
                    session_id: sessionId,
                    excerpt: chunk.injection_warning.excerpt,
                  });
                } else if (chunk.complete) {
                  sendMsg({
                    type: "complete",
                    session_id: sessionId,
                    cost_usd: chunk.complete.cost_usd,
                    input_tokens: chunk.complete.input_tokens,
                    output_tokens: chunk.complete.output_tokens,
                  });
                } else if (chunk.error) {
                  sendMsg({
                    type: "error",
                    code: chunk.error.code,
                    message: chunk.error.message,
                  });
                }
              }
            } catch (err) {
              fastify.log.error({ sessionId, error: err instanceof Error ? err.message : String(err) }, "gRPC stream error");
              sendMsg({
                type: "error",
                code: "AGENT_ERROR",
                message: err instanceof Error ? err.message : "Agent runtime error",
              });
            }
          })();

          return;
        }

        if (msg.type === "approve") {
          // Forward approval to agent-runtime gRPC
          void fastify.agentClient
            .approveToolCall(msg.session_id, msg.call_id, msg.approved)
            .then(() => {
              fastify.log.info({ callId: msg.call_id, approved: msg.approved }, "Approval forwarded");
            })
            .catch((err: unknown) => {
              fastify.log.error({ callId: msg.call_id, err }, "Failed to forward approval");
              sendMsg({
                type: "error",
                code: "APPROVAL_ERROR",
                message: "Failed to process approval",
              });
            });
        }
      });

      socket.on("close", () => {
        fastify.log.info({ sessionId }, "WebSocket connection closed");
        // Clean up rate limit counter for this session
        sessionMsgCounters.delete(sessionId);
      });

      socket.on("error", (err: Error) => {
        fastify.log.error({ sessionId, error: err.message }, "WebSocket error");
      });
    }
  );
}
