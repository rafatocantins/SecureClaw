/**
 * vault-admin.route.ts — Admin vault operations (key rotation).
 *
 * POST /api/v1/vault/rotate-key — Re-encrypt all vault entries with a new key.
 *
 * SECURITY:
 * - verifyToken enforced — no public access
 * - Rate limit: 3/min (admin operation, not a hot path)
 * - Key material NEVER appears in logs or responses
 * - Audit event emitted on success and failure (no key material in payload)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyToken } from "../plugins/auth.plugin.js";
import type { VaultGrpcClient } from "../grpc/vault.client.js";
import type { AuditGrpcClient } from "../grpc/audit.client.js";

declare module "fastify" {
  interface FastifyInstance {
    vaultClient: VaultGrpcClient;
  }
}

interface VaultAdminRouteOpts {
  auditClient: AuditGrpcClient;
}

const RotateKeyBody = z.object({
  old_master_key: z.string().min(1),
  new_master_key: z.string().min(1),
});

export async function vaultAdminRoute(
  fastify: FastifyInstance,
  opts: VaultAdminRouteOpts,
): Promise<void> {
  fastify.addHook("preHandler", verifyToken);

  // POST /rotate-key — Re-encrypt all vault entries with a new master key
  fastify.post(
    "/rotate-key",
    {
      config: {
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
    },
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply,
    ) => {
      const parsed = RotateKeyBody.safeParse(req.body);
      if (!parsed.success) {
        await reply.code(400).send({
          error: "validation_error",
          issues: parsed.error.issues,
        });
        return;
      }

      const { old_master_key, new_master_key } = parsed.data;

      try {
        const result = await fastify.vaultClient.rotateKey(
          old_master_key,
          new_master_key,
        );

        // Audit event — no key material in payload
        opts.auditClient.logEvent({
          event_type: "VAULT_KEY_ROTATED",
          payload: { rotated_count: result.rotated_count },
          severity: "WARN",
        }).catch(() => {
          // Fire-and-forget audit logging — do not fail the request
        });

        await reply.code(200).send({ rotated_count: result.rotated_count });
      } catch (err) {
        // Audit event on failure — no key material
        opts.auditClient.logEvent({
          event_type: "VAULT_KEY_ROTATION_FAILED",
          payload: {
            error: err instanceof Error ? err.message : "unknown",
          },
          severity: "ERROR",
        }).catch(() => {
          // Fire-and-forget
        });

        fastify.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Vault key rotation failed",
        );
        await reply.code(502).send({ error: "vault_unavailable" });
      }
    },
  );
}
