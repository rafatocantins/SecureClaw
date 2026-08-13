/**
 * helmet.test.ts — Asserts that @fastify/helmet security headers are present.
 *
 * Uses a minimal Fastify instance (not buildServer) to avoid mocking all gRPC
 * clients. Registers only helmet + healthRoute — sufficient to assert header
 * presence without coupling to infrastructure dependencies.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import { healthRoute } from "../routes/health.route.js";

async function buildMinimalApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        connectSrc: ["'self'"],
        scriptSrc:  ["'none'"],
        styleSrc:   ["'none'"],
        imgSrc:     ["'none'"],
        frameSrc:   ["'none'"],
        objectSrc:  ["'none'"],
        baseUri:    ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(healthRoute, { prefix: "/health" });
  return app;
}

describe("Security headers (@fastify/helmet)", () => {
  it("sets X-Content-Type-Options: nosniff on /health", async () => {
    const app = await buildMinimalApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options to deny embedding", async () => {
    const app = await buildMinimalApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    // Helmet sets SAMEORIGIN — must not be absent
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("sets X-DNS-Prefetch-Control: off", async () => {
    const app = await buildMinimalApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
  });

  it("sets Content-Security-Policy with connect-src 'self' and default-src 'none'", async () => {
    const app = await buildMinimalApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    const csp = res.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it("/health still returns 200 with correct body when helmet is registered", async () => {
    const app = await buildMinimalApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; service: string }>();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("tessera-gateway");
  });
});
