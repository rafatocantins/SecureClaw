import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateGatewayToken,
  setGatewaySecret,
  getGatewaySecret,
  verifyToken,
  blockTokenInQueryParams,
  getTokenExpiryMs,
  requireRole,
} from "./auth.plugin.js";

const SECRET = "test-gateway-secret";

// Minimal Fastify reply mock
interface ReplyMock {
  code: (c: number) => ReplyMock;
  send: (b: unknown) => Promise<void>;
  readonly statusCode: number;
  readonly body: unknown;
}

function makeReply(): ReplyMock {
  let statusCode = 200;
  let body: unknown;
  const reply: ReplyMock = {
    code(c: number): ReplyMock {
      statusCode = c;
      return reply;
    },
    async send(b: unknown): Promise<void> {
      body = b;
    },
    get statusCode(): number {
      return statusCode;
    },
    get body(): unknown {
      return body;
    },
  };
  return reply;
}

// Minimal Fastify request mock (includes role field)
function makeReq(
  authHeader?: string,
  query: Record<string, string> = {}
): { headers: Record<string, string>; query: Record<string, string>; userId?: string; role?: string } {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    query,
    userId: undefined,
    role: undefined,
  };
}

describe("getGatewaySecret", () => {
  beforeEach(() => setGatewaySecret(""));
  afterEach(() => setGatewaySecret(""));

  it("returns empty string before any secret is set", () => {
    expect(getGatewaySecret()).toBe("");
  });

  it("returns the secret after setGatewaySecret is called", () => {
    setGatewaySecret("my-secret");
    expect(getGatewaySecret()).toBe("my-secret");
  });
});

describe("getTokenExpiryMs", () => {
  afterEach(() => {
    delete process.env["TOKEN_EXPIRY_SECONDS"];
  });

  it("defaults to 300 000 ms (5 minutes) when env var is not set", () => {
    delete process.env["TOKEN_EXPIRY_SECONDS"];
    expect(getTokenExpiryMs()).toBe(300_000);
  });

  it("returns the configured value when TOKEN_EXPIRY_SECONDS is set", () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "3600";
    expect(getTokenExpiryMs()).toBe(3_600_000);
  });

  it("clamps to minimum 30 seconds — ignores values below 30", () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "5";
    expect(getTokenExpiryMs()).toBe(300_000); // falls back to default
  });

  it("clamps to maximum 604800 seconds (7 days) — ignores values above", () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "9999999";
    expect(getTokenExpiryMs()).toBe(300_000); // falls back to default
  });

  it("ignores non-numeric values", () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "not-a-number";
    expect(getTokenExpiryMs()).toBe(300_000);
  });
});

describe("generateGatewayToken", () => {
  it("produces a token with four dot-separated parts", () => {
    const token = generateGatewayToken("alice", SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(4);
  });

  it("first part is the userId", () => {
    const token = generateGatewayToken("alice", SECRET);
    expect(token.startsWith("alice.")).toBe(true);
  });

  it("second part is the role (defaults to user)", () => {
    const token = generateGatewayToken("alice", SECRET);
    const [, role] = token.split(".");
    expect(role).toBe("user");
  });

  it("second part is admin when role is explicitly admin", () => {
    const token = generateGatewayToken("alice", SECRET, "admin");
    const [, role] = token.split(".");
    expect(role).toBe("admin");
  });

  it("third part (index 2) is a numeric timestamp", () => {
    const token = generateGatewayToken("alice", SECRET);
    const parts = token.split(".");
    const ts = parts[2];
    expect(Number.isInteger(Number(ts))).toBe(true);
    expect(Number(ts)).toBeGreaterThan(0);
  });

  it("fourth part (index 3) is a hex HMAC signature", () => {
    const token = generateGatewayToken("alice", SECRET);
    const parts = token.split(".");
    const sig = parts[3];
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it("different secrets produce different tokens for the same user", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const t1 = generateGatewayToken("alice", "secret-a");
    const t2 = generateGatewayToken("alice", "secret-b");
    vi.useRealTimers();
    expect(t1).not.toBe(t2);
  });
});

describe("verifyToken", () => {
  beforeEach(() => {
    setGatewaySecret(SECRET);
  });

  afterEach(() => {
    vi.useRealTimers();
    setGatewaySecret("");
  });

  it("accepts a fresh valid token", async () => {
    const token = generateGatewayToken("bob", SECRET);
    const req = makeReq(`Bearer ${token}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(req.userId).toBe("bob");
  });

  it("attaches role from token", async () => {
    const token = generateGatewayToken("alice", SECRET, "admin");
    const req = makeReq(`Bearer ${token}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(req.userId).toBe("alice");
    expect(req.role).toBe("admin");
  });

  it("attaches user role when token has user role", async () => {
    const token = generateGatewayToken("bob", SECRET, "user");
    const req = makeReq(`Bearer ${token}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(req.role).toBe("user");
  });

  it("rejects a request with no Authorization header", async () => {
    const req = makeReq();
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe("unauthorized");
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const req = makeReq("Basic dXNlcjpwYXNz");
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
  });

  it("rejects 3-part legacy token with 401", async () => {
    // Old 3-part format: userId.timestamp.sig
    const req = makeReq("Bearer alice.1700000000000.deadbeef");
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { message: string }).message).toMatch(/format/i);
  });

  it("rejects a token with fewer than 3 parts", async () => {
    const req = makeReq("Bearer alice.nohex");
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { message: string }).message).toMatch(/format/i);
  });

  it("rejects a token with a non-numeric timestamp", async () => {
    const req = makeReq("Bearer alice.user.notanumber.deadbeef");
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { message: string }).message).toMatch(/timestamp/i);
  });

  it("rejects a token older than the expiry window (replay prevention)", async () => {
    vi.useFakeTimers();
    const pastMs = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    vi.setSystemTime(pastMs);
    const token = generateGatewayToken("carol", SECRET);

    // Move time forward past the window
    vi.setSystemTime(pastMs + 6 * 60 * 1000);

    const req = makeReq(`Bearer ${token}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { message: string }).message).toMatch(/expired/i);
  });

  it("accepts a token within a custom TOKEN_EXPIRY_SECONDS window", async () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "3600"; // 1 hour
    vi.useFakeTimers();
    const pastMs = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    vi.setSystemTime(pastMs);
    const token = generateGatewayToken("grace", SECRET);

    // Move time forward 10 minutes — still within 1-hour window
    vi.setSystemTime(pastMs + 10 * 60 * 1000);

    const req = makeReq(`Bearer ${token}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(req.userId).toBe("grace");

    vi.useRealTimers();
    delete process.env["TOKEN_EXPIRY_SECONDS"];
  });

  it("rejects a token signed with a different secret", async () => {
    const token = generateGatewayToken("dave", "wrong-secret");
    const req = makeReq(`Bearer ${token}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { message: string }).message).toMatch(/signature/i);
  });

  it("rejects a token with a tampered signature", async () => {
    const token = generateGatewayToken("eve", SECRET);
    const parts = token.split(".");
    const sig = parts[3]!;
    const tampered = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    const req = makeReq(`Bearer ${parts[0]}.${parts[1]}.${parts[2]}.${tampered}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
  });

  it("rejects token with tampered role", async () => {
    const token = generateGatewayToken("frank", SECRET, "user");
    const parts = token.split(".");
    // Tamper role from "user" to "admin" but keep original signature
    const tampered = `${parts[0]}.admin.${parts[2]}.${parts[3]}`;
    const req = makeReq(`Bearer ${tampered}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { message: string }).message).toMatch(/signature/i);
  });

  it("rejects a token with a tampered userId (payload mismatch)", async () => {
    const token = generateGatewayToken("frank", SECRET);
    const parts = token.split(".");
    // Change userId but keep original signature
    const req = makeReq(`Bearer hacker.${parts[1]}.${parts[2]}.${parts[3]}`);
    const reply = makeReply();

    await verifyToken(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
  });
});

describe("requireRole", () => {
  it("allows request with matching role", async () => {
    const req = { ...makeReq(), role: "admin" };
    const reply = makeReply();

    await requireRole("admin")(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it("allows request with one of multiple allowed roles", async () => {
    const req = { ...makeReq(), role: "user" };
    const reply = makeReply();

    await requireRole("admin", "user")(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it("blocks request with non-matching role with 403", async () => {
    const req = { ...makeReq(), role: "user" };
    const reply = makeReply();

    await requireRole("admin")(req as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe("Forbidden");
  });

  it("blocks request with undefined role with 403", async () => {
    const req = { ...makeReq(), role: undefined };
    const reply = makeReply();

    await requireRole("admin")(req as never, reply as never);

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe("Forbidden");
  });
});

describe("blockTokenInQueryParams", () => {
  const SUSPICIOUS_KEYS = ["token", "access_token", "auth", "api_key", "key", "authorization"];

  for (const key of SUSPICIOUS_KEYS) {
    it(`blocks requests with '${key}' in query params`, async () => {
      const req = makeReq(undefined, { [key]: "some-value" });
      const reply = makeReply();

      await blockTokenInQueryParams(req as never, reply as never);

      expect(reply.statusCode).toBe(400);
      expect((reply.body as { error: string }).error).toBe("bad_request");
    });
  }

  it("allows requests with harmless query params", async () => {
    const req = makeReq(undefined, { page: "1", limit: "20", search: "hello" });
    const reply = makeReply();

    await blockTokenInQueryParams(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeUndefined();
  });

  it("allows requests with no query params", async () => {
    const req = makeReq(undefined, {});
    const reply = makeReply();

    await blockTokenInQueryParams(req as never, reply as never);

    expect(reply.statusCode).toBe(200);
  });
});
