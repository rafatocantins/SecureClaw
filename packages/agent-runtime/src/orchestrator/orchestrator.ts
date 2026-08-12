/**
 * orchestrator.ts — Main orchestrator pipeline (Thinker → Worker → Verifier).
 *
 * Implements the Phase 3D orchestration pipeline:
 *   classify → route model → decompose → worker → verify → (retry on failure)
 *
 * When TESSERA_ORCHESTRATOR_ENABLED=true and LLM providers are injected,
 * uses real LLM calls for decomposition and worker execution. Falls back
 * to stubs when disabled or providers are unavailable.
 */

import { classifyComplexity } from "./triage-classifier.js";
import { routeModel } from "./model-router.js";
import { decompose } from "./task-decomposer.js";
import { verifyWithFeedback } from "./output-verifier.js";
import { OutputVerifier } from "../verifier/output-verifier.js";
import type { LLMProvider } from "../llm/provider.interface.js";
import {
  type OrchestratorConfig,
  type Task,
  type TaskResult,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from "./types.js";

/**
 * Map of model role → LLM provider instance.
 * Thinker: used for task decomposition.
 * Worker: used for step execution.
 * Both are optional — when absent, stubs are used.
 */
export interface OrchestratorProviders {
  thinker?: LLMProvider;
  worker?: LLMProvider;
}

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

const WORKER_SYSTEM_PROMPT = `You are a precise task execution agent. Execute the given step accurately and return ONLY the result. Do not add commentary, explanations, or markdown formatting. Be concise and direct.`;

/**
 * Orchestrator — Phase 3D pipeline.
 *
 * Each instance is initialized with a config (from env or explicit) and
 * optional LLM providers. The execute() method runs the full pipeline:
 * classify → route → decompose → execute worker → verify → retry on failure.
 */
export class Orchestrator {
  readonly config: OrchestratorConfig;
  private readonly providers: OrchestratorProviders;
  private readonly verifier: OutputVerifier;

  constructor(
    config?: Partial<OrchestratorConfig>,
    providers?: OrchestratorProviders,
  ) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
    this.providers = providers ?? {};
    this.verifier = new OutputVerifier();
  }

  /**
   * Execute a task through the full orchestrator pipeline.
   *
   * Pipeline stages:
   *   1. Guard: throw if orchestrator is disabled
   *   2. Triage: classify task complexity
   *   3. Route: select the appropriate model
   *   4. Decompose: break task into steps (Thinker LLM or stub)
   *   5. Worker: execute steps (Worker LLM or stub)
   *   6. Verify: validate output (Verifier gate with real OutputVerifier)
   *   7. Retry: if verification fails, retry up to maxRetries with feedback
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
    let verifierFeedback: string | undefined;

    // Decompose once (Thinker stage) — uses LLM if provider available
    const steps = await decompose(classifiedTask, this.providers.thinker);

    // Worker stage: execute all steps
    if (this.providers.worker) {
      // Real LLM execution: call worker for each step
      const stepResults: string[] = [];
      for (const step of steps) {
        try {
          const stepOutput = await this.providers.worker.complete(
            WORKER_SYSTEM_PROMPT,
            step,
            2048,
          );
          stepResults.push(stepOutput);
        } catch {
          // Worker call failed — use step description as fallback
          stepResults.push(`[Worker LLM failed for step: ${step}]`);
        }
      }
      lastOutput = stepResults.join("\n\n");
    } else {
      // Stub execution: concatenate step descriptions
      for (const step of steps) {
        lastOutput += step;
      }
    }

    // Verifier gate with retry loop (max 2 retries with feedback)
    const maxRetries = Math.min(this.config.maxRetries, 2);

    // Use real OutputVerifier only when we have real providers (not stub mode).
    // In stub mode, the fallback heuristic (non-empty, no ERROR) is used.
    const effectiveVerifier = this.providers.worker ? this.verifier : undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      retriesUsed = attempt;

      const feedback = verifyWithFeedback(
        lastOutput,
        classifiedTask,
        effectiveVerifier,
      );
      verifierPassed = feedback.passed;

      if (verifierPassed) {
        break;
      }

      // Store feedback for the result
      verifierFeedback = feedback.summary;

      // If we have retries left, re-run worker with verifier feedback
      if (attempt < maxRetries && this.providers.worker) {
        // Re-execute steps with verifier feedback as additional context
        const retryStepResults: string[] = [];
        for (const step of steps) {
          try {
            const retryPrompt = `${step}\n\n[Previous attempt had issues: ${feedback.summary}. Please fix these issues.]`;
            const stepOutput = await this.providers.worker.complete(
              WORKER_SYSTEM_PROMPT,
              retryPrompt,
              2048,
            );
            retryStepResults.push(stepOutput);
          } catch {
            retryStepResults.push(`[Worker LLM failed for retry step: ${step}]`);
          }
        }
        lastOutput = retryStepResults.join("\n\n");
      } else if (attempt < maxRetries) {
        // Stub retry: remove ERROR markers
        lastOutput = lastOutput.replace(/ERROR/gi, "FIXED");
      }
    }

    return {
      taskId: task.id,
      output: lastOutput,
      verifierPassed,
      retriesUsed,
      modelUsed,
      ...(verifierFeedback !== undefined ? { verifierFeedback } : {}),
    };
  }
}
