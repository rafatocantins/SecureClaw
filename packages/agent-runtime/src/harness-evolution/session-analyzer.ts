/**
 * Session Analyzer — Aggregates failure patterns across sessions.
 *
 * Injects an AuditService (interface) so there is no direct
 * database coupling. Uses pure TypeScript — no LLM calls.
 */

import type {
  AuditService,
  SessionAnalysis,
  FailurePattern,
} from "./types.js";
import { detectToolFailures } from "./pattern-detectors.js";
import { detectLoops } from "./pattern-detectors.js";
import { detectInjectionPatterns } from "./pattern-detectors.js";
import { detectApprovalBottlenecks } from "./pattern-detectors.js";

export interface PatternSummary {
  patternType: string;
  totalOccurrences: number;
  affectedSessions: number;
}

export class SessionAnalyzer {
  private readonly audit: AuditService;

  constructor(audit: AuditService) {
    this.audit = audit;
  }

  /**
   * Reads recent sessions, fetches their events, and runs all
   * detectors to aggregate FailurePatterns per session.
   */
  async analyze(limit = 50): Promise<SessionAnalysis[]> {
    const sessions = await this.audit.getRecentSessions(limit);

    const analyses: SessionAnalysis[] = [];

    for (const session of sessions) {
      const events = await this.audit.getSessionEvents(session.sessionId);

      const patterns: FailurePattern[] = [
        ...detectToolFailures(events),
        ...detectLoops(events),
        ...detectInjectionPatterns(events),
        ...detectApprovalBottlenecks(events),
      ];

      analyses.push({
        sessionId: session.sessionId,
        patterns,
        analyzedAt: new Date(),
        sessionCount: sessions.length,
      });
    }

    return analyses;
  }

  /**
   * Summarizes all patterns across analyses — how many times each
   * pattern type occurred and how many sessions were affected.
   */
  getPatternSummary(analyses: SessionAnalysis[]): PatternSummary[] {
    const byType = new Map<string, { occurrences: number; sessions: Set<string> }>();

    for (const analysis of analyses) {
      for (const pattern of analysis.patterns) {
        if (!byType.has(pattern.type)) {
          byType.set(pattern.type, { occurrences: 0, sessions: new Set() });
        }
        const entry = byType.get(pattern.type)!;
        entry.occurrences += pattern.frequency;
        entry.sessions.add(pattern.sessionId);
      }
    }

    const summary: PatternSummary[] = [];
    for (const [patternType, data] of byType) {
      summary.push({
        patternType,
        totalOccurrences: data.occurrences,
        affectedSessions: data.sessions.size,
      });
    }

    // Sort by occurrences descending for readability
    summary.sort((a, b) => b.totalOccurrences - a.totalOccurrences);

    return summary;
  }
}
