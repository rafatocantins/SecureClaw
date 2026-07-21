/**
 * orchestrator.test.ts — Unit tests for the Phase 3D Orchestrator.
 *
 * Covers: triage classifier, model router, task decomposer,
 * output verifier, orchestrator pipeline, config loading, and retry logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Orchestrator, loadConfigFromEnv } from "../orchestrator.js";
import { classifyComplexity } from "../triage-classifier.js";
import { routeModel } from "../model-router.js";
import { decompose } from "../task-decomposer.js";
import { verify } from "../output-verifier.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "../types.js";
import type { OrchestratorConfig, Task } from "../types.js";

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
    // "critical" + "refactor" → should be "critical"
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
    // "critical" (security) takes priority over "complex" (infrastructure, deployment) and "simple" (ping)
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
    // A simple echo task should go through worker model
    const complexity = classifyComplexity("echo hello");
    const model = routeModel(complexity, config);
    expect(complexity).toBe("simple");
    expect(model).toBe(config.workerModel);

    // A security incident should go through thinker model
    const complexity2 = classifyComplexity("security breach in production");
    const model2 = routeModel(complexity2, config);
    expect(complexity2).toBe("critical");
    expect(model2).toBe(config.thinkerModel);
  });
});

// ── decompose ───────────────────────────────────────────────────────────────

describe("decompose", () => {
  it("returns task description as single step (stub)", () => {
    const task = makeTask({ description: "do thing A then thing B" });
    const steps = decompose(task);
    expect(steps).toEqual(["do thing A then thing B"]);
    expect(steps).toHaveLength(1);
  });
});

// ── verify ──────────────────────────────────────────────────────────────────

describe("verify", () => {
  it("passes non-empty output without ERROR marker", () => {
    const task = makeTask();
    expect(verify("All tests passed", task)).toBe(true);
    expect(verify("Build successful", task)).toBe(true);
  });

  it("fails when output is empty", () => {
    const task = makeTask();
    expect(verify("", task)).toBe(false);
  });

  it("fails when output contains ERROR marker", () => {
    const task = makeTask();
    expect(verify("ERROR: connection refused", task)).toBe(false);
    expect(verify("some output before ERROR", task)).toBe(false);
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

    it("retries when verification fails and can pass on retry", async () => {
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

      // With 1 retry, ERROR → FIXED on first retry, so verifier passes
      expect(result.retriesUsed).toBe(1);
      expect(result.verifierPassed).toBe(true);
      expect(result.output).not.toContain("ERROR");
    });

    it("stops retrying early if verification passes on a retry", async () => {
      // The retry logic replaces ERROR → FIXED.
      // With maxRetries=3 and output containing "ERROR", the first retry fixes it
      // and the loop breaks early — retriesUsed should be 1 (not 3).
      const orchestrator = new Orchestrator({ enabled: true, maxRetries: 3 });
      const task = makeTask({ description: "echo ERROR" });

      const result = await orchestrator.execute(task);

      expect(result.retriesUsed).toBe(1);
      expect(result.verifierPassed).toBe(true);
      expect(result.output).toContain("FIXED");
    });
  });
});

// ── loadConfigFromEnv ───────────────────────────────────────────────────────

describe("loadConfigFromEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save relevant env vars
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
    // Restore saved env vars
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

    // Number("not-a-number") is NaN, NaN || default returns default
    expect(config.maxRetries).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxRetries);
  });
});
