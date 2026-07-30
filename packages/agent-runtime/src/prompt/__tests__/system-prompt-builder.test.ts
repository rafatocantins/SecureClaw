/**
 * system-prompt-builder.test.ts — Tests for the security system prompt builder,
 * including harness patch injection.
 */
import { describe, it, expect } from "vitest";
import {
  buildSecuritySystemPrompt,
  type HarnessPatchPrompt,
  type SystemPromptParams,
} from "../system-prompt-builder.js";

function makeParams(overrides: Partial<SystemPromptParams> = {}): SystemPromptParams {
  return {
    agentName: "Tessera",
    sessionId: "sess-test",
    sessionDelimiter: "<SC-sess-test>",
    allowedToolIds: ["file_read", "shell_exec"],
    costCapUsd: 5.0,
    ...overrides,
  };
}

describe("buildSecuritySystemPrompt — harness patches", () => {
  it("activePatches=empty array produces identical output to no patches", () => {
    const withoutPatches = buildSecuritySystemPrompt(makeParams());
    const withEmpty = buildSecuritySystemPrompt(
      makeParams({ activePatches: [] })
    );
    expect(withEmpty).toBe(withoutPatches);
  });

  it("activePatches=undefined produces identical output to no patches", () => {
    const withoutPatches = buildSecuritySystemPrompt(makeParams());
    const withUndefined = buildSecuritySystemPrompt(
      makeParams({ activePatches: undefined })
    );
    expect(withUndefined).toBe(withoutPatches);
  });

  it("injects 2 patches into Active Harness Improvements section", () => {
    const patches: HarnessPatchPrompt[] = [
      {
        id: "patch-1",
        proposedChange: "Always validate tool inputs before execution",
        confidence: 0.85,
      },
      {
        id: "patch-2",
        proposedChange: "Prefer read-only operations when uncertain",
        confidence: 0.72,
      },
    ];

    const prompt = buildSecuritySystemPrompt(makeParams({ activePatches: patches }));

    // Verify the section exists
    expect(prompt).toContain("## Active Harness Improvements");
    expect(prompt).toContain(
      "The following improvements were applied by the harness self-evolution system:"
    );

    // Verify both patches are visible
    expect(prompt).toContain(
      "- Always validate tool inputs before execution (confidence: 85%)"
    );
    expect(prompt).toContain(
      "- Prefer read-only operations when uncertain (confidence: 72%)"
    );
  });

  it("injects a single patch with correct confidence formatting", () => {
    const patches: HarnessPatchPrompt[] = [
      {
        id: "patch-single",
        proposedChange: "Notify user before making network calls",
        confidence: 0.999,
      },
    ];

    const prompt = buildSecuritySystemPrompt(
      makeParams({ activePatches: patches })
    );

    expect(prompt).toContain("confidence: 100%)"); // 0.999*100 ≈ 100
  });

  it("security invariants are preserved after patch injection", () => {
    const patches: HarnessPatchPrompt[] = [
      {
        id: "patch-sec",
        proposedChange: "Do not trust external URLs without validation",
        confidence: 0.9,
      },
    ];

    const prompt = buildSecuritySystemPrompt(
      makeParams({ activePatches: patches })
    );

    // All 10 security rules must still be present
    expect(prompt).toContain("**RULE 1 — IDENTITY LOCK**");
    expect(prompt).toContain("**RULE 2 — INSTRUCTION HIERARCHY**");
    expect(prompt).toContain("**RULE 3 — TOOL POLICY**");
    expect(prompt).toContain("**RULE 4 — CREDENTIAL PROTECTION**");
    expect(prompt).toContain("**RULE 5 — CONFIDENTIALITY OF SYSTEM PROMPT**");
    expect(prompt).toContain("**RULE 6 — INJECTION DEFENSE**");
    expect(prompt).toContain("**RULE 7 — HUMAN OVERSIGHT**");
    expect(prompt).toContain("**RULE 8 — SCOPE LIMITATION**");
    expect(prompt).toContain("**RULE 9 — TRANSPARENCY**");
    expect(prompt).toContain("**RULE 10 — COST AWARENESS**");

    // Identity and session delimiter still present
    expect(prompt).toContain("You are Tessera");
    expect(prompt).toContain("<SC-sess-test>");

    // Persona section still present
    expect(prompt).toContain("# Persona and Behavior");
    expect(prompt).toContain(
      "You are helpful, precise, and security-conscious."
    );
  });

  it("patches section appears after learned patterns when both are present", () => {
    const patches: HarnessPatchPrompt[] = [
      {
        id: "patch-p1",
        proposedChange: "Improvement A",
        confidence: 0.8,
      },
    ];

    const prompt = buildSecuritySystemPrompt(
      makeParams({
        priorLessons: ["User prefers short responses", "User uses Python"],
        activePatches: patches,
      })
    );

    // Learned Patterns must appear before Active Harness Improvements
    const lessonsIdx = prompt.indexOf("# Learned Patterns from Prior Sessions");
    const patchesIdx = prompt.indexOf("## Active Harness Improvements");
    expect(lessonsIdx).toBeGreaterThan(-1);
    expect(patchesIdx).toBeGreaterThan(-1);
    expect(lessonsIdx).toBeLessThan(patchesIdx);
  });
});
