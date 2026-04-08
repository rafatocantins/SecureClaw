/**
 * alerting.service.test.ts — Comprehensive tests for AlertingService.
 *
 * Test groups:
 *   A — Zod schema validation (4 tests)
 *   B — URL validation on construction (4 tests)
 *   C — HMAC signing (3 tests)
 *   D — Vault-ref stripping / AC-14 (2 tests)
 *   E — Delivery behaviour with mock fetch (4 tests)
 *   F — Fire-and-forget: does not throw (2 tests)
 *   G — Disabled state (no WEBHOOK_URL) — tested via AlertingService optional usage (2 tests)
 *   H — Integration test: real local HTTP server (1 test)
 *
 * Total: 22 tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { verifyHmac } from "@tessera/shared";
import { AlertingService, stripVaultRefs, TESSERA_VERSION } from "./alerting.service.js";
import {
  AlertPayloadSchema,
  ApprovalRequestedPayloadSchema,
  QuotaBreachPayloadSchema,
  InjectionDetectedPayloadSchema,
  PolicyDeniedPayloadWithToolSchema,
} from "./schemas/alert.schema.js";
import type { AlertPayload } from "./schemas/alert.schema.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function basePayload(): Omit<AlertPayload, "event_type"> {
  return {
    timestamp: new Date().toISOString(),
    tessera_version: TESSERA_VERSION,
    session_id: "sess-test",
    user_id: "org/user",
  };
}

function makeService(overrides?: { url?: string; secret?: string; timeoutMs?: number }): AlertingService {
  return new AlertingService({
    webhookUrl: overrides?.url ?? "http://127.0.0.1:9999",
    webhookSecret: overrides?.secret ?? "test-secret",
    ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
}

// ── Group A — Zod schema validation ───────────────────────────────────────

describe("Group A — Zod schema validation", () => {
  it("A1: APPROVAL_REQUESTED valid payload passes", () => {
    const result = ApprovalRequestedPayloadSchema.safeParse({
      ...basePayload(),
      event_type: "APPROVAL_REQUESTED",
      call_id: "call-1",
      tool_id: "file_read",
      input_preview: "{ path: '/etc/hosts' }",
    });
    expect(result.success).toBe(true);
  });

  it("A1b: APPROVAL_REQUESTED missing input_preview fails", () => {
    const result = ApprovalRequestedPayloadSchema.safeParse({
      ...basePayload(),
      event_type: "APPROVAL_REQUESTED",
      call_id: "call-1",
      tool_id: "file_read",
      // input_preview missing
    });
    expect(result.success).toBe(false);
  });

  it("A2: QUOTA_BREACH missing team_id fails", () => {
    const result = QuotaBreachPayloadSchema.safeParse({
      ...basePayload(),
      event_type: "QUOTA_BREACH",
      spent_usd: 10,
      quota_usd: 5,
      // team_id missing
    });
    expect(result.success).toBe(false);
  });

  it("A2b: QUOTA_BREACH valid payload with team_id passes", () => {
    const result = QuotaBreachPayloadSchema.safeParse({
      ...basePayload(),
      event_type: "QUOTA_BREACH",
      team_id: "acme",
      spent_usd: 10.5,
      quota_usd: 5.0,
    });
    expect(result.success).toBe(true);
  });

  it("A3: INJECTION_DETECTED excerpt > 256 chars fails", () => {
    const result = InjectionDetectedPayloadSchema.safeParse({
      ...basePayload(),
      event_type: "INJECTION_DETECTED",
      source: "user_input",
      excerpt: "x".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("A3b: INJECTION_DETECTED excerpt <= 256 chars passes", () => {
    const result = InjectionDetectedPayloadSchema.safeParse({
      ...basePayload(),
      event_type: "INJECTION_DETECTED",
      source: "tool_output",
      excerpt: "x".repeat(256),
    });
    expect(result.success).toBe(true);
  });

  it("A4: POLICY_DENIED valid reason string passes", () => {
    const result = PolicyDeniedPayloadWithToolSchema.safeParse({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "policy_engine_denied",
      tool_id: "shell_exec",
    });
    expect(result.success).toBe(true);
  });

  it("A4b: POLICY_DENIED without tool_id (turn cap case) passes", () => {
    const result = PolicyDeniedPayloadWithToolSchema.safeParse({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "turn_cap_exceeded",
    });
    expect(result.success).toBe(true);
  });
});

// ── Group B — URL validation on construction ──────────────────────────────

describe("Group B — URL validation", () => {
  it("B1: http://example.com throws on construction", () => {
    expect(() => new AlertingService({
      webhookUrl: "http://example.com/hook",
      webhookSecret: "s",
    })).toThrow(/HTTPS/);
  });

  it("B2: https://hooks.example.com does not throw", () => {
    expect(() => new AlertingService({
      webhookUrl: "https://hooks.example.com/tessera",
      webhookSecret: "s",
    })).not.toThrow();
  });

  it("B3: http://127.0.0.1:8080 does not throw (loopback allowed)", () => {
    expect(() => new AlertingService({
      webhookUrl: "http://127.0.0.1:8080/hook",
      webhookSecret: "s",
    })).not.toThrow();
  });

  it("B4: http://localhost:8080 throws (localhost not trusted per PO AC-3)", () => {
    expect(() => new AlertingService({
      webhookUrl: "http://localhost:8080/hook",
      webhookSecret: "s",
    })).toThrow(/HTTPS|DNS rebinding|not trusted/i);
  });
});

// ── Group C — HMAC signing ─────────────────────────────────────────────────

describe("Group C — HMAC signing", () => {
  it("C1: X-Webhook-Signature header starts with 'sha256='", async () => {
    const receivedHeaders: Record<string, string> = {};

    // Intercept fetch
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      Object.assign(receivedHeaders, h);
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const svc = makeService({ secret: "my-secret" });
      const payload: AlertPayload = {
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "turn_cap_exceeded",
      };
      await svc.fireAlert(payload);
      expect(receivedHeaders["X-Webhook-Signature"]).toMatch(/^sha256=/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("C2: signature is verifiable with verifyHmac from @tessera/shared", async () => {
    const secret = "verify-me-secret";
    let capturedBody = "";
    let capturedSig = "";

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      capturedSig = h["X-Webhook-Signature"] ?? "";
      capturedBody = (init.body as Buffer).toString("utf-8");
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const svc = makeService({ secret });
      const payload: AlertPayload = {
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "ssrf_block",
        tool_id: "http_request",
      };
      await svc.fireAlert(payload);

      // Strip "sha256=" prefix for verifyHmac
      const hexSig = capturedSig.replace(/^sha256=/, "");
      expect(verifyHmac(secret, capturedBody, hexSig)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("C3: different secrets produce different signatures", async () => {
    const sigs: string[] = [];

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      sigs.push(h["X-Webhook-Signature"] ?? "");
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const payload: AlertPayload = {
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "policy_engine_denied",
      };

      const svc1 = makeService({ secret: "secret-A" });
      await svc1.fireAlert({ ...payload });

      const svc2 = makeService({ secret: "secret-B" });
      await svc2.fireAlert({ ...payload });

      expect(sigs[0]).not.toBe(sigs[1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Group D — Vault-ref stripping / AC-14 ─────────────────────────────────

describe("Group D — Vault-ref stripping (AC-14)", () => {
  it("D1: excerpt with __VAULT_REF:abc123__ is stripped to [REDACTED]", () => {
    const result = stripVaultRefs("result contains __VAULT_REF:abc123__ in it");
    expect(result).toBe("result contains [REDACTED] in it");
    expect(result).not.toContain("__VAULT_REF:");
  });

  it("D2: input_preview with UUID vault ref is stripped", () => {
    const result = stripVaultRefs(
      '{"key": "__VAULT_REF:00000000-0000-0000-0000-000000000000__"}'
    );
    expect(result).toBe('{"key": "[REDACTED]"}');
    expect(result).not.toContain("__VAULT_REF:");
  });

  it("D3: service strips vault refs from INJECTION_DETECTED excerpt before POST", async () => {
    let capturedBody = "";
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = (init.body as Buffer).toString("utf-8");
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const svc = makeService();
      await svc.fireAlert({
        ...basePayload(),
        event_type: "INJECTION_DETECTED",
        source: "tool_output",
        excerpt: "output: __VAULT_REF:deadbeef-dead-beef-dead-beefdeadbeef__",
      });
      expect(capturedBody).not.toContain("__VAULT_REF:");
      expect(capturedBody).toContain("[REDACTED]");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Group E — Delivery behaviour ──────────────────────────────────────────

describe("Group E — Delivery behaviour", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("E1: 200 response → DeliveryResult { success: true, status_code: 200 }", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const svc = makeService();
    const result = await svc.fireAlert({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "policy_engine_denied",
    });
    expect(result).toMatchObject({ success: true, status_code: 200 });
  });

  it("E2: 500 response → DeliveryResult { success: false, status_code: 500 }", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 500 }));
    const svc = makeService();
    const result = await svc.fireAlert({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "ssrf_block",
    });
    expect(result).toMatchObject({ success: false, status_code: 500 });
  });

  it("E3: AbortError (timeout) → DeliveryResult { success: false, error: string }", async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    const svc = makeService({ timeoutMs: 50 });
    const result = await svc.fireAlert({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "turn_cap_exceeded",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("E4: auditFn called exactly once regardless of outcome", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const svc = makeService();
    const auditFn = vi.fn();
    await svc.fireAlert({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "policy_engine_denied",
    }, auditFn);
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_success: false, status_code: 503 })
    );
  });

  it("E5: auditFn called with delivery_success: true on 200", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const svc = makeService();
    const auditFn = vi.fn();
    await svc.fireAlert({
      ...basePayload(),
      event_type: "POLICY_DENIED",
      reason: "policy_engine_denied",
    }, auditFn);
    expect(auditFn).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_success: true, status_code: 200 })
    );
  });
});

// ── Group F — Fire-and-forget: does not throw ─────────────────────────────

describe("Group F — Fire-and-forget: does not throw", () => {
  it("F1: fireAlert with a fetch that throws resolves (does not reject)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unreachable")));
    try {
      const svc = makeService();
      const result = await svc.fireAlert({
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "policy_engine_denied",
      });
      // Should resolve with error result, not reject
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("F2: fireAlert with network error still calls auditFn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    try {
      const svc = makeService();
      const auditFn = vi.fn();
      await svc.fireAlert({
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "ssrf_block",
      }, auditFn);
      expect(auditFn).toHaveBeenCalledTimes(1);
      expect(auditFn).toHaveBeenCalledWith(
        expect.objectContaining({ delivery_success: false })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Group G — Disabled state (no WEBHOOK_URL) ─────────────────────────────

describe("Group G — Disabled state", () => {
  it("G1: when alertingService is undefined (optional), no webhook calls are made", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // Simulate the agent-loop pattern: void alertingService?.fireAlert(...)
      const alertingService: AlertingService | undefined = undefined;
      void alertingService?.fireAlert({
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "turn_cap_exceeded",
      });
      // No fetch should have been called
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("G2: AlertingService without secret sends no X-Webhook-Signature header", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(new Response(null, { status: 200 }));
    }));
    try {
      const svc = new AlertingService({
        webhookUrl: "http://127.0.0.1:9999",
        webhookSecret: "",
      });
      await svc.fireAlert({
        ...basePayload(),
        event_type: "POLICY_DENIED",
        reason: "policy_engine_denied",
      });
      expect(capturedHeaders["X-Webhook-Signature"]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Group H — Integration test: real local HTTP server ────────────────────

describe("Group H — Integration: real local server", () => {
  it("H1: posts valid payload with verifiable HMAC signature to real HTTP listener", async () => {
    const secret = "integration-test-secret";
    let receivedBody = "";
    let receivedHeaders: Record<string, string> = {};

    // Stand up a minimal Node.js HTTP server on a random port
    await new Promise<void>((resolveServer, rejectServer) => {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks).toString("utf-8");
          receivedHeaders = req.headers as Record<string, string>;
          res.writeHead(200);
          res.end();
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        const port = addr.port;
        const svc = new AlertingService({
          webhookUrl: `http://127.0.0.1:${port}`,
          webhookSecret: secret,
        });

        const payload: AlertPayload = {
          event_type: "APPROVAL_REQUESTED",
          timestamp: new Date().toISOString(),
          tessera_version: TESSERA_VERSION,
          session_id: "sess-integration",
          user_id: "org/user",
          call_id: "call-integration",
          tool_id: "shell_exec",
          input_preview: "echo hello",
        };

        const auditFn = vi.fn();

        svc.fireAlert(payload, auditFn).then((result) => {
          server.close(() => {
            try {
              // Verify delivery result
              expect(result.success).toBe(true);
              expect(result.status_code).toBe(200);

              // Verify Content-Type header
              expect(receivedHeaders["content-type"]).toBe("application/json");

              // Verify HMAC signature
              const sigHeader = receivedHeaders["x-webhook-signature"] ?? "";
              expect(sigHeader).toMatch(/^sha256=/);
              const hexSig = sigHeader.replace(/^sha256=/, "");
              expect(verifyHmac(secret, receivedBody, hexSig)).toBe(true);

              // Verify payload round-trips correctly
              const parsed = JSON.parse(receivedBody) as Record<string, unknown>;
              expect(parsed["event_type"]).toBe("APPROVAL_REQUESTED");
              expect(parsed["session_id"]).toBe("sess-integration");
              expect(parsed["tool_id"]).toBe("shell_exec");

              // Verify auditFn called with success
              expect(auditFn).toHaveBeenCalledTimes(1);
              expect(auditFn).toHaveBeenCalledWith(
                expect.objectContaining({ delivery_success: true })
              );

              resolveServer();
            } catch (e) {
              rejectServer(e);
            }
          });
        }).catch(rejectServer);
      });

      server.on("error", rejectServer);
    });
  });
});
