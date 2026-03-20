/**
 * server.ts — Fastify server factory for the Tessera gateway.
 *
 * SECURITY:
 * - Binds to 127.0.0.1 by default (loopback only)
 * - CORS restricted — no wildcard origins
 * - Rate limiting enabled globally
 * - Token-in-URL detection on every request
 * - All sensitive headers redacted from logs
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { GatewayConfig } from "@tessera/shared";
import { blockTokenInQueryParams } from "./plugins/auth.plugin.js";
import { healthRoute } from "./routes/health.route.js";
import { sessionsRoute } from "./routes/sessions.route.js";
import { chatRoute } from "./routes/chat.route.js";
import { approvalsRoute } from "./routes/approvals.route.js";
import { auditRoute } from "./routes/audit.route.js";
import { credentialsRoute } from "./routes/credentials.route.js";
import { complianceRoute } from "./routes/compliance.route.js";
import { costsRoute } from "./routes/costs.route.js";
import { marketplaceRoute } from "./routes/marketplace.route.js";
import { skillsRoute } from "./routes/skills.route.js";
import { tokenRoute } from "./routes/token.route.js";
import type { AgentGrpcClient } from "./grpc/agent.client.js";
import { AuditGrpcClient } from "./grpc/audit.client.js";
import { VaultGrpcClient } from "./grpc/vault.client.js";
import { SkillsGrpcClient } from "./grpc/skills.client.js";

export async function buildServer(config: GatewayConfig, agentClient: AgentGrpcClient): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env["TESSERA_LOG_LEVEL"] ?? "info",
      // Redact sensitive fields from logs
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.api_key",
        "req.body.secret",
        "req.body.value",
      ],
    },
    trustProxy: false,
    bodyLimit: config.max_request_size_bytes,
  });

  // CORS — strict, no wildcard
  await app.register(fastifyCors, {
    origin: config.allowed_origins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: true,
    maxAge: 300,
  });

  // Rate limiting — global default; individual routes override via config.rateLimit
  await app.register(fastifyRateLimit, {
    max: config.rate_limit_per_minute,
    timeWindow: "1 minute",
    // Extract userId from the Bearer token BEFORE auth runs (onRequest lifecycle).
    // Token format: {userId}.{timestamp}.{hmac} — userId is everything before the first dot.
    // We don't verify the signature here; rate-limiting an invalid token under any userId is fine.
    keyGenerator: (req) => {
      const auth = req.headers["authorization"];
      if (auth?.startsWith("Bearer ")) {
        const token = auth.slice(7).trim();
        const dot = token.indexOf(".");
        if (dot > 0) return token.slice(0, dot); // userId segment
      }
      return req.ip;
    },
    errorResponseBuilder: (_req, context) => ({
      error: "rate_limited",
      message: `Too many requests. Limit: ${context.max} per ${context.after}`,
      retry_after_seconds: Math.ceil(context.ttl / 1000),
    }),
  });

  // WebSocket support
  await app.register(fastifyWebsocket);

  // Security headers — registered after websocket, before routes
  // Pure JSON API server: CSP locked down to 'none' except connect-src 'self' for WS.
  // crossOriginEmbedderPolicy disabled: COEP would break the Vite frontend WS connection
  // without coordinated COOP headers on the client side.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        connectSrc: ["'self'"],
        scriptSrc:  ["'none'"],
        styleSrc:   ["'none'"],
        imgSrc:     ["'none'"],
        frameSrc:   ["'none'"],
        objectSrc:  ["'none'"],
        baseUri:    ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // Global security hook: block tokens in query params on ALL routes
  app.addHook("onRequest", blockTokenInQueryParams);

  // OTel: create a SERVER span for each HTTP request.
  // SECURITY: http.url is set to the path only (never the full URL) —
  // the WS chat upgrade uses ?token= which must never appear in traces.
  app.addHook("onRequest", async (req, _reply) => {
    const tracer = trace.getTracer("tessera-gateway", "0.1.0");
    // Use the route template (e.g. /api/v1/chat/:sessionId) not the actual URL
    // to keep cardinality low and prevent PII/token leakage from path params.
    const routeTemplate = req.routeOptions.url ?? req.url.split("?")[0];
    const span = tracer.startSpan(`HTTP ${req.method} ${routeTemplate}`, {
      kind: SpanKind.SERVER,
    });
    // Attach span to request for retrieval in onResponse
    (req as FastifyRequest & { _otelSpan?: Span })._otelSpan = span;
  });

  app.addHook("onResponse", async (req, reply) => {
    const span = (req as FastifyRequest & { _otelSpan?: Span })._otelSpan;
    if (!span) return;
    // SECURITY: path only — never include query string (?token= leak prevention)
    const pathOnly = req.url.split("?")[0];
    span.setAttributes({
      "http.method": req.method,
      "http.route": req.routeOptions.url ?? pathOnly,
      "http.status_code": reply.statusCode,
      "http.url": pathOnly,
    });
    if (reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  });

  // Decorate Fastify instance with the gRPC client so routes can access it
  app.decorate("agentClient", agentClient);

  // Register routes
  await app.register(healthRoute, { prefix: "/health" });
  await app.register(tokenRoute, { prefix: "/api/v1/token" });
  await app.register(sessionsRoute, { prefix: "/api/v1/sessions" });
  const auditClient = new AuditGrpcClient();
  await app.register(chatRoute, {
    prefix: "/api/v1/chat",
    maxMsgsPerMinute: config.rate_limit_per_session_per_minute,
    auditClient,
  });
  await app.register(approvalsRoute, { prefix: "/api/v1/approvals" });
  await app.register(auditRoute, { prefix: "/api/v1/audit", auditClient });

  const vaultClient = new VaultGrpcClient();
  app.decorate("vaultClient", vaultClient);
  await app.register(credentialsRoute, { prefix: "/api/v1/credentials" });

  await app.register(complianceRoute, { prefix: "/api/v1/compliance", auditClient });
  await app.register(costsRoute, { prefix: "/api/v1/costs", auditClient });

  const skillsClient = new SkillsGrpcClient();
  app.decorate("skillsClient", skillsClient);
  await app.register(marketplaceRoute, { prefix: "/api/v1/marketplace", skillsClient });
  await app.register(skillsRoute, { prefix: "/api/v1/skills", skillsClient });

  return app;
}

export async function startServer(config: GatewayConfig, agentClient: AgentGrpcClient): Promise<FastifyInstance> {
  const app = await buildServer(config, agentClient);

  // CRITICAL: Bind to loopback only by default
  // External access requires explicit configuration + reverse proxy with TLS
  await app.listen({
    port: config.port,
    host: config.host, // Default: "127.0.0.1" — never "0.0.0.0" by default
  });

  app.log.info(
    { host: config.host, port: config.port },
    "Tessera Gateway started"
  );

  if (config.host !== "127.0.0.1") {
    app.log.warn(
      { host: config.host },
      "SECURITY WARNING: Gateway is not bound to loopback. Ensure a reverse proxy with TLS and authentication is in place."
    );
  }

  return app;
}
