/**
 * task-decomposer.ts — Task decomposition (Thinker role).
 *
 * Breaks a complex task into ordered, executable sub-steps.
 * Currently a stub that returns the original task description as a
 * single step. Future iterations will integrate with an LLM for
 * intelligent decomposition.
 */

import type { Task } from "./types.js";

/**
 * Decompose a task into an ordered list of executable sub-steps.
 *
 * Stub implementation: returns the task description as a single step.
 * The Thinker model will drive decomposition in a future iteration.
 */
export function decompose(task: Task): string[] {
  return [task.description];
}
