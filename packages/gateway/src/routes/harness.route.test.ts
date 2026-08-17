/**
 * harness.route.test.ts — Tests for the Harness Self-Evolution REST routes.
 *
 * Security focus: every route requires HMAC auth (verifyToken preHandler).
 * The `apply` route delegates to HarnessEvolutionService.applyPatch() which
 * always re-validates against the 8 security invariants before applying.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { setGatewaySecret, generateGatewayToken } from "../plugins/auth.plugin.js";
import { harnessRoute } from "./harness.route.js";
import type { HarnessRouteOptions } from "./harness.route.js";

const SECRET = "test-harness-route-secret-xyz";

function makeAgentClient(
  overrides: Record<string, unknown> = {}
): HarnessRouteOptions["agentClient"] {
  return {
    listHarnessPatches: async () => [],
    runHarnessEvolution: async () => ({
      sessions_analyzed: 0,
      patches_generated: 0,
      patches_applied: 0,
      patches_rejected: 0,
      summary: [],
    }),
    applyHarnessPatch: async () => ({ id: "", applied: false, reason: "not found" }),
    ...overrides,
  } as unknown as HarnessRouteOptions["agentClient"];
}

async function buildApp(opts: HarnessRouteOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyRateLimit, { max: 200, timeWindow: "1 minute" });
  await app.register(harnessRoute, { prefix: "/api/v1/harness", ...opts });
  return app;
}

describe("Harness Self-Evolution routes", () => {
  beforeEach(() => setGatewaySecret(SECRET));
  afterEach(() => setGatewaySecret(""));

  it("GET /patches: returns stored patches", async () => {
    const agentClient = makeAgentClient({
      listHarnessPatches: async () => [
        {
          id: "p1",
          type: "system_instruction",
          target: "system-prompt",
          proposed_change: "add guard",
          confidence: 0.9,
          recommendation: "apply",
          applied: false,
          applied_at: 0,
        },
      ],
    });
    const app = await buildApp({ agentClient });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/harness/patches",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ patches: Array<{ id: string; proposed_change: string }> }>();
    expect(body.patches).toHaveLength(1);
    expect(body.patches[0]?.id).toBe("p1");
    expect(body.patches[0]?.proposed_change).toBe("add guard");
  });

  it("GET /patches: rejects request without auth token (401)", async () => {
    const app = await buildApp({ agentClient: makeAgentClient() });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/harness/patches",
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /analyze: runs evolution and returns summary", async () => {
    const agentClient = makeAgentClient({
      runHarnessEvolution: async () => ({
        sessions_analyzed: 2,
        patches_generated: 1,
        patches_applied: 0,
        patches_rejected: 1,
        summary: [
          { pattern_type: "tool_failure", total_occurrences: 3, affected_sessions: 1 },
        ],
      }),
    });
    const app = await buildApp({ agentClient });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/harness/analyze",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: { limit: 25 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      sessions_analyzed: number;
      summary: Array<{ pattern_type: string; total_occurrences: number }>;
    }>();
    expect(body.sessions_analyzed).toBe(2);
    expect(body.summary[0]?.pattern_type).toBe("tool_failure");
    expect(body.summary[0]?.total_occurrences).toBe(3);
  });

  it("POST /analyze: defaults limit to 50 when omitted", async () => {
    let capturedLimit = -1;
    const agentClient = makeAgentClient({
      runHarnessEvolution: async (limit: number) => {
        capturedLimit = limit;
        return {
          sessions_analyzed: 0,
          patches_generated: 0,
          patches_applied: 0,
          patches_rejected: 0,
          summary: [],
        };
      },
    });
    const app = await buildApp({ agentClient });
    const token = generateGatewayToken("user-a", SECRET, "user");

    await app.inject({
      method: "POST",
      url: "/api/v1/harness/analyze",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(capturedLimit).toBe(50);
  });

  it("POST /apply/:id: applies patch through the security gate", async () => {
    const agentClient = makeAgentClient({
      applyHarnessPatch: async (id: string) => ({ id, applied: true, reason: "ok" }),
    });
    const app = await buildApp({ agentClient });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/harness/apply/patch-1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; applied: boolean }>();
    expect(body.applied).toBe(true);
    expect(body.id).toBe("patch-1");
  });

  it("POST /apply/:id: returns 502 when agent is unavailable", async () => {
    const agentClient = makeAgentClient({
      applyHarnessPatch: async () => {
        throw new Error("gRPC connection refused");
      },
    });
    const app = await buildApp({ agentClient });
    const token = generateGatewayToken("user-a", SECRET, "user");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/harness/apply/patch-1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("agent_unavailable");
  });

  it("POST /apply/:id: rejects request without auth token (401)", async () => {
    const app = await buildApp({ agentClient: makeAgentClient() });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/harness/apply/patch-1",
    });

    expect(res.statusCode).toBe(401);
  });
});
