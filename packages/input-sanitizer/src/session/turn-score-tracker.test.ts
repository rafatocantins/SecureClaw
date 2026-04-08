/**
 * turn-score-tracker.test.ts — Tests for per-session injection score accumulation.
 */
import { describe, it, expect } from "vitest";
import {
  TurnScoreTracker,
  SEVERITY_SCORES,
  SENSITIVITY_THRESHOLDS,
} from "./turn-score-tracker.js";
import type { InjectionMatch } from "../heuristic/injection.detector.js";

function match(severity: "low" | "medium" | "high" | "critical"): InjectionMatch {
  return { pattern_id: `TEST_${severity.toUpperCase()}`, severity, excerpt: "test" };
}

// ── Construction and defaults ──────────────────────────────────────────────────

describe("TurnScoreTracker — construction", () => {
  it("defaults to medium sensitivity", () => {
    const tracker = new TurnScoreTracker();
    expect(tracker.sensitivityLevel).toBe("medium");
  });

  it("accepts explicit sensitivity levels", () => {
    expect(new TurnScoreTracker("low").sensitivityLevel).toBe("low");
    expect(new TurnScoreTracker("medium").sensitivityLevel).toBe("medium");
    expect(new TurnScoreTracker("high").sensitivityLevel).toBe("high");
  });

  it("getScore returns 0 for unknown session", () => {
    const tracker = new TurnScoreTracker();
    expect(tracker.getScore("unknown-session")).toBe(0);
  });
});

// ── Score accumulation ─────────────────────────────────────────────────────────

describe("TurnScoreTracker — score accumulation", () => {
  it("adds correct score for a single critical match", () => {
    const tracker = new TurnScoreTracker("medium");
    const result = tracker.addMatches("s1", [match("critical")]);

    expect(result.added_score).toBe(SEVERITY_SCORES["critical"]);
    expect(result.current_score).toBe(SEVERITY_SCORES["critical"]);
    expect(result.previous_score).toBe(0);
  });

  it("accumulates score across multiple turns", () => {
    const tracker = new TurnScoreTracker("medium");
    tracker.addMatches("s1", [match("high")]);
    tracker.addMatches("s1", [match("high")]);
    const result = tracker.addMatches("s1", [match("medium")]);

    // 5 + 5 + 2 = 12
    expect(result.current_score).toBe(12);
    expect(tracker.getScore("s1")).toBe(12);
  });

  it("scores are isolated per session", () => {
    const tracker = new TurnScoreTracker("medium");
    tracker.addMatches("s1", [match("critical")]);
    tracker.addMatches("s2", [match("low")]);

    expect(tracker.getScore("s1")).toBe(10);
    expect(tracker.getScore("s2")).toBe(1);
  });

  it("empty match list adds 0 to score", () => {
    const tracker = new TurnScoreTracker("medium");
    tracker.addMatches("s1", [match("high")]);
    const result = tracker.addMatches("s1", []);

    expect(result.added_score).toBe(0);
    expect(result.current_score).toBe(SEVERITY_SCORES["high"]);
  });

  it("multiple matches in one turn all contribute", () => {
    const tracker = new TurnScoreTracker("medium");
    const result = tracker.addMatches("s1", [
      match("critical"),
      match("high"),
      match("medium"),
      match("low"),
    ]);

    expect(result.added_score).toBe(10 + 5 + 2 + 1);
  });
});

// ── Threshold detection ────────────────────────────────────────────────────────

describe("TurnScoreTracker — threshold detection", () => {
  it("medium: threshold_exceeded becomes true at >= 15", () => {
    const tracker = new TurnScoreTracker("medium");
    expect(SENSITIVITY_THRESHOLDS["medium"]).toBe(15);

    // 10 + 4 = 14: not yet exceeded
    tracker.addMatches("s1", [match("critical")]); // +10
    const r1 = tracker.addMatches("s1", [match("medium"), match("medium")]); // +4
    expect(r1.threshold_exceeded).toBe(false);
    expect(r1.current_score).toBe(14);

    // +1 = 15: exactly at threshold — exceeded
    const r2 = tracker.addMatches("s1", [match("low")]);
    expect(r2.threshold_exceeded).toBe(true);
    expect(r2.current_score).toBe(15);
  });

  it("low: threshold is 25, harder to exceed", () => {
    const tracker = new TurnScoreTracker("low");
    // 2 critical = 20, not yet exceeded
    tracker.addMatches("s1", [match("critical"), match("critical")]);
    const r1 = tracker.addMatches("s1", []);
    expect(r1.threshold_exceeded).toBe(false);
    expect(r1.current_score).toBe(20);

    // +5 = 25: exceeded
    const r2 = tracker.addMatches("s1", [match("high")]);
    expect(r2.threshold_exceeded).toBe(true);
  });

  it("high: threshold is 8, reached quickly", () => {
    const tracker = new TurnScoreTracker("high");
    const r = tracker.addMatches("s1", [match("high"), match("high")]); // 5+5=10 >= 8
    expect(r.threshold_exceeded).toBe(true);
  });

  it("threshold field in result matches configured sensitivity", () => {
    const tracker = new TurnScoreTracker("low");
    const r = tracker.addMatches("s1", [match("critical")]);
    expect(r.threshold).toBe(SENSITIVITY_THRESHOLDS["low"]);
  });
});

// ── Session reset ──────────────────────────────────────────────────────────────

describe("TurnScoreTracker — session reset", () => {
  it("resetSession clears accumulated score", () => {
    const tracker = new TurnScoreTracker("medium");
    tracker.addMatches("s1", [match("critical"), match("critical")]);
    expect(tracker.getScore("s1")).toBe(20);

    tracker.resetSession("s1");
    expect(tracker.getScore("s1")).toBe(0);
  });

  it("resetSession on unknown session is a no-op", () => {
    const tracker = new TurnScoreTracker("medium");
    expect(() => tracker.resetSession("nonexistent")).not.toThrow();
  });

  it("resetting one session does not affect another", () => {
    const tracker = new TurnScoreTracker("medium");
    tracker.addMatches("s1", [match("critical")]);
    tracker.addMatches("s2", [match("high")]);

    tracker.resetSession("s1");
    expect(tracker.getScore("s1")).toBe(0);
    expect(tracker.getScore("s2")).toBe(5);
  });
});

// ── isSeveritySuspicious ───────────────────────────────────────────────────────

describe("TurnScoreTracker — isSeveritySuspicious", () => {
  it("low sensitivity: only critical is suspicious", () => {
    const tracker = new TurnScoreTracker("low");
    expect(tracker.isSeveritySuspicious("critical")).toBe(true);
    expect(tracker.isSeveritySuspicious("high")).toBe(false);
    expect(tracker.isSeveritySuspicious("medium")).toBe(false);
    expect(tracker.isSeveritySuspicious("low")).toBe(false);
  });

  it("medium sensitivity: critical + high are suspicious", () => {
    const tracker = new TurnScoreTracker("medium");
    expect(tracker.isSeveritySuspicious("critical")).toBe(true);
    expect(tracker.isSeveritySuspicious("high")).toBe(true);
    expect(tracker.isSeveritySuspicious("medium")).toBe(false);
    expect(tracker.isSeveritySuspicious("low")).toBe(false);
  });

  it("high sensitivity: all severities are suspicious", () => {
    const tracker = new TurnScoreTracker("high");
    expect(tracker.isSeveritySuspicious("critical")).toBe(true);
    expect(tracker.isSeveritySuspicious("high")).toBe(true);
    expect(tracker.isSeveritySuspicious("medium")).toBe(true);
    expect(tracker.isSeveritySuspicious("low")).toBe(true);
  });
});
