/**
 * backup.route.test.ts — Tests for GET /api/v1/backup and POST /api/v1/backup/restore.
 *
 * Security: auth required, invalid archives rejected, partial failures return 207.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { setGatewaySecret, generateGatewayToken } from "../plugins/auth.plugin.js";
import { backupRoute } from "./backup.route.js";

const SECRET = "test-backup-secret-xyz789";
const VALID_TOKEN = () => generateGatewayToken("admin-user", SECRET);

const FAKE_DUMP = {
  data: Buffer.from("fake-compressed-data"),
  checksum_sha256: "a".repeat(64),
  success: true,
  error_message: "",
};

const FAKE_RESTORE = {
  success: true,
  error_message: "",
  restart_required: true,
};

function makeMockVaultClient(overrides: Partial<{
  dumpState: () => Promise<typeof FAKE_DUMP>;
  restoreState: () => Promise<typeof FAKE_RESTORE>;
}> = {}) {
  return {
    listSecretRefs: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getSecretRef: vi.fn(),
    rotateKey: vi.fn(),
    dumpState: overrides.dumpState ?? vi.fn(async () => FAKE_DUMP),
    restoreState: overrides.restoreState ?? vi.fn(async () => FAKE_RESTORE),
    close: vi.fn(),
  };
}

function makeMockAuditClient(overrides: Partial<{
  dumpState: () => Promise<typeof FAKE_DUMP>;
  restoreState: () => Promise<typeof FAKE_RESTORE>;
}> = {}) {
  return {
    logEvent: vi.fn(async () => ({ event_id: 1, success: true, alerts_triggered: [] })),
    queryEvents: vi.fn(),
    getCostSummary: vi.fn(),
    getTeamCostSummary: vi.fn(),
    getTeamQuota: vi.fn(),
    setTeamQuota: vi.fn(),
    checkQuotaExceeded: vi.fn(),
    getComplianceReport: vi.fn(),
    dumpState: overrides.dumpState ?? vi.fn(async () => FAKE_DUMP),
    restoreState: overrides.restoreState ?? vi.fn(async () => FAKE_RESTORE),
    close: vi.fn(),
  };
}

function makeMockSkillsClient(overrides: Partial<{
  dumpState: () => Promise<typeof FAKE_DUMP>;
  restoreState: () => Promise<typeof FAKE_RESTORE>;
}> = {}) {
  return {
    publishSkill: vi.fn(),
    listMarketplaceSkills: vi.fn(),
    getMarketplaceSkill: vi.fn(),
    installFromMarketplace: vi.fn(),
    installSkill: vi.fn(),
    listInstalledSkills: vi.fn(),
    dumpState: overrides.dumpState ?? vi.fn(async () => FAKE_DUMP),
    restoreState: overrides.restoreState ?? vi.fn(async () => FAKE_RESTORE),
    close: vi.fn(),
  };
}

// Mock MemoryGrpcClient so we don't need a live server
vi.mock("../grpc/memory.client.js", () => ({
  MemoryGrpcClient: vi.fn().mockImplementation(() => ({
    dumpState: vi.fn(async () => FAKE_DUMP),
    restoreState: vi.fn(async () => FAKE_RESTORE),
    close: vi.fn(),
  })),
}));

async function buildApp(opts: {
  vaultClient?: ReturnType<typeof makeMockVaultClient>;
  auditClient?: ReturnType<typeof makeMockAuditClient>;
  skillsClient?: ReturnType<typeof makeMockSkillsClient>;
} = {}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyRateLimit, { max: 100, timeWindow: "1 minute" });

  const vaultClient = opts.vaultClient ?? makeMockVaultClient();
  const auditClient = opts.auditClient ?? makeMockAuditClient();
  const skillsClient = opts.skillsClient ?? makeMockSkillsClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
  app.decorate("vaultClient", vaultClient as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
  app.decorate("skillsClient", skillsClient as any);

  await app.register(backupRoute, {
    prefix: "/api/v1/backup",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
    auditClient: auditClient as any,
  });

  return { app, vaultClient, auditClient, skillsClient };
}

async function gzipBuffer(buf: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  await pipeline(
    Readable.from(buf),
    gzip,
    async function* (source) {
      for await (const chunk of source) {
        chunks.push(chunk as Buffer);
      }
    },
  );
  return Buffer.concat(chunks);
}

async function makeValidArchive(): Promise<Buffer> {
  const envelope = {
    version: 1,
    created_at_unix_ms: Date.now(),
    services: {
      vault:  { data_b64: Buffer.from("v").toString("base64"), checksum_sha256: "a".repeat(64) },
      audit:  { data_b64: Buffer.from("a").toString("base64"), checksum_sha256: "b".repeat(64) },
      memory: { data_b64: Buffer.from("m").toString("base64"), checksum_sha256: "c".repeat(64) },
      skills: { data_b64: Buffer.from("s").toString("base64"), checksum_sha256: "d".repeat(64) },
    },
  };
  return gzipBuffer(Buffer.from(JSON.stringify(envelope)));
}

describe("GET /api/v1/backup", () => {
  beforeEach(() => setGatewaySecret(SECRET));
  afterEach(() => setGatewaySecret(""));

  it("200: returns binary archive with correct content-type", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/backup",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/filename="tessera-backup-/);
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it("200: archive is valid gzip containing JSON envelope", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/backup",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
    });

    const { gunzipSync } = await import("node:zlib");
    const decompressed = gunzipSync(res.rawPayload);
    const parsed = JSON.parse(decompressed.toString("utf-8")) as {
      version: number;
      services: Record<string, { data_b64: string; checksum_sha256: string }>;
    };

    expect(parsed.version).toBe(1);
    expect(parsed.services).toHaveProperty("vault");
    expect(parsed.services).toHaveProperty("audit");
    expect(parsed.services).toHaveProperty("memory");
    expect(parsed.services).toHaveProperty("skills");
  });

  it("200: emits BACKUP_CREATED audit event", async () => {
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ auditClient });

    await app.inject({
      method: "GET",
      url: "/api/v1/backup",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(auditClient.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "BACKUP_CREATED", severity: "WARN" }),
    );
  });

  it("401: no token", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/backup" });
    expect(res.statusCode).toBe(401);
  });

  it("401: invalid token", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/backup",
      headers: { Authorization: "Bearer bad.token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("502: vault dumpState failure returns backup_failed", async () => {
    const vaultClient = makeMockVaultClient({
      dumpState: vi.fn(async () => { throw new Error("vault unreachable"); }),
    });
    const { app } = await buildApp({ vaultClient });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/backup",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toBe("backup_failed");
  });
});

describe("POST /api/v1/backup/restore", () => {
  beforeEach(() => setGatewaySecret(SECRET));
  afterEach(() => setGatewaySecret(""));

  it("200: restores all services and returns restart_required=true", async () => {
    const archive = await makeValidArchive();
    const { app } = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: archive,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; restart_required: boolean; services: Record<string, { success: boolean }> }>();
    expect(body.success).toBe(true);
    expect(body.restart_required).toBe(true);
    expect(body.services["vault"].success).toBe(true);
    expect(body.services["audit"].success).toBe(true);
    expect(body.services["memory"].success).toBe(true);
    expect(body.services["skills"].success).toBe(true);
  });

  it("200: emits BACKUP_RESTORED audit event", async () => {
    const archive = await makeValidArchive();
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ auditClient });

    await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: archive,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(auditClient.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "BACKUP_RESTORED", severity: "WARN" }),
    );
  });

  it("207: partial failure returns 207 with service errors", async () => {
    const archive = await makeValidArchive();
    const vaultClient = makeMockVaultClient({
      restoreState: vi.fn(async () => { throw new Error("vault restore failed"); }),
    });
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ vaultClient, auditClient });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: archive,
    });

    expect(res.statusCode).toBe(207);
    const body = res.json<{
      success: boolean;
      services: Record<string, { success: boolean; error?: string }>;
    }>();
    expect(body.success).toBe(false);
    expect(body.services["vault"].success).toBe(false);
    expect(body.services["vault"].error).toContain("vault restore failed");
    expect(body.services["audit"].success).toBe(true);
  });

  it("207: emits BACKUP_RESTORE_PARTIAL on partial failure", async () => {
    const archive = await makeValidArchive();
    const vaultClient = makeMockVaultClient({
      restoreState: vi.fn(async () => { throw new Error("fail"); }),
    });
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ vaultClient, auditClient });

    await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: archive,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(auditClient.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "BACKUP_RESTORE_PARTIAL", severity: "ERROR" }),
    );
  });

  it("400: empty body", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: Buffer.alloc(0),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("validation_error");
  });

  it("400: invalid (non-gzip) body", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: Buffer.from("not-a-valid-gzip-archive"),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_backup");
  });

  it("400: gzip with invalid JSON", async () => {
    const { app } = await buildApp();
    const bad = await gzipBuffer(Buffer.from("not-json"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: bad,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_backup");
  });

  it("400: gzip with JSON but wrong schema (missing services)", async () => {
    const { app } = await buildApp();
    const bad = await gzipBuffer(Buffer.from(JSON.stringify({ version: 1, created_at_unix_ms: 12345 })));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN()}`,
        "Content-Type": "application/octet-stream",
      },
      payload: bad,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("validation_error");
  });

  it("401: no token", async () => {
    const archive = await makeValidArchive();
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/backup/restore",
      headers: { "Content-Type": "application/octet-stream" },
      payload: archive,
    });
    expect(res.statusCode).toBe(401);
  });
});
