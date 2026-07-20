/**
 * triage-classifier.ts — Heuristic-based task complexity classifier.
 *
 * Classifies incoming tasks into one of four complexity tiers
 * (simple, medium, complex, critical) based on keyword analysis.
 */

import type { TaskComplexity } from "./types.js";

/** Keywords mapping to each complexity tier. */
const COMPLEXITY_KEYWORDS: Record<TaskComplexity, readonly string[]> = {
  simple: ["echo", "ping", "date", "uptime", "whoami", "status", "version", "help"],
  medium: [],
  complex: ["refactor", "migrate", "orchestrat", "pipeline", "infrastructure", "deploy", "multi-step", "integration"],
  critical: ["critical", "urgent", "security", "breach", "incident", "outage", "production-down", "p0", "emergency", "exploit", "cve"],
};

/**
 * Classify a task description into a complexity tier based on keyword heuristics.
 *
 * Rules are evaluated in descending order of severity (critical first);
 * the first match wins. If no keywords match, defaults to "medium".
 */
export function classifyComplexity(description: string): TaskComplexity {
  const lower = description.toLowerCase();

  // Evaluate in descending severity order
  const tiers: TaskComplexity[] = ["critical", "complex", "simple"];

  for (const tier of tiers) {
    const keywords = COMPLEXITY_KEYWORDS[tier];
    if (!keywords) continue;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        return tier;
      }
    }
  }

  return "medium";
}
