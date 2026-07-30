/**
 * HarnessEvolutionService — Self-evolution pipeline orchestrator.
 *
 * Connects SessionAnalyzer (#60) and HarnessPatchGenerator (#67) into
 * a complete self-evolution pipeline:
 *   1. Analyzes sessions via SessionAnalyzer
 *   2. Generates patches via HarnessPatchGenerator
 *   3. Validates against security invariants
 *   4. Persists to memory-store (harness_patches table)
 *   5. Applies via approval gate based on confidence score
 */

import type { SessionAnalyzer, PatternSummary } from "./session-analyzer.js";
import type { HarnessPatchGenerator } from "./patch-generator.js";
import type { HarnessPatch, GeneratedPatch } from "./types.js";
import type { AuditGrpcClient } from "../grpc/clients/audit.client.js";
import type { MemoryGrpcClient } from "../grpc/clients/memory.client.js";

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
  private readonly patchStore: Map<string, HarnessPatch & { applied: boolean; appliedAt?: number }>;

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
  }

  // ── evolve() ──────────────────────────────────────────────────────────

  /**
   * Run the full self-evolution pipeline:
   * analyze → generate → validate → persist → apply.
   */
  async evolve(limit = 50): Promise<EvolutionResult> {
    // 1. Analyze sessions
    const analyses = await this.analyzer.analyze(limit);

    const sessionsAnalyzed = analyses.length;

    // 2. Generate patches with confidence scores
    const patchesWithConfidence =
      this.generator.generatePatchesWithConfidence(analyses);

    const patchesGenerated = patchesWithConfidence.length;

    // 3 + 4 + 5. Validate, persist, and apply each patch
    let patchesApplied = 0;
    let patchesRejected = 0;

    for (const { patch, confidence } of patchesWithConfidence) {
      // Update the patch confidence from the calculated score
      patch.confidence = confidence.score;

      // Audit event: patch generated
      this.auditClient.logEvent({
        event_type: "HARNESS_PATCH_GENERATED",
        payload: {
          patch_id: patch.id,
          confidence: confidence.score,
          pattern_type: patch.type,
        },
        severity: "INFO",
      });

      // Security gate & apply
      const result = await this.applyPatch(patch);
      if (result.applied) {
        patchesApplied++;
      } else {
        patchesRejected++;
      }
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

  // ── applyPatch() ──────────────────────────────────────────────────────

  /**
   * Apply a single harness patch through the security gate.
   *
   * Security rules:
   *  - Contains "disable sandbox" or "bypass" → reject
   *  - Confidence < 0.3 → reject
   *  - Confidence >= 0.7 → auto-apply
   *  - Confidence 0.3–0.7 → mark for review (not applied)
   */
  async applyPatch(patch: HarnessPatch): Promise<ApplyResult> {
    // ── Security gate: blocked terms ─────────────────────────────────
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
      // Persist as rejected
      this.storePatch(patch, false);
      return {
        id: patch.id,
        applied: false,
        reason: `Confidence ${patch.confidence.toFixed(2)} below reject threshold (${REJECT_THRESHOLD})`,
      };
    }

    if (patch.confidence < AUTO_APPLY_THRESHOLD) {
      // Mark for review — not applied automatically
      this.storePatch(patch, false);
      return {
        id: patch.id,
        applied: false,
        reason: `Confidence ${patch.confidence.toFixed(2)} requires human review (range: ${REJECT_THRESHOLD}–${AUTO_APPLY_THRESHOLD})`,
      };
    }

    // ── Auto-apply ───────────────────────────────────────────────────
    this.storePatch(patch, true);

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
      reason: `Auto-applied (confidence ${patch.confidence.toFixed(2)} >= ${AUTO_APPLY_THRESHOLD})`,
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
  getStoredPatches(): Array<HarnessPatch & { applied: boolean; appliedAt?: number }> {
    return Array.from(this.patchStore.values());
  }

  /**
   * Clear the internal patch store (for testing).
   */
  clearPatches(): void {
    this.patchStore.clear();
  }
}
