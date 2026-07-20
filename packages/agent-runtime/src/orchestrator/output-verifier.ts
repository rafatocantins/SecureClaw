/**
 * output-verifier.ts — Output validation gate (Verifier role).
 *
 * Validates task execution output before returning it to the caller.
 * Currently a stub that checks basic output quality heuristics.
 * Future iterations will integrate with an LLM for semantic verification.
 */

import type { Task } from "./types.js";

/**
 * Verify whether a task output is acceptable.
 *
 * Stub implementation: checks that output is non-empty and does not
 * contain any error markers.
 */
export function verify(output: string, _task: Task): boolean {
  return output.length > 0 && !output.includes("ERROR");
}
