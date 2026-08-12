/**
 * task-decomposer.ts — Task decomposition (Thinker role).
 *
 * Breaks a complex task into ordered, executable sub-steps.
 * When a thinker LLM provider is available, uses it for intelligent
 * decomposition. Otherwise falls back to the stub (single step).
 */

import type { Task } from "./types.js";
import type { LLMProvider } from "../llm/provider.interface.js";

const DECOMPOSER_SYSTEM_PROMPT = `You are a task decomposer. Your job is to break a complex task into ordered, executable sub-steps.

Rules:
1. Each step must be self-contained and executable independently.
2. Steps must be ordered logically (dependencies first).
3. Output ONLY a JSON array of strings — no explanations, no markdown.
4. Each step should be a clear, actionable instruction.
5. For simple tasks, a single step is acceptable.

Example input: "Set up a new project with TypeScript, ESLint, and tests"
Example output: ["Initialize project with package.json", "Install TypeScript and configure tsconfig.json", "Install and configure ESLint", "Create a sample test file with vitest"]

Now decompose the following task into steps:`;

/**
 * Decompose a task into an ordered list of executable sub-steps.
 *
 * When a thinker provider is supplied, calls the LLM for intelligent
 * decomposition. Falls back to the stub (single step = task description)
 * when no provider is given.
 */
export async function decompose(
  task: Task,
  thinkerProvider?: LLMProvider,
): Promise<string[]> {
  if (thinkerProvider) {
    try {
      const userMessage = `Task: ${task.description}${
        task.context ? `\n\nContext: ${task.context}` : ""
      }`;

      const response = await thinkerProvider.complete(
        DECOMPOSER_SYSTEM_PROMPT,
        userMessage,
        1024,
      );

      // Try to parse JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
          return parsed as string[];
        }
      }

      // Fallback: split by numbered lines
      const lines = response
        .split("\n")
        .map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
        .filter((l) => l.length > 0);

      if (lines.length > 1) {
        return lines;
      }
    } catch {
      // LLM call failed — fall through to stub
    }
  }

  // Stub fallback: single step
  return [task.description];
}
