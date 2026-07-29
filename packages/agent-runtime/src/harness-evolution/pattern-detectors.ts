/**
 * Pattern Detectors — Individual failure-pattern detection functions.
 *
 * Each detector takes an array of AuditEvents and returns
 * zero or more FailurePattern objects.
 */

import type { AuditEvent, FailurePattern } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makePattern(
  type: FailurePattern["type"],
  sessionId: string,
  frequency: number,
  evidence: string[],
  firstSeen: Date,
  lastSeen: Date,
): FailurePattern {
  return { type, sessionId, frequency, evidence, firstSeen, lastSeen };
}

// ── Detectors ──────────────────────────────────────────────────────────────

/**
 * Groups failed tool calls into FailurePatterns, one per tool name.
 */
export function detectToolFailures(events: AuditEvent[]): FailurePattern[] {
  const failures = events.filter(
    (e) => e.eventType === "tool_call" && e.success === false,
  );

  if (failures.length === 0) return [];

  // Group by toolName
  const byTool = new Map<
    string,
    { events: AuditEvent[]; sessionId: string }
  >();

  for (const ev of failures) {
    const key = ev.toolName ?? "unknown";
    if (!byTool.has(key)) {
      byTool.set(key, { events: [], sessionId: ev.sessionId });
    }
    byTool.get(key)!.events.push(ev);
  }

  const patterns: FailurePattern[] = [];

  for (const [toolName, group] of byTool) {
    const times = group.events.map((e) => e.timestamp);
    times.sort((a, b) => a.getTime() - b.getTime());

    const first = times[0]!;
    const last = times[times.length - 1]!;

    patterns.push(
      makePattern(
        "tool_failure",
        group.sessionId,
        group.events.length,
        group.events.map(
          (e) => `${toolName}: ${e.error ?? "unknown error"} at ${e.timestamp.toISOString()}`,
        ),
        first,
        last,
      ),
    );
  }

  return patterns;
}

/**
 * Detects ≥3 identical consecutive tool calls (loops).
 *
 * Uses a state-machine approach: emit patterns only when a run ends
 * (tool name changes) or when the array ends.
 */
export function detectLoops(events: AuditEvent[]): FailurePattern[] {
  const toolEvents = events.filter((e) => e.eventType === "tool_call");

  if (toolEvents.length < 3) return [];

  const patterns: FailurePattern[] = [];

  function emitRun(start: number, end: number, tool: string, count: number): void {
    if (count < 3) return;
    const startEv = toolEvents[start]!;
    const endEv = toolEvents[end]!;
    const runEvents = toolEvents.slice(start, end + 1);
    patterns.push(
      makePattern(
        "loop_detected",
        startEv.sessionId,
        count,
        runEvents.map((e) => `${e.toolName ?? "unknown"} at ${e.timestamp.toISOString()}`),
        startEv.timestamp,
        endEv.timestamp,
      ),
    );
  }

  let runStart = 0;
  let runCount = 1;
  let currentTool = toolEvents[0]!.toolName ?? "unknown";

  for (let i = 1; i < toolEvents.length; i++) {
    const name = toolEvents[i]!.toolName ?? "unknown";

    if (name === currentTool) {
      runCount++;
    } else {
      // Run ended — emit if ≥3
      emitRun(runStart, i - 1, currentTool, runCount);
      currentTool = name;
      runCount = 1;
      runStart = i;
    }
  }

  // Emit final run if ≥3
  emitRun(runStart, toolEvents.length - 1, currentTool, runCount);

  return patterns;
}

/**
 * Detects events whose eventType contains 'injection' (case-insensitive).
 */
export function detectInjectionPatterns(events: AuditEvent[]): FailurePattern[] {
  const injections = events.filter((e) =>
    e.eventType.toLowerCase().includes("injection"),
  );

  if (injections.length === 0) return [];

  // Group by sessionId
  const bySession = new Map<string, AuditEvent[]>();
  for (const ev of injections) {
    if (!bySession.has(ev.sessionId)) {
      bySession.set(ev.sessionId, []);
    }
    bySession.get(ev.sessionId)!.push(ev);
  }

  const patterns: FailurePattern[] = [];

  for (const [sessionId, sessEvents] of bySession) {
    const times = sessEvents.map((e) => e.timestamp);
    times.sort((a, b) => a.getTime() - b.getTime());

    const first = times[0]!;
    const last = times[times.length - 1]!;

    patterns.push(
      makePattern(
        "injection_detected",
        sessionId,
        sessEvents.length,
        sessEvents.map(
          (e) => {
            const detailMsg =
              e.details && typeof e.details === "object" && "message" in e.details
                ? String((e.details as Record<string, unknown>)["message"])
                : "no details";
            return `${e.eventType}: ${detailMsg} at ${e.timestamp.toISOString()}`;
          },
        ),
        first,
        last,
      ),
    );
  }

  return patterns;
}

/**
 * Detects events with 'approval_required' or 'approval_pending' in eventType.
 */
export function detectApprovalBottlenecks(events: AuditEvent[]): FailurePattern[] {
  const approvalEvents = events.filter(
    (e) =>
      e.eventType === "approval_required" ||
      e.eventType === "approval_pending",
  );

  if (approvalEvents.length === 0) return [];

  // Group by sessionId
  const bySession = new Map<string, AuditEvent[]>();
  for (const ev of approvalEvents) {
    if (!bySession.has(ev.sessionId)) {
      bySession.set(ev.sessionId, []);
    }
    bySession.get(ev.sessionId)!.push(ev);
  }

  const patterns: FailurePattern[] = [];

  for (const [sessionId, sessEvents] of bySession) {
    const times = sessEvents.map((e) => e.timestamp);
    times.sort((a, b) => a.getTime() - b.getTime());

    const first = times[0]!;
    const last = times[times.length - 1]!;

    patterns.push(
      makePattern(
        "approval_bottleneck",
        sessionId,
        sessEvents.length,
        sessEvents.map(
          (e) =>
            `${e.eventType}: tool=${e.toolName ?? "unknown"} at ${e.timestamp.toISOString()}`,
        ),
        first,
        last,
      ),
    );
  }

  return patterns;
}
