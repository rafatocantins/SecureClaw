/**
 * session-context.ts — Per-session isolated state.
 *
 * SECURITY: Each session is completely isolated.
 * No data leaks between sessions, even from the same user.
 * Destroyed when the session ends — no persistent state in memory.
 */
import type { LLMMessage } from "../llm/provider.interface.js";
import type { LLMProvider } from "../llm/provider.interface.js";
import type { SessionDelimiters } from "@tessera/input-sanitizer";
import type { HarnessPatchPrompt } from "../prompt/system-prompt-builder.js";

export interface SessionContext {
  readonly session_id: string;
  readonly user_id: string;
  readonly created_at: number;
  provider: LLMProvider;
  delimiters: SessionDelimiters;
  messages: LLMMessage[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  tool_call_count: number;
  status: "active" | "idle" | "awaiting_approval" | "terminated" | "error";
  last_activity_at: number;
  /** Lessons from prior sessions, injected into the system prompt on first turn. */
  priorLessons: string[];
  /** Active harness patches to inject into the system prompt (from self-evolution). */
  activePatches?: HarnessPatchPrompt[];
  /** Set to true if any tool call failed during this session (used for self-critique). */
  hadToolFailure: boolean;
}

export function createSessionContext(params: {
  session_id: string;
  user_id: string;
  provider: LLMProvider;
  delimiters: SessionDelimiters;
}): SessionContext {
  return {
    session_id: params.session_id,
    user_id: params.user_id,
    created_at: Date.now(),
    provider: params.provider,
    delimiters: params.delimiters,
    messages: [],
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    tool_call_count: 0,
    status: "active",
    last_activity_at: Date.now(),
    priorLessons: [],
    hadToolFailure: false,
  };
}

export function addUserMessage(ctx: SessionContext, content: string): void {
  ctx.messages.push({ role: "user", content });
  ctx.last_activity_at = Date.now();
}

export function addAssistantMessage(
  ctx: SessionContext,
  content: string,
  toolCalls?: Array<{ call_id: string; tool_id: string; input: Record<string, unknown> }>
): void {
  ctx.messages.push({
    role: "assistant",
    content,
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  });
  ctx.last_activity_at = Date.now();
}

export function addToolResult(
  ctx: SessionContext,
  toolCallId: string,
  toolName: string,
  result: string
): void {
  ctx.messages.push({
    role: "tool",
    content: result,
    tool_call_id: toolCallId,
    tool_name: toolName,
  });
  ctx.last_activity_at = Date.now();
}

export function recordUsage(
  ctx: SessionContext,
  inputTokens: number,
  outputTokens: number,
  costUsd: number
): void {
  ctx.total_input_tokens += inputTokens;
  ctx.total_output_tokens += outputTokens;
  ctx.total_cost_usd += costUsd;
}
