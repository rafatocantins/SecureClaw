/**
 * telemetry.test.ts — Gateway OTel span instrumentation tests.
 *
 * Strategy: use a minimal Fastify instance (not buildServer) to avoid
 * mocking all gRPC clients. Register only the OTel hooks manually,
 * then drive requests via app.inject().
 *
 * The @opentelemetry/api is mocked so no real OTLP endpoint is needed.
 * We assert that spans are created with the correct attributes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { registerOtelHooks } from "./telemetry.js";

// ── Span mock helpers ────────────────────────────────────────────────────────

function makeMockSpan() {
  const span = {
    attributes: {} as Record<string, unknown>,
    status: { code: SpanStatusCode.UNSET } as { code: SpanStatusCode; message?: string },
    ended: false,
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(span.attributes, attrs);
      return span;
    },
    setStatus(s: { code: SpanStatusCode; message?: string }) {
      span.status = s;
      return span;
    },
    end() {
      span.ended = true;
    },
  };
  return span;
}

type MockSpan = ReturnType<typeof makeMockSpan>;

// Track spans created by each call to startSpan
const spansCreated: Array<{ name: string; options: { kind?: SpanKind }; span: MockSpan }> = [];

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...original,
    trace: {
      getTracer: () => ({
        startSpan: (name: string, options: { kind?: SpanKind } = {}) => {
          const span = makeMockSpan();
          spansCreated.push({ name, options, span });
          return span;
        },
      }),
    },
  };
});

// ── Minimal Fastify app with OTel hooks ──────────────────────────────────────

function buildTracedApp() {
  const app = Fastify({ logger: false });

  // Use the real production hooks (imported from telemetry.ts)
  registerOtelHooks(app);

  // Register a simple test route
  app.get("/test", async (_req, reply) => {
    await reply.code(200).send({ ok: true });
  });

  // Route that errors
  app.get("/boom", async (_req, reply) => {
    await reply.code(500).send({ error: "internal" });
  });

  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Gateway OTel span instrumentation", () => {
  beforeEach(() => {
    spansCreated.length = 0;
  });

  afterEach(() => {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  });

  it("initTelemetry() is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set", async () => {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    // Import the real telemetry module (not mocked — we just call the function)
    const { initTelemetry } = await import("./telemetry.js");
    // Should not throw and should not attempt to load SDK
    expect(() => initTelemetry()).not.toThrow();
    // No SDK init means no spans fired from that path
    expect(spansCreated).toHaveLength(0);
  });

  it("creates a SERVER span for each HTTP request", async () => {
    const app = await buildTracedApp();
    await app.inject({ method: "GET", url: "/test" });

    expect(spansCreated).toHaveLength(1);
    expect(spansCreated[0]!.options.kind).toBe(SpanKind.SERVER);
  });

  it("span attributes include http.method, http.route, and http.status_code", async () => {
    const app = await buildTracedApp();
    await app.inject({ method: "GET", url: "/test" });

    const span = spansCreated[0]!.span;
    expect(span.attributes["http.method"]).toBe("GET");
    expect(span.attributes["http.status_code"]).toBe(200);
    // Route template is set (may be /test or unknown for 404s — this route is registered)
    expect(span.attributes["http.route"]).toBeDefined();
  });

  it("http.url attribute never includes query string (token leak prevention)", async () => {
    const app = await buildTracedApp();
    // Simulate a WS-style request with a ?token= query param
    await app.inject({ method: "GET", url: "/test?token=super-secret-token&other=value" });

    const span = spansCreated[0]!.span;
    const httpUrl = span.attributes["http.url"] as string;
    expect(httpUrl).toBe("/test");
    expect(httpUrl).not.toContain("token");
    expect(httpUrl).not.toContain("super-secret");
    expect(httpUrl).not.toContain("?");
  });

  it("spans for responses with status >= 500 are marked as ERROR", async () => {
    const app = await buildTracedApp();
    await app.inject({ method: "GET", url: "/boom" });

    const span = spansCreated[0]!.span;
    expect(span.attributes["http.status_code"]).toBe(500);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("spans for successful responses are not marked as ERROR", async () => {
    const app = await buildTracedApp();
    await app.inject({ method: "GET", url: "/test" });

    const span = spansCreated[0]!.span;
    expect(span.attributes["http.status_code"]).toBe(200);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("span is ended after response completes", async () => {
    const app = await buildTracedApp();
    await app.inject({ method: "GET", url: "/test" });

    const span = spansCreated[0]!.span;
    expect(span.ended).toBe(true);
  });
});
