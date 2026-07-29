/**
 * patch-generator.test.ts — Unit tests for HarnessPatchGenerator.
 *
 * Covers:
 *  1. Patch generation for all 4 failure-pattern types
 *  2. Low confidence for low-frequency patterns (< 3 occurrences)
 *  3. High confidence for high-frequency patterns (> 10 occurrences)
 *  4. Unique patch IDs
 *  5. generatePatchesWithConfidence returns confidence per patch
 *  6. Empty analyses → empty patches
 */

import { describe, it, expect } from "vitest";
import {
  HarnessPatchGenerator,
  aggregatePatterns,
  calculateConfidence,
} from "../patch-generator.js";
import type {
  SessionAnalysis,
  FailurePattern,
} from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makePattern(
  overrides: Partial<FailurePattern> & { type: FailurePattern["type"] },
): FailurePattern {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    frequency: overrides.frequency ?? 1,
    evidence: overrides.evidence ?? ["ev1"],
    firstSeen: overrides.firstSeen ?? new Date("2025-06-01T00:00:00Z"),
    lastSeen: overrides.lastSeen ?? new Date("2025-06-15T00:00:00Z"),
    type: overrides.type,
  };
}

function makeAnalysis(
  sessionId: string,
  patterns: FailurePattern[],
  sessionCount = 3,
): SessionAnalysis {
  return {
    sessionId,
    patterns,
    analyzedAt: new Date(),
    sessionCount,
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────────

describe("HarnessPatchGenerator", () => {
  const generator = new HarnessPatchGenerator();

  // ── 1. Generates patches for all 4 pattern types ─────────────────────────

  it("generatePatches: produces one patch per unique pattern type", () => {
    const analyses = [
      makeAnalysis("sess-1", [
        makePattern({ type: "tool_failure", frequency: 5 }),
        makePattern({ type: "loop_detected", frequency: 4 }),
      ]),
      makeAnalysis("sess-2", [
        makePattern({ type: "injection_detected", frequency: 2 }),
        makePattern({ type: "approval_bottleneck", frequency: 3 }),
      ]),
    ];

    const patches = generator.generatePatches(analyses);
    expect(patches).toHaveLength(4);

    const types = patches.map((p) => p.type);
    expect(types).toContain("tool_rule"); // for tool_failure
    expect(types).toContain("system_instruction"); // for loop_detected
    expect(types).toContain("prompt_update"); // for injection_detected
    expect(types).toContain("tool_rule"); // for approval_bottleneck

    const sourceTypes = patches.flatMap((p) => p.sourcePatterns);
    expect(sourceTypes).toContain("tool_failure");
    expect(sourceTypes).toContain("loop_detected");
    expect(sourceTypes).toContain("injection_detected");
    expect(sourceTypes).toContain("approval_bottleneck");
  });

  // ── 2. Low confidence for low frequency (< 3 occurrences) ────────────────

  it("calculateConfidence: low score when totalFrequency < 3", () => {
    const stats = {
      totalFrequency: 2,
      affectedSessions: 1,
      lastSeen: new Date("2025-01-15T00:00:00Z"), // old → low recency
    };

    const confidence = calculateConfidence(stats, 10);
    expect(confidence.score).toBeLessThan(0.3);
    expect(confidence.recommendation).toBe("reject");
    expect(confidence.factors.frequencyScore).toBeLessThan(0.2);
  });

  // ── 3. High confidence for high frequency (> 10 occurrences) ─────────────

  it("calculateConfidence: high score when totalFrequency > 10 and recent", () => {
    const stats = {
      totalFrequency: 15,
      affectedSessions: 8,
      lastSeen: new Date(), // very recent
    };

    const confidence = calculateConfidence(stats, 10);
    expect(confidence.score).toBeGreaterThan(0.7);
    expect(confidence.recommendation).toBe("apply");
    expect(confidence.factors.frequencyScore).toBe(1);
  });

  // ── 4. Unique patch IDs ──────────────────────────────────────────────────

  it("generatePatches: all patch IDs are unique", () => {
    const analyses = [
      makeAnalysis("sess-1", [
        makePattern({ type: "tool_failure", frequency: 5 }),
        makePattern({ type: "loop_detected", frequency: 4 }),
      ]),
      makeAnalysis("sess-2", [
        makePattern({ type: "injection_detected", frequency: 2 }),
        makePattern({ type: "approval_bottleneck", frequency: 3 }),
      ]),
    ];

    const patches = generator.generatePatches(analyses);
    const ids = patches.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  // ── 5. generatePatchesWithConfidence returns confidence per patch ────────

  it("generatePatchesWithConfidence: returns confidence for each patch", () => {
    const now = new Date();
    const analyses = [
      makeAnalysis("sess-1", [
        makePattern({
          type: "tool_failure",
          frequency: 12,
          lastSeen: now,
          firstSeen: now,
        }),
        makePattern({
          type: "loop_detected",
          frequency: 1,
          lastSeen: new Date("2025-01-15T00:00:00Z"),
          firstSeen: new Date("2025-01-15T00:00:00Z"),
        }),
      ]),
    ];

    const results = generator.generatePatchesWithConfidence(analyses);
    expect(results).toHaveLength(2);

    for (const entry of results) {
      expect(entry.patch).toBeDefined();
      expect(entry.patch.id).toBeTruthy();
      expect(entry.patch.type).toBeTruthy();
      expect(entry.confidence).toBeDefined();
      expect(entry.confidence.score).toBeGreaterThanOrEqual(0);
      expect(entry.confidence.score).toBeLessThanOrEqual(1);
      expect(["apply", "review", "reject"]).toContain(
        entry.confidence.recommendation,
      );
      expect(entry.confidence.factors).toBeDefined();
      expect(Object.keys(entry.confidence.factors).length).toBeGreaterThan(0);
    }

    // High-frequency tool_failure should have high confidence
    const toolFailureResult = results.find(
      (r) => r.patch.sourcePatterns[0] === "tool_failure",
    );
    expect(toolFailureResult).toBeDefined();
    expect(toolFailureResult!.confidence.recommendation).toBe("apply");

    // Low-frequency loop_detected should have low confidence
    const loopResult = results.find(
      (r) => r.patch.sourcePatterns[0] === "loop_detected",
    );
    expect(loopResult).toBeDefined();
    expect(loopResult!.confidence.recommendation).toBe("reject");
  });

  // ── 6. Empty array of analyses → empty array of patches ─────────────────

  it("generatePatches: returns empty array for empty analyses", () => {
    expect(generator.generatePatches([])).toEqual([]);
  });

  it("generatePatchesWithConfidence: returns empty array for empty analyses", () => {
    expect(generator.generatePatchesWithConfidence([])).toEqual([]);
  });
});

// ── aggregatePatterns unit tests ──────────────────────────────────────────

describe("aggregatePatterns", () => {
  it("merges patterns of the same type across sessions", () => {
    const analyses = [
      makeAnalysis("sess-1", [
        makePattern({ type: "tool_failure", frequency: 3, sessionId: "sess-1" }),
      ]),
      makeAnalysis("sess-2", [
        makePattern({ type: "tool_failure", frequency: 2, sessionId: "sess-2" }),
      ]),
    ];

    const result = aggregatePatterns(analyses);
    const stats = result.get("tool_failure");
    expect(stats).toBeDefined();
    expect(stats!.totalFrequency).toBe(5);
    expect(stats!.affectedSessions).toBe(2);
  });

  it("returns empty map for empty analyses", () => {
    const result = aggregatePatterns([]);
    expect(result.size).toBe(0);
  });
});

// ── calculateConfidence edge cases ────────────────────────────────────────

describe("calculateConfidence", () => {
  it("mid-range score (0.3–0.7) → recommendation 'review'", () => {
    const stats = {
      totalFrequency: 7,
      affectedSessions: 4,
      lastSeen: new Date(Date.now() - 48 * 60 * 60 * 1000), // 2 days ago
    };

    const confidence = calculateConfidence(stats, 10);
    expect(confidence.score).toBeGreaterThanOrEqual(0.3);
    expect(confidence.score).toBeLessThanOrEqual(0.7);
    expect(confidence.recommendation).toBe("review");
  });

  it("old pattern → low recency score", () => {
    const stats = {
      totalFrequency: 12, // high frequency
      affectedSessions: 5,
      lastSeen: new Date("2025-01-01T00:00:00Z"), // very old
    };

    const confidence = calculateConfidence(stats, 10);
    expect(confidence.factors.recencyScore).toBe(0.1);
  });
});
