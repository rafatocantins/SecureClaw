/**
 * sanitizer.ts — Main SanitizerService orchestrating all input/output sanitization.
 *
 * This is the primary entry point for all content that passes through
 * the agent. It coordinates:
 * 1. Heuristic injection detection (sync, fast, runs on everything)
 * 2. Session delimiter checking (sync, fast, runs on external content)
 * 3. LLM classifier (async, runs only on external content)
 * 4. PII detection (sync, runs on outputs before destructive tools)
 * 5. Output guardrails (sync, runs before destructive tool execution)
 * 6. Decode-then-scan (base64/URL/Unicode — runs on external content per sensitivity)
 * 7. Turn-level score accumulation (per session — detects incremental probing)
 *
 * Sensitivity is configured via INJECTION_SENSITIVITY env var (low|medium|high).
 * The env var is read once at construction time (CLAUDE.md §H.1).
 */
import { InjectionDetectedError } from "@tessera/shared";
import { scanForInjection, type InjectionScanResult } from "./heuristic/injection.detector.js";
import { detectAndRedactPii, type PiiDetectionResult } from "./heuristic/pii.detector.js";
import {
  createSessionDelimiters,
  wrapExternalContent,
  containsDelimiter,
  type SessionDelimiters,
} from "./delimiter/session-delimiter.js";
import {
  tagUserInstruction,
  tagExternalData,
  formatTaggedContent,
  type TaggedContent,
} from "./content-type/content-tagger.js";
import {
  classifyExternalContent,
  type LLMClassifierAdapter,
  type ClassificationResult,
} from "./llm/llm-classifier.js";
import {
  checkOutputGuardrails,
  type GuardrailResult,
} from "./output/output-guardrail.js";
import { checkUrlSafety, checkUrlSafetyResolved, type UrlSafetyResult } from "./url/url-safety.js";
import {
  scanWithDecodedLayers,
  type DecodeLayer,
  type MultiLayerScanResult,
} from "./encoding/decode-layers.js";
import {
  TurnScoreTracker,
  type SensitivityLevel,
} from "./session/turn-score-tracker.js";

// Decode layers applied per sensitivity level for external content.
const DECODE_LAYERS_BY_SENSITIVITY: Readonly<Record<SensitivityLevel, DecodeLayer[]>> = {
  low:    [],
  medium: ["base64", "url_encoded"],
  high:   ["base64", "url_encoded", "unicode_normalized"],
};

export interface SanitizeUserInputResult {
  safe_content: string;
  injection_scan: InjectionScanResult;
  was_blocked: boolean;
  block_reason?: string;
  /** True if the turn-score threshold was exceeded (accumulated across turns). */
  turn_score_exceeded?: boolean;
}

export interface SanitizeExternalContentResult {
  wrapped_content: string;
  injection_scan: InjectionScanResult;
  /** Decode-layer scan details (populated when sensitivity is medium or high). */
  multi_layer_scan?: MultiLayerScanResult | undefined;
  llm_classification?: ClassificationResult | undefined;
  is_suspicious: boolean;
  suspicion_reason?: string | undefined;
  /** True if the turn-score threshold was exceeded (accumulated across turns). */
  turn_score_exceeded?: boolean;
}

export interface SanitizerConfig {
  mode: "heuristic" | "llm" | "both";
  llm_threshold: number; // 0.7 default: flag if injection_confidence >= threshold
  block_on_critical: boolean; // Block (vs warn) on critical heuristic matches
  sensitivity: SensitivityLevel; // low|medium|high — default read from INJECTION_SENSITIVITY
}

function parseSensitivity(raw: string | undefined): SensitivityLevel {
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return "medium";
}

const DEFAULT_CONFIG: SanitizerConfig = {
  mode: "both",
  llm_threshold: 0.7,
  block_on_critical: true,
  // Read from env at startup (§H.1 — not per-call)
  sensitivity: parseSensitivity(process.env["INJECTION_SENSITIVITY"]),
};

export class SanitizerService {
  private config: SanitizerConfig;
  private sessionDelimiters: Map<string, SessionDelimiters>;
  private llmClassifier?: LLMClassifierAdapter | undefined;
  private turnScoreTracker: TurnScoreTracker;

  constructor(config: Partial<SanitizerConfig> = {}, llmClassifier?: LLMClassifierAdapter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionDelimiters = new Map();
    this.llmClassifier = llmClassifier;
    this.turnScoreTracker = new TurnScoreTracker(this.config.sensitivity);
  }

  /**
   * Create session delimiters for a new session.
   * Must be called when a session is created.
   */
  initSession(sessionId: string): SessionDelimiters {
    const delimiters = createSessionDelimiters(sessionId);
    this.sessionDelimiters.set(sessionId, delimiters);
    return delimiters;
  }

  /**
   * Clean up session state when session ends.
   */
  destroySession(sessionId: string): void {
    this.sessionDelimiters.delete(sessionId);
    this.turnScoreTracker.resetSession(sessionId);
  }

  /**
   * Sanitize user-provided input (from authenticated user).
   * Runs heuristic scan but does NOT block on matches (user is trusted,
   * but we still log and alert on suspicious content for visibility).
   * Turn score is accumulated — repeated suspicious input from a user escalates.
   */
  sanitizeUserInput(content: string, sessionId: string): SanitizeUserInputResult {
    const injection_scan = scanForInjection(content);

    // Check if user input contains session delimiters
    const delimiters = this.sessionDelimiters.get(sessionId);
    if (delimiters && containsDelimiter(content, delimiters)) {
      injection_scan.matches.push({
        pattern_id: "SESSION_DELIMITER_IN_USER_INPUT",
        severity: "high",
        excerpt: content.slice(0, 200),
      });
      injection_scan.is_suspicious = true;
    }

    // Accumulate turn score (user inputs are still tracked for incremental probing)
    const turnResult = this.turnScoreTracker.addMatches(sessionId, injection_scan.matches);
    const turn_score_exceeded = turnResult.threshold_exceeded;

    const tagged: TaggedContent = tagUserInstruction(content);

    const result: SanitizeUserInputResult = {
      safe_content: formatTaggedContent(tagged),
      injection_scan,
      was_blocked: false,
      ...(turn_score_exceeded ? { turn_score_exceeded: true } : {}),
    };
    return result;
  }

  /**
   * Sanitize external content (web scraping, file reads, email body, etc.).
   * Runs decode-then-scan (per sensitivity), heuristic scan, and LLM classification.
   * Content is wrapped in session-specific DATA delimiters.
   */
  async sanitizeExternalContent(
    content: string,
    sessionId: string,
    source: string
  ): Promise<SanitizeExternalContentResult> {
    const delimiters = this.sessionDelimiters.get(sessionId);
    if (!delimiters) {
      throw new Error(`No session delimiters found for session ${sessionId}. Call initSession() first.`);
    }

    // 1. Heuristic scan on original content
    const injection_scan = scanForInjection(content);

    // 2. Check if content tries to reproduce session delimiters
    if (containsDelimiter(content, delimiters)) {
      injection_scan.is_suspicious = true;
      injection_scan.matches.push({
        pattern_id: "SESSION_DELIMITER_ESCAPE_ATTEMPT",
        severity: "critical",
        excerpt: content.slice(0, 200),
      });
    }

    // 3. Decode-then-scan (applied per sensitivity level)
    const decodeLayers = DECODE_LAYERS_BY_SENSITIVITY[this.config.sensitivity];
    let multi_layer_scan: MultiLayerScanResult | undefined;
    if (decodeLayers.length > 0) {
      multi_layer_scan = scanWithDecodedLayers(content, decodeLayers);
      // Merge any new matches found in decoded layers into injection_scan
      for (const decodedMatch of multi_layer_scan.all_matches) {
        const alreadyPresent = injection_scan.matches.some(
          (m) => m.pattern_id === decodedMatch.pattern_id,
        );
        if (!alreadyPresent) {
          injection_scan.matches.push(decodedMatch);
          if (!injection_scan.is_suspicious) {
            injection_scan.is_suspicious = true;
          }
        }
      }
    }

    // 4. Apply sensitivity filter — only matches at or above min severity set is_suspicious
    const sensitiveMatches = injection_scan.matches.filter((m) =>
      this.turnScoreTracker.isSeveritySuspicious(m.severity),
    );
    const is_suspicious_from_heuristic = sensitiveMatches.length > 0;

    // 5. Accumulate turn score using ALL matches (not filtered — full data for audit)
    const turnResult = this.turnScoreTracker.addMatches(sessionId, injection_scan.matches);
    const turn_score_exceeded = turnResult.threshold_exceeded;

    // If turn score exceeded, inject a synthetic match so callers see it
    if (turn_score_exceeded && !injection_scan.matches.some((m) => m.pattern_id === "TURN_SCORE_THRESHOLD_EXCEEDED")) {
      injection_scan.matches.push({
        pattern_id: "TURN_SCORE_THRESHOLD_EXCEEDED",
        severity: "high",
        excerpt: `Accumulated score ${turnResult.current_score} >= threshold ${turnResult.threshold}`,
      });
      injection_scan.is_suspicious = true;
    }

    // 6. LLM classification for external content (if enabled and classifier available)
    let llm_classification: ClassificationResult | undefined;
    if (
      (this.config.mode === "llm" || this.config.mode === "both") &&
      this.llmClassifier
    ) {
      llm_classification = await classifyExternalContent(
        content,
        this.llmClassifier,
        { threshold: this.config.llm_threshold }
      );
    }

    const is_suspicious =
      is_suspicious_from_heuristic ||
      turn_score_exceeded ||
      (llm_classification !== undefined &&
        llm_classification.injection_confidence >= this.config.llm_threshold);

    let suspicion_reason: string | undefined;
    if (is_suspicious) {
      if (is_suspicious_from_heuristic) {
        suspicion_reason = `Heuristic: ${sensitiveMatches.map((m) => m.pattern_id).join(", ")}`;
      } else if (turn_score_exceeded) {
        suspicion_reason = `Turn score threshold exceeded: ${turnResult.current_score}/${turnResult.threshold}`;
      } else {
        suspicion_reason = `LLM classifier confidence: ${llm_classification?.injection_confidence ?? 0}`;
      }
    }

    // 7. Wrap external content in DATA delimiters
    const tagged = tagExternalData(content, source);
    const wrapped = wrapExternalContent(
      formatTaggedContent(tagged),
      delimiters,
      source
    );

    const result: SanitizeExternalContentResult = {
      wrapped_content: wrapped,
      injection_scan,
      is_suspicious,
      ...(multi_layer_scan !== undefined ? { multi_layer_scan } : {}),
      ...(llm_classification !== undefined ? { llm_classification } : {}),
      ...(suspicion_reason !== undefined ? { suspicion_reason } : {}),
      ...(turn_score_exceeded ? { turn_score_exceeded: true } : {}),
    };
    return result;
  }

  /**
   * Check output before executing a destructive tool.
   * Returns guardrail result — callers must respect blocking violations.
   */
  checkOutputGuardrails(toolId: string, toolInputJson: string): GuardrailResult {
    return checkOutputGuardrails(toolId, toolInputJson);
  }

  /**
   * Detect and redact PII in any content string.
   */
  detectPii(content: string): PiiDetectionResult {
    return detectAndRedactPii(content);
  }

  /**
   * Check whether a URL is safe to request (SSRF prevention).
   * Validates scheme, private IP ranges, metadata endpoints, and domain lists.
   * Pure sync — does not resolve DNS.
   */
  checkUrlSafety(url: string): UrlSafetyResult {
    return checkUrlSafety(url);
  }

  /**
   * Async SSRF check that also resolves DNS and validates all returned IPs.
   * Defends against DNS rebinding: a hostname that passes the sync string
   * check may still resolve to a private IP at fetch time.
   * Fail-closed: DNS resolution failures are treated as blocked.
   */
  async checkUrlSafetyResolved(url: string): Promise<UrlSafetyResult> {
    return checkUrlSafetyResolved(url);
  }

  /**
   * Quick injection check — throws InjectionDetectedError on critical matches.
   * Use for fast-path blocking of clearly malicious inputs.
   */
  assertNotInjection(content: string): void {
    const result = scanForInjection(content);
    if (
      result.is_suspicious &&
      result.highest_severity === "critical" &&
      this.config.block_on_critical
    ) {
      const match = result.matches[0];
      if (match) {
        throw new InjectionDetectedError(match.pattern_id, match.excerpt);
      }
    }
  }
}
