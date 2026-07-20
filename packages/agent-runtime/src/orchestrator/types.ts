/**
 * types.ts — Shared type definitions for the Phase 3D Orchestrator.
 *
 * This module defines all interfaces and types used by the orchestrator
 * pipeline: Thinker → Worker → Verifier.
 */

export type TaskComplexity = "simple" | "medium" | "complex" | "critical";

export interface OrchestratorConfig {
  /** Whether the orchestrator is enabled (default: false for backward compat). */
  enabled: boolean;
  /** Model to use for the Thinker role (complex decomposition). */
  thinkerModel: string;
  /** Model to use for the Worker role (execution). */
  workerModel: string;
  /** Model to use for the Verifier gate (output validation). */
  verifierModel: string;
  /** Maximum number of retry attempts on verification failure. */
  maxRetries: number;
  /** Timeout in milliseconds for the full pipeline. */
  timeout: number;
}

export interface Task {
  id: string;
  description: string;
  complexity: TaskComplexity;
  context?: string;
}

export interface TaskResult {
  taskId: string;
  output: string;
  verifierPassed: boolean;
  retriesUsed: number;
  modelUsed: string;
}

/** Default orchestrator configuration. */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: false,
  thinkerModel: "openrouter/anthropic/claude-sonnet",
  workerModel: "openrouter/mistral/mistral-large",
  verifierModel: "openrouter/anthropic/claude-haiku",
  maxRetries: 3,
  timeout: 120_000,
};
