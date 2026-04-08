/**
 * decode-layers.ts — Decode-then-scan: strip common encodings and re-run injection
 * detection on the decoded variants.
 *
 * Rationale: attackers encode payloads (base64, URL-encoding, Unicode homoglyphs)
 * to evade plain-text heuristic checks. This module attempts to decode each layer
 * before rescanning, so that injection patterns are matched against the actual text
 * the model may reconstruct internally.
 *
 * Layers applied (controlled by the caller / sensitivity level):
 *   "base64"           — extract all base64 blobs ≥ 30 chars, decode, rescan
 *   "url_encoded"      — full decodeURIComponent on content, rescan if changed
 *   "unicode_normalized" — NFKD normalization + strip combining marks, rescan if changed
 */
import { scanForInjection } from "../heuristic/injection.detector.js";
import type { InjectionMatch, InjectionScanResult } from "../heuristic/injection.detector.js";

export type DecodeLayer = "base64" | "url_encoded" | "unicode_normalized";

export interface DecodedLayerScan {
  layer: DecodeLayer;
  /** First 120 chars of the decoded text (for logging context). */
  decoded_excerpt: string;
  matches: InjectionMatch[];
}

export interface MultiLayerScanResult {
  /** Raw scan on the original, unmodified content. */
  original: InjectionScanResult;
  /** Results from each successfully decoded layer. */
  decoded_layers: DecodedLayerScan[];
  /**
   * Union of all matches across original + decoded layers.
   * Pattern IDs are deduplicated — the highest-severity instance wins.
   */
  all_matches: InjectionMatch[];
  is_suspicious: boolean;
  highest_severity: "low" | "medium" | "high" | "critical" | null;
}

const SEVERITY_ORDER: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

// Minimum base64 segment length to consider for decoding (avoids false positives
// on short alphanumeric tokens that happen to be valid base64).
const MIN_BASE64_LEN = 30;

// Matches a run of base64 characters (standard alphabet), at least MIN_BASE64_LEN chars.
const BASE64_SEGMENT_RE = new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_LEN},}={0,2}`, "g");

/**
 * Try to find and decode base64 segments within `content`.
 * Returns the concatenation of all successfully decoded segments for rescanning.
 * Returns null if no decodable segments were found.
 */
function tryDecodeBase64Segments(content: string): string | null {
  const decoded: string[] = [];
  let match: RegExpExecArray | null;
  BASE64_SEGMENT_RE.lastIndex = 0;

  while ((match = BASE64_SEGMENT_RE.exec(content)) !== null) {
    const segment = match[0];
    if (segment === undefined) continue;
    try {
      const bytes = Buffer.from(segment, "base64");
      const text = bytes.toString("utf-8");
      // Only use the decoded text if it contains printable ASCII / UTF-8
      // (rejects random binary blobs that happen to be valid base64)
      if (/[\x20-\x7E]/.test(text)) {
        decoded.push(text);
      }
    } catch {
      // Not valid base64 — skip
    }
  }

  return decoded.length > 0 ? decoded.join(" ") : null;
}

/**
 * Try to URL-decode the entire content string.
 * Returns the decoded string if it differs from the original, otherwise null.
 */
function tryDecodeUrl(content: string): string | null {
  try {
    const decoded = decodeURIComponent(content);
    return decoded !== content ? decoded : null;
  } catch {
    // Contains invalid percent-encoding sequences — skip
    return null;
  }
}

/**
 * Normalize content using Unicode NFKD and strip combining diacritical marks
 * (U+0300–U+036F). This catches homoglyph attacks that use accented or
 * visually-similar characters to bypass keyword-based pattern matching.
 * Returns the normalized string if it differs from the original, otherwise null.
 */
function tryNormalizeUnicode(content: string): string | null {
  const normalized = content
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "");
  return normalized !== content ? normalized : null;
}

/**
 * Merge match lists, deduplicating by pattern_id.
 * When two layers produce the same pattern_id, the higher-severity instance wins.
 */
function mergeMatches(
  ...matchLists: InjectionMatch[][]
): InjectionMatch[] {
  const byId = new Map<string, InjectionMatch>();
  for (const list of matchLists) {
    for (const m of list) {
      const existing = byId.get(m.pattern_id);
      if (!existing) {
        byId.set(m.pattern_id, m);
      } else {
        const existingOrder = SEVERITY_ORDER[existing.severity] ?? 0;
        const newOrder = SEVERITY_ORDER[m.severity] ?? 0;
        if (newOrder > existingOrder) {
          byId.set(m.pattern_id, m);
        }
      }
    }
  }
  return Array.from(byId.values());
}

function computeHighestSeverity(
  matches: InjectionMatch[],
): "low" | "medium" | "high" | "critical" | null {
  if (matches.length === 0) return null;
  return matches.reduce<"low" | "medium" | "high" | "critical">(
    (highest, m) => {
      const cur = SEVERITY_ORDER[m.severity] ?? 0;
      const hi = SEVERITY_ORDER[highest] ?? 0;
      return cur > hi ? m.severity : highest;
    },
    "low",
  );
}

/**
 * Scan content with the specified decoding layers applied.
 *
 * @param content - The raw content string to scan.
 * @param layers  - Which decode layers to apply. Empty array = original scan only.
 */
export function scanWithDecodedLayers(
  content: string,
  layers: DecodeLayer[] = ["base64", "url_encoded", "unicode_normalized"],
): MultiLayerScanResult {
  const original = scanForInjection(content);
  const decodedLayers: DecodedLayerScan[] = [];

  if (layers.includes("base64")) {
    const decoded = tryDecodeBase64Segments(content);
    if (decoded !== null) {
      const scanResult = scanForInjection(decoded);
      decodedLayers.push({
        layer: "base64",
        decoded_excerpt: decoded.slice(0, 120),
        matches: scanResult.matches,
      });
    }
  }

  if (layers.includes("url_encoded")) {
    const decoded = tryDecodeUrl(content);
    if (decoded !== null) {
      const scanResult = scanForInjection(decoded);
      decodedLayers.push({
        layer: "url_encoded",
        decoded_excerpt: decoded.slice(0, 120),
        matches: scanResult.matches,
      });
    }
  }

  if (layers.includes("unicode_normalized")) {
    const decoded = tryNormalizeUnicode(content);
    if (decoded !== null) {
      const scanResult = scanForInjection(decoded);
      decodedLayers.push({
        layer: "unicode_normalized",
        decoded_excerpt: decoded.slice(0, 120),
        matches: scanResult.matches,
      });
    }
  }

  const all_matches = mergeMatches(
    original.matches,
    ...decodedLayers.map((l) => l.matches),
  );

  const is_suspicious = all_matches.length > 0;
  const highest_severity = computeHighestSeverity(all_matches);

  return {
    original,
    decoded_layers: decodedLayers,
    all_matches,
    is_suspicious,
    highest_severity,
  };
}
