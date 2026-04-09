/**
 * costs.route.ts — Team cost showback/chargeback endpoints.
 *
 * GET /api/v1/costs/teams?from=&to=          → all teams summary (JSON)
 * GET /api/v1/costs/teams/:teamId?from=&to=  → single team details (JSON)
 * GET /api/v1/costs/export?from=&to=         → all teams as CSV download
 * GET /api/v1/costs/teams/:teamId/quota      → team quota status
 * PUT /api/v1/costs/teams/:teamId/quota      → set team quota
 *
 * Auth: HMAC token required.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyToken, requireRole } from "../plugins/auth.plugin.js";
import type { AuditGrpcClient } from "../grpc/audit.client.js";

export interface CostsRouteOptions {
  auditClient: AuditGrpcClient;
}

export async function costsRoute(
  fastify: FastifyInstance,
  opts: CostsRouteOptions
): Promise<void> {
  fastify.addHook("preHandler", verifyToken);

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // GET /teams — all teams summary
  fastify.get(
    "/teams",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (
      req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>,
      reply
    ) => {
      const toMs = req.query.to ? parseInt(req.query.to, 10) : Date.now();
      const fromMs = req.query.from ? parseInt(req.query.from, 10) : toMs - THIRTY_DAYS_MS;

      try {
        const summary = await opts.auditClient.getTeamCostSummary("", fromMs, toMs);
        await reply.send(summary);
      } catch (err) {
        fastify.log.error({ err }, "Failed to get team cost summary");
        await reply.code(502).send({ error: "costs_unavailable" });
      }
    }
  );

  // GET /teams/:teamId — single team details
  fastify.get(
    "/teams/:teamId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (
      req: FastifyRequest<{ Params: { teamId: string }; Querystring: { from?: string; to?: string } }>,
      reply
    ) => {
      const { teamId } = req.params;
      const toMs = req.query.to ? parseInt(req.query.to, 10) : Date.now();
      const fromMs = req.query.from ? parseInt(req.query.from, 10) : toMs - THIRTY_DAYS_MS;

      try {
        const summary = await opts.auditClient.getTeamCostSummary(teamId, fromMs, toMs);
        // Return the specific team's entry (or empty result)
        const team = summary.teams.find((t) => t.team_id === teamId) ?? null;
        await reply.send({ team, grand_total_usd: summary.grand_total_usd });
      } catch (err) {
        fastify.log.error({ err }, "Failed to get team cost detail");
        await reply.code(502).send({ error: "costs_unavailable" });
      }
    }
  );

  // GET /export — CSV download for FinOps tools
  fastify.get(
    "/export",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (
      req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>,
      reply
    ) => {
      const toMs = req.query.to ? parseInt(req.query.to, 10) : Date.now();
      const fromMs = req.query.from ? parseInt(req.query.from, 10) : toMs - THIRTY_DAYS_MS;

      try {
        const summary = await opts.auditClient.getTeamCostSummary("", fromMs, toMs);
        const header = "team_id,total_cost_usd,input_tokens,output_tokens,session_count\n";
        const rows = summary.teams
          .map((t) =>
            `${t.team_id},${t.total_cost_usd.toFixed(6)},${t.input_tokens},${t.output_tokens},${t.session_count}`
          )
          .join("\n");
        const csv = header + rows;

        await reply
          .header("Content-Disposition", 'attachment; filename="tessera-costs.csv"')
          .header("Content-Type", "text/csv")
          .send(csv);
      } catch (err) {
        fastify.log.error({ err }, "Failed to export costs CSV");
        await reply.code(502).send({ error: "costs_unavailable" });
      }
    }
  );

  // GET /teams/:teamId/quota — Get team quota summary
  fastify.get(
    "/teams/:teamId/quota",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (
      req: FastifyRequest<{ Params: { teamId: string } }>,
      reply
    ) => {
      const { teamId } = req.params;

      try {
        const quota = await opts.auditClient.getTeamQuota(teamId);
        const resetDateIso = new Date(
          quota.days_until_reset * 24 * 60 * 60 * 1000 + Date.now()
        ).toISOString();

        await reply.send({
          team_id: teamId,
          quota_usd: quota.quota_usd,
          current_spend_usd: quota.current_spend_usd,
          remaining_usd: quota.remaining_usd,
          days_until_reset: quota.days_until_reset,
          at_capacity: quota.at_capacity,
          reset_date_iso: resetDateIso,
        });
      } catch (err) {
        fastify.log.error({ err }, "Failed to get team quota");
        await reply.code(502).send({ error: "quota_unavailable" });
      }
    }
  );

  // PUT /teams/:teamId/quota — admin-only; wrapped in a scoped plugin for role guard
  await fastify.register(async (adminScope) => {
    adminScope.addHook("preHandler", requireRole("admin"));

    adminScope.put(
      "/teams/:teamId/quota",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (
        req: FastifyRequest<{ Params: { teamId: string }; Body: { quota_usd?: number } }>,
        reply
      ) => {
        const { teamId } = req.params;
        const body = req.body as Record<string, unknown> | undefined;
        const quotaVal = body?.["quota_usd"];
        const quota_usd = typeof quotaVal === "number" ? quotaVal : undefined;

        // Validate input
        if (quota_usd === undefined || typeof quota_usd !== "number" || quota_usd < 0) {
          await reply.code(400).send({ error: "invalid_quota_usd" });
          return;
        }

        try {
          await opts.auditClient.setTeamQuota(teamId, quota_usd);

          // Emit audit event
          await opts.auditClient.logEvent({
            event_type: "QUOTA_CONFIGURED",
            payload: { team_id: teamId, quota_usd },
            severity: "WARN",
          });

          await reply.code(204).send();
        } catch (err) {
          fastify.log.error({ err }, "Failed to set team quota");
          await reply.code(502).send({ error: "quota_unavailable" });
        }
      }
    );
  });
}
