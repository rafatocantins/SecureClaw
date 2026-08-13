/**
 * token.route.test.ts — Tests for GET /token/config and POST /token/refresh.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { setGatewaySecret, generateGatewayToken } from "../plugins/auth.plugin.js";
import { tokenRoute } from "./token.route.js";

const SECRET = "test-route-secret-abc123";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Rate limiting is required by tokenRoute (config.rateLimit)
  await app.register(fastifyRateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(tokenRoute, { prefix: "/api/v1/token" });
  return app;
}

describe("GET /api/v1/token/config", () => {
  afterEach(() => {
    delete process.env["TOKEN_EXPIRY_SECONDS"];
  });

  it("returns default expiry_seconds of 300", async () => {
    delete process.env["TOKEN_EXPIRY_SECONDS"];
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/token/config" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ expiry_seconds: number }>();
    expect(body.expiry_seconds).toBe(300);
  });

  it("reflects TOKEN_EXPIRY_SECONDS env var", async () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "3600";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/token/config" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ expiry_seconds: number }>();
    expect(body.expiry_seconds).toBe(3600);
  });

  it("requires no auth header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/token/config" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/v1/token/refresh", () => {
  beforeEach(() => setGatewaySecret(SECRET));
  afterEach(() => {
    setGatewaySecret("");
    delete process.env["TOKEN_EXPIRY_SECONDS"];
  });

  it("returns a fresh token for a valid current token", async () => {
    const app = await buildApp();
    const token = generateGatewayToken("refresh-user", SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; expires_in_seconds: number }>();
    expect(typeof body.token).toBe("string");
    expect(body.token.startsWith("refresh-user.")).toBe(true);
    expect(body.token.split(".")).toHaveLength(4);
    expect(body.expires_in_seconds).toBe(300);
  });

  it("refreshed token preserves admin role", async () => {
    const app = await buildApp();
    const token = generateGatewayToken("admin-user", SECRET, "admin");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string }>();
    const parts = body.token.split(".");
    expect(parts[1]).toBe("admin");
  });

  it("refreshed token preserves user role", async () => {
    const app = await buildApp();
    const token = generateGatewayToken("regular-user", SECRET, "user");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string }>();
    const parts = body.token.split(".");
    expect(parts[1]).toBe("user");
  });

  it("returns expires_in_seconds matching TOKEN_EXPIRY_SECONDS", async () => {
    process.env["TOKEN_EXPIRY_SECONDS"] = "1800";
    const app = await buildApp();
    const token = generateGatewayToken("hi", SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ expires_in_seconds: number }>();
    expect(body.expires_in_seconds).toBe(1800);
  });

  it("rejects refresh with no Authorization header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/token/refresh" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects refresh with an invalid token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returned token is itself valid for verification", async () => {
    const app = await buildApp();
    const token = generateGatewayToken("verify-me", SECRET);

    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(refreshRes.statusCode).toBe(200);

    const { token: newToken } = refreshRes.json<{ token: string }>();

    // Use the new token to call /config (an authenticated route) — should succeed
    const configRes = await app.inject({
      method: "POST",
      url: "/api/v1/token/refresh",
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(configRes.statusCode).toBe(200);
  });
});
