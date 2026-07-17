/**
 * index.ts — Barrel exports for the Phase 3D Orchestrator package.
 */

export { Orchestrator, loadConfigFromEnv } from "./orchestrator.js";
export { classifyComplexity } from "./triage-classifier.js";
export { routeModel } from "./model-router.js";
export { decompose } from "./task-decomposer.js";
export { verify } from "./output-verifier.js";
export type {
  TaskComplexity,
  OrchestratorConfig,
  Task,
  TaskResult,
} from "./types.js";
export { DEFAULT_ORCHESTRATOR_CONFIG } from "./types.js";
