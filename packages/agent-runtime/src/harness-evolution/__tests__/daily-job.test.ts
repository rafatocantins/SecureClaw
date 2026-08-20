/**
 * daily-job.test.ts — Unit tests for runDailyEvolution (daily job wrapper).
 *
 * Covers:
 *  1. Idempotency: running the job 3× produces 0 duplicate patch IDs and a
 *     stable patch count.
 *  2. OTel spans: HARNESS_EVOLUTION root span + the 3 sub-spans are emitted.
 *  3. Error propagation: analyzer failures are rethrown while the root span
 *     is still ended (and the exception recorded).
 *
 * @opentelemetry/api is mocked via vi.mock("../../telemetry.js") because OTel
 * is external I/O — no real exporter should be hit during tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { AuditService, AuditSession, AuditEvent } from "../types.js";
import { SessionAnalyzer } from "../session-analyzer.js";
import { HarnessPatchGenerator } from "../patch-generator.js";
import { HarnessEvolutionService } from "../evolution-service.js";
import { runDailyEvolution } from "../daily-job.js";
import type { AuditGrpcClient } from "../../grpc/clients/audit.client.js";

// ── OTel mocks (external I/O — vi.mock is allowed here) ──────────────────────

const mocks = vi.hoisted(() => ({
  startActiveSpan: vi.fn(),
  spanEnd: vi.fn(),
  spanRecordException: vi.fn(),
  spanSetStatus: vi.fn(),
  spanSetAttributes: vi.fn(),
}));

vi.mock("../../telemetry.js", () => ({
  getTracer: () => ({
    startActiveSpan: mocks.startActiveSpan,
  }),
}));

// ── Helpers (mirrors evolution-service.test.ts) ─────────────────────────────

function makeSession(overrides: Partial<AuditSession> = {}): AuditSession {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    startTime: overrides.startTime ?? new Date("2025-01-01T00:00:00Z"),
    modelId: overrides.modelId ?? "deepseek-v4",
    status: overrides.status ?? "completed",
    endTime: overrides.endTime,
  };
}

function makeToolFailureEvent(sessionId = "sess-1", count = 5): AuditEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId,
    timestamp: new Date(2025, 0, 1, i, 0, 0),
    eventType: "tool_call",
    toolName: "shell_exec",
    success: false,
    error: `Tool execution failed: exit code 1 (attempt ${i + 1})`,
    details: { tool_name: "shell_exec", exit_code: 1 },
  }));
}

function mockAuditService(
  sessions: AuditSession[],
  eventsBySession: Map<string, AuditEvent[]>,
): AuditService {
  return {
    getRecentSessions: vi.fn().mockResolvedValue(sessions),
    getSessionEvents: vi
      .fn()
      .mockImplementation((sessionId: string) =>
        Promise.resolve(eventsBySession.get(sessionId) ?? []),
      ),
  };
}

function mockAuditGrpcClient(): AuditGrpcClient {
  return {
    logEvent: vi.fn(),
  } as unknown as AuditGrpcClient;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runDailyEvolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startActiveSpan.mockImplementation(
      (name: string, fn: (span: unknown) => unknown) => {
        const span = {
          end: mocks.spanEnd,
          recordException: mocks.spanRecordException,
          setStatus: mocks.spanSetStatus,
          setAttributes: mocks.spanSetAttributes,
        };
        return fn(span);
      },
    );
  });

  it("is idempotent across 3 runs (0 duplicate patch IDs)", async () => {
    const session = makeSession({ sessionId: "sess-1" });
    const events = makeToolFailureEvent("sess-1", 8);
    const auditService = mockAuditService(
      [session],
      new Map([["sess-1", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    await runDailyEvolution(service);
    const countAfterFirst = service.getStoredPatches().length;
    await runDailyEvolution(service);
    const countAfterSecond = service.getStoredPatches().length;
    await runDailyEvolution(service);
    const countAfterThird = service.getStoredPatches().length;

    const ids = service.getStoredPatches().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // 0 duplicate ids
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(countAfterThird).toBe(countAfterFirst);
  });

  it("emits HARNESS_EVOLUTION root span and 3 sub-spans", async () => {
    const session = makeSession({ sessionId: "sess-1" });
    const events = makeToolFailureEvent("sess-1", 8);
    const auditService = mockAuditService(
      [session],
      new Map([["sess-1", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    await runDailyEvolution(service);

    const spanNames = mocks.startActiveSpan.mock.calls.map((c) => c[0]);
    expect(spanNames).toContain("HARNESS_EVOLUTION");
    expect(spanNames).toContain("harness_evolution.analyze");
    expect(spanNames).toContain("harness_evolution.generate");
    expect(spanNames).toContain("harness_evolution.validate_persist");
    expect(mocks.spanEnd).toHaveBeenCalled();
  });

  it("rethrows analyzer errors and still ends the span", async () => {
    const auditService: AuditService = {
      getRecentSessions: vi.fn().mockRejectedValue(new Error("analyze boom")),
      getSessionEvents: vi.fn().mockResolvedValue([]),
    };
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    await expect(runDailyEvolution(service)).rejects.toThrow("analyze boom");

    expect(mocks.spanEnd).toHaveBeenCalled();
    expect(mocks.spanRecordException).toHaveBeenCalled();
    expect(mocks.spanSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
  });
});
