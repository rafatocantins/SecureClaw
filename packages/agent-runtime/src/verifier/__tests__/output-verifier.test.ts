/**
 * output-verifier.test.ts — Unit tests for the OutputVerifier.
 *
 * Covers all four verification categories plus boundary and edge cases.
 * Minimum 8 tests as required by the spec.
 */

import { describe, it, expect } from "vitest";
import { OutputVerifier } from "../output-verifier.js";
import type { VerificationInput } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    taskDescription: "Summarize the Q3 financial report and highlight key metrics.",
    agentOutput:
      "The Q3 financial report shows revenue of $12.5M (up 15% YoY), operating margin of 22%, and net income of $3.2M. Key metrics: revenue growth, margin expansion, and cash flow improvement.",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OutputVerifier", () => {
  const verifier = new OutputVerifier();

  // ── Test 1: Valid output passes all checks ──────────────────────────────
  it("passes all checks for a valid, complete output", () => {
    const input = makeInput();
    const result = verifier.verify(input);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.summary).toContain("Score: 100/100");
  });

  // ── Test 2: Output with hallucination markers fails factuality ──────────
  it("fails factuality when output contains hallucination markers", () => {
    const input = makeInput({
      taskDescription: "Describe the current weather in Lisbon.",
      agentOutput:
        "The weather in Lisbon is sunny at 22°C. [TODO: add humidity] Source: https://example.com/weather. Winds are light at 10 km/h.",
    });
    const result = verifier.verify(input);

    expect(result.passed).toBe(false);
    // factuality fails (-25). Completeness: key terms "Describe" "current" "weather" "Lisbon" — 
    // output contains "weather", "Lisbon" → enough to pass. Score = 75.
    expect(result.score).toBe(75);

    const factCheck = result.checks.find((c) => c.category === "factuality")!;
    expect(factCheck.passed).toBe(false);
    expect(factCheck.detail).toContain("Hallucination markers detected");
  });

  // ── Test 3: Incomplete output fails completeness ────────────────────────
  it("fails completeness when output is missing key task terms", () => {
    const input = makeInput({
      taskDescription: "Analyze the database migration strategy, backup procedures, and rollback plan.",
      agentOutput: "The database is working fine.", // Missing all key terms
    });
    const result = verifier.verify(input);

    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThanOrEqual(75); // completeness fails

    const compCheck = result.checks.find((c) => c.category === "completeness")!;
    expect(compCheck.passed).toBe(false);
    expect(compCheck.detail).toContain("missing");
  });

  // ── Test 4: Output with code injection fails safety ─────────────────────
  it("fails safety when output contains script injection", () => {
    const input = makeInput({
      taskDescription: "Report the system status.",
      agentOutput:
        "The system status report: CPU at 45%, memory at 62%, disk at 71%. <script>alert('xss')</script> All systems operational.",
    });
    const result = verifier.verify(input);

    expect(result.passed).toBe(false);
    // safety fails (-25). Completeness should pass since output covers key terms.
    expect(result.score).toBe(75);

    const safetyCheck = result.checks.find((c) => c.category === "safety")!;
    expect(safetyCheck.passed).toBe(false);
    expect(safetyCheck.detail).toContain("Injection patterns detected");
  });

  it("fails safety when output contains SQL injection pattern", () => {
    const input = makeInput({
      taskDescription: "Query user data.",
      agentOutput: "Query results: SELECT * FROM users WHERE name = 'admin' OR '1'='1'",
    });
    const result = verifier.verify(input);

    const safetyCheck = result.checks.find((c) => c.category === "safety")!;
    expect(safetyCheck.passed).toBe(false);
  });

  it("fails safety when output contains shell injection pattern", () => {
    const input = makeInput({
      taskDescription: "Run system cleanup.",
      agentOutput: "Running cleanup: cleanup.sh; rm -rf /important",
    });
    const result = verifier.verify(input);

    const safetyCheck = result.checks.find((c) => c.category === "safety")!;
    expect(safetyCheck.passed).toBe(false);
    expect(safetyCheck.detail).toContain("Injection patterns detected");
  });

  // ── Test 5: Boundary — empty input (taskDescription and output) ─────────
  it("handles completely empty input gracefully", () => {
    const input: VerificationInput = {
      taskDescription: "",
      agentOutput: "",
    };
    const result = verifier.verify(input);

    expect(result.checks).toHaveLength(4);
    // factuality fails (empty), completeness vacuously passes (no task),
    // safety passes (empty), compliance passes (empty)
    expect(result.score).toBe(75);
    expect(result.passed).toBe(false);

    const factCheck = result.checks.find((c) => c.category === "factuality")!;
    expect(factCheck.passed).toBe(false);

    const safetyCheck = result.checks.find((c) => c.category === "safety")!;
    expect(safetyCheck.passed).toBe(true);

    const compCheck = result.checks.find((c) => c.category === "completeness")!;
    expect(compCheck.passed).toBe(true); // No task → vacuously complete
  });

  // ── Test 6: Boundary — empty output with a task description ─────────────
  it("fails when agent output is empty but task description is provided", () => {
    const input = makeInput({ agentOutput: "" });
    const result = verifier.verify(input);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(50); // factuality fails, completeness fails, safety+compliance pass

    const factCheck = result.checks.find((c) => c.category === "factuality")!;
    expect(factCheck.passed).toBe(false);

    const compCheck = result.checks.find((c) => c.category === "completeness")!;
    expect(compCheck.passed).toBe(false);
    expect(compCheck.detail).toContain("empty");
  });

  // ── Test 7: Scoring — each check contributes exactly 25 points ──────────
  it("scores exactly 25 per passing check (verify all combinations)", () => {
    // All passing = 100
    const perfect = verifier.verify(makeInput());
    expect(perfect.score).toBe(100);

    // Factuality failure = 75 (use task with terms covered by output)
    const factFail = verifier.verify(
      makeInput({
        taskDescription: "Report on weather in Lisbon.",
        agentOutput: "Weather in Lisbon: sunny, 22°C. See https://example.com/weather [TODO: verify].",
      })
    );
    expect(factFail.score).toBe(75);

    // Safety failure = 75
    const safetyFail = verifier.verify(
      makeInput({
        taskDescription: "Report system status.",
        agentOutput: "System status: all OK. <script>alert(1)</script> End of report.",
      })
    );
    expect(safetyFail.score).toBe(75);

    // Both factuality + safety fail = 50
    const doubleFail = verifier.verify(
      makeInput({
        taskDescription: "Report system status.",
        agentOutput: "System status: <script>alert(1)</script> Report at https://example.com [TODO: verify].",
      })
    );
    expect(doubleFail.score).toBe(50);

    // All fail with empty output = 50 (safety + compliance pass vacuously)
    const emptyOut = verifier.verify(makeInput({ agentOutput: "" }));
    expect(emptyOut.score).toBe(50);
  });

  // ── Test 8: Edge case — perfect output scores 100 ───────────────────────
  it("scores 100/100 for a perfect, comprehensive output", () => {
    const input: VerificationInput = {
      taskDescription: "Provide a comprehensive system health report including CPU, memory, and disk metrics.",
      agentOutput:
        "System Health Report:\n" +
        "- CPU: 45% utilization across 8 cores, healthy\n" +
        "- Memory: 62% used (9.9GB / 16GB), normal range\n" +
        "- Disk: 71% used (178GB / 250GB), no alerts\n" +
        "All metrics are within acceptable thresholds. No action required.",
    };
    const result = verifier.verify(input);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.summary).toContain("All 4 checks passed");
  });

  // ── Test 9: Safety context is reflected in check details ────────────────
  it("includes safety context in check details when provided", () => {
    const input = makeInput({
      safetyContext: "user-facing",
      agentOutput: "Report: all systems operational.",
    });
    const result = verifier.verify(input);

    const safetyCheck = result.checks.find((c) => c.category === "safety")!;
    expect(safetyCheck.passed).toBe(true);
    expect(safetyCheck.detail).toContain("user-facing");
  });

  // ── Test 10: Compliance EU AI Act violations are detected ────────────────
  it("fails compliance when EU AI Act violations are detected", () => {
    const input = makeInput({
      taskDescription: "Recommend an engagement strategy.",
      agentOutput:
        "We recommend using subliminal manipulation techniques to increase user engagement and retention rates.",
    });
    const result = verifier.verify(input);

    const compCheck = result.checks.find((c) => c.category === "compliance")!;
    expect(compCheck.passed).toBe(false);
    expect(compCheck.detail).toContain("EU AI Act");
    // compliance fails (-25). Completeness should pass.
    expect(result.score).toBe(75);
  });

  // ── Test 11: VerificationResult has correct structure ───────────────────
  it("returns correctly structured VerificationResult", () => {
    const result = verifier.verify(makeInput());

    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("checks");
    expect(result).toHaveProperty("summary");

    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(typeof result.summary).toBe("string");

    for (const check of result.checks) {
      expect(check).toHaveProperty("category");
      expect(check).toHaveProperty("passed");
      expect(check).toHaveProperty("detail");
      expect(["factuality", "completeness", "safety", "compliance"]).toContain(
        check.category,
      );
    }
  });
});
