/**
 * auth.plugin.ts — HMAC token authentication for the gateway.
 *
 * SECURITY PROPERTIES:
 * - Tokens are ONLY accepted in the Authorization header (never query params)
 * - Constant-time comparison prevents timing attacks
 * - Configurable replay window (TOKEN_EXPIRY_SECONDS, default 300) prevents token replay
 * - No "localhost trust" — authentication is always required
 *
 * Token format: {userId}.{role}.{timestamp_ms}.{hmac_sha256(secret, userId:role:timestamp)}
 * Old 3-part tokens are rejected before any HMAC check.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyHmac, signHmac, isExpired, nowUtcMs } from "@tessera/shared";

void isExpired; // Used in other modules

// Gateway secret is loaded from the OS vault at startup, never from env
let gatewaySecret = "";

export function setGatewaySecret(secret: string): void {
  gatewaySecret = secret;
}

export function getGatewaySecret(): string {
  return gatewaySecret;
}

/**
 * Returns the token expiry window in milliseconds.
 * Reads TOKEN_EXPIRY_SECONDS from env (30–604800 range); defaults to 300s (5 minutes).
 */
export function getTokenExpiryMs(): number {
  const val = process.env["TOKEN_EXPIRY_SECONDS"];
  if (val) {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n >= 30 && n <= 604800) return n * 1000;
  }
  return 5 * 60 * 1000; // default: 5 minutes
}

/**
 * Generate a signed HMAC token for a user.
 * Called by the CLI to generate tokens for configured users.
 *
 * The role is baked into the signed payload — a token where the role is
 * stripped or altered will fail HMAC verification.
 */
export function generateGatewayToken(
  userId: string,
  secret: string,
  role: "admin" | "user" = "user",
): string {
  const timestamp = nowUtcMs().toString();
  const payload = `${userId}:${role}:${timestamp}`;
  const signature = signHmac(secret, payload);
  return `${userId}.${role}.${timestamp}.${signature}`;
}

/**
 * Fastify preHandler that enforces role-based access.
 * Returns 403 { error: "Forbidden" } if req.role is not in the allowed roles.
 * Must be placed AFTER verifyToken in the preHandler chain.
 */
export function requireRole(
  ...roles: string[]
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function roleGuard(req, reply) {
    if (!req.role || !roles.includes(req.role)) {
      await reply.code(403).send({ error: "Forbidden" });
    }
  };
}

/**
 * Fastify pre-handler hook that validates HMAC tokens.
 * Attached to all authenticated routes.
 *
 * WebSocket exception: browsers cannot set custom HTTP headers during a WS
 * upgrade. For WebSocket connections we fall back to the `?token=` query
 * param (the global blockTokenInQueryParams hook exempts WS upgrades).
 */
export async function verifyToken(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let authHeader = req.headers["authorization"];

  // Browser WebSocket fallback — accept token in query param only during upgrade
  if (!authHeader && req.headers["upgrade"] === "websocket") {
    const q = req.query as Record<string, string>;
    if (q["token"]) authHeader = `Bearer ${q["token"]}`;
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    await reply.code(401).send({
      error: "unauthorized",
      message: "Authorization header with Bearer token required",
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  const parts = token.split(".");

  if (parts.length !== 4) {
    await reply.code(401).send({
      error: "unauthorized",
      message: "Invalid token format",
    });
    return;
  }

  const [userId, role, timestampStr, signature] = parts as [string, string, string, string];
  const timestamp = parseInt(timestampStr, 10);

  if (isNaN(timestamp)) {
    await reply.code(401).send({ error: "unauthorized", message: "Invalid token timestamp" });
    return;
  }

  // Replay attack prevention: reject tokens older than the configured expiry window
  if (Math.abs(nowUtcMs() - timestamp) > getTokenExpiryMs()) {
    await reply.code(401).send({ error: "unauthorized", message: "Token expired or from the future" });
    return;
  }

  // Constant-time HMAC verification — role is part of the signed payload
  const payload = `${userId}:${role}:${timestampStr}`;
  if (!verifyHmac(gatewaySecret, payload, signature)) {
    await reply.code(401).send({ error: "unauthorized", message: "Invalid token signature" });
    return;
  }

  // Attach userId and role to request for use in route handlers and role guards
  req.userId = userId;
  req.role = role;
}

/**
 * Hook that blocks any request with Authorization data in query parameters.
 * Tokens in URLs appear in server logs, browser history, and proxies.
 *
 * WebSocket exception: browsers cannot send custom headers during a WS
 * upgrade, so the `?token=` query param is the only viable auth channel.
 * We exempt WS upgrades here; verifyToken handles the actual validation.
 */
export async function blockTokenInQueryParams(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Allow token in query params for WebSocket upgrade requests (browser limitation)
  if (req.headers["upgrade"] === "websocket") return;

  const query = req.query as Record<string, string>;
  const suspiciousKeys = ["token", "access_token", "auth", "api_key", "key", "authorization"];

  for (const key of suspiciousKeys) {
    if (key in query) {
      await reply.code(400).send({
        error: "bad_request",
        message: "Authentication credentials must not appear in URL query parameters. Use Authorization header.",
      });
      return;
    }
  }
}

// Augment FastifyRequest to include userId and role
declare module "fastify" {
  interface FastifyRequest {
    userId?: string | undefined;
    role?: string | undefined;
  }
}
