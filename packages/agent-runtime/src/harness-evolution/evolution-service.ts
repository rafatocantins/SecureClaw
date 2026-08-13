/**
 * HarnessEvolutionService — Self-evolution pipeline orchestrator.
 *
 * Connects SessionAnalyzer (#60) and HarnessPatchGenerator (#67) into
 * a complete self-evolution pipeline:
 *   1. Analyzes sessions via SessionAnalyzer
 *   2. Generates patches via HarnessPatchGenerator
 *   3. Validates against security invariants
 *   4. Persists to memory-store (harness_patches table)
 *   5. Stores as PENDING — requires human approval (never auto-applies)
 *
 * Phase 1 additions (Task 3):
 *   - generatePatchesFromLessons(): creates patches from ExtractedLesson[]
 *   - validatePatch(): rejects patches that violate security invariants,
 *     contain vault placeholders, or exceed 500 chars
 *   - finalizeSession(): pipeline hook for session finalization
 */

import type { SessionAnalyzer, PatternSummary } from "./session-analyzer.js";
import type { HarnessPatchGenerator } from "./patch-generator.js";
import type {
  HarnessPatch,
  PatchValidationResult,
  PendingPatch,
} from "./types.js";
import type { AuditGrpcClient } from "../grpc/clients/audit.client.js";
import type { MemoryGrpcClient } from "../grpc/clients/memory.client.js";
import type { ExtractedLesson } from "../lessons/lesson-extractor.js";

// ── Public types ──────────────────────────────────────────────────────────

export interface EvolutionResult {
  sessionsAnalyzed: number;
  patchesGenerated: number;
  patchesApplied: number;
  patchesRejected: number;
  summary: PatternSummary[];
}

export interface ApplyResult {
  id: string;
  applied: boolean;
  reason: string;
}

// ── Security constants ────────────────────────────────────────────────────

/**
 * The 8 security invariants that must NEVER be modified by any patch.
 * These map to SecurityConfigSchema keys — changing any of them could
 * weaken the system's security posture.
 */
const SECURITY_INVARIANTS = new Set([
  "sandbox_mode",
  "tool_policy",
  "gateway_bind",
  "gateway_auth",
  "credential_storage",
  "session_isolation",
  "audit_logging",
  "injection_detection",
]);

/** Pattern matching vault credential placeholders (__VAULT_REF:uuid__). */
const VAULT_PLACEHOLDER_RE =
  /__VAULT_REF:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/i;

/** Maximum allowed length for a patch's proposedChange. */
const MAX_PATCH_CHARS = 500;

/** Blocked terms (Phase 0 — retained for backward compat). */
const BLOCKED_TERMS = ["disable sandbox", "bypass"];

const AUTO_APPLY_THRESHOLD = 0.7;
const REJECT_THRESHOLD = 0.3;

// ── HarnessEvolutionService ───────────────────────────────────────────────

export class HarnessEvolutionService {
  private readonly analyzer: SessionAnalyzer;
  private readonly generator: HarnessPatchGenerator;
  private readonly auditClient: AuditGrpcClient;
  private readonly memoryClient: MemoryGrpcClient | undefined;

  /** In-memory patch store (backed by harness_patches table in production). */
  private readonly patchStore: Map<
    string,
    HarnessPatch & { applied: boolean; appliedAt?: number }
  >;

  /** Pending patches awaiting human review (not auto-applied). */
  private readonly pendingPatches: Map<string, PendingPatch>;

  constructor(
    analyzer: SessionAnalyzer,
    generator: HarnessPatchGenerator,
    auditClient: AuditGrpcClient,
    memoryClient?: MemoryGrpcClient,
  ) {
    this.analyzer = analyzer;
    this.generator = generator;
    this.auditClient = auditClient;
    this.memoryClient = memoryClient;
    this.patchStore = new Map();
    this.pendingPatches = new Map();
  }

  // ── evolve() ──────────────────────────────────────────────────────────

  /**
   * Run the full self-evolution pipeline:
   * analyze → generate → validate → persist as pending.
   *
   * Phase 1 change: patches are stored as PENDING (never auto-applied).
   * Human approval is always required.
   */
  async evolve(limit = 50): Promise<EvolutionResult> {
    // 1. Analyze sessions
    const analyses = await this.analyzer.analyze(limit);

    const sessionsAnalyzed = analyses.length;

    // 2. Generate patches with confidence scores
    const patchesWithConfidence =
      this.generator.generatePatchesWithConfidence(analyses);

    const patchesGenerated = patchesWithConfidence.length;

    // 3 + 4. Validate and persist each patch as PENDING
    let patchesApplied = 0;
    let patchesRejected = 0;

    for (const { patch, confidence } of patchesWithConfidence) {
      // Update the patch confidence from the calculated score
      patch.confidence = confidence.score;

      // ── Phase 1: Validate patch ──────────────────────────────────
      const validation = this.validatePatch(patch);

      // Audit event: patch generated
      this.auditClient.logEvent({
        event_type: "HARNESS_PATCH_GENERATED",
        payload: {
          patch_id: patch.id,
          confidence: confidence.score,
          pattern_type: patch.type,
          validation_valid: validation.valid,
          ...(validation.reason
            ? { validation_reason: validation.reason }
            : {}),
        },
        severity: "INFO",
      });

      if (!validation.valid) {
        // Store rejected patch for audit trail
        this.storePatch(patch, false);
        patchesRejected++;
        continue;
      }

      // ── Store as pending (requires human review) ──────────────────
      this.storePendingPatch(patch, validation);

      // Still log to audit that the patch was stored as pending
      patchesApplied++;
    }

    // 5. Compute summary
    const summary = this.analyzer.getPatternSummary(analyses);

    return {
      sessionsAnalyzed,
      patchesGenerated,
      patchesApplied,
      patchesRejected,
      summary,
    };
  }

  // ── Phase 1: generatePatchesFromLessons() ──────────────────────────────

  /**
   * Generate candidate patches from ExtractedLesson[] (T-3-01 lessons).
   *
   * Maps lesson categories to patch types:
   *   - mistake → tool_rule (avoid repeating errors)
   *   - preference → system_instruction (encode user preferences)
   *   - procedure → system_instruction (codify correct approaches)
   *   - fact → prompt_update (inject factual constraints)
   */
  generatePatchesFromLessons(
    lessons: ExtractedLesson[],
  ): Array<{ patch: HarnessPatch; valid: boolean; reason?: string }> {
    if (lessons.length === 0) return [];

    const results: Array<{
      patch: HarnessPatch;
      valid: boolean;
      reason?: string;
    }> = [];

    const timestamp = Date.now();

    for (let i = 0; i < lessons.length; i++) {
      const lesson = lessons[i]!;
      const id = `patch-lesson-${timestamp}-${i}`;

      let patchType: HarnessPatch["type"];
      let target: string;

      switch (lesson.category) {
        case "mistake":
          patchType = "tool_rule";
          target = "lesson_mistake_guard";
          break;
        case "preference":
          patchType = "system_instruction";
          target = "lesson_preference";
          break;
        case "procedure":
          patchType = "system_instruction";
          target = "lesson_procedure";
          break;
        case "fact":
          patchType = "prompt_update";
          target = "lesson_fact_injection";
          break;
      }

      const proposedChange = `[${lesson.category}] ${lesson.lesson_text}`;

      const patch: HarnessPatch = {
        id,
        type: patchType,
        target,
        proposedChange,
        rationale: `Extracted from session analysis: ${lesson.lesson_text.slice(0, 100)}`,
        confidence: 0.5, // Lessons always start at review-level confidence
        sourcePatterns: [],
        generatedAt: new Date(),
      };

      // Validate the patch
      const validation = this.validatePatch(patch);
      results.push({
        patch,
        valid: validation.valid,
        ...(validation.reason !== undefined ? { reason: validation.reason } : {}),
      });

      // If valid, store as pending
      if (validation.valid) {
        this.storePendingPatch(patch, validation);

        this.auditClient.logEvent({
          event_type: "HARNESS_LESSON_PATCH_GENERATED",
          payload: {
            patch_id: id,
            lesson_category: lesson.category,
            validation_valid: true,
          },
          severity: "INFO",
        });
      } else {
        this.auditClient.logEvent({
          event_type: "HARNESS_LESSON_PATCH_REJECTED",
          payload: {
            patch_id: id,
            lesson_category: lesson.category,
            validation_reason: validation.reason,
          },
          severity: "WARN",
        });
      }
    }

    return results;
  }

  // ── Phase 1: finalizeSession() pipeline hook ───────────────────────────

  /**
   * Session finalization hook called after extractLessons().
   * Takes the extracted lessons and generates patches from them,
   * storing valid ones as pending for human review.
   *
   * Called from the AgentLoop after lessons are extracted.
   */
  async finalizeSession(
    userId: string,
    sessionId: string,
    lessons: ExtractedLesson[],
  ): Promise<number> {
    if (lessons.length === 0) return 0;

    const results = this.generatePatchesFromLessons(lessons);

    // storePendingPatch() already persists via storePatch() → memoryClient.
    // No additional persistence needed here — just return the count.

    const validCount = results.filter((r) => r.valid).length;
    return validCount;
  }

  // ── Phase 1: validatePatch() ─────────────────────────────────────────

  /**
   * Validate a patch against all security rules:
   *
   * (a) Must not modify any of the 8 security invariants
   * (b) Must not contain vault credential placeholders (__VAULT_REF:*__)
   * (c) Must not exceed 500 characters in proposedChange
   *
   * Also checks Phase 0 blocked terms for backward compatibility.
   */
  validatePatch(patch: HarnessPatch): PatchValidationResult {
    const change = patch.proposedChange;
    const lowerChange = change.toLowerCase();

    // ── (a) Security invariant check ───────────────────────────────────
    for (const invariant of SECURITY_INVARIANTS) {
      // Check if the patch attempts to reference or modify the invariant
      if (
        lowerChange.includes(invariant.toLowerCase()) &&
        // Must mention it in a modifying context (not just descriptive)
        (lowerChange.includes("change") ||
          lowerChange.includes("modify") ||
          lowerChange.includes("set") ||
          lowerChange.includes("update") ||
          lowerChange.includes("disable") ||
          lowerChange.includes("enable") ||
          lowerChange.includes("relax") ||
          lowerChange.includes("weaken") ||
          lowerChange.includes("override") ||
          lowerChange.includes("turn off") ||
          // If the invariant name is the target
          patch.target.includes(invariant))
      ) {
        return {
          valid: false,
          reason: `Patch attempts to modify security invariant: "${invariant}"`,
          violatedInvariant: invariant,
        };
      }
    }

    // ── (b) Vault placeholder check ────────────────────────────────────
    if (VAULT_PLACEHOLDER_RE.test(change)) {
      return {
        valid: false,
        reason: "Patch contains vault credential placeholder (__VAULT_REF:*__)",
        violatedInvariant: "credential_storage",
      };
    }

    // ── (c) Length check ───────────────────────────────────────────────
    if (change.length > MAX_PATCH_CHARS) {
      return {
        valid: false,
        reason: `Patch proposedChange exceeds ${MAX_PATCH_CHARS} characters (actual: ${change.length})`,
      };
    }

    // ── Phase 0 blocked terms (backward compat) ────────────────────────
    for (const term of BLOCKED_TERMS) {
      if (lowerChange.includes(term)) {
        return {
          valid: false,
          reason: `Security gate: contains blocked term "${term}"`,
        };
      }
    }

    return { valid: true };
  }

  // ── Phase 1: storePendingPatch() ──────────────────────────────────────

  /**
   * Store a validated patch as pending human review.
   * Does NOT auto-apply — that requires explicit human approval via applyPatch().
   */
  private storePendingPatch(
    patch: HarnessPatch,
    validation: PatchValidationResult,
  ): void {
    const pending: PendingPatch = {
      id: patch.id,
      patch,
      storedAt: new Date(),
      status: "pending_review",
      validationResult: validation,
    };

    this.pendingPatches.set(patch.id, pending);

    // Also store in the main patch store (as not-applied)
    this.storePatch(patch, false);
  }

  /**
   * Get all pending patches awaiting human review.
   */
  getPendingPatches(): PendingPatch[] {
    return Array.from(this.pendingPatches.values());
  }

  // ── applyPatch() ──────────────────────────────────────────────────────

  /**
   * Apply a single harness patch through the security gate.
   *
   * Phase 1 change: patches are always stored as pending initially.
   * This method is for explicit human-triggered application.
   *
   * Security rules:
   *  - Fails validatePatch() → reject
   *  - Confidence < 0.3 → reject
   *  - Confidence >= 0.7 → auto-apply (human-triggered only)
   *  - Confidence 0.3–0.7 → mark for review (not applied)
   */
  async applyPatch(patch: HarnessPatch): Promise<ApplyResult> {
    // ── Phase 1: Full validation ──────────────────────────────────────
    const validation = this.validatePatch(patch);
    if (!validation.valid) {
      this.storePatch(patch, false);
      return {
        id: patch.id,
        applied: false,
        reason: `Validation failed: ${validation.reason}`,
      };
    }

    // ── Phase 0 blocked terms (additional safety net) ─────────────────
    const lowerChange = patch.proposedChange.toLowerCase();
    for (const term of BLOCKED_TERMS) {
      if (lowerChange.includes(term)) {
        return {
          id: patch.id,
          applied: false,
          reason: `Security gate: contains blocked term "${term}"`,
        };
      }
    }

    // ── Confidence-based gate ────────────────────────────────────────
    if (patch.confidence < REJECT_THRESHOLD) {
      this.storePatch(patch, false);
      return {
        id: patch.id,
        applied: false,
        reason: `Confidence ${patch.confidence.toFixed(2)} below reject threshold (${REJECT_THRESHOLD})`,
      };
    }

    if (patch.confidence < AUTO_APPLY_THRESHOLD) {
      this.storePatch(patch, false);
      return {
        id: patch.id,
        applied: false,
        reason: `Confidence ${patch.confidence.toFixed(2)} requires human review (range: ${REJECT_THRESHOLD}–${AUTO_APPLY_THRESHOLD})`,
      };
    }

    // ── Apply ───────────────────────────────────────────────────────
    this.storePatch(patch, true);

    // Remove from pending if it was there
    this.pendingPatches.delete(patch.id);

    // Audit event: patch applied
    this.auditClient.logEvent({
      event_type: "HARNESS_PATCH_APPLIED",
      payload: {
        patch_id: patch.id,
        confidence: patch.confidence,
      },
      severity: "INFO",
    });

    return {
      id: patch.id,
      applied: true,
      reason: `Applied (confidence ${patch.confidence.toFixed(2)} >= ${AUTO_APPLY_THRESHOLD})`,
    };
  }

  // ── Persistence helpers ────────────────────────────────────────────────

  /**
   * Store a patch in the internal store and persist to the memory-store DB
   * via gRPC when available.
   */
  private storePatch(patch: HarnessPatch, applied: boolean): void {
    const existing = this.patchStore.get(patch.id);

    // Idempotent: don't overwrite an already-applied patch
    if (existing && existing.applied) {
      return;
    }

    this.patchStore.set(patch.id, {
      ...patch,
      applied,
      ...(applied ? { appliedAt: Date.now() } : {}),
    });

    // Persist to memory-store DB via gRPC
    this.memoryClient?.storeHarnessPatch({
      id: patch.id,
      patch_type: patch.type,
      target: patch.target,
      proposed_change: patch.proposedChange,
      confidence: patch.confidence,
      recommendation:
        patch.confidence >= AUTO_APPLY_THRESHOLD
          ? "apply"
          : patch.confidence >= REJECT_THRESHOLD
            ? "review"
            : "reject",
      source_patterns: JSON.stringify(patch.sourcePatterns),
      applied,
      applied_at: applied ? Date.now() : 0,
      generated_at: patch.generatedAt.getTime(),
    });
  }

  /**
   * Get all stored patches (for testing / introspection).
   */
  getStoredPatches(): Array<
    HarnessPatch & { applied: boolean; appliedAt?: number }
  > {
    return Array.from(this.patchStore.values());
  }

  /**
   * Clear the internal patch store (for testing).
   */
  clearPatches(): void {
    this.patchStore.clear();
    this.pendingPatches.clear();
  }
}
