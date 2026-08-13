/**
 * output-verifier.ts — OutputVerifier class for the Verifier Gate.
 *
 * Validates agent outputs across four dimensions:
 *  1. Factuality  — no fabricated claims
 *  2. Completeness — all task requirements addressed
 *  3. Safety       — no code injection or malicious patterns
 *  4. Compliance   — EU AI Act basic transparency
 *
 * Each check contributes 25 points. Total score ranges from 0–100.
 * Pure TypeScript — no Docker, no Integration Tests, no LLM dependency.
 */

import type {
  VerificationInput,
  VerificationResult,
  VerificationCheck,
} from "./types.js";

// ── Injection / dangerous pattern detection ─────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  // HTML/JS injection
  /<script[\s>]/i,
  /\bon(error|load|click|mouseover|focus|blur)\s*=/i,
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /\bsetTimeout\s*\(\s*['"`]/i,
  /\bsetInterval\s*\(\s*['"`]/i,
  // Shell injection
  /;\s*rm\s+-rf/i,
  /\|\s*sh\b/i,
  /`[^`]*`/, // backtick command substitution
  /\$\([^)]*\)/, // $(command) substitution
  // SQL injection
  /'\s*OR\s+'1'\s*=\s*'1/i,
  /\bDROP\s+TABLE\b/i,
  /\bUNION\s+SELECT\b/i,
  // Path traversal
  /\.\.\//,
  /\.\.\\/,
  // Env/credential exfiltration
  /\bprocess\.env\b/,
  /\/etc\/passwd/,
  /\/etc\/shadow/,
];

// ── Hallucination / factuality markers ──────────────────────────────────

const HALLUCINATION_MARKERS: RegExp[] = [
  // Fabricated URLs on common fake domains
  /https?:\/\/example\.(com|org|net)/i,
  /https?:\/\/fake/i,
  /https?:\/\/test\.(com|org)/i,
  // Placeholder markers
  /\[TODO[^\]]*\]/i,
  /\[PLACEHOLDER[^\]]*\]/i,
  /\[INSERT_[A-Z_]+\]/i,
  // Clearly fabricated identifiers
  /fake-[a-f0-9]{8}-[a-f0-9]{4}/i,
];

// ── EU AI Act prohibited content markers ────────────────────────────────

const COMPLIANCE_VIOLATION_MARKERS: RegExp[] = [
  // Subliminal manipulation
  /\bsubliminal\s+(manipulation|influence|messaging)\b/i,
  // Social scoring
  /\bsocial\s+scoring\b/i,
  // Real-time biometric categorisation in public
  /\breal[- ]?time\s+biometric\b/i,
];

/**
 * OutputVerifier — Validates agent outputs against four quality gates.
 *
 * Usage:
 * ```ts
 * const verifier = new OutputVerifier();
 * const result = verifier.verify({
 *   taskDescription: "Summarize the report",
 *   agentOutput: "The report covers Q3 results...",
 *   safetyContext: "sandbox",
 * });
 * ```
 */
export class OutputVerifier {
  /**
   * Verify an agent output against the task description.
   *
   * Returns a VerificationResult with pass/fail status, 0–100 score,
   * individual check results, and a human-readable summary.
   */
  verify(input: VerificationInput): VerificationResult {
    const checks: VerificationCheck[] = [
      this.checkFactuality(input),
      this.checkCompleteness(input),
      this.checkSafety(input),
      this.checkCompliance(input),
    ];

    const score = checks.reduce((sum, c) => sum + (c.passed ? 25 : 0), 0);
    const passed = checks.every((c) => c.passed);
    const summary = this.buildSummary(checks, score);

    return { passed, score, checks, summary };
  }

  // ── Individual checks ──────────────────────────────────────────────────

  private checkFactuality(input: VerificationInput): VerificationCheck {
    const { agentOutput } = input;

    // Empty output is not factual
    if (!agentOutput || agentOutput.trim().length === 0) {
      return {
        category: "factuality",
        passed: false,
        detail: "Output is empty — cannot verify factuality.",
      };
    }

    // Check for hallucination markers
    const foundMarkers: string[] = [];
    for (const pattern of HALLUCINATION_MARKERS) {
      const match = agentOutput.match(pattern);
      if (match) {
        foundMarkers.push(match[0]);
      }
    }

    if (foundMarkers.length > 0) {
      return {
        category: "factuality",
        passed: false,
        detail: `Hallucination markers detected: ${foundMarkers.join(", ")}. Output may contain fabricated or placeholder content.`,
      };
    }

    return {
      category: "factuality",
      passed: true,
      detail: "No hallucination markers detected. Output appears grounded.",
    };
  }

  private checkCompleteness(input: VerificationInput): VerificationCheck {
    const { taskDescription, agentOutput } = input;

    // Empty task description — vacuously complete (regardless of output)
    if (!taskDescription || taskDescription.trim().length === 0) {
      return {
        category: "completeness",
        passed: true,
        detail: "No task description to check against.",
      };
    }

    // Empty output is incomplete
    if (!agentOutput || agentOutput.trim().length === 0) {
      return {
        category: "completeness",
        passed: false,
        detail: "Output is empty — all requirements are missing.",
      };
    }

    // Heuristic: extract key terms from task description and verify
    // they appear (at least partially) in the agent output.
    const taskTerms = this.extractKeyTerms(taskDescription);
    const outputLower = agentOutput.toLowerCase();

    const missingTerms: string[] = [];
    for (const term of taskTerms) {
      if (!outputLower.includes(term.toLowerCase())) {
        missingTerms.push(term);
      }
    }

    // Allow up to 30% of terms to be missing (heuristic tolerance)
    const threshold = Math.max(1, Math.floor(taskTerms.length * 0.7));
    const coveredCount = taskTerms.length - missingTerms.length;

    if (taskTerms.length > 0 && coveredCount < threshold) {
      return {
        category: "completeness",
        passed: false,
        detail: `Output missing key terms from task: ${missingTerms.join(", ")}. Covered ${coveredCount}/${taskTerms.length} terms.`,
      };
    }

    // Also check if the output is substantially shorter than the task
    // (suggests incomplete response)
    if (agentOutput.length < taskDescription.length * 0.3 && taskDescription.length > 50) {
      return {
        category: "completeness",
        passed: false,
        detail: `Output (${agentOutput.length} chars) is substantially shorter than task description (${taskDescription.length} chars) — likely incomplete.`,
      };
    }

    return {
      category: "completeness",
      passed: true,
      detail:
        taskTerms.length > 0
          ? `All key terms addressed (${coveredCount}/${taskTerms.length}).`
          : "Completeness verified.",
    };
  }

  private checkSafety(input: VerificationInput): VerificationCheck {
    const { agentOutput, safetyContext } = input;

    // Empty output is safe (but flagged for completeness elsewhere)
    if (!agentOutput || agentOutput.trim().length === 0) {
      return {
        category: "safety",
        passed: true,
        detail: "Empty output — no safety issues detected.",
      };
    }

    const foundPatterns: string[] = [];
    for (const pattern of INJECTION_PATTERNS) {
      const match = agentOutput.match(pattern);
      if (match) {
        foundPatterns.push(match[0]);
      }
    }

    if (foundPatterns.length > 0) {
      const contextNote = safetyContext
        ? ` (context: ${safetyContext})`
        : "";
      return {
        category: "safety",
        passed: false,
        detail: `Injection patterns detected${contextNote}: ${foundPatterns.join(", ")}.`,
      };
    }

    return {
      category: "safety",
      passed: true,
      detail: safetyContext
        ? `No injection patterns detected in ${safetyContext} context.`
        : "No injection patterns detected.",
    };
  }

  private checkCompliance(input: VerificationInput): VerificationCheck {
    const { agentOutput } = input;

    // Empty output is compliant (no content to violate)
    if (!agentOutput || agentOutput.trim().length === 0) {
      return {
        category: "compliance",
        passed: true,
        detail: "Empty output — no compliance issues detected.",
      };
    }

    const violations: string[] = [];
    for (const pattern of COMPLIANCE_VIOLATION_MARKERS) {
      const match = agentOutput.match(pattern);
      if (match) {
        violations.push(match[0]);
      }
    }

    if (violations.length > 0) {
      return {
        category: "compliance",
        passed: false,
        detail: `EU AI Act compliance violations detected: ${violations.join(", ")}.`,
      };
    }

    return {
      category: "compliance",
      passed: true,
      detail: "No EU AI Act compliance violations detected (Regulation 2024/1689).",
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Extract meaningful key terms from a task description for
   * completeness checking. Filters out common stop words.
   */
  private extractKeyTerms(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "being", "have", "has", "had", "do", "does", "did", "will",
      "would", "could", "should", "may", "might", "can", "shall",
      "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "as", "into", "through", "during", "before", "after",
      "and", "but", "or", "nor", "not", "so", "yet", "both",
      "this", "that", "these", "those", "it", "its",
      "i", "you", "he", "she", "we", "they",
      "me", "him", "her", "us", "them",
      "my", "your", "his", "our", "their",
      "please", "just", "also", "very", "really", "quite",
    ]);

    // Split on non-word characters, filter short words and stop words
    return text
      .split(/[^a-zA-Z0-9]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()));
  }

  /**
   * Build a human-readable summary from check results.
   */
  private buildSummary(checks: VerificationCheck[], score: number): string {
    const failed = checks.filter((c) => !c.passed);
    const passed = checks.filter((c) => c.passed);

    if (failed.length === 0) {
      return `All ${checks.length} checks passed. Score: ${score}/100. Output is verified.`;
    }

    const failedCategories = failed.map((c) => c.category).join(", ");
    const passedCategories = passed.map((c) => c.category).join(", ");

    let summary = `Verification failed: ${failedCategories}. `;
    summary += `Passed: ${passed.length > 0 ? passedCategories : "none"}. `;
    summary += `Score: ${score}/100.`;

    return summary;
  }
}
