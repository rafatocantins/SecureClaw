/**
 * memory.route.test.ts — Tests for GET /api/v1/memory/lessons.
 *
 * Security focus (T-4-02): user_id must come from the verified token,
 * never from query params — prevents cross-user lesson enumeration.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { setGatewaySecret, generateGatewayToken } from "../plugins/auth.plugin.js";
import { memoryRoute } from "./memory.route.js";
import type { MemoryRouteOptions } from "./memory.route.js";
import type { GrpcStoredLesson } from "@tessera/shared";

const SECRET = "test-memory-route-secret-xyz";

const SAMPLE_LESSONS: GrpcStoredLesson[] = [
  {
    id: 1,
    user_id: "user-a",
    source_session_id: "sess-1",
    lesson_text: "Always validate input before processing",
    category: "procedure",
    created_at: 1_700_000_000_000,
    access_count: 2,
  },
  {
    id: 2,
    user_id: "user-a",
    source_session_id: "sess-1",
    lesson_text: "User prefers concise responses",
    category: "preference",
    created_at: 1_700_000_001_000,
    access_count: 0,
  },
];

function makeMemoryClient(lessons: GrpcStoredLesson[] = SAMPLE_LESSONS): MemoryRouteOptions["memoryClient"] {
  return {
    listLessons: async (_userId: string, _limit: number) => lessons,
  } as unknown as MemoryRouteOptions["memoryClient"];
}

async function buildApp(opts: MemoryRouteOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyRateLimit, { max: 200, timeWindow: "1 minute" });
  await app.register(memoryRoute, { prefix: "/api/v1/memory", ...opts });
  return app;
}

describe("GET /api/v1/memory/lessons", () => {
  beforeEach(() => setGatewaySecret(SECRET));
  afterEach(() => setGatewaySecret(""));

  it("returns lessons for the authenticated user", async () => {
    const app = await buildApp({ memoryClient: makeMemoryClient() });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ lessons: GrpcStoredLesson[] }>();
    expect(body.lessons).toHaveLength(2);
    expect(body.lessons[0]?.lesson_text).toBe("Always validate input before processing");
  });

  it("T-4-02: ignores any user_id query param — uses token identity", async () => {
    let capturedUserId = "";
    const client = {
      listLessons: async (userId: string) => {
        capturedUserId = userId;
        return SAMPLE_LESSONS;
      },
    } as unknown as MemoryRouteOptions["memoryClient"];

    const app = await buildApp({ memoryClient: client });
    const token = generateGatewayToken("user-a", SECRET, "user");

    // Attacker tries to read lessons for user-b by passing user_id=user-b
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons?user_id=user-b&limit=10",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    // Must use the token's userId, not the query param
    expect(capturedUserId).toBe("user-a");
    expect(capturedUserId).not.toBe("user-b");
  });

  it("rejects request with no auth token — 401", async () => {
    const app = await buildApp({ memoryClient: makeMemoryClient() });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons",
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects tampered token — 401", async () => {
    const app = await buildApp({ memoryClient: makeMemoryClient() });
    const token = generateGatewayToken("user-a", SECRET, "user");
    const tampered = token.slice(0, -4) + "xxxx";

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons",
      headers: { authorization: `Bearer ${tampered}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("applies default limit of 20 when not specified", async () => {
    let capturedLimit = 0;
    const client = {
      listLessons: async (_userId: string, limit: number) => {
        capturedLimit = limit;
        return [];
      },
    } as unknown as MemoryRouteOptions["memoryClient"];

    const app = await buildApp({ memoryClient: client });
    const token = generateGatewayToken("user-a", SECRET, "user");

    await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(capturedLimit).toBe(20);
  });

  it("caps limit at 100 even if higher value requested", async () => {
    let capturedLimit = 0;
    const client = {
      listLessons: async (_userId: string, limit: number) => {
        capturedLimit = limit;
        return [];
      },
    } as unknown as MemoryRouteOptions["memoryClient"];

    const app = await buildApp({ memoryClient: client });
    const token = generateGatewayToken("user-a", SECRET, "user");

    await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons?limit=9999",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(capturedLimit).toBe(100);
  });

  it("returns empty lessons array when none stored", async () => {
    const app = await buildApp({ memoryClient: makeMemoryClient([]) });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ lessons: GrpcStoredLesson[] }>();
    expect(body.lessons).toHaveLength(0);
  });

  it("returns 502 when memory service is unavailable", async () => {
    const failingClient = {
      listLessons: async () => { throw new Error("gRPC connection refused"); },
    } as unknown as MemoryRouteOptions["memoryClient"];

    const app = await buildApp({ memoryClient: failingClient });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory/lessons",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("memory_service_unavailable");
  });
});
