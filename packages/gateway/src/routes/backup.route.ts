/**
 * backup.route.ts — System backup and restore endpoints.
 *
 * GET  /api/v1/backup         — Create a full backup archive (binary download).
 * POST /api/v1/backup/restore — Restore from a backup archive.
 *
 * Archive format: gzip-compressed JSON envelope:
 *   { version: 1, created_at_unix_ms: number,
 *     services: { vault, audit, memory, skills }
 *     where each entry is { data_b64: string, checksum_sha256: string } }
 *
 * SECURITY:
 * - verifyToken enforced — no public access
 * - Rate limit: 5/min (admin-only operation)
 * - Audit events emitted on create and restore
 * - Restore body size capped at 256 MiB (override bodyLimit for this route)
 */
import { createGzip, gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyToken, requireRole } from "../plugins/auth.plugin.js";
import type { GrpcRestoreStateResponse } from "@tessera/shared";
import type { VaultGrpcClient } from "../grpc/vault.client.js";
import type { AuditGrpcClient } from "../grpc/audit.client.js";
import type { SkillsGrpcClient } from "../grpc/skills.client.js";
import { MemoryGrpcClient } from "../grpc/memory.client.js";

const BACKUP_VERSION = 1;
const MAX_RESTORE_BYTES = 256 * 1024 * 1024; // 256 MiB

interface ServiceBackupEntry {
  data_b64: string;
  checksum_sha256: string;
}

interface BackupEnvelope {
  version: number;
  created_at_unix_ms: number;
  services: {
    vault: ServiceBackupEntry;
    audit: ServiceBackupEntry;
    memory: ServiceBackupEntry;
    skills: ServiceBackupEntry;
  };
}

const ServiceEntrySchema = z.object({
  data_b64: z.string().min(1),
  checksum_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const BackupEnvelopeSchema = z.object({
  version: z.literal(1),
  created_at_unix_ms: z.number().int().positive(),
  services: z.object({
    vault: ServiceEntrySchema,
    audit: ServiceEntrySchema,
    memory: ServiceEntrySchema,
    skills: ServiceEntrySchema,
  }),
});

declare module "fastify" {
  interface FastifyInstance {
    vaultClient: VaultGrpcClient;
    skillsClient: SkillsGrpcClient;
  }
}

interface BackupRouteOpts {
  auditClient: AuditGrpcClient;
}

export async function backupRoute(
  fastify: FastifyInstance,
  opts: BackupRouteOpts,
): Promise<void> {
  fastify.addHook("preHandler", verifyToken);

  // Accept raw binary bodies for the restore endpoint
  fastify.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_RESTORE_BYTES },
    (_req, body, done) => { done(null, body); },
  );

  const memoryClient = new MemoryGrpcClient();
  fastify.addHook("onClose", async () => memoryClient.close());

  // GET /api/v1/backup — dump all service state into a single archive
  fastify.get(
    "/",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      try {
        const [vault, audit, memory, skills] = await Promise.all([
          fastify.vaultClient.dumpState(),
          opts.auditClient.dumpState(),
          memoryClient.dumpState(),
          fastify.skillsClient.dumpState(),
        ]);

        const envelope: BackupEnvelope = {
          version: BACKUP_VERSION,
          created_at_unix_ms: Date.now(),
          services: {
            vault:   { data_b64: Buffer.from(vault.data).toString("base64"),   checksum_sha256: vault.checksum_sha256 },
            audit:   { data_b64: Buffer.from(audit.data).toString("base64"),   checksum_sha256: audit.checksum_sha256 },
            memory:  { data_b64: Buffer.from(memory.data).toString("base64"),  checksum_sha256: memory.checksum_sha256 },
            skills:  { data_b64: Buffer.from(skills.data).toString("base64"),  checksum_sha256: skills.checksum_sha256 },
          },
        };

        const jsonBytes = Buffer.from(JSON.stringify(envelope), "utf-8");

        // Gzip compress
        const chunks: Buffer[] = [];
        const gzip = createGzip();
        await pipeline(
          Readable.from(jsonBytes),
          gzip,
          async function* (source) {
            for await (const chunk of source) {
              chunks.push(chunk as Buffer);
            }
          },
        );
        const compressed = Buffer.concat(chunks);

        opts.auditClient.logEvent({
          event_type: "BACKUP_CREATED",
          payload: { size_bytes: compressed.length },
          severity: "WARN",
        }).catch(() => { /* fire-and-forget */ });

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        await reply
          .code(200)
          .header("Content-Type", "application/octet-stream")
          .header("Content-Disposition", `attachment; filename="tessera-backup-${ts}.gz"`)
          .header("Content-Length", String(compressed.length))
          .send(compressed);
      } catch (err) {
        fastify.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Backup creation failed",
        );
        await reply.code(502).send({ error: "backup_failed", message: err instanceof Error ? err.message : "unknown" });
      }
    },
  );

  // POST /api/v1/backup/restore — admin-only; wrapped in a scoped plugin for role guard
  await fastify.register(async (adminScope) => {
    adminScope.addHook("preHandler", requireRole("admin"));

    adminScope.post(
      "/restore",
      {
        config: {
          rateLimit: { max: 5, timeWindow: "1 minute" },
          // Allow large bodies for this route; bodyLimit set per-route via addContentTypeParser
        },
        bodyLimit: MAX_RESTORE_BYTES,
      },
      async (req: FastifyRequest<{ Body: Buffer }>, reply) => {
        const rawBody = req.body;

        if (!rawBody || rawBody.length === 0) {
          await reply.code(400).send({ error: "validation_error", message: "Empty request body" });
          return;
        }

        let envelope: BackupEnvelope;
        try {
          const decompressed = gunzipSync(rawBody);
          const parsed: unknown = JSON.parse(decompressed.toString("utf-8"));
          const result = BackupEnvelopeSchema.safeParse(parsed);
          if (!result.success) {
            await reply.code(400).send({ error: "validation_error", issues: result.error.issues });
            return;
          }
          envelope = result.data;
        } catch {
          await reply.code(400).send({ error: "invalid_backup", message: "Could not decompress or parse backup archive" });
          return;
        }

        const results: Record<string, { success: boolean; restart_required: boolean; error?: string }> = {};

        // Restore each service (continue on partial failure)
        const services = [
          {
            name: "vault" as const,
            restore: (e: ServiceBackupEntry): Promise<GrpcRestoreStateResponse> =>
              fastify.vaultClient.restoreState(Buffer.from(e.data_b64, "base64"), e.checksum_sha256),
          },
          {
            name: "audit" as const,
            restore: (e: ServiceBackupEntry): Promise<GrpcRestoreStateResponse> =>
              opts.auditClient.restoreState(Buffer.from(e.data_b64, "base64"), e.checksum_sha256),
          },
          {
            name: "memory" as const,
            restore: (e: ServiceBackupEntry): Promise<GrpcRestoreStateResponse> =>
              memoryClient.restoreState(Buffer.from(e.data_b64, "base64"), e.checksum_sha256),
          },
          {
            name: "skills" as const,
            restore: (e: ServiceBackupEntry): Promise<GrpcRestoreStateResponse> =>
              fastify.skillsClient.restoreState(Buffer.from(e.data_b64, "base64"), e.checksum_sha256),
          },
        ] as const;

        let anyFailure = false;
        for (const svc of services) {
          try {
            const res = await svc.restore(envelope.services[svc.name]);
            results[svc.name] = { success: true, restart_required: res.restart_required };
          } catch (err) {
            anyFailure = true;
            results[svc.name] = {
              success: false,
              restart_required: false,
              error: err instanceof Error ? err.message : "unknown",
            };
          }
        }

        opts.auditClient.logEvent({
          event_type: anyFailure ? "BACKUP_RESTORE_PARTIAL" : "BACKUP_RESTORED",
          payload: { results },
          severity: anyFailure ? "ERROR" : "WARN",
        }).catch(() => { /* fire-and-forget */ });

        const statusCode = anyFailure ? 207 : 200;
        await reply.code(statusCode).send({
          success: !anyFailure,
          backup_created_at_unix_ms: envelope.created_at_unix_ms,
          services: results,
          restart_required: Object.values(results).some((r) => r.restart_required),
        });
      },
    );
  });
}
