/**
 * token.route.ts — Token configuration and refresh endpoints.
 *
 * GET  /api/v1/token/config   — returns the configured expiry window (public, no auth)
 * POST /api/v1/token/refresh  — exchanges a valid token for a fresh one (auth required)
 *
 * The refresh endpoint lets CLI users and external clients extend their session
 * without re-entering credentials. Rate limited to 10/min per user.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  verifyToken,
  generateGatewayToken,
  getGatewaySecret,
  getTokenExpiryMs,
} from "../plugins/auth.plugin.js";

export async function tokenRoute(fastify: FastifyInstance): Promise<void> {
  // GET /token/config — public, no auth
  // Clients use this to know when to schedule a refresh (e.g. 60s before expiry).
  fastify.get(
    "/config",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      await reply.send({
        expiry_seconds: Math.floor(getTokenExpiryMs() / 1000),
      });
    }
  );

  // POST /token/refresh — auth required, returns a fresh token for the same userId
  // Rate limited per-user to prevent abuse while allowing reasonable refresh cadence.
  fastify.post(
    "/refresh",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: [verifyToken],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = req.userId;
      if (!userId) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }

      const secret = getGatewaySecret();
      if (!secret) {
        fastify.log.error("Gateway secret not initialised — cannot issue refresh token");
        await reply.code(503).send({ error: "service_unavailable" });
        return;
      }

      const role = (req.role === "admin" ? "admin" : "user") as "admin" | "user";
      const token = generateGatewayToken(userId, secret, role);
      const expiresInSeconds = Math.floor(getTokenExpiryMs() / 1000);

      await reply.send({ token, expires_in_seconds: expiresInSeconds });
    }
  );
}
