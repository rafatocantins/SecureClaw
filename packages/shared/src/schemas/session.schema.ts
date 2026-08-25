import { z } from "zod";

export const SessionStatusSchema = z.enum([
  "active",
  "idle",
  "awaiting_approval",
  "terminated",
  "error",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionMetadataSchema = z.object({
  channel: z.string().optional(),
  user_agent: z.string().optional(),
  ip_address: z.string().optional(),
});

export const SessionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string(),
  provider: z.string(),
  status: SessionStatusSchema,
  created_at: z.string().datetime(),
  last_activity_at: z.string().datetime(),
  total_input_tokens: z.number().int().default(0),
  total_output_tokens: z.number().int().default(0),
  total_cost_usd: z.number().default(0),
  tool_call_count: z.number().int().default(0),
  metadata: SessionMetadataSchema.optional(),
});

export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionRequestSchema = z.object({
  provider: z.string().min(1),
  metadata: SessionMetadataSchema.optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
