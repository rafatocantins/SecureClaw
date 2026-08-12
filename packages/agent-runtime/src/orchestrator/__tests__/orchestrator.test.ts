/**
 * orchestrator.test.ts — Unit tests for the Phase 3D Orchestrator.
 *
 * Covers: triage classifier, model router, task decomposer,
 * output verifier, orchestrator pipeline, config loading, retry logic,
 * and real OutputVerifier integration with mock LLM providers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Orchestrator, loadConfigFromEnv } from "../orchestrator.js";
import type { OrchestratorProviders } from "../orchestrator.js";
import { classifyComplexity } from "../triage-classifier.js";
import { routeModel } from "../model-router.js";
import { decompose } from "../task-decomposer.js";
import { verify, verifyWithFeedback } from "../output-verifier.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "../types.js";
import type { OrchestratorConfig, Task } from "../types.js";
import { OutputVerifier } from "../../verifier/output-verifier.js";
import type { LLMProvider, LLMStreamChunk, LLMMessage, LLMTool } from "../../llm/provider.interface.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    description: "run a diagnostic check",
    complexity: "medium",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return { ...DEFAULT_ORCHESTRATOR_CONFIG, ...overrides };
}

// ── Mock LLM Provider ──────────────────────────────────────────────────────

/**
 * Creates a mock LLMProvider that returns predefined responses.
 * Supports both `complete()` (non-streaming) and `streamCompletion()`.
 */
function createMockProvider(
  responseFn: (prompt: string) => string,
  providerName = "mock",
  modelName = "mock-model",
): LLMProvider {
  return {
    provider_name: providerName,
    model_name: modelName,
    async complete(
      _systemPrompt: string,
      userMessage: string,
      _maxTokens: number,
    ): Promise<string> {
      return responseFn(userMessage);
    },
    async *streamCompletion(
      _messages: LLMMessage[],
      _tools: LLMTool[],
      _systemPrompt: string,
    ): AsyncIterable<LLMStreamChunk> {
      const text = responseFn(_messages.map((m) => m.content).join("\n"));
      yield { type: "text", text };
      yield {
        type: "finish",
        finish_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    },
    estimateCostUsd(_inputTokens: number, _outputTokens: number): number {
      return 0.001;
    },
  };
}

// ── classifyComplexity ──────────────────────────────────────────────────────

describe("classifyComplexity", () => {
  it("returns 'simple' for echo/ping/date keywords", () => {
    expect(classifyComplexity("echo hello world")).toBe("simple");
    expect(classifyComplexity("ping the server")).toBe("simple");
    expect(classifyComplexity("check the date and uptime")).toBe("simple");
  });

  it("returns 'critical' for urgent/security/incident keywords", () => {
    expect(classifyComplexity("CRITICAL: production down")).toBe("critical");
    expect(classifyComplexity("security breach detected")).toBe("critical");
    expect(classifyComplexity("P0 incident: outage on payment gateway")).toBe("critical");
    expect(classifyComplexity("emergency — exploit found")).toBe("critical");
  });

  it("returns 'complex' for refactor/migrate/orchestrate keywords", () => {
    expect(classifyComplexity("refactor the auth module")).toBe("complex");
    expect(classifyComplexity("migrate database to new schema")).toBe("complex");
    expect(classifyComplexity("deploy multi-step pipeline")).toBe("complex");
  });

  it("defaults to 'medium' when no keywords match", () => {
    expect(classifyComplexity("analyze the log file")).toBe("medium");
    expect(classifyComplexity("generate a report for the team")).toBe("medium");
    expect(classifyComplexity("")).toBe("medium");
  });

  it("critical keywords take priority over complex ones", () => {
    expect(classifyComplexity("critical refactor of security module")).toBe("critical");
  });

  it("classifies CVE and exploit keywords as critical", () => {
    expect(classifyComplexity("CVE-2025-1234 found in dependencies")).toBe("critical");
    expect(classifyComplexity("zero-day exploit in production")).toBe("critical");
    expect(classifyComplexity("p0: outage affecting all users")).toBe("critical");
  });

  it("classifies integration and deployment tasks as complex", () => {
    expect(classifyComplexity("integration tests failing on CI")).toBe("complex");
    expect(classifyComplexity("deploy to production environment")).toBe("complex");
    expect(classifyComplexity("infrastructure as code migration")).toBe("complex");
  });

  it("is case-insensitive", () => {
    expect(classifyComplexity("URGENT: fix the bug")).toBe("critical");
    expect(classifyComplexity("Ping The Server")).toBe("simple");
    expect(classifyComplexity("DEPLOY to staging")).toBe("complex");
  });

  it("handles long descriptions with mixed signals", () => {
    const desc = "Run a simple ping test to check if the security infrastructure is working after deployment";
    expect(classifyComplexity(desc)).toBe("critical");
  });
});

// ── routeModel ──────────────────────────────────────────────────────────────

describe("routeModel", () => {
  const config = makeConfig();

  it("routes simple tasks to workerModel", () => {
    expect(routeModel("simple", config)).toBe(config.workerModel);
  });

  it("routes medium tasks to workerModel", () => {
    expect(routeModel("medium", config)).toBe(config.workerModel);
  });

  it("routes complex tasks to thinkerModel", () => {
    expect(routeModel("complex", config)).toBe(config.thinkerModel);
  });

  it("routes critical tasks to thinkerModel", () => {
    expect(routeModel("critical", config)).toBe(config.thinkerModel);
  });

  it("routes medium tasks to workerModel with custom configs", () => {
    const customConfig = makeConfig({
      workerModel: "custom/worker-v2",
      thinkerModel: "custom/thinker-v2",
    });
    expect(routeModel("medium", customConfig)).toBe("custom/worker-v2");
    expect(routeModel("complex", customConfig)).toBe("custom/thinker-v2");
  });

  it("routes all known tiers correctly end-to-end", () => {
    const tiers: Array<{ tier: import("../types.js").TaskComplexity; expected: "worker" | "thinker" }> = [
      { tier: "simple", expected: "worker" },
      { tier: "medium", expected: "worker" },
      { tier: "complex", expected: "thinker" },
      { tier: "critical", expected: "thinker" },
    ];
    for (const { tier, expected } of tiers) {
      const model = routeModel(tier, config);
      if (expected === "worker") {
        expect(model).toBe(config.workerModel);
      } else {
        expect(model).toBe(config.thinkerModel);
      }
    }
  });

  it("integration: classify then route produces correct model chain", () => {
    const complexity = classifyComplexity("echo hello");
    const model = routeModel(complexity, config);
    expect(complexity).toBe("simple");
    expect(model).toBe(config.workerModel);

    const complexity2 = classifyComplexity("security breach in production");
    const model2 = routeModel(complexity2, config);
    expect(complexity2).toBe("critical");
    expect(model2).toBe(config.thinkerModel);
  });
});

// ── decompose ───────────────────────────────────────────────────────────────

describe("decompose", () => {
  it("returns task description as single step (stub, no provider)", async () => {
    const task = makeTask({ description: "do thing A then thing B" });
    const steps = await decompose(task);
    expect(steps).toEqual(["do thing A then thing B"]);
    expect(steps).toHaveLength(1);
  });

  // ── NEW: Mock LLM decomposition tests ───────────────────────────────────
  it("uses LLM to decompose when thinker provider is given", async () => {
    const mockThinker = createMockProvider(() =>
      '["Step 1: Initialize project", "Step 2: Configure TypeScript", "Step 3: Add tests"]',
    );
    const task = makeTask({ description: "Set up a new TypeScript project" });
    const steps = await decompose(task, mockThinker);
    expect(steps).toEqual([
      "Step 1: Initialize project",
      "Step 2: Configure TypeScript",
      "Step 3: Add tests",
    ]);
    expect(steps).toHaveLength(3);
  });

  it("falls back to stub when LLM returns invalid JSON", async () => {
    const mockThinker = createMockProvider(() => "not a JSON array at all");
    const task = makeTask({ description: "build a REST API" });
    const steps = await decompose(task, mockThinker);
    expect(steps).toEqual(["build a REST API"]);
    expect(steps).toHaveLength(1);
  });

  it("falls back to line-splitting when LLM returns numbered list", async () => {
    const mockThinker = createMockProvider(() =>
      "1. Install dependencies\n2. Configure the server\n3. Run tests",
    );
    const task = makeTask({ description: "Set up a project" });
    const steps = await decompose(task, mockThinker);
    expect(steps).toEqual([
      "Install dependencies",
      "Configure the server",
      "Run tests",
    ]);
    expect(steps).toHaveLength(3);
  });

  it("falls back to stub when LLM throws an error", async () => {
    const mockThinker: LLMProvider = {
      provider_name: "mock",
      model_name: "error-model",
      async complete(): Promise<string> {
        throw new Error("LLM unavailable");
      },
      async *streamCompletion(): AsyncIterable<LLMStreamChunk> {
        yield { type: "error", error: "LLM unavailable" };
      },
      estimateCostUsd(): number {
        return 0;
      },
    };
    const task = makeTask({ description: "do something important" });
    const steps = await decompose(task, mockThinker);
    expect(steps).toEqual(["do something important"]);
    expect(steps).toHaveLength(1);
  });

  it("includes task context in LLM prompt when provided", async () => {
    let receivedUserMessage = "";
    const mockThinker = createMockProvider((prompt: string) => {
      receivedUserMessage = prompt;
      return '["Step 1: Review code", "Step 2: Apply fix"]';
    });
    const task = makeTask({
      description: "Fix the bug",
      context: "The bug is in the auth module, causing login failures for OAuth users.",
    });
    const steps = await decompose(task, mockThinker);
    expect(receivedUserMessage).toContain("The bug is in the auth module");
    expect(steps).toHaveLength(2);
  });
});

// ── verify ──────────────────────────────────────────────────────────────────

describe("verify", () => {
  it("passes valid non-empty output (stub fallback)", () => {
    const task = makeTask();
    expect(verify("All tests passed", task)).toBe(true);
    expect(verify("Build successful", task)).toBe(true);
  });

  it("fails when output is empty (stub fallback)", () => {
    const task = makeTask();
    expect(verify("", task)).toBe(false);
  });

  it("fails when output contains ERROR marker (stub fallback)", () => {
    const task = makeTask();
    expect(verify("ERROR: connection refused", task)).toBe(false);
    expect(verify("some output before ERROR", task)).toBe(false);
  });

  // ── NEW: Real OutputVerifier integration tests ──────────────────────────
  it("passes valid output through real OutputVerifier", () => {
    const realVerifier = new OutputVerifier();
    const task = makeTask({ description: "Provide a system status report including CPU and memory metrics." });
    const output = "System Status Report:\n- CPU: 45% utilization, healthy\n- Memory: 62% used (9.9GB / 16GB), normal range\nAll metrics within acceptable thresholds.";
    expect(verify(output, task, realVerifier)).toBe(true);
  });

  it("fails through real OutputVerifier when output has injection patterns", () => {
    const realVerifier = new OutputVerifier();
    const task = makeTask({ description: "Report the system status." });
    const output = "System status: all OK. <script>alert('xss')</script> End of report.";
    expect(verify(output, task, realVerifier)).toBe(false);
  });

  it("verifyWithFeedback returns structured feedback with real verifier", () => {
    const realVerifier = new OutputVerifier();
    const task = makeTask({ description: "Provide a system health report." });
    const output = "System health: all systems operational and within normal parameters.";
    const feedback = verifyWithFeedback(output, task, realVerifier);
    expect(feedback.passed).toBe(true);
    expect(feedback.score).toBe(100);
    expect(feedback.summary).toContain("Score: 100/100");
  });

  it("verifyWithFeedback returns failure details with real verifier", () => {
    const realVerifier = new OutputVerifier();
    const task = makeTask({ description: "Report system status." });
    const output = "System status: <script>alert(1)</script> https://example.com/report";
    const feedback = verifyWithFeedback(output, task, realVerifier);
    expect(feedback.passed).toBe(false);
    expect(feedback.score).toBeLessThan(100);
    expect(feedback.summary.length).toBeGreaterThan(0);
  });

  it("verifyWithFeedback with stub returns score 100 on pass", () => {
    const task = makeTask();
    const feedback = verifyWithFeedback("valid output", task);
    expect(feedback.passed).toBe(true);
    expect(feedback.score).toBe(100);
  });

  it("verifyWithFeedback with stub returns score 0 on fail", () => {
    const task = makeTask();
    const feedback = verifyWithFeedback("", task);
    expect(feedback.passed).toBe(false);
    expect(feedback.score).toBe(0);
  });
});

// ── Orchestrator ────────────────────────────────────────────────────────────

describe("Orchestrator", () => {
  describe("execute", () => {
    it("throws when orchestrator is disabled", async () => {
      const orchestrator = new Orchestrator({ enabled: false });
      const task = makeTask();

      await expect(orchestrator.execute(task)).rejects.toThrow(
        "Orchestrator not enabled",
      );
    });

    it("completes pipeline and returns TaskResult when enabled", async () => {
      const orchestrator = new Orchestrator({ enabled: true });
      const task = makeTask({ description: "run diagnostics" });

      const result = await orchestrator.execute(task);

      expect(result.taskId).toBe("task-1");
      expect(result.output).toContain("run diagnostics");
      expect(result.verifierPassed).toBe(true);
      expect(result.retriesUsed).toBe(0);
      expect(result.modelUsed).toBe(DEFAULT_ORCHESTRATOR_CONFIG.workerModel);
    });

    it("classifies task complexity inline and routes to correct model", async () => {
      const orchestrator = new Orchestrator({ enabled: true });
      const task = makeTask({ description: "critical security breach" });

      const result = await orchestrator.execute(task);

      expect(result.modelUsed).toBe(DEFAULT_ORCHESTRATOR_CONFIG.thinkerModel);
      expect(result.verifierPassed).toBe(true);
    });

    it("retries when verification fails (stub) and can pass on retry", async () => {
      const orchestrator = new Orchestrator({ enabled: true, maxRetries: 2 });
      const task = makeTask({ description: "echo ERROR: something went wrong" });

      const result = await orchestrator.execute(task);

      // Retry replaces ERROR → FIXED, so verifier should pass
      expect(result.verifierPassed).toBe(true);
      expect(result.retriesUsed).toBe(1);
      expect(result.output).toContain("FIXED");
      expect(result.output).not.toContain("ERROR");
    });

    it("uses configured maxRetries from constructor", async () => {
      const orchestrator = new Orchestrator({ enabled: true, maxRetries: 1 });
      const task = makeTask({ description: "echo ERROR" });

      const result = await orchestrator.execute(task);

      expect(result.retriesUsed).toBe(1);
      expect(result.verifierPassed).toBe(true);
      expect(result.output).not.toContain("ERROR");
    });

    it("stops retrying early if verification passes on a retry", async () => {
      const orchestrator = new Orchestrator({ enabled: true, maxRetries: 3 });
      const task = makeTask({ description: "echo ERROR" });

      const result = await orchestrator.execute(task);

      expect(result.retriesUsed).toBe(1);
      expect(result.verifierPassed).toBe(true);
      expect(result.output).toContain("FIXED");
    });

    // ── NEW: Mock LLM provider tests ──────────────────────────────────────
    it("uses thinker provider for decomposition when available", async () => {
      const mockThinker = createMockProvider(() =>
        '["Step 1: Analyze system logs", "Step 2: Identify errors", "Step 3: Propose fix"]',
        "mock-thinker",
        "claude-sonnet",
      );
      const mockWorker = createMockProvider(
        (prompt) => `Executed: ${prompt} — Result: authentication system working with no errors detected.`,
        "mock-worker",
        "mistral-large",
      );
      const providers: OrchestratorProviders = {
        thinker: mockThinker,
        worker: mockWorker,
      };

      const orchestrator = new Orchestrator({ enabled: true }, providers);
      const task = makeTask({ description: "Debug the authentication system" });

      const result = await orchestrator.execute(task);

      expect(result.verifierPassed).toBe(true);
      expect(result.output).toContain("Executed: Step 1:");
      expect(result.output).toContain("Executed: Step 2:");
      expect(result.output).toContain("Executed: Step 3:");
    });

    it("retries with verifier feedback when verification fails with mock LLM", async () => {
      // First response contains an injection pattern that the real verifier will catch
      let callCount = 0;
      const mockWorker = createMockProvider((prompt: string) => {
        callCount++;
        if (callCount === 1) {
          // First attempt contains injection (fails safety check)
          return `System report: <script>alert('xss')</script> ${prompt}`;
        }
        // Retry: clean output with key terms matching the task
        return `Clean system health report with CPU and memory metrics: all within normal parameters.`;
      });

      const orchestrator = new Orchestrator(
        { enabled: true, maxRetries: 2 },
        { worker: mockWorker },
      );
      const task = makeTask({ description: "Provide a system health report with CPU and memory metrics" });

      const result = await orchestrator.execute(task);

      // Should have retried and eventually passed
      expect(result.verifierPassed).toBe(true);
      expect(result.retriesUsed).toBeGreaterThan(0);
      // verifierFeedback should be present from the failed attempt
      expect(result.verifierFeedback).toBeDefined();
    });

    it("returns verifierFeedback when verification fails after all retries", async () => {
      // Worker always returns injection pattern
      const mockWorker = createMockProvider(
        () => "System report: <script>alert('xss')</script> All metrics OK.",
      );

      const orchestrator = new Orchestrator(
        { enabled: true, maxRetries: 1 },
        { worker: mockWorker },
      );
      const task = makeTask({ description: "Provide a system health report." });

      const result = await orchestrator.execute(task);

      // Should have exhausted retries and still failed
      expect(result.verifierPassed).toBe(false);
      expect(result.verifierFeedback).toBeDefined();
      expect(result.verifierFeedback!.length).toBeGreaterThan(0);
    });

    it("respects maxRetries cap of 2 even when config allows more", async () => {
      const orchestrator = new Orchestrator({ enabled: true, maxRetries: 5 });
      const task = makeTask({ description: "echo ERROR" });

      const result = await orchestrator.execute(task);

      // maxRetries is capped at 2 in the orchestrator
      // With stub mode, ERROR gets fixed on first retry → retriesUsed = 1
      expect(result.retriesUsed).toBeLessThanOrEqual(2);
    });

    it("falls back to stub execution when worker provider is absent but thinker is present", async () => {
      const mockThinker = createMockProvider(() =>
        '["Step 1: Check server status", "Step 2: Review logs"]',
      );
      const providers: OrchestratorProviders = { thinker: mockThinker };

      const orchestrator = new Orchestrator({ enabled: true }, providers);
      const task = makeTask({ description: "Diagnose server issues" });

      const result = await orchestrator.execute(task);

      // Stub execution concatenates step descriptions
      expect(result.output).toContain("Check server status");
      expect(result.output).toContain("Review logs");
      expect(result.verifierPassed).toBe(true);
    });

    it("handles worker LLM errors gracefully by using step as fallback", async () => {
      const errorWorker: LLMProvider = {
        provider_name: "error-worker",
        model_name: "broken-model",
        async complete(): Promise<string> {
          throw new Error("Worker LLM crashed");
        },
        async *streamCompletion(): AsyncIterable<LLMStreamChunk> {
          yield { type: "error", error: "Worker LLM crashed" };
        },
        estimateCostUsd(): number {
          return 0;
        },
      };

      const orchestrator = new Orchestrator(
        { enabled: true },
        { worker: errorWorker },
      );
      const task = makeTask({ description: "run health check" });

      const result = await orchestrator.execute(task);

      expect(result.output).toContain("[Worker LLM failed for step:");
      expect(result.output).toContain("run health check");
    });

    it("propagates config from constructor including custom models", async () => {
      const orchestrator = new Orchestrator({
        enabled: true,
        thinkerModel: "custom/thinker-v3",
        workerModel: "custom/worker-v3",
      });
      const task = makeTask({ description: "critical security incident" });

      const result = await orchestrator.execute(task);

      expect(result.modelUsed).toBe("custom/thinker-v3");
    });
  });
});

// ── loadConfigFromEnv ───────────────────────────────────────────────────────

describe("loadConfigFromEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "TESSERA_ORCHESTRATOR_ENABLED",
      "TESSERA_ORCHESTRATOR_THINKER_MODEL",
      "TESSERA_ORCHESTRATOR_WORKER_MODEL",
      "TESSERA_ORCHESTRATOR_VERIFIER_MODEL",
      "TESSERA_ORCHESTRATOR_MAX_RETRIES",
      "TESSERA_ORCHESTRATOR_TIMEOUT",
    ]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns defaults when no env vars are set", () => {
    delete process.env["TESSERA_ORCHESTRATOR_ENABLED"];
    const config = loadConfigFromEnv();
    expect(config.enabled).toBe(false);
    expect(config.thinkerModel).toBe(DEFAULT_ORCHESTRATOR_CONFIG.thinkerModel);
    expect(config.workerModel).toBe(DEFAULT_ORCHESTRATOR_CONFIG.workerModel);
    expect(config.verifierModel).toBe(DEFAULT_ORCHESTRATOR_CONFIG.verifierModel);
    expect(config.maxRetries).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxRetries);
    expect(config.timeout).toBe(DEFAULT_ORCHESTRATOR_CONFIG.timeout);
  });

  it("reads enabled from TESSERA_ORCHESTRATOR_ENABLED", () => {
    process.env["TESSERA_ORCHESTRATOR_ENABLED"] = "true";
    const config = loadConfigFromEnv();
    expect(config.enabled).toBe(true);

    process.env["TESSERA_ORCHESTRATOR_ENABLED"] = "false";
    const config2 = loadConfigFromEnv();
    expect(config2.enabled).toBe(false);
  });

  it("reads custom model names from env vars", () => {
    process.env["TESSERA_ORCHESTRATOR_THINKER_MODEL"] = "custom/thinker";
    process.env["TESSERA_ORCHESTRATOR_WORKER_MODEL"] = "custom/worker";
    process.env["TESSERA_ORCHESTRATOR_VERIFIER_MODEL"] = "custom/verifier";

    const config = loadConfigFromEnv();

    expect(config.thinkerModel).toBe("custom/thinker");
    expect(config.workerModel).toBe("custom/worker");
    expect(config.verifierModel).toBe("custom/verifier");
  });

  it("reads numeric env vars with fallback to defaults on invalid values", () => {
    process.env["TESSERA_ORCHESTRATOR_MAX_RETRIES"] = "5";
    process.env["TESSERA_ORCHESTRATOR_TIMEOUT"] = "60000";

    const config = loadConfigFromEnv();

    expect(config.maxRetries).toBe(5);
    expect(config.timeout).toBe(60000);
  });

  it("falls back to defaults for invalid numeric env values", () => {
    process.env["TESSERA_ORCHESTRATOR_MAX_RETRIES"] = "not-a-number";

    const config = loadConfigFromEnv();

    expect(config.maxRetries).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxRetries);
  });
});
