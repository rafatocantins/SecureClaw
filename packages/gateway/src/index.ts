export { buildServer, startServer } from "./server.js";
export { setGatewaySecret, verifyToken, generateGatewayToken, blockTokenInQueryParams } from "./plugins/auth.plugin.js";
export { healthRoute } from "./routes/health.route.js";
export { sessionsRoute } from "./routes/sessions.route.js";
export { chatRoute } from "./routes/chat.route.js";
export { AgentGrpcClient } from "./grpc/agent.client.js";

// ── Standalone server entry point ─────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const { loadDotenv } = await import("@tessera/shared");
  loadDotenv();

  const { initTelemetry, shutdownTelemetry } = await import("./telemetry.js");
  initTelemetry();

  const { AgentGrpcClient: Client } = await import("./grpc/agent.client.js");
  const { setGatewaySecret: setSecret, generateGatewayToken: genToken } = await import("./plugins/auth.plugin.js");
  const { startServer: start } = await import("./server.js");

  const hmacSecret = process.env["GATEWAY_HMAC_SECRET"] ?? "dev-insecure-change-me";
  if (!process.env["GATEWAY_HMAC_SECRET"]) {
    process.stderr.write(
      "[gateway] WARNING: GATEWAY_HMAC_SECRET not set — using insecure dev default.\n" +
      "[gateway]          Run 'tessera init' to generate secure secrets.\n"
    );
  }
  setSecret(hmacSecret);

  const agentClient = new Client();
  const config = {
    host: process.env["GATEWAY_HOST"] ?? "127.0.0.1",
    port: parseInt(process.env["GATEWAY_PORT"] ?? "18789", 10),
    max_request_size_bytes: 1_048_576,
    rate_limit_per_minute: 60,
    rate_limit_per_session_per_minute: 30,
    websocket_ping_interval_ms: 30_000,
    allowed_origins: (process.env["GATEWAY_ALLOWED_ORIGINS"] ?? "http://127.0.0.1:5173").split(","),
    token_expiry_ms: 300_000,
  };

  await start(config, agentClient);

  // Print a dev token for convenience
  const devToken = genToken("dev-user", hmacSecret);
  process.stdout.write(`[gateway] Dev token (for testing): ${devToken}\n`);
  process.stdout.write(`[gateway] Listening on http://${config.host}:${config.port}\n`);

  // Graceful shutdown: flush OTel spans before exit
  const shutdown = (signal: string): void => {
    process.stdout.write(`[gateway] Received ${signal} — shutting down\n`);
    shutdownTelemetry().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
