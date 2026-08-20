/**
 * harness.route.ts — Harness Self-Evolution REST endpoints.
 *
 * SECURITY: HMAC auth required on every route (verifyToken preHandler — no bypass).
 * The `apply` endpoint delegates to HarnessEvolutionService.applyPatch() on the
 * agent runtime, which always re-validates the patch against the 8 security
 * invariants, vault-placeholder and 500-char limits before applying.
 *
 * Routes:
 *   GET  /api/v1/harness/patches      → list stored + pending patches
 *   POST /api/v1/harness/analyze      → run the self-evolution pipeline
 *   POST /api/v1/harness/apply/:id    → apply a patch by ID (security gate)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyToken } from "../plugins/auth.plugin.js";
import type { AgentGrpcClient } from "../grpc/agent.client.js";

export interface HarnessRouteOptions {
  agentClient: AgentGrpcClient;
}

/** Upper bound for the analyze `limit` body field (defensive). */
const MAX_ANALYZE_LIMIT = 500;
const DEFAULT_ANALYZE_LIMIT = 50;

export async function harnessRoute(
  fastify: FastifyInstance,
  opts: HarnessRouteOptions
): Promise<void> {
  fastify.addHook("preHandler", verifyToken);

  // GET /patches — list stored + pending patches
  fastify.get(
    "/patches",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      try {
        const patches = await opts.agentClient.listHarnessPatches();
        return reply.send({
          patches: patches.map((p) => ({
            id: p.id,
            type: p.type,
            target: p.target,
            proposed_change: p.proposed_change,
            confidence: p.confidence,
            recommendation: p.recommendation,
            applied: p.applied,
          })),
        });
      } catch (err) {
        fastify.log.error({ err }, "Failed to list harness patches");
        return reply.code(502).send({ error: "agent_unavailable" });
      }
    }
  );

  // POST /analyze — run the self-evolution pipeline
  fastify.post(
    "/analyze",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req: FastifyRequest<{ Body: { limit?: unknown } }>, reply) => {
      const body = req.body as { limit?: unknown } | undefined;
      const limitVal = body?.["limit"];
      const limit =
        typeof limitVal === "number" &&
        Number.isFinite(limitVal) &&
        limitVal > 0
          ? Math.min(Math.floor(limitVal), MAX_ANALYZE_LIMIT)
          : DEFAULT_ANALYZE_LIMIT;

      try {
        const result = await opts.agentClient.runHarnessEvolution(limit);
        return reply.send({
          sessions_analyzed: result.sessions_analyzed,
          patches_generated: result.patches_generated,
          patches_applied: result.patches_applied,
          patches_rejected: result.patches_rejected,
          summary: result.summary ?? [],
        });
      } catch (err) {
        fastify.log.error({ err }, "Failed to run harness evolution");
        return reply.code(502).send({ error: "agent_unavailable" });
      }
    }
  );

  // POST /apply/:id — apply a patch by ID (always goes through validatePatch)
  fastify.post(
    "/apply/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const { id } = req.params;
      if (!id) {
        return reply.code(400).send({ error: "missing_patch_id" });
      }

      try {
        const result = await opts.agentClient.applyHarnessPatch(id);
        return reply.send({
          id: result.id,
          applied: result.applied,
          reason: result.reason,
        });
      } catch (err) {
        fastify.log.error({ err, patchId: id }, "Failed to apply harness patch");
        return reply.code(502).send({ error: "agent_unavailable" });
      }
    }
  );
}
