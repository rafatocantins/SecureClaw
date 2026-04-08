/**
 * vault-admin.route.test.ts — Tests for POST /api/v1/vault/rotate-key.
 *
 * Security checks: auth required, body validation, no key material in responses,
 * audit events emitted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { setGatewaySecret, generateGatewayToken } from "../plugins/auth.plugin.js";
import { vaultAdminRoute } from "./vault-admin.route.js";

const SECRET = "test-vault-admin-secret-abc123";
const VALID_TOKEN = () => generateGatewayToken("admin-user", SECRET, "admin");
const USER_TOKEN = () => generateGatewayToken("regular-user", SECRET, "user");

// Mock vault client
function makeMockVaultClient(overrides: {
  rotateKey?: (old: string, nw: string) => Promise<{ rotated_count: number }>;
} = {}) {
  return {
    listSecretRefs: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getSecretRef: vi.fn(),
    close: vi.fn(),
    rotateKey: overrides.rotateKey ?? vi.fn(async () => ({ rotated_count: 5 })),
  };
}

// Mock audit client
function makeMockAuditClient() {
  return {
    logEvent: vi.fn(async () => ({ event_id: 1, success: true, alerts_triggered: [] })),
    queryEvents: vi.fn(),
    getCostSummary: vi.fn(),
    getTeamCostSummary: vi.fn(),
    getTeamQuota: vi.fn(),
    setTeamQuota: vi.fn(),
    checkQuotaExceeded: vi.fn(),
    getComplianceReport: vi.fn(),
    close: vi.fn(),
  };
}

async function buildApp(opts: {
  vaultClient?: ReturnType<typeof makeMockVaultClient>;
  auditClient?: ReturnType<typeof makeMockAuditClient>;
} = {}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyRateLimit, { max: 100, timeWindow: "1 minute" });

  const vaultClient = opts.vaultClient ?? makeMockVaultClient();
  const auditClient = opts.auditClient ?? makeMockAuditClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock decoration
  app.decorate("vaultClient", vaultClient as any);

  await app.register(vaultAdminRoute, {
    prefix: "/api/v1/vault",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
    auditClient: auditClient as any,
  });

  return { app, vaultClient, auditClient };
}

describe("POST /api/v1/vault/rotate-key", () => {
  beforeEach(() => setGatewaySecret(SECRET));
  afterEach(() => setGatewaySecret(""));

  it("200: mocked vault client returns rotated_count", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: { old_master_key: "old-key", new_master_key: "new-key" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rotated_count: number }>();
    expect(body.rotated_count).toBe(5);
  });

  it("200: response does not contain key material", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: { old_master_key: "secret-old", new_master_key: "secret-new" },
    });

    const text = res.body;
    expect(text).not.toContain("secret-old");
    expect(text).not.toContain("secret-new");
    expect(text).not.toContain("old_master_key");
    expect(text).not.toContain("new_master_key");
  });

  it("200: emits VAULT_KEY_ROTATED audit event", async () => {
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ auditClient });

    await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: { old_master_key: "old", new_master_key: "new" },
    });

    // Allow the fire-and-forget promise to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(auditClient.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "VAULT_KEY_ROTATED",
        payload: { rotated_count: 5 },
        severity: "WARN",
      }),
    );
  });

  it("400: missing body fields", async () => {
    const { app } = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("validation_error");
  });

  it("400: empty string fields rejected", async () => {
    const { app } = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: { old_master_key: "", new_master_key: "new" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("401: no token", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      payload: { old_master_key: "old", new_master_key: "new" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("401: invalid token", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: "Bearer invalid.token.here" },
      payload: { old_master_key: "old", new_master_key: "new" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("502: vault client throws returns vault_unavailable", async () => {
    const vaultClient = makeMockVaultClient({
      rotateKey: vi.fn(async () => { throw new Error("connection refused"); }),
    });
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ vaultClient, auditClient });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: { old_master_key: "old", new_master_key: "new" },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("vault_unavailable");
  });

  it("502: emits VAULT_KEY_ROTATION_FAILED audit event on error", async () => {
    const vaultClient = makeMockVaultClient({
      rotateKey: vi.fn(async () => { throw new Error("vault error"); }),
    });
    const auditClient = makeMockAuditClient();
    const { app } = await buildApp({ vaultClient, auditClient });

    await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${VALID_TOKEN()}` },
      payload: { old_master_key: "old", new_master_key: "new" },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(auditClient.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "VAULT_KEY_ROTATION_FAILED",
        severity: "ERROR",
      }),
    );
  });

  it("403: user-role token is forbidden on rotate-key", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vault/rotate-key",
      headers: { Authorization: `Bearer ${USER_TOKEN()}` },
      payload: { old_master_key: "old", new_master_key: "new" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("Forbidden");
  });
});
