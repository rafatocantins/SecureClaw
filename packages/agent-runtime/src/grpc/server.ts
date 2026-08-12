/**
 * server.ts — AgentService gRPC server.
 *
 * Binds on AGENT_RUNTIME_ADDR (default 0.0.0.0:19001).
 * Only reachable from within the internal Docker network.
 *
 * mTLS: loads agent-runtime.crt / agent-runtime.key from GRPC_CERTS_DIR.
 * Falls back to insecure transport when certs are absent (dev mode).
 */
import { loadProto, grpc, serverCredentials } from "@tessera/shared";
import type { SessionManager } from "../session/session-manager.js";
import type { AgentLoop } from "../llm/agent-loop.js";
import type { AgentRuntimeConfig } from "../config.js";
import { makeAgentImpl } from "./agent.impl.js";

export function startAgentGrpcServer(
  sessionManager: SessionManager,
  agentLoop: AgentLoop,
  config: AgentRuntimeConfig,
  addr: string
): Promise<grpc.Server> {

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = loadProto("agent.proto") as any;
  const AgentServiceDef = proto.tessera?.agent?.v1?.AgentService as grpc.ServiceClientConstructor;

  if (!AgentServiceDef) {
    throw new Error("Failed to load AgentService from agent.proto");
  }

  const server = new grpc.Server();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.addService((AgentServiceDef as any).service, makeAgentImpl(sessionManager, agentLoop, config));

  const creds = serverCredentials("agent-runtime");

  return new Promise((resolve, reject) => {
    server.bindAsync(addr, creds, (err, port) => {
      if (err) {
        reject(err);
        return;
      }
      process.stdout.write(`[agent-grpc] Server listening on ${addr} (port ${port})\n`);
      resolve(server);
    });
  });
}
