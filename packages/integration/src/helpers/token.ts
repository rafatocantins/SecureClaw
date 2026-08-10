/**
 * token.ts — Generate a valid gateway HMAC bearer token for integration tests.
 *
 * Matches the token format in packages/gateway/src/plugins/auth.plugin.ts:
 *   token = {userId}.{role}.{timestamp_ms}.{hmac_sha256_hex(secret, userId:role:timestamp)}
 *
 * The gateway rejects 3-part tokens (pre-4-part format). This helper generates
 * 4-part tokens with role baked into the signed payload, matching
 * generateGatewayToken() in auth.plugin.ts.
 *
 * Intentionally does NOT import from @tessera packages — the integration package
 * is standalone to avoid circular workspace dependencies.
 */
import { createHmac } from "node:crypto";

export function generateToken(
  userId: string,
  secret: string,
  role: "admin" | "user" = "user",
): string {
  const ts = Date.now().toString();
  const payload = `${userId}:${role}:${ts}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${userId}.${role}.${ts}.${sig}`;
}
