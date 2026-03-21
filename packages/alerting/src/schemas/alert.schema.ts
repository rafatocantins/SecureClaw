import { z } from "zod";

/**
 * Base fields shared by all four alert event types.
 * Per Product Owner approval: event_type discriminator, timestamp, tessera_version.
 */
const AlertBaseSchema = z.object({
  event_type: z.enum([
    "APPROVAL_REQUESTED",
    "QUOTA_BREACH",
    "INJECTION_DETECTED",
    "POLICY_DENIED",
  ]),
  timestamp: z.string(),         // ISO 8601
  tessera_version: z.string(),   // from package.json at module load time
  session_id: z.string(),
  user_id: z.string(),
});

/**
 * APPROVAL_REQUESTED — fires when agent requests human approval for a tool call.
 * input_preview included per PO requirement (max 300 chars, vault refs stripped).
 */
export const ApprovalRequestedPayloadSchema = AlertBaseSchema.extend({
  event_type: z.literal("APPROVAL_REQUESTED"),
  call_id: z.string(),
  tool_id: z.string(),
  input_preview: z.string().max(300),
});

/**
 * QUOTA_BREACH — fires when team spending reaches or exceeds configured quota.
 * team_id required per PO approval (explicit field in payload struct).
 */
export const QuotaBreachPayloadSchema = AlertBaseSchema.extend({
  event_type: z.literal("QUOTA_BREACH"),
  team_id: z.string(),
  spent_usd: z.number(),
  quota_usd: z.number(),
});

/**
 * INJECTION_DETECTED — fires on user input injection (~line 126) and tool output
 * injection (~line 681) in agent-loop.ts. Both trigger points fire independently.
 * excerpt is max 256 chars with vault refs stripped (AC-14).
 */
export const InjectionDetectedPayloadSchema = AlertBaseSchema.extend({
  event_type: z.literal("INJECTION_DETECTED"),
  source: z.enum(["user_input", "tool_output"]),
  excerpt: z.string().max(256),
});

/**
 * POLICY_DENIED — fires on three sub-triggers:
 *   "policy_engine_denied" — deny-by-default policy rejects tool call
 *   "ssrf_block"           — URL safety check blocks http_request
 *   "turn_cap_exceeded"    — agent hit max turn limit
 * tool_id is optional because turn_cap has no specific tool.
 */
export const PolicyDeniedPayloadSchema = AlertBaseSchema.extend({
  event_type: z.literal("POLICY_DENIED"),
  reason: z.string(),
  ...({}),
});

export const PolicyDeniedPayloadWithToolSchema = PolicyDeniedPayloadSchema.extend({
  tool_id: z.string().optional(),
});

/**
 * Discriminated union of all four event payload types.
 * Used to validate payloads before POST.
 */
export const AlertPayloadSchema = z.discriminatedUnion("event_type", [
  ApprovalRequestedPayloadSchema,
  QuotaBreachPayloadSchema,
  InjectionDetectedPayloadSchema,
  PolicyDeniedPayloadWithToolSchema,
]);

export type ApprovalRequestedPayload = z.infer<typeof ApprovalRequestedPayloadSchema>;
export type QuotaBreachPayload = z.infer<typeof QuotaBreachPayloadSchema>;
export type InjectionDetectedPayload = z.infer<typeof InjectionDetectedPayloadSchema>;
export type PolicyDeniedPayload = z.infer<typeof PolicyDeniedPayloadWithToolSchema>;
export type AlertPayload = z.infer<typeof AlertPayloadSchema>;
