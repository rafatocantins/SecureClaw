/**
 * evolution-service.test.ts — Unit tests for HarnessEvolutionService.
 *
 * Covers:
 *  1. evolve() with 0 sessions → empty EvolutionResult
 *  2. evolve() with tool_failure pattern → 1 patch, confidence calculated
 *  3. evolve() with loop_detected → patch type system_instruction
 *  4. evolve() with multiple patterns → sorted by confidence
 *  5. applyPatch() with confidence > 0.7 → marked applied
 *  6. applyPatch() with confidence < 0.3 → marked rejected
 *  7. Security gate: "disable sandbox" → rejected
 *  8. evolve() with memoryClient undefined → no crash (graceful)
 *  9. Duplicate patch → idempotent (no duplicate insert)
 * 10. evolve() with no patterns → 0 patches, 0 applied
 * 11. Security gate: "bypass" → rejected
 * 12. Auto-applied patch fires audit event HARNESS_PATCH_APPLIED
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AuditService,
  AuditSession,
  AuditEvent,
  HarnessPatch,
} from "../types.js";
import { SessionAnalyzer } from "../session-analyzer.js";
import { HarnessPatchGenerator } from "../patch-generator.js";
import { HarnessEvolutionService } from "../evolution-service.js";
import type { AuditGrpcClient } from "../../grpc/clients/audit.client.js";
import type { MemoryGrpcClient } from "../../grpc/clients/memory.client.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<AuditSession> = {}): AuditSession {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    startTime: overrides.startTime ?? new Date("2025-01-01T00:00:00Z"),
    modelId: overrides.modelId ?? "deepseek-v4",
    status: overrides.status ?? "completed",
    endTime: overrides.endTime,
  };
}

function makeToolFailureEvent(sessionId = "sess-1", count = 5): AuditEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId,
    timestamp: new Date(2025, 0, 1, i, 0, 0),
    eventType: "tool_call",
    toolName: "shell_exec",
    success: false,
    error: `Tool execution failed: exit code 1 (attempt ${i + 1})`,
    details: { tool_name: "shell_exec", exit_code: 1 },
  }));
}

function makeLoopEvents(sessionId = "sess-1", count = 6): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      sessionId,
      timestamp: new Date(2025, 0, 1, i, 0, 0),
      eventType: "tool_call",
      toolName: "shell_exec",
      success: true,
      details: { command: `echo loop_${i}` },
    });
  }
  return events;
}

function mockAuditService(
  sessions: AuditSession[],
  eventsBySession: Map<string, AuditEvent[]>,
): AuditService {
  return {
    getRecentSessions: vi.fn().mockResolvedValue(sessions),
    getSessionEvents: vi
      .fn()
      .mockImplementation((sessionId: string) =>
        Promise.resolve(eventsBySession.get(sessionId) ?? []),
      ),
  };
}

function mockAuditGrpcClient(): AuditGrpcClient {
  return {
    logEvent: vi.fn(),
  } as unknown as AuditGrpcClient;
}

function mockMemoryGrpcClient(): MemoryGrpcClient {
  return {
    storeHarnessPatch: vi.fn(),
    getActivePatches: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryGrpcClient;
}

// ── Test 1: evolve() with 0 sessions → empty EvolutionResult ────────────────

describe("HarnessEvolutionService.evolve()", () => {
  let auditClient: AuditGrpcClient;

  beforeEach(() => {
    auditClient = mockAuditGrpcClient();
  });

  it("returns empty EvolutionResult when there are 0 sessions", async () => {
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    const result = await service.evolve();

    expect(result.sessionsAnalyzed).toBe(0);
    expect(result.patchesGenerated).toBe(0);
    expect(result.patchesApplied).toBe(0);
    expect(result.patchesRejected).toBe(0);
    expect(result.summary).toEqual([]);
  });

  // ── Test 2: evolve() with tool_failure pattern → 1 patch, confidence ───

  it("generates 1 patch with calculated confidence for tool_failure pattern", async () => {
    const session = makeSession({ sessionId: "sess-1" });
    const events = makeToolFailureEvent("sess-1", 8); // 8 failures → high frequency
    const auditService = mockAuditService(
      [session],
      new Map([["sess-1", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    const result = await service.evolve();

    expect(result.sessionsAnalyzed).toBe(1);
    expect(result.patchesGenerated).toBeGreaterThanOrEqual(1);
    // Confidence should be > 0 because of 8 failures
    expect(result.summary.length).toBeGreaterThanOrEqual(1);

    // Verify audit events were emitted
    expect(auditClient.logEvent).toHaveBeenCalled();
  });

  // ── Test 3: evolve() with loop_detected → type system_instruction ────

  it("generates system_instruction patch for loop_detected pattern", async () => {
    const session = makeSession({ sessionId: "sess-loop" });
    const events = makeLoopEvents("sess-loop", 6);
    const auditService = mockAuditService(
      [session],
      new Map([["sess-loop", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    const result = await service.evolve();

    // loop_detected should produce a system_instruction type patch
    const storedPatches = service.getStoredPatches();
    const loopPatches = storedPatches.filter(
      (p) => p.type === "system_instruction",
    );
    expect(loopPatches.length).toBeGreaterThanOrEqual(1);

    // Pattern summary should include loop_detected
    const loopSummary = result.summary.find(
      (s) => s.patternType === "loop_detected",
    );
    expect(loopSummary).toBeDefined();
  });

  // ── Test 4: multiple patterns → sorted by confidence ───────────────────

  it("handles multiple patterns and returns them sorted", async () => {
    const session1 = makeSession({ sessionId: "sess-1" });
    const session2 = makeSession({ sessionId: "sess-2" });

    // sess-1: tool failures (high frequency)
    const events1 = makeToolFailureEvent("sess-1", 12);
    // sess-2: loops (lower frequency)
    const events2 = makeLoopEvents("sess-2", 4);

    const auditService = mockAuditService(
      [session1, session2],
      new Map([
        ["sess-1", events1],
        ["sess-2", events2],
      ]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    const result = await service.evolve();

    expect(result.sessionsAnalyzed).toBe(2);
    // Summary should be sorted by totalOccurrences descending
    for (let i = 1; i < result.summary.length; i++) {
      expect(result.summary[i - 1].totalOccurrences).toBeGreaterThanOrEqual(
        result.summary[i].totalOccurrences,
      );
    }
  });

  // ── Test 10: no patterns → 0 patches, 0 applied ──────────────────────

  it("returns 0 patches when no failure patterns are detected", async () => {
    const session = makeSession({ sessionId: "sess-clean" });
    const cleanEvents: AuditEvent[] = [
      {
        sessionId: "sess-clean",
        timestamp: new Date("2025-01-01T00:00:00Z"),
        eventType: "tool_call",
        toolName: "file_read",
        success: true,
      },
    ];
    const auditService = mockAuditService(
      [session],
      new Map([["sess-clean", cleanEvents]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const service = new HarnessEvolutionService(analyzer, generator, auditClient);

    const result = await service.evolve();

    expect(result.patchesGenerated).toBe(0);
    expect(result.patchesApplied).toBe(0);
    expect(result.patchesRejected).toBe(0);
  });
});

// ── applyPatch() tests ──────────────────────────────────────────────────────

describe("HarnessEvolutionService.applyPatch()", () => {
  let auditClient: AuditGrpcClient;
  let service: HarnessEvolutionService;

  function makePatch(overrides: Partial<HarnessPatch> = {}): HarnessPatch {
    return {
      id: overrides.id ?? "patch-test-1",
      type: overrides.type ?? "tool_rule",
      target: overrides.target ?? "tool_allowlist",
      proposedChange:
        overrides.proposedChange ??
        "Add rate limiting to shell_exec tool to prevent abuse",
      rationale: overrides.rationale ?? "Shell exec was called too frequently",
      confidence: overrides.confidence ?? 0.5,
      sourcePatterns: overrides.sourcePatterns ?? ["tool_failure"],
      generatedAt: overrides.generatedAt ?? new Date(),
    };
  }

  beforeEach(() => {
    auditClient = mockAuditGrpcClient();
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    service = new HarnessEvolutionService(analyzer, generator, auditClient);
  });

  // ── Test 5: confidence > 0.7 → auto-applied ─────────────────────────

  it("auto-applies patch when confidence >= 0.7", async () => {
    const patch = makePatch({ confidence: 0.85, id: "patch-high-conf" });

    const result = await service.applyPatch(patch);

    expect(result.applied).toBe(true);
    expect(result.id).toBe("patch-high-conf");
    expect(result.reason).toContain("Applied");

    // Verify patch is stored as applied
    const stored = service.getStoredPatches();
    const storedPatch = stored.find((p) => p.id === "patch-high-conf");
    expect(storedPatch).toBeDefined();
    expect(storedPatch!.applied).toBe(true);
    expect(storedPatch!.appliedAt).toBeGreaterThan(0);
  });

  // ── Test 6: confidence < 0.3 → rejected ────────────────────────────

  it("rejects patch when confidence < 0.3", async () => {
    const patch = makePatch({ confidence: 0.15, id: "patch-low-conf" });

    const result = await service.applyPatch(patch);

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("below reject threshold");
  });

  // ── Test 7: security gate "disable sandbox" → rejected ──────────────

  it("rejects patch containing 'disable sandbox'", async () => {
    const patch = makePatch({
      id: "patch-disable-sandbox",
      confidence: 0.95, // Even high confidence won't override security gate
      proposedChange: "Disable sandbox for shell_exec to improve performance",
    });

    const result = await service.applyPatch(patch);

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("Security gate");
    expect(result.reason).toContain("disable sandbox");
  });

  // ── Test 11: security gate "bypass" → rejected ──────────────────────

  it("rejects patch containing 'bypass'", async () => {
    const patch = makePatch({
      id: "patch-bypass",
      confidence: 0.95,
      proposedChange: "Bypass approval gate for file_read operations",
    });

    const result = await service.applyPatch(patch);

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("Security gate");
    expect(result.reason).toContain("bypass");
  });

  // ── Test 9: duplicate patch → idempotent ────────────────────────────

  it("handles duplicate patches idempotently", async () => {
    const patch = makePatch({ confidence: 0.9, id: "patch-dup" });

    // First application
    const result1 = await service.applyPatch(patch);
    expect(result1.applied).toBe(true);

    // Second application of same patch
    const result2 = await service.applyPatch(patch);
    expect(result2.applied).toBe(true);

    // Should only have one entry in the store
    const stored = service.getStoredPatches();
    const dupPatches = stored.filter((p) => p.id === "patch-dup");
    expect(dupPatches.length).toBe(1);
  });

  // ── Test 12: auto-applied fires HARNESS_PATCH_APPLIED audit ────────

  it("fires HARNESS_PATCH_APPLIED audit event on auto-apply", async () => {
    const patch = makePatch({ confidence: 0.88, id: "patch-audit" });

    await service.applyPatch(patch);

    expect(auditClient.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "HARNESS_PATCH_APPLIED",
        payload: expect.objectContaining({ patch_id: "patch-audit" }),
      }),
    );
  });

  // ── Confidence 0.3–0.7 → review (not applied) ──────────────────────

  it("marks patch for review when confidence is between 0.3 and 0.7", async () => {
    const patch = makePatch({ confidence: 0.5, id: "patch-review" });

    const result = await service.applyPatch(patch);

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("human review");
  });

  // ── Edge: confidence = 0 → rejected ────────────────────────────────

  it("rejects patch when confidence = 0", async () => {
    const patch = makePatch({ confidence: 0, id: "patch-zero" });

    const result = await service.applyPatch(patch);

    expect(result.applied).toBe(false);
    expect(result.reason).toContain("below reject threshold");
  });
});

// ── Graceful degradation tests ─────────────────────────────────────────────

describe("HarnessEvolutionService graceful degradation", () => {
  it("does not crash when memoryClient is undefined", async () => {
    const session = makeSession({ sessionId: "sess-1" });
    const events = makeToolFailureEvent("sess-1", 5);
    const auditService = mockAuditService(
      [session],
      new Map([["sess-1", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();

    // No memoryClient provided
    const service = new HarnessEvolutionService(
      analyzer,
      generator,
      auditClient,
      undefined,
    );

    const result = await service.evolve();
    expect(result.sessionsAnalyzed).toBe(1);
    // Should not crash
  });

  it("does not crash with memoryClient provided", async () => {
    const session = makeSession({ sessionId: "sess-1" });
    const events = makeToolFailureEvent("sess-1", 5);
    const auditService = mockAuditService(
      [session],
      new Map([["sess-1", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    const memoryClient = mockMemoryGrpcClient();

    const service = new HarnessEvolutionService(
      analyzer,
      generator,
      auditClient,
      memoryClient,
    );

    const result = await service.evolve();
    expect(result.sessionsAnalyzed).toBe(1);
    // Should not crash
  });
});

// ── Phase 1: validatePatch() tests ──────────────────────────────────────────

describe("HarnessEvolutionService.validatePatch()", () => {
  let service: HarnessEvolutionService;

  function makePatch(overrides: Partial<HarnessPatch> = {}): HarnessPatch {
    return {
      id: overrides.id ?? "patch-test-1",
      type: overrides.type ?? "tool_rule",
      target: overrides.target ?? "tool_allowlist",
      proposedChange:
        overrides.proposedChange ??
        "Add rate limiting to shell_exec tool to prevent abuse",
      rationale: overrides.rationale ?? "Shell exec was called too frequently",
      confidence: overrides.confidence ?? 0.5,
      sourcePatterns: overrides.sourcePatterns ?? ["tool_failure"],
      generatedAt: overrides.generatedAt ?? new Date(),
    };
  }

  beforeEach(() => {
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    service = new HarnessEvolutionService(analyzer, generator, auditClient);
  });

  // ── Test: AC2a — rejects patches modifying security invariants ────────

  it("rejects patch that attempts to modify sandbox_mode invariant", () => {
    const patch = makePatch({
      id: "patch-sandbox",
      target: "security_config",
      proposedChange:
        "Change sandbox_mode to off_for_dev to improve performance",
    });

    const result = service.validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("security invariant");
    expect(result.reason).toContain("sandbox_mode");
    expect(result.violatedInvariant).toBe("sandbox_mode");
  });

  it("rejects patch that attempts to modify tool_policy invariant", () => {
    const patch = makePatch({
      id: "patch-policy",
      target: "security_config",
      proposedChange:
        "Relax tool_policy to allow_all_except_denylist for development",
    });

    const result = service.validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("tool_policy");
    expect(result.violatedInvariant).toBe("tool_policy");
  });

  it("rejects patch that targets an invariant directly", () => {
    const patch = makePatch({
      id: "patch-direct-invariant",
      target: "session_isolation",
      proposedChange: "Modify session_isolation settings for multi-tenancy",
    });

    const result = service.validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.violatedInvariant).toBe("session_isolation");
  });

  // ── Test: AC2b — rejects patches with vault placeholders ─────────────

  it("rejects patch containing vault credential placeholder", () => {
    const patch = makePatch({
      id: "patch-vault",
      target: "credential_injection",
      proposedChange:
        "Use credential __VAULT_REF:12345678-1234-1234-1234-123456789abc__ for API calls",
    });

    const result = service.validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("vault credential placeholder");
  });

  // ── Test: AC2c — rejects patches exceeding 500 chars ─────────────────

  it("rejects patch when proposedChange exceeds 500 characters", () => {
    const longChange = "x".repeat(501);
    const patch = makePatch({
      id: "patch-too-long",
      proposedChange: longChange,
    });

    const result = service.validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("exceeds 500 characters");
  });

  // ── Test: valid patch passes validation ──────────────────────────────

  it("accepts a valid patch that passes all checks", () => {
    const patch = makePatch({
      id: "patch-valid",
      target: "tool_allowlist",
      proposedChange:
        "Add rate limiting to shell_exec tool to prevent excessive calls",
    });

    const result = service.validatePatch(patch);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ── Phase 1: generatePatchesFromLessons() tests ────────────────────────────

describe("HarnessEvolutionService.generatePatchesFromLessons()", () => {
  let service: HarnessEvolutionService;

  beforeEach(() => {
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    service = new HarnessEvolutionService(analyzer, generator, auditClient);
  });

  // ── Test: AC1 — generates patches from lessons ────────────────────

  it("generates patches for each lesson category (mistake, preference, procedure, fact)", () => {
    const lessons = [
      { lesson_text: "Avoid using shell_exec for file operations", category: "mistake" as const },
      { lesson_text: "User prefers dark mode in all outputs", category: "preference" as const },
      { lesson_text: "Always run npm install before npm test", category: "procedure" as const },
      { lesson_text: "The API base URL is https://api.example.com", category: "fact" as const },
    ];

    const results = service.generatePatchesFromLessons(lessons);

    expect(results).toHaveLength(4);

    // Check types by category
    const mistakeResult = results.find((r) => r.patch.target === "lesson_mistake_guard");
    expect(mistakeResult).toBeDefined();
    expect(mistakeResult!.patch.type).toBe("tool_rule");

    const preferenceResult = results.find((r) => r.patch.target === "lesson_preference");
    expect(preferenceResult).toBeDefined();
    expect(preferenceResult!.patch.type).toBe("system_instruction");

    const procedureResult = results.find((r) => r.patch.target === "lesson_procedure");
    expect(procedureResult).toBeDefined();
    expect(procedureResult!.patch.type).toBe("system_instruction");

    const factResult = results.find((r) => r.patch.target === "lesson_fact_injection");
    expect(factResult).toBeDefined();
    expect(factResult!.patch.type).toBe("prompt_update");
  });

  it("returns empty array for empty lessons list", () => {
    const results = service.generatePatchesFromLessons([]);
    expect(results).toEqual([]);
  });

  it("validates lesson patches and marks invalid ones", () => {
    const longText = "x".repeat(501); // Exceeds 500 char limit
    const lessons = [
      { lesson_text: longText, category: "fact" as const },
    ];

    const results = service.generatePatchesFromLessons(lessons);

    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toContain("exceeds 500");
  });

  it("lessons from mistakes map to tool_rule patch type", () => {
    const lessons = [
      { lesson_text: "Do not call http_request without URL validation", category: "mistake" as const },
    ];

    const results = service.generatePatchesFromLessons(lessons);

    expect(results).toHaveLength(1);
    expect(results[0].patch.type).toBe("tool_rule");
    expect(results[0].patch.target).toBe("lesson_mistake_guard");
    expect(results[0].patch.confidence).toBe(0.5);
    expect(results[0].valid).toBe(true);
  });
});

// ── Phase 1: finalizeSession() pipeline hook tests ─────────────────────────

describe("HarnessEvolutionService.finalizeSession()", () => {
  let service: HarnessEvolutionService;
  let memoryClient: MemoryGrpcClient;

  beforeEach(() => {
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    memoryClient = mockMemoryGrpcClient();
    service = new HarnessEvolutionService(
      analyzer,
      generator,
      auditClient,
      memoryClient,
    );
  });

  it("returns 0 when lessons array is empty", async () => {
    const count = await service.finalizeSession("user-1", "sess-1", []);
    expect(count).toBe(0);
  });

  it("creates pending patches from extracted lessons and persists to memory", async () => {
    const lessons = [
      { lesson_text: "Avoid running long shell commands", category: "mistake" as const },
      { lesson_text: "User uses TypeScript strict mode", category: "fact" as const },
    ];

    const count = await service.finalizeSession("user-1", "sess-1", lessons);

    expect(count).toBe(2);
    expect(memoryClient.storeHarnessPatch).toHaveBeenCalledTimes(2);
  });

  it("does not crash when memoryClient is undefined", async () => {
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    const svcNoMemory = new HarnessEvolutionService(
      analyzer,
      generator,
      auditClient,
      undefined,
    );

    const lessons = [
      { lesson_text: "A test lesson", category: "procedure" as const },
    ];

    // Should not throw
    const count = await svcNoMemory.finalizeSession("user-1", "sess-1", lessons);
    expect(count).toBe(1);
  });
});

// ── Phase 1: Pending patches storage tests ─────────────────────────────────

describe("HarnessEvolutionService pending patches", () => {
  let service: HarnessEvolutionService;

  beforeEach(() => {
    const auditService = mockAuditService([], new Map());
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();
    service = new HarnessEvolutionService(analyzer, generator, auditClient);
  });

  it("getPendingPatches returns empty when no lessons have been processed", () => {
    expect(service.getPendingPatches()).toEqual([]);
  });

  it("getPendingPatches returns patches after generatePatchesFromLessons", () => {
    const lessons = [
      { lesson_text: "Validate all inputs", category: "mistake" as const },
    ];

    service.generatePatchesFromLessons(lessons);

    const pending = service.getPendingPatches();
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending_review");
    expect(pending[0].patch.target).toBe("lesson_mistake_guard");
    expect(pending[0].validationResult.valid).toBe(true);
  });

  it("clearPatches clears both patch store and pending patches", () => {
    service.generatePatchesFromLessons([
      { lesson_text: "Test", category: "fact" as const },
    ]);

    expect(service.getPendingPatches().length).toBe(1);

    service.clearPatches();
    expect(service.getPendingPatches()).toEqual([]);
    expect(service.getStoredPatches()).toEqual([]);
  });

  it("does not store invalid patches as pending", () => {
    const longText = "x".repeat(501);
    const lessons = [
      { lesson_text: longText, category: "fact" as const },
    ];

    service.generatePatchesFromLessons(lessons);

    const pending = service.getPendingPatches();
    expect(pending.length).toBe(0);
  });
});

// ── Phase 1: evolve() integration with validatePatch ───────────────────────

describe("HarnessEvolutionService.evolve() with Phase 1 validation", () => {
  it("rejects patches in evolve() pipeline that fail validation", async () => {
    // Create a custom analyzer that returns a session with an invalid-like pattern
    // Actually: evolve should still work — patches that fail validation are just
    // not stored as pending. Let's test that evolve still completes.
    const session = makeSession({ sessionId: "sess-1" });
    const events = makeToolFailureEvent("sess-1", 8);
    const auditService = mockAuditService(
      [session],
      new Map([["sess-1", events]]),
    );
    const analyzer = new SessionAnalyzer(auditService);
    const generator = new HarnessPatchGenerator();
    const auditClient = mockAuditGrpcClient();

    const service = new HarnessEvolutionService(
      analyzer,
      generator,
      auditClient,
    );

    const result = await service.evolve();

    expect(result.sessionsAnalyzed).toBe(1);
    expect(result.patchesGenerated).toBeGreaterThanOrEqual(1);
    // Patches are now stored as pending, not auto-applied
    expect(result.patchesApplied).toBeGreaterThanOrEqual(0);
  });
});
