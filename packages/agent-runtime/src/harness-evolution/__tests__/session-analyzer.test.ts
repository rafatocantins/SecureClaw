/**
 * session-analyzer.test.ts — Unit tests for Harness Session Analyzer.
 *
 * Covers all 4 detectors individually, the SessionAnalyzer.analyze() aggregation,
 * getPatternSummary(), empty sessions, and sessions with no problems.
 */

import { describe, it, expect, vi } from "vitest";
import type { AuditService, AuditEvent, AuditSession } from "../types.js";
import { SessionAnalyzer } from "../session-analyzer.js";
import {
  detectToolFailures,
  detectLoops,
  detectInjectionPatterns,
  detectApprovalBottlenecks,
} from "../pattern-detectors.js";
import type { FailurePattern } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    timestamp: overrides.timestamp ?? new Date("2025-01-01T00:00:00Z"),
    eventType: overrides.eventType ?? "tool_call",
    toolName: overrides.toolName,
    success: overrides.success,
    error: overrides.error,
    details: overrides.details,
  };
}

function makeSession(overrides: Partial<AuditSession> = {}): AuditSession {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    startTime: overrides.startTime ?? new Date("2025-01-01T00:00:00Z"),
    modelId: overrides.modelId ?? "deepseek-v4",
    status: overrides.status ?? "completed",
    endTime: overrides.endTime,
  };
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

function expectFailurePattern(
  pattern: FailurePattern,
  expectedType: FailurePattern["type"],
  expectedSessionId: string,
  expectedMinFrequency: number,
): void {
  expect(pattern.type).toBe(expectedType);
  expect(pattern.sessionId).toBe(expectedSessionId);
  expect(pattern.frequency).toBeGreaterThanOrEqual(expectedMinFrequency);
  expect(pattern.evidence.length).toBeGreaterThanOrEqual(expectedMinFrequency);
  expect(pattern.firstSeen).toBeInstanceOf(Date);
  expect(pattern.lastSeen).toBeInstanceOf(Date);
}

// ── Test Suite ─────────────────────────────────────────────────────────────

// ── 1. detectToolFailures ──────────────────────────────────────────────────

describe("detectToolFailures", () => {
  it("returns empty array when there are no failures", () => {
    const events = [
      makeEvent({ toolName: "file_read", success: true }),
      makeEvent({ toolName: "shell_exec", success: true }),
    ];
    expect(detectToolFailures(events)).toEqual([]);
  });

  it("groups failed tool calls by tool name", () => {
    const events = [
      makeEvent({ toolName: "shell_exec", success: false, error: "EACCES" }),
      makeEvent({ toolName: "shell_exec", success: false, error: "ENOMEM" }),
      makeEvent({ toolName: "file_read", success: false, error: "ENOENT" }),
    ];
    const patterns = detectToolFailures(events);
    expect(patterns).toHaveLength(2);

    const shell = patterns.find((p) =>
      p.evidence.some((e) => e.startsWith("shell_exec")),
    );
    expect(shell).toBeDefined();
    expect(shell!.frequency).toBe(2);

    const file = patterns.find((p) =>
      p.evidence.some((e) => e.startsWith("file_read")),
    );
    expect(file).toBeDefined();
    expect(file!.frequency).toBe(1);
  });

  it("ignores non-tool_call events", () => {
    const events = [
      makeEvent({ eventType: "message", success: false }),
      makeEvent({ eventType: "tool_call", toolName: "shell_exec", success: false, error: "fail" }),
    ];
    const patterns = detectToolFailures(events);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe("tool_failure");
  });
});

// ── 2. detectLoops ─────────────────────────────────────────────────────────

describe("detectLoops", () => {
  it("returns empty for fewer than 3 tool events", () => {
    const events = [
      makeEvent({ toolName: "http_request" }),
      makeEvent({ toolName: "http_request" }),
    ];
    expect(detectLoops(events)).toEqual([]);
  });

  it("detects 3 consecutive identical tool calls", () => {
    const events = [
      makeEvent({ timestamp: new Date("2025-01-01T00:00:01Z"), toolName: "http_request" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:02Z"), toolName: "http_request" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:03Z"), toolName: "http_request" }),
    ];
    const patterns = detectLoops(events);
    expect(patterns).toHaveLength(1);
    expectFailurePattern(patterns[0], "loop_detected", "sess-1", 3);
  });

  it("detects loop of 5 identical calls with a different call in between", () => {
    const events = [
      makeEvent({ timestamp: new Date("2025-01-01T00:00:01Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:02Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:03Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:04Z"), toolName: "file_read" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:05Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:06Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:07Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:08Z"), toolName: "shell_exec" }),
      makeEvent({ timestamp: new Date("2025-01-01T00:00:09Z"), toolName: "shell_exec" }),
    ];
    const patterns = detectLoops(events);
    expect(patterns).toHaveLength(2); // first run of 3, second run of 5

    const secondLoop = patterns.find((p) => p.frequency === 5);
    expect(secondLoop).toBeDefined();
    expect(secondLoop!.type).toBe("loop_detected");
  });
});

// ── 3. detectInjectionPatterns ─────────────────────────────────────────────

describe("detectInjectionPatterns", () => {
  it("returns empty when no injection events exist", () => {
    const events = [
      makeEvent({ eventType: "tool_call", toolName: "shell_exec" }),
      makeEvent({ eventType: "message" }),
    ];
    expect(detectInjectionPatterns(events)).toEqual([]);
  });

  it("detects events with 'injection' in eventType (case-insensitive)", () => {
    const events = [
      makeEvent({ eventType: "prompt_injection_detected", details: { message: "suspicious input" } }),
      makeEvent({ eventType: "INJECTION_ALERT", details: { message: "malicious pattern" } }),
      makeEvent({ eventType: "response_injection_detected", details: { message: "data leak" } }),
    ];
    const patterns = detectInjectionPatterns(events);
    expect(patterns).toHaveLength(1); // all same session
    expectFailurePattern(patterns[0], "injection_detected", "sess-1", 3);
  });
});

// ── 4. detectApprovalBottlenecks ───────────────────────────────────────────

describe("detectApprovalBottlenecks", () => {
  it("returns empty for non-approval events", () => {
    const events = [
      makeEvent({ eventType: "tool_call", toolName: "file_write" }),
    ];
    expect(detectApprovalBottlenecks(events)).toEqual([]);
  });

  it("detects approval_required and approval_pending events", () => {
    const events = [
      makeEvent({ eventType: "approval_required", toolName: "file_write" }),
      makeEvent({ eventType: "approval_pending", toolName: "shell_exec" }),
    ];
    const patterns = detectApprovalBottlenecks(events);
    expect(patterns).toHaveLength(1); // same session
    expectFailurePattern(patterns[0], "approval_bottleneck", "sess-1", 2);
  });

  it("groups by session", () => {
    const events = [
      makeEvent({ sessionId: "sess-1", eventType: "approval_required", toolName: "file_write" }),
      makeEvent({ sessionId: "sess-2", eventType: "approval_pending", toolName: "shell_exec" }),
    ];
    const patterns = detectApprovalBottlenecks(events);
    expect(patterns).toHaveLength(2);

    const sess1 = patterns.find((p) => p.sessionId === "sess-1");
    const sess2 = patterns.find((p) => p.sessionId === "sess-2");
    expect(sess1).toBeDefined();
    expect(sess2).toBeDefined();
    expect(sess1!.frequency).toBe(1);
    expect(sess2!.frequency).toBe(1);
  });
});

// ── 5. SessionAnalyzer.analyze() ───────────────────────────────────────────

describe("SessionAnalyzer.analyze()", () => {
  it("returns empty array when there are no sessions", async () => {
    const svc = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(svc);
    const result = await analyzer.analyze(10);
    expect(result).toEqual([]);
    expect(svc.getRecentSessions).toHaveBeenCalledWith(10);
  });

  it("aggregates patterns from multiple sessions", async () => {
    const eventsSess1 = [
      makeEvent({ sessionId: "sess-1", toolName: "shell_exec", success: false, error: "EACCES" }),
      makeEvent({ sessionId: "sess-1", toolName: "shell_exec", success: false, error: "EACCES" }),
    ];
    const eventsSess2 = [
      makeEvent({ sessionId: "sess-2", eventType: "approval_required", toolName: "file_write" }),
      makeEvent({ sessionId: "sess-2", eventType: "approval_required", toolName: "shell_exec" }),
      makeEvent({ sessionId: "sess-2", eventType: "approval_required", toolName: "http_request" }),
    ];

    const sessions = [
      makeSession({ sessionId: "sess-1" }),
      makeSession({ sessionId: "sess-2" }),
    ];

    const eventsMap = new Map<string, AuditEvent[]>();
    eventsMap.set("sess-1", eventsSess1);
    eventsMap.set("sess-2", eventsSess2);

    const svc = mockAuditService(sessions, eventsMap);
    const analyzer = new SessionAnalyzer(svc);
    const result = await analyzer.analyze();

    expect(result).toHaveLength(2);

    const sess1Result = result.find((r) => r.sessionId === "sess-1")!;
    expect(sess1Result.patterns).toHaveLength(1);
    expect(sess1Result.patterns[0].type).toBe("tool_failure");
    expect(sess1Result.sessionCount).toBe(2);

    const sess2Result = result.find((r) => r.sessionId === "sess-2")!;
    expect(sess2Result.patterns).toHaveLength(1);
    expect(sess2Result.patterns[0].type).toBe("approval_bottleneck");
    expect(sess2Result.sessionCount).toBe(2);
  });

  it("returns sessions with empty patterns when there are no problems", async () => {
    const events = [
      makeEvent({ toolName: "file_read", success: true }),
      makeEvent({ toolName: "http_request", success: true }),
    ];
    const sessions = [makeSession({ sessionId: "sess-1" })];
    const eventsMap = new Map<string, AuditEvent[]>();
    eventsMap.set("sess-1", events);

    const svc = mockAuditService(sessions, eventsMap);
    const analyzer = new SessionAnalyzer(svc);
    const result = await analyzer.analyze();

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("sess-1");
    expect(result[0].patterns).toEqual([]);
  });
});

// ── 6. getPatternSummary ───────────────────────────────────────────────────

describe("getPatternSummary", () => {
  it("summarizes patterns across analyses by type", () => {
    const analyzer = new SessionAnalyzer(
      mockAuditService([], new Map()),
    );

    const analyses = [
      {
        sessionId: "sess-1",
        patterns: [
          {
            type: "tool_failure" as const,
            sessionId: "sess-1",
            frequency: 3,
            evidence: ["a", "b", "c"],
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
          {
            type: "loop_detected" as const,
            sessionId: "sess-1",
            frequency: 4,
            evidence: ["d", "e", "f", "g"],
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
        ],
        analyzedAt: new Date(),
        sessionCount: 2,
      },
      {
        sessionId: "sess-2",
        patterns: [
          {
            type: "tool_failure" as const,
            sessionId: "sess-2",
            frequency: 1,
            evidence: ["h"],
            firstSeen: new Date(),
            lastSeen: new Date(),
          },
        ],
        analyzedAt: new Date(),
        sessionCount: 2,
      },
    ];

    const summary = analyzer.getPatternSummary(analyses);
    expect(summary).toHaveLength(2);

    // Sorted by occurrences desc: tool_failure (4) first, loop_detected (4) second
    const tf = summary.find((s) => s.patternType === "tool_failure")!;
    expect(tf.totalOccurrences).toBe(4);
    expect(tf.affectedSessions).toBe(2);

    const ld = summary.find((s) => s.patternType === "loop_detected")!;
    expect(ld.totalOccurrences).toBe(4);
    expect(ld.affectedSessions).toBe(1);
  });
});
