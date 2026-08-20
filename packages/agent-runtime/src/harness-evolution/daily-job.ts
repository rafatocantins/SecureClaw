/**
 * daily-job.ts — Idempotent daily harness-evolution job with OTel tracing.
 *
 * Runs HarnessEvolutionService.evolve() inside a root span `HARNESS_EVOLUTION`
 * with attributes describing the evolution result. Enabled by the operator via
 * HARNESS_EVOLUTION_SCHEDULE=1 (see config.ts) — OFF by default.
 *
 * The service itself computes deterministic patch ids (see
 * computeDeterministicId in evolution-service.ts), so re-running this job over
 * the same sessions is idempotent: already-stored patches are skipped instead
 * of duplicated.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "../telemetry.js";
import type {
  HarnessEvolutionService,
  EvolutionResult,
} from "./evolution-service.js";

export async function runDailyEvolution(
  service: HarnessEvolutionService,
  limit = 50,
): Promise<EvolutionResult> {
  const tracer = getTracer();

  return tracer.startActiveSpan("HARNESS_EVOLUTION", async (span) => {
    try {
      const result = await service.evolve(limit);

      span.setAttributes({
        sessions_analyzed: result.sessionsAnalyzed,
        patches_generated: result.patchesGenerated,
        patches_applied: result.patchesApplied,
        patches_rejected: result.patchesRejected,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}
