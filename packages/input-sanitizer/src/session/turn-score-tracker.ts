/**
 * turn-score-tracker.ts — Per-session injection suspicion score accumulation.
 *
 * Each injection match found during a session adds to a running score weighted
 * by severity. When the score exceeds the threshold for the configured sensitivity
 * level, the tracker flags the session as having reached threshold.
 *
 * This catches incremental injection attacks that individually score below
 * the single-turn threshold but collectively indicate coordinated probing.
 *
 * Score weights (chosen to make critical > 2×high >> medium >> low):
 *   critical = 10  |  high = 5  |  medium = 2  |  low = 1
 *
 * Threshold by sensitivity:
 *   low    = 25  (requires ~3 critical matches or equivalent)
 *   medium = 15  (requires ~2 critical or 3 high — default)
 *   high   =  8  (requires 1 critical + small change, or 2 high)
 *
 * Score is NOT reset between turns — it accumulates for the session lifetime.
 * Call resetSession() when a session is destroyed.
 */
import type { InjectionMatch } from "../heuristic/injection.detector.js";

export type SensitivityLevel = "low" | "medium" | "high";

export const SEVERITY_SCORES: Readonly<Record<string, number>> = {
  low: 1,
  medium: 2,
  high: 5,
  critical: 10,
};

export const SENSITIVITY_THRESHOLDS: Readonly<Record<SensitivityLevel, number>> = {
  low: 25,
  medium: 15,
  high: 8,
};

/** Minimum severity levels that contribute to is_suspicious per sensitivity. */
export const SENSITIVITY_MIN_SEVERITY: Readonly<Record<SensitivityLevel, number>> = {
  low: SEVERITY_SCORES["critical"]!,    // 10 — only critical
  medium: SEVERITY_SCORES["high"]!,      //  5 — critical + high
  high: SEVERITY_SCORES["low"]!,         //  1 — all severities
};

export interface TurnScoreResult {
  previous_score: number;
  added_score: number;
  current_score: number;
  threshold: number;
  threshold_exceeded: boolean;
}

export class TurnScoreTracker {
  private readonly scores = new Map<string, number>();
  private readonly threshold: number;
  private readonly sensitivity: SensitivityLevel;

  constructor(sensitivity: SensitivityLevel = "medium") {
    this.sensitivity = sensitivity;
    this.threshold = SENSITIVITY_THRESHOLDS[sensitivity];
  }

  /**
   * Add injection matches from a single turn to the session's running score.
   * Returns the updated score state.
   */
  addMatches(sessionId: string, matches: InjectionMatch[]): TurnScoreResult {
    const previous_score = this.scores.get(sessionId) ?? 0;

    const added_score = matches.reduce((sum, m) => {
      return sum + (SEVERITY_SCORES[m.severity] ?? 0);
    }, 0);

    const current_score = previous_score + added_score;
    this.scores.set(sessionId, current_score);

    return {
      previous_score,
      added_score,
      current_score,
      threshold: this.threshold,
      threshold_exceeded: current_score >= this.threshold,
    };
  }

  /** Get the current accumulated score for a session (0 if not yet tracked). */
  getScore(sessionId: string): number {
    return this.scores.get(sessionId) ?? 0;
  }

  /** Clear the score for a session. Call when the session is destroyed. */
  resetSession(sessionId: string): void {
    this.scores.delete(sessionId);
  }

  /**
   * Returns true if, given the sensitivity level, a match of this severity
   * should contribute to `is_suspicious` (independent of turn score).
   */
  isSeveritySuspicious(severity: "low" | "medium" | "high" | "critical"): boolean {
    const minScore = SENSITIVITY_MIN_SEVERITY[this.sensitivity];
    return (SEVERITY_SCORES[severity] ?? 0) >= minScore;
  }

  get sensitivityLevel(): SensitivityLevel {
    return this.sensitivity;
  }
}
