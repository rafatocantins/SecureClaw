/**
 * output-verifier.ts — Output validation gate (Verifier role).
 *
 * Delegates to the real OutputVerifier from verifier/ for semantic
 * validation across factuality, completeness, safety, and compliance.
 * Falls back to heuristic stub when verifier is not provided.
 */

import type { Task } from "./types.js";
import type { VerifierFeedback } from "./types.js";
import { OutputVerifier } from "../verifier/output-verifier.js";
import type { VerificationInput } from "../verifier/types.js";

/**
 * Verify whether a task output is acceptable.
 *
 * When a real OutputVerifier instance is provided, performs full
 * multi-dimensional verification (factuality, completeness, safety,
 * compliance). Otherwise falls back to the legacy heuristic stub
 * (non-empty output without ERROR markers).
 */
export function verify(
  output: string,
  task: Task,
  verifier?: OutputVerifier,
): boolean {
  if (verifier) {
    const input: VerificationInput = {
      taskDescription: task.description,
      agentOutput: output,
    };
    const result = verifier.verify(input);
    return result.passed;
  }

  // Legacy stub fallback
  return output.length > 0 && !output.includes("ERROR");
}

/**
 * Verify with detailed feedback (for retry loops).
 *
 * Returns structured VerifierFeedback instead of a boolean, so the
 * retry loop can use the summary to improve the next attempt.
 */
export function verifyWithFeedback(
  output: string,
  task: Task,
  verifier?: OutputVerifier,
): VerifierFeedback {
  if (verifier) {
    const input: VerificationInput = {
      taskDescription: task.description,
      agentOutput: output,
    };
    const result = verifier.verify(input);
    return {
      passed: result.passed,
      score: result.score,
      summary: result.summary,
    };
  }

  // Legacy stub fallback
  const passed = output.length > 0 && !output.includes("ERROR");
  return {
    passed,
    score: passed ? 100 : 0,
    summary: passed
      ? "Stub check passed (non-empty, no ERROR markers)."
      : "Stub check failed (empty output or ERROR marker found).",
  };
}
