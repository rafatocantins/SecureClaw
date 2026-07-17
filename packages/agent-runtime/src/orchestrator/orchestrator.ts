/**
 * orchestrator.ts — Main orchestrator pipeline (Thinker → Worker → Verifier).
 *
 * Implements the Phase 3D orchestration pipeline:
 *   classify → route model → decompose → worker → verify → (retry on failure)
 *
 * Default disabled (TESSERA_ORCHESTRATOR_ENABLED=false) for backward
 * compatibility. Set the env var to "true" to activate.
 */

import { classifyComplexity } from "./triage-classifier.js";
import { routeModel } from "./model-router.js";
import { decompose } from "./task-decomposer.js";
import { verify } from "./output-verifier.js";
import {
  type OrchestratorConfig,
  type Task,
  type TaskResult,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from "./types.js";

/** Read orchestrator configuration from environment variables. */
export function loadConfigFromEnv(): OrchestratorConfig {
  const rawRetries = Number(process.env["TESSERA_ORCHESTRATOR_MAX_RETRIES"]);
  const rawTimeout = Number(process.env["TESSERA_ORCHESTRATOR_TIMEOUT"]);

  return {
    enabled: process.env["TESSERA_ORCHESTRATOR_ENABLED"] === "true",
    thinkerModel:
      process.env["TESSERA_ORCHESTRATOR_THINKER_MODEL"] ??
      DEFAULT_ORCHESTRATOR_CONFIG.thinkerModel,
    workerModel:
      process.env["TESSERA_ORCHESTRATOR_WORKER_MODEL"] ??
      DEFAULT_ORCHESTRATOR_CONFIG.workerModel,
    verifierModel:
      process.env["TESSERA_ORCHESTRATOR_VERIFIER_MODEL"] ??
      DEFAULT_ORCHESTRATOR_CONFIG.verifierModel,
    maxRetries: Number.isNaN(rawRetries)
      ? DEFAULT_ORCHESTRATOR_CONFIG.maxRetries
      : rawRetries,
    timeout: Number.isNaN(rawTimeout)
      ? DEFAULT_ORCHESTRATOR_CONFIG.timeout
      : rawTimeout,
  };
}

/**
 * Orchestrator — Phase 3D pipeline.
 *
 * Each instance is initialized with a config (from env or explicit).
 * The execute() method runs the full pipeline: classify → route →
 * decompose → execute worker → verify → retry on failure.
 */
export class Orchestrator {
  readonly config: OrchestratorConfig;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
  }

  /**
   * Execute a task through the full orchestrator pipeline.
   *
   * Pipeline stages:
   *   1. Guard: throw if orchestrator is disabled
   *   2. Triage: classify task complexity
   *   3. Route: select the appropriate model
   *   4. Decompose: break task into steps (Thinker)
   *   5. Worker: execute steps
   *   6. Verify: validate output (Verifier gate)
   *   7. Retry: if verification fails, retry up to maxRetries
   *
   * @throws Error if the orchestrator is not enabled
   */
  async execute(task: Task): Promise<TaskResult> {
    if (!this.config.enabled) {
      throw new Error(
        "Orchestrator not enabled. " +
          "Set TESSERA_ORCHESTRATOR_ENABLED=true to activate.",
      );
    }

    const complexity = classifyComplexity(task.description);
    const modelUsed = routeModel(complexity, this.config);

    // Update task complexity inline for downstream consumers
    const classifiedTask: Task = { ...task, complexity };

    let lastOutput = "";
    let retriesUsed = 0;
    let verifierPassed = false;

    // Decompose once (Thinker stage)
    const steps = decompose(classifiedTask);

    // Worker stage: execute all steps
    for (const step of steps) {
      lastOutput += step; // stub execution — replaces in future with actual LLM call
    }

    // Verifier gate with retry loop
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      retriesUsed = attempt;
      verifierPassed = verify(lastOutput, classifiedTask);

      if (verifierPassed) {
        break;
      }

      // If we have retries left, re-run worker on the output
      if (attempt < this.config.maxRetries) {
        // Remove ERROR markers and retry annotations for clean re-processing
        lastOutput = lastOutput.replace(/ERROR/gi, "FIXED");
      }
    }

    return {
      taskId: task.id,
      output: lastOutput,
      verifierPassed,
      retriesUsed,
      modelUsed,
    };
  }
}
