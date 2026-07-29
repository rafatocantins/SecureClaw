/**
 * HarnessPatchGenerator — Generates concrete harness patches from session analyses.
 *
 * Takes SessionAnalysis[] (output of SessionAnalyzer) and produces
 * HarnessPatch[] with confidence scores for human review or auto-application.
 *
 * Pure TypeScript — no external dependencies, no LLM calls.
 */

import type {
  SessionAnalysis,
  FailurePattern,
  HarnessPatch,
  ConfidenceScore,
} from "./types.js";

// ── Aggregated per-type statistics ──────────────────────────────────────────

interface AggregatedPatternStats {
  totalFrequency: number;
  affectedSessions: number;
  lastSeen: Date;
}

// ── Public API ──────────────────────────────────────────────────────────────

export class HarnessPatchGenerator {
  /**
   * Generate HarnessPatch[] from session analyses.
   * One patch per unique failure-pattern type found across all analyses.
   */
  generatePatches(analyses: SessionAnalysis[]): HarnessPatch[] {
    const withConfidence = this.generatePatchesWithConfidence(analyses);
    return withConfidence.map((entry) => entry.patch);
  }

  /**
   * Generate patches with confidence scores for each patch.
   * Useful when a human or automated system needs to decide
   * whether to apply, review, or reject each suggestion.
   */
  generatePatchesWithConfidence(
    analyses: SessionAnalysis[],
  ): Array<{ patch: HarnessPatch; confidence: ConfidenceScore }> {
    if (analyses.length === 0) return [];

    const aggregated = aggregatePatterns(analyses);
    const totalSessions = analyses[0]?.sessionCount ?? analyses.length;
    const results: Array<{ patch: HarnessPatch; confidence: ConfidenceScore }> =
      [];

    let index = 0;
    for (const [patternType, stats] of aggregated) {
      const patch = generatePatch(patternType, stats, totalSessions, index);
      const confidence = calculateConfidence(stats, totalSessions);
      results.push({ patch, confidence });
      index++;
    }

    return results;
  }
}

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export function aggregatePatterns(
  analyses: SessionAnalysis[],
): Map<FailurePattern["type"], AggregatedPatternStats> {
  const map = new Map<
    FailurePattern["type"],
    { totalFrequency: number; sessions: Set<string>; lastSeen: Date }
  >();

  for (const analysis of analyses) {
    for (const pattern of analysis.patterns) {
      let entry = map.get(pattern.type);
      if (!entry) {
        entry = {
          totalFrequency: 0,
          sessions: new Set(),
          lastSeen: pattern.lastSeen,
        };
        map.set(pattern.type, entry);
      }
      entry.totalFrequency += pattern.frequency;
      entry.sessions.add(pattern.sessionId);
      if (pattern.lastSeen > entry.lastSeen) {
        entry.lastSeen = pattern.lastSeen;
      }
    }
  }

  const result = new Map<FailurePattern["type"], AggregatedPatternStats>();
  for (const [type, data] of map) {
    result.set(type, {
      totalFrequency: data.totalFrequency,
      affectedSessions: data.sessions.size,
      lastSeen: data.lastSeen,
    });
  }
  return result;
}

export function generatePatch(
  patternType: FailurePattern["type"],
  stats: AggregatedPatternStats,
  totalSessions: number,
  index: number,
): HarnessPatch {
  const timestamp = Date.now();
  const id = `patch-${patternType}-${timestamp}-${index}`;

  switch (patternType) {
    case "tool_failure":
      return {
        id,
        type: "tool_rule",
        target: "tool_allowlist",
        proposedChange: `Review and potentially remove or restrict tools that have failed ${stats.totalFrequency} times across ${stats.affectedSessions} sessions`,
        rationale: `Tools are failing frequently (${stats.totalFrequency} failures in ${stats.affectedSessions}/${totalSessions} sessions). Consider removing unreliable tools from the allowlist.`,
        confidence: 0,
        sourcePatterns: [patternType],
        generatedAt: new Date(),
      };

    case "loop_detected":
      return {
        id,
        type: "system_instruction",
        target: "agent_loop_guard",
        proposedChange: `Add loop detection guard: if the same tool is called more than 3 consecutive times without observable progress, abort the loop and request human intervention. Detected ${stats.totalFrequency} loop occurrences across ${stats.affectedSessions} sessions.`,
        rationale: `Agent entered repetitive loops in ${stats.affectedSessions}/${totalSessions} sessions. Adding explicit guard rails prevents wasted tokens and compute resources.`,
        confidence: 0,
        sourcePatterns: [patternType],
        generatedAt: new Date(),
      };

    case "injection_detected":
      return {
        id,
        type: "prompt_update",
        target: "input_sanitization",
        proposedChange: `Strengthen input sanitization: scan all user-provided inputs for injection patterns before they enter the LLM context window. Detected ${stats.totalFrequency} injection events across ${stats.affectedSessions} sessions.`,
        rationale: `Injection attempts detected in ${stats.affectedSessions}/${totalSessions} sessions. Hardening input sanitization prevents prompt manipulation and data leakage.`,
        confidence: 0,
        sourcePatterns: [patternType],
        generatedAt: new Date(),
      };

    case "approval_bottleneck":
      return {
        id,
        type: "tool_rule",
        target: "approval_thresholds",
        proposedChange: `Adjust approval thresholds: reduce required approvals for low-risk operations or batch-approve repetitive safe operations. Detected ${stats.totalFrequency} pending approvals across ${stats.affectedSessions} sessions.`,
        rationale: `Approval bottlenecks detected in ${stats.affectedSessions}/${totalSessions} sessions. Streamlining approval flow reduces latency without compromising security posture.`,
        confidence: 0,
        sourcePatterns: [patternType],
        generatedAt: new Date(),
      };
  }
}

export function calculateConfidence(
  stats: AggregatedPatternStats,
  totalSessions: number,
): ConfidenceScore {
  // Frequency factor: 0–1 based on total occurrences (cap at 15)
  const frequencyScore = Math.min(stats.totalFrequency / 15, 1);

  // Session factor: proportion of total sessions affected (50 %+ = max)
  const sessionRatio =
    totalSessions > 0 ? stats.affectedSessions / totalSessions : 0;
  const sessionScore = Math.min(sessionRatio * 2, 1);

  // Recency factor: how recently was this pattern last seen
  const hoursSinceLastSeen =
    (Date.now() - stats.lastSeen.getTime()) / (1000 * 60 * 60);
  let recencyScore: number;
  if (hoursSinceLastSeen < 24) {
    recencyScore = 1;
  } else if (hoursSinceLastSeen < 168) {
    // 7 days
    recencyScore = 0.5;
  } else {
    recencyScore = 0.1;
  }

  // Weighted combination
  const score =
    frequencyScore * 0.4 + sessionScore * 0.3 + recencyScore * 0.3;

  const factors: Record<string, number> = {
    frequencyScore,
    sessionScore,
    recencyScore,
  };

  let recommendation: "apply" | "review" | "reject";
  if (score < 0.3) {
    recommendation = "reject";
  } else if (score <= 0.7) {
    recommendation = "review";
  } else {
    recommendation = "apply";
  }

  return { score, factors, recommendation };
}
