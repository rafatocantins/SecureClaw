/**
 * memory.route.ts — Memory / lessons REST endpoints.
 *
 * Authenticated (HMAC token required):
 *   GET /api/v1/memory/lessons?limit=<n>  → list lessons for the authenticated user
 *
 * SECURITY: user_id is always sourced from the verified token (req.userId),
 * never from query params. This prevents cross-user lesson enumeration (T-4-02).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyToken } from "../plugins/auth.plugin.js";
import type { MemoryGrpcClient } from "../grpc/memory.client.js";

export interface MemoryRouteOptions {
  memoryClient: MemoryGrpcClient;
}

export async function memoryRoute(
  fastify: FastifyInstance,
  opts: MemoryRouteOptions
): Promise<void> {
  fastify.addHook("preHandler", verifyToken);

  // GET /lessons — list stored lessons for the authenticated user
  fastify.get(
    "/lessons",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (
      req: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply
    ) => {
      const userId = req.userId ?? ""; // Always from verified token — never from query params
      const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 100);
      try {
        const lessons = await opts.memoryClient.listLessons(userId, limit);
        return reply.send({ lessons });
      } catch (err) {
        fastify.log.error({ err }, "Failed to list lessons from memory service");
        return reply.code(502).send({ error: "memory_service_unavailable" });
      }
    }
  );
}
