/**
 * model-router.ts — Model selection based on task complexity.
 *
 * Routes tasks to the appropriate model tier:
 * - simple → workerModel (cheaper/faster)
 * - medium → workerModel
 * - complex → thinkerModel (more capable)
 * - critical → thinkerModel
 */

import type { TaskComplexity, OrchestratorConfig } from "./types.js";

/**
 * Select the model to use for a given task complexity and orchestrator config.
 *
 * Simple and medium tasks go to the worker model; complex and critical tasks
 * go to the thinker model for better reasoning. The verifier model is used
 * exclusively during the verification phase.
 */
export function routeModel(
  complexity: TaskComplexity,
  config: OrchestratorConfig,
): string {
  switch (complexity) {
    case "simple":
    case "medium":
      return config.workerModel;
    case "complex":
    case "critical":
      return config.thinkerModel;
    default:
      return config.workerModel;
  }
}
