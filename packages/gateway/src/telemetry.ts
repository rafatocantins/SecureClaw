/**
 * telemetry.ts — OpenTelemetry setup for the Tessera gateway.
 *
 * Zero overhead when OTEL_EXPORTER_OTLP_ENDPOINT is unset (no SDK init).
 * Exports to any OTLP-compatible backend (Jaeger, Grafana Tempo, Honeycomb, Datadog).
 *
 * Usage:
 *   import { initTelemetry, shutdownTelemetry, registerOtelHooks } from "./telemetry.js";
 *   initTelemetry(); // call once at startup
 *   registerOtelHooks(app); // call once after Fastify instance is created
 *   // Then use trace.getTracer("tessera-gateway", "0.1.0") anywhere in the process.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";

// Lazy import — only loaded when OTEL endpoint is configured
let sdk: import("@opentelemetry/sdk-node").NodeSDK | null = null;

export function initTelemetry(): void {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!endpoint) return; // no-op — zero overhead when not configured

  // Dynamic imports to avoid loading OTel SDKs when not needed
  import("@opentelemetry/sdk-node").then(({ NodeSDK }) =>
    import("@opentelemetry/exporter-trace-otlp-http").then(({ OTLPTraceExporter }) =>
      import("@opentelemetry/resources").then(({ Resource }) =>
        import("@opentelemetry/semantic-conventions").then(({ ATTR_SERVICE_NAME }) => {
          sdk = new NodeSDK({
            resource: new Resource({ [ATTR_SERVICE_NAME]: "tessera-gateway" }),
            traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
          });
          sdk.start();
          process.stdout.write(`[telemetry] OpenTelemetry exporting to ${endpoint}\n`);
        })
      )
    )
  ).catch((err: unknown) => {
    process.stderr.write(`[telemetry] Failed to initialize OTel: ${String(err)}\n`);
  });
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch {
      // Ignore shutdown errors
    }
  }
}

/**
 * registerOtelHooks — attach onRequest/onResponse Fastify hooks that create
 * a SERVER span for each HTTP request.
 *
 * SECURITY: http.url is set to the path only (never the full URL) —
 * the WS chat upgrade uses ?token= which must never appear in traces.
 *
 * Safe to call when the OTel SDK is not initialised — trace.getTracer()
 * returns a no-op tracer in that case.
 */
export function registerOtelHooks(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, _reply) => {
    const tracer = trace.getTracer("tessera-gateway", "0.1.0");
    // Use the route template (e.g. /api/v1/chat/:sessionId) not the actual URL
    // to keep cardinality low and prevent PII/token leakage from path params.
    const routeTemplate = req.routeOptions.url ?? req.url.split("?")[0];
    const span = tracer.startSpan(`HTTP ${req.method} ${routeTemplate}`, {
      kind: SpanKind.SERVER,
    });
    // Attach span to request for retrieval in onResponse
    (req as FastifyRequest & { _otelSpan?: Span })._otelSpan = span;
  });

  app.addHook("onResponse", async (req, reply) => {
    const span = (req as FastifyRequest & { _otelSpan?: Span })._otelSpan;
    if (!span) return;
    // SECURITY: path only — never include query string (?token= leak prevention)
    const pathOnly = req.url.split("?")[0];
    span.setAttributes({
      "http.method": req.method,
      "http.route": req.routeOptions.url ?? pathOnly,
      "http.status_code": reply.statusCode,
      "http.url": pathOnly,
    });
    if (reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  });
}
