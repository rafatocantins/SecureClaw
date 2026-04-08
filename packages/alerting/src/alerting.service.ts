/**
 * alerting.service.ts — Webhook alert delivery for Tessera security events.
 *
 * SECURITY:
 * - HTTPS-only endpoint validation on construction (loopback 127.0.0.1/::1 allowed for dev)
 * - "localhost" NOT trusted (DNS rebinding risk — per PO AC-3)
 * - HMAC-SHA256 signing with X-Webhook-Signature header if secret is set
 * - Vault-ref stripping: __VAULT_REF:*__ patterns removed before payload assembly
 * - Fire-and-forget: never throws to caller, never blocks agent turn
 * - ALERT_SENT audit event emitted for every delivery attempt
 */
import { createRequire } from "node:module";
import { signHmac } from "@tessera/shared";
import { AlertPayloadSchema } from "./schemas/alert.schema.js";
import type { AlertPayload } from "./schemas/alert.schema.js";

// Read package version once at module load — included in every alert payload
// as tessera_version to help SIEM systems correlate events across upgrades.
const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };
export const TESSERA_VERSION: string = _pkg.version;

export interface AlertingServiceConfig {
  /** Must be HTTPS or http://127.0.0.1:* / http://[::1]:* for dev. Validated on construction. */
  webhookUrl: string;
  /** HMAC-SHA256 signing key. If empty string, signature header is omitted. */
  webhookSecret: string;
  /** POST timeout in ms. Default: 10000 (10 seconds). */
  timeoutMs?: number | undefined;
}

export interface DeliveryResult {
  success: boolean;
  status_code?: number | undefined;
  error?: string | undefined;
}

/**
 * Emitted after every fireAlert() delivery attempt (success or failure).
 * The agent-runtime caller converts this into an ALERT_SENT audit log entry.
 */
export interface AlertAuditEvent {
  session_id: string;
  user_id: string;
  alert_event_type: string;
  delivery_success: boolean;
  status_code?: number | undefined;
  error?: string | undefined;
}

/**
 * Strip __VAULT_REF:*__ placeholders from any string.
 * Applied to excerpt (INJECTION_DETECTED) and input_preview (APPROVAL_REQUESTED)
 * before the payload is assembled — raw vault refs must never appear in webhook bodies.
 * Exported so agent-loop.ts can import it for pre-assembly stripping.
 */
export function stripVaultRefs(s: string): string {
  return s.replace(/__VAULT_REF:[a-f0-9-]+__/gi, "[REDACTED]");
}

export class AlertingService {
  private readonly config: AlertingServiceConfig;

  constructor(config: AlertingServiceConfig) {
    this.validateWebhookUrl(config.webhookUrl);
    this.config = config;
  }

  /**
   * Fire-and-forget webhook delivery.
   * Never throws. Errors are written to stderr and reported via auditFn.
   *
   * @param payload   Validated alert payload (vault refs must be stripped by caller)
   * @param auditFn   Optional callback invoked with delivery result for audit logging
   * @returns         DeliveryResult (useful in tests; callers should void-discard)
   */
  async fireAlert(
    payload: AlertPayload,
    auditFn?: ((event: AlertAuditEvent) => void) | undefined
  ): Promise<DeliveryResult> {
    // Strip vault refs from user-derived string fields before schema parse
    const sanitized = this.sanitizePayload(payload);

    // Validate through Zod schema — malformed payloads are logged and skipped
    const parseResult = AlertPayloadSchema.safeParse(sanitized);
    if (!parseResult.success) {
      const errMsg = `AlertingService: invalid payload for ${payload.event_type}: ${parseResult.error.message}`;
      process.stderr.write(`[alerting] ${errMsg}\n`);
      const result: DeliveryResult = { success: false, error: errMsg };
      auditFn?.({
        session_id: payload.session_id,
        user_id: payload.user_id,
        alert_event_type: payload.event_type,
        delivery_success: false,
        error: errMsg,
      });
      return result;
    }

    const validPayload = parseResult.data;
    const bodyBytes = Buffer.from(JSON.stringify(validPayload), "utf-8");
    const sig = this.signPayload(bodyBytes);
    const result = await this.postWithTimeout(validPayload.event_type, bodyBytes, sig);

    auditFn?.({
      session_id: validPayload.session_id,
      user_id: validPayload.user_id,
      alert_event_type: validPayload.event_type,
      delivery_success: result.success,
      ...(result.status_code !== undefined ? { status_code: result.status_code } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });

    return result;
  }

  // ── Private methods ────────────────────────────────────────────────────────

  /**
   * Validate webhook URL on construction so misconfiguration fails fast.
   * HTTPS required. Loopback (127.0.0.1, ::1) allowed for dev.
   * "localhost" is NOT trusted — DNS rebinding risk (PO AC-3).
   */
  private validateWebhookUrl(url: string): void {
    const parsed = new URL(url); // throws on malformed URL
    const isLoopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !isLoopback) {
      throw new Error(
        `Webhook URL must use HTTPS (or http://127.0.0.1:* / http://[::1]:* for dev). ` +
        `Got protocol "${parsed.protocol}" for host "${parsed.hostname}". ` +
        `Note: "localhost" is not trusted (DNS rebinding risk).`
      );
    }
  }

  /**
   * HMAC-SHA256 sign the raw body bytes.
   * Format: "sha256=<hex>" — matches gateway auth pattern.
   * Returns empty string if no secret configured (header omitted by postWithTimeout).
   */
  private signPayload(bodyBytes: Buffer): string {
    if (!this.config.webhookSecret) return "";
    // Identical algorithm to gateway auth.plugin.ts signHmac usage:
    // input = raw body as UTF-8 string; output = sha256=<hex HMAC>
    return "sha256=" + signHmac(this.config.webhookSecret, bodyBytes.toString("utf-8"));
  }

  /**
   * HTTP POST with AbortController timeout.
   * Never throws — all errors become DeliveryResult { success: false, error: ... }.
   */
  private async postWithTimeout(
    eventType: string,
    bodyBytes: Buffer,
    sig: string
  ): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Tessera-Event": eventType,
    };
    if (sig) {
      headers["X-Webhook-Signature"] = sig;
    }

    try {
      const resp = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers,
        body: bodyBytes,
        signal: controller.signal,
      });
      return {
        success: resp.status >= 200 && resp.status < 300,
        status_code: resp.status,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[alerting] Webhook POST failed: ${errMsg}\n`);
      return {
        success: false,
        error: errMsg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Strip vault refs from all user-derived string fields in the payload.
   * Covers: excerpt (INJECTION_DETECTED), input_preview (APPROVAL_REQUESTED).
   */
  private sanitizePayload(payload: AlertPayload): AlertPayload {
    if (payload.event_type === "INJECTION_DETECTED") {
      return {
        ...payload,
        excerpt: stripVaultRefs(payload.excerpt),
      };
    }
    if (payload.event_type === "APPROVAL_REQUESTED") {
      return {
        ...payload,
        input_preview: stripVaultRefs(payload.input_preview),
      };
    }
    return payload;
  }
}
