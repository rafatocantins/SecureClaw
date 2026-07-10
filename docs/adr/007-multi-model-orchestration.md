# ADR-007: Multi-Model Orchestration Architecture

**Status:** Proposed
**Date:** 2026-07-10
**Deciders:** Augustus (strategic advisor), Marcus (architect), Kai (developer)

## Context

Tessera currently uses a **single model per session** — the user or administrator selects one provider/model pair at session initialization, and every tool call, reflection step, and response generation goes through that same model. This was sufficient for MVP (March–April 2026), but it is now the single largest competitive gap in the platform.

### Research Evidence (14 Papers Analyzed)

Augustus conducted a comprehensive literature review (see References) covering the state-of-the-art in multi-model orchestration as of July 2026. Three key findings drive this ADR:

1. **Orchestration beats individual models decisively.** TRINITY (ICLR 2026) achieves 86.2% on LiveCodeBench with a coordinator under 20K trainable parameters orchestrating a pool of larger models — beating GPT-5's standalone 83.8%. Conductor (ICLR 2026) proves a 7B-parameter orchestrator (Qwen2.5-7B) directing GPT-5, Claude Sonnet 4, and Gemini 2.5 Pro outperforms every individual worker. The Sakana Fugu-Ultra system (June 2026) leads 10 of 11 major benchmarks using orchestrated heterogeneous worker pools.

2. **Cost optimization is a solved problem.** AgentCollab (2026) demonstrates that "cheap tries, expensive decides" — routing simple tasks to a fast/cheap model and escalating only complex tasks — achieves near-optimal cost-quality tradeoffs. The "Harness Updating Is Not Harness Benefit" paper (May 2026) proves that cheap models (Qwen3.5-9B) produce harness/prompt updates as good as Claude Opus 4.6, meaning self-improvement loops need not be expensive.

3. **Hallucination reduction is measurable and significant.** Council Mode (2026) achieves a 35.9% reduction in hallucinations through triage → parallel generation → synthesis. S²-MAD (2025) cuts 94.5% of tokens with under 2% quality loss via early-stop debate with a verifier gate.

### Available Models

Rafael has approved allocation of these models (June 2026):

| Model | Cost (input) | Cost (output) | Best Role |
|---|---|---|---|
| DeepSeek V4 Pro | $1.74/M | $3.48/M | Primary worker (coding, complex reasoning) |
| DeepSeek V4 Flash | $0.14/M | $0.42/M | Triage, harness evolution, verifier |
| MiniMax M3 | $0.30/M | $1.20/M | Tiebreaker/judge, medium-complexity worker |
| Claude Sonnet 4.6 | $3.00/M | $15.00/M | Strategic analysis, architecture design |

### Cost Feasibility

At ~10 sessions/day with triage overhead, the incremental cost of orchestration is estimated at **~€0.42/month** — well within Rafael's ~€10/month budget.

## Decision

**We will build a multi-model orchestration layer in `packages/agent-runtime` that dynamically assigns tasks to models based on a triage classifier and a TRINITY-inspired Thinker/Worker/Verifier architecture.**

> **TRINITY fidelity note:** TRINITY (ICLR 2026) uses a **trained coordinator** (sep-CMA-ES, <20K parameters) that learns to decompose tasks through evolutionary optimization against a reward signal. Our v1 orchestrator uses a **prompt-based Flash classifier** — fundamentally different. Prompt-based decomposition will be less precise than a trained coordinator, particularly for novel or ambiguous tasks. We commit to:
> - Measuring the decomposition quality gap in integration tests (comparing Flash triage decisions against a human-labeled complexity benchmark).
> - Setting realistic expectations: the v1 orchestrator will improve on single-model quality for clear-cut cases but may misclassify borderline tasks.
> - Revisiting learned orchestration (sep-CMA-ES or RL) in Sprint 4 if session volume justifies the training investment.
>
> This is also discussed in Alternatives Considered §6 (Fugu-style Learned Orchestrator).

The system is feature-flagged behind `TESSERA_ORCHESTRATOR_ENABLED` (default: `false` for backward compatibility) and introduces no breaking changes to existing single-model sessions.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentRuntime (gRPC)                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Orchestrator (new module)                 │  │
│  │                                                       │  │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────────────┐  │  │
│  │  │  Triage  │──▶│  Router  │──▶│  Thinker          │  │  │
│  │  │Classifier│   │ (select  │   │  (decompose task) │  │  │
│  │  └──────────┘   │  model)  │   └───────┬──────────┘  │  │
│  │                 └──────────┘           │              │  │
│  │                                        ▼              │  │
│  │  ┌──────────────────────────────────────────────────┐ │  │
│  │  │              Worker (execute)                    │ │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │ │  │
│  │  │  │DeepSeek  │  │MiniMax   │  │ Claude       │  │ │  │
│  │  │  │V4 Pro    │  │M3        │  │ Sonnet 4.6   │  │ │  │
│  │  │  └──────────┘  └──────────┘  └──────────────┘  │ │  │
│  │  └───────────────────────┬──────────────────────────┘ │  │
│  │                          │ output                     │  │
│  │                          ▼                            │  │
│  │  ┌──────────────────────────────────────────────────┐ │  │
│  │  │              Verifier (validate)                 │ │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │ │  │
│  │  │  │Flash     │  │M3 (judge│  │ Criteria:    │  │ │  │
│  │  │  │(primary) │  │ tiebreak)│  │ factual,     │  │ │  │
│  │  │  │          │  │          │  │ complete,    │  │ │  │
│  │  │  │          │  │          │  │ safe          │  │ │  │
│  │  │  └──────────┘  └──────────┘  └──────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────┘ │  │
│  │                                                       │  │
│  │  ┌──────────────────────────────────────────────────┐ │  │
│  │  │         Provider Abstraction Layer               │ │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │ │  │
│  │  │  │DeepSeek  │  │MiniMax   │  │ OpenRouter   │  │ │  │
│  │  │  │Adapter   │  │Adapter   │  │ Adapter      │  │ │  │
│  │  │  └──────────┘  └──────────┘  └──────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Existing (unchanged)                                 │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │  │
│  │  │Reflection│  │ Vector   │  │ RBAC             │   │  │
│  │  │Loop (3A) │  │Memory(3B)│  │ (4A)             │   │  │
│  │  └──────────┘  └──────────┘  └──────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Model Selection Strategy: Triage Classifier

We evaluated three options and selected the **triage classifier**:

| Option | Pros | Cons |
|---|---|---|
| Triage classifier | Low latency (1 call), simple, proven (-35.9% hallucinations in Council Mode) | One extra call per session |
| Static rules | Zero latency, predictable | Brittle, can't adapt to novel tasks |
| Complexity score | Fine-grained | Requires calibration, higher latency |

**How it works:**

1. On session start (if `TESSERA_ORCHESTRATOR_ENABLED=true`), the orchestrator sends the user's first message to DeepSeek Flash with a compact classification prompt.
2. Flash returns a structured classification: `{ complexity: "simple" | "medium" | "complex", roles: string[], reasoning: string }`.
3. The orchestrator routes based on the result:
   - **Simple** → Flash executes directly (single-call, cheapest path)
   - **Medium** → DeepSeek V4 Pro with self-critique (leverages existing reflection loop 3A)
   - **Complex** → TRINITY-style: Thinker (Flash) decomposes → Worker (Pro) executes → Verifier (Flash) validates

**Pseudocode:**

```
async function selectModel(userMessage: string, ctx: SessionContext): Promise<ModelAssignment> {
  const result = await callFlash(classifyPrompt(userMessage, ctx));
  const { complexity, roles } = parseStructuredOutput(result);

  switch (complexity) {
    case "simple":
      return { primary: "flash", roles: [] };
    case "medium":
      return { primary: "pro", roles: ["worker"], enableSelfCritique: true };
    case "complex":
      return {
        primary: "pro",
        roles: ["thinker", "worker", "verifier"],
        thinker: "flash",
        worker: "pro",
        verifier: "flash",
      };
  }
}
```

**Rationale:** The triage classifier costs ~€0.0005 per session (one Flash call at ~150 tokens) and provides data-driven routing that adapts to novel tasks. Static rules cannot capture task nuance, and complexity scoring adds latency without commensurate benefit.

### Provider Interface (TypeScript)

The provider abstraction uses the **Adapter pattern** to decouple the orchestrator from specific API implementations. Every provider conforms to a single interface, and adding a new provider requires only implementing that interface — zero changes to the orchestrator.

```typescript
// packages/agent-runtime/src/orchestrator/provider.interface.ts

import { z } from "zod";

// ── Envelope types (shared across all providers) ──

export const MessageRole = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const ChatMessage = z.object({
  role: MessageRole,
  content: z.string(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ProviderResponse = z.object({
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.string(),
      })
    )
    .optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  finishReason: z.enum(["stop", "tool_calls", "length", "content_filter"]),
});
export type ProviderResponse = z.infer<typeof ProviderResponse>;

// ── Cost metadata (per-request, for cost_ledger) ──

export interface ProviderCostInfo {
  /** Provider + model identifier, e.g. "deepseek/v4-pro" */
  modelKey: string;
  /** Cost per 1M input tokens in euro cents (for ledger aggregation) */
  inputCostPerMillionEuroCents: number;
  /** Cost per 1M output tokens in euro cents */
  outputCostPerMillionEuroCents: number;
  /** Role this invocation served, e.g. "triage", "worker", "verifier" */
  role: string;
}

// ── Provider interface (the core abstraction) ──

export interface LLMProvider {
  /** Unique provider ID, e.g. "deepseek", "minimax", "openrouter" */
  readonly providerId: string;

  /**
   * List models available through this provider.
   * Each model name is provider-qualified, e.g. "deepseek/v4-pro".
   */
  listModels(): string[];

  /**
   * Get cost metadata for a specific model. Used by the cost tracker
   * to attribute usage in the cost_ledger without hardcoding prices.
   */
  getCostInfo(model: string): ProviderCostInfo;

  /**
   * Send a chat completion request.
   *
   * @param model  - Provider-qualified model name
   * @param messages - Conversation messages (vault refs already resolved to placeholders)
   * @param tools  - Tool definitions (optional, for function-calling models)
   * @param signal - AbortSignal for cancellation
   * @returns ProviderResponse with content, tool calls, and token usage
   *
   * @throws ProviderError on API failure (see failover section)
   */
  chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<ProviderResponse>;
}

// ── Error types for failover ──

export const ProviderErrorKind = z.enum([
  "timeout",
  "rate_limited",
  "auth_failure",
  "server_error",
  "content_filter",
  "unknown",
]);
export type ProviderErrorKind = z.infer<typeof ProviderErrorKind>;

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderErrorKind,
    public readonly providerId: string,
    public readonly model: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
```

**Key design decisions in this interface:**

1. **Zod is the single source of truth** for all cross-boundary types (per project rule E.4). No parallel interfaces. `z.infer<typeof Schema>` drives all runtime validation.
2. **`ProviderCostInfo` is returned by the adapter, not hardcoded** — each adapter knows its own pricing model. The cost tracker calls `getCostInfo()` once per model assignment and multiplies by token usage.
3. **`ProviderError` carries a `retryable` flag** — the failover chain reads this to decide whether to retry the same model or escalate to the next.
4. **`AbortSignal` support** — allows the orchestrator to cancel slow calls during failover without leaking connections.
5. **Tool definitions are optional** — the triage/verifier models receive no tools (they only see structured output), reducing both cost and security surface.

### Relationship to the Existing LLMProvider Interface

The ADR proposes a new `LLMProvider` interface that differs from the **existing** one (`packages/agent-runtime/src/llm/provider.interface.ts`). This is deliberate and the interfaces serve different purposes:

| Concern | Existing LLMProvider | ADR LLMProvider |
|---|---|---|
| **Model binding** | One model per instance (`provider_name` + `model_name` read-only) | Multi-model via `chat(model, ...)` |
| **Streaming** | `streamCompletion()` (AsyncIterable, token-by-token) + `complete()` (non-streaming) | `chat()` (non-streaming only in v1) |
| **Cost currency** | `estimateCostUsd()` returns USD | `getCostInfo()` returns EUR cents |
| **Error handling** | Throws on failure | Structured `ProviderError` with `retryable` flag |
| **Tools** | `LLMTool[]` (`{ id, description, input_schema }`) | `ToolDefinition[]` (`{ name, description, parameters }`) |
| **Capabilities** | No model listing | `listModels()` for discovery |

**Migration strategy — the orchestrator wraps AgentLoop, not replaces it:**

The ADR originally referenced `createSingleModelAgentLoop()` — a function that **does not exist** in the current codebase. The actual integration path is:

1. **Existing code path** (`TESSERA_ORCHESTRATOR_ENABLED=false`): `startAgentGrpcServer(sessionManager, agentLoop, addr)` where `agentLoop` is an `AgentLoop` instance — unchanged.

2. **Orchestrated code path** (`TESSERA_ORCHESTRATOR_ENABLED=true`): The orchestrator implements the **same caller-facing contract** as `AgentLoop.run()` — an `AsyncGenerator<GrpcAgentChunk>`. Internally, the orchestrator uses the new `LLMProvider` adapters for its own model calls (triage, thinker, verifier), but it delegates actual tool-execution work to a wrapped `AgentLoop` instance. Concretely:

```typescript
// Orchestrator wraps AgentLoop — it intercepts the first message for triage,
// then delegates the real work to AgentLoop with the selected model.
class Orchestrator {
  constructor(
    private providers: Map<string, LLMProvider>,  // new interface
    private agentLoop: AgentLoop,                  // existing AgentLoop
    private sessionManager: SessionManager
  ) {}

  async *run(ctx: SessionContext, content: string): AsyncGenerator<GrpcAgentChunk> {
    // 1. Triage with Flash (via new LLMProvider)
    const classification = await this.classify(content, ctx);
    
    // 2. Set the appropriate provider on the session context
    ctx.provider = this.selectProvider(classification);
    
    // 3. Delegate to existing AgentLoop for streaming execution
    yield* this.agentLoop.run(ctx, content);
    
    // 4. (Complex only) Verify after AgentLoop completes
    if (classification.complexity === "complex") {
      yield* this.verifyAndCorrect(ctx, classification);
    }
  }
}
```

This design means:
- The `startAgentGrpcServer(sessionManager, orchestrator, addr)` call works because `Orchestrator.run()` has the same signature.
- The existing `AgentLoop` continues to handle tool execution, policy enforcement, and streaming — unchanged.
- The new `LLMProvider` adapters are thin wrappers around provider SDKs; they do not duplicate `AgentLoop`'s security logic.
- A future refactoring (Sprint 3) can extract a shared `AgentLoopCore` that both paths use, but this is not required for v1.

### Failover Chain

The failover chain is **linear with retry-aware escalation**, inspired by AgentCollab's "cheap tries, expensive decides" but applied to reliability rather than quality.

```
Primary (Pro) ──▶ Fallback (Flash) ──▶ Last-resort (M3) ──▶ Error to user
     │                    │                    │
     ├─ timeout          ├─ timeout           ├─ timeout
     ├─ rate_limited     ├─ rate_limited      └─ All fail →
     ├─ server_error     └─ server_error         GRPC status
     └─ (retryable?)                             UNAVAILABLE
```

**Rules:**

| From | Condition | To | Behavior |
|---|---|---|---|
| Pro | `retryable=true` + retries < 2 | Pro | Exponential backoff (1s, 2s, 4s) |
| Pro | `retryable=false` or retries exhausted | Flash | Log warning, emit `FAILOVER_STARTED` audit event |
| Flash | `retryable=true` + retries < 1 | Flash | Single retry |
| Flash | Failed | M3 | Log warning, emit `FAILOVER_CRITICAL` audit event |
| M3 | Failed | — | Return `UNAVAILABLE` gRPC status to caller |

**What counts as retryable:**
- `timeout` — yes (network blip)
- `rate_limited` — yes (quotas fluctuate)
- `server_error` (5xx) — yes (transient)
- `auth_failure` — **no** (will not self-heal)
- `content_filter` — **no** (re-sending same content would re-trigger)

**What happens to in-flight state:**
- The orchestrator replays the **original messages + any completed tool results** into the fallback model — no loss of context.
- If the primary model returned partial tool calls before failing, those are discarded; the fallback starts fresh from the last known-good state.
- Each failover step is recorded in `audit_events` with: `{ from_model, to_model, reason, session_id, latency_ms }`.

### Flash Single Point of Failure

Flash serves **four distinct roles** in v1: triage classifier, thinker (task decomposition), verifier (output validation), and fallback model. This concentration creates a single point of failure:

| Failure scenario | Impact | Mitigation |
|---|---|---|
| Flash API degraded | All complex sessions stall at triage, thinking, or verification | M3 can substitute for triage; verifier can be skipped with `VERIFIER_MODE=warn-only` |
| Flash rate-limited | Simple tasks (Flash-only path) fail entirely | Simple tasks escalate to Pro with self-critique |
| Flash unavailable | Orchestrator cannot function | `TESSERA_ORCHESTRATOR_ENABLED` can be dynamically set to `false` to revert to single-model mode |

**Mitigations we commit to:**

1. **Separate API key for Flash:** Use a dedicated DeepSeek API key for Flash calls, distinct from the Pro key. This prevents a Pro quota exhaustion from also taking down Flash (and vice versa).

2. **Health check + auto-degrade:** The orchestrator maintains a circuit breaker for each provider. If Flash fails 3 consecutive requests within a 60-second window, the orchestrator auto-degrades: simple tasks route to Pro with self-critique, complex tasks skip the verifier, and triage moves to M3.

3. **`VERIFIER_MODE` configuration:** Three modes control verifier behavior:
   - `enforce` (default): Verifier failure blocks delivery
   - `warn-only`: Verifier runs but failures are logged (not blocking)
   - `off`: Verifier is skipped entirely (useful during Flash outages)

4. **Dedicated triage model (Sprint 2):** We will evaluate GLM-4.7 Flash or Qwen3.5-9B as an alternative triage model to reduce concentration risk. The provider abstraction makes this a configuration change, not a code change.

### Cost Tracking

Cost attribution uses a **per-invocation ledger entry** written at the end of each provider call, before the response is returned to the agent loop.

**Data model (new table in `audit-system`):**

```sql
CREATE TABLE IF NOT EXISTS cost_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  model_key   TEXT    NOT NULL,  -- e.g. "deepseek/v4-pro"
  role        TEXT    NOT NULL,  -- "triage", "thinker", "worker", "verifier", "fallback"
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_euro_cents INTEGER NOT NULL, -- stored as integer cents to avoid FP drift
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_cost_ledger_session ON cost_ledger(session_id);
CREATE INDEX idx_cost_ledger_model   ON cost_ledger(model_key);
```

**Cost calculation:** Adapter returns `ProviderCostInfo.inputCostPerMillionEuroCents` and `outputCostPerMillionEuroCents`. The ledger writer computes:

```
cost_euro_cents = ceil((inputTokens  * inputCostPerMillionEuroCents  / 1_000_000)
                     + (outputTokens * outputCostPerMillionEuroCents / 1_000_000))
```

Integer cents avoid floating-point accumulation errors across thousands of ledger rows.

**Aggregation queries** (for admin dashboard):
```sql
-- Cost by model, last 30 days
SELECT model_key, SUM(cost_euro_cents) / 100.0 AS cost_eur
FROM cost_ledger
WHERE created_at >= datetime('now', '-30 days')
GROUP BY model_key
ORDER BY cost_eur DESC;

-- Cost by role, last 30 days
SELECT role, SUM(cost_euro_cents) / 100.0 AS cost_eur
FROM cost_ledger
WHERE created_at >= datetime('now', '-30 days')
GROUP BY role;

-- Sessions exceeding budget threshold
SELECT session_id, SUM(cost_euro_cents) / 100.0 AS cost_eur
FROM cost_ledger
GROUP BY session_id
HAVING cost_eur > 0.10
ORDER BY cost_eur DESC;
```

### Estimated Cost per Session

| Task Complexity | Calls | Models | Est. Cost (€) |
|---|---|---|---|
| Simple | 1 | Flash (triage) + Flash (exec) | ~€0.0005 |
| Medium | 1–3 | Flash (triage) + Pro (exec + self-critique) | ~€0.005 |
| Complex | 3–6 | Flash (triage + thinker + verifier) + Pro (worker) | ~€0.015 |
| Complex w/ failover | 4–8 | Above + M3 (fallback) | ~€0.025 |

At 10 sessions/day (~300/month) with ~70% simple, ~25% medium, ~5% complex distribution, the estimated monthly cost is **~€0.71**:

| Tier | Sessions | Cost/session | Subtotal |
|---|---|---|---|
| Simple (70%) | 210 | €0.0005 | €0.105 |
| Medium (25%) | 75 | €0.005 | €0.375 |
| Complex (5%) | 15 | €0.015 | €0.225 |
| **Total** | **300** | — | **€0.705** |

A more conservative ~85/13/2% distribution (still predominantly simple) would yield ~€0.42/month. We present the 70/25/5 estimate as the realistic baseline and will calibrate with production data.

**Clarification on simple tasks:** Simple tasks require only **one Flash call** — the triage classification itself serves as the response. The classifier's output is returned directly to the user without a second invocation. This is consistent with the pseudocode above (`{ primary: "flash", roles: [] }`).

### State Management

**The orchestrator does NOT maintain state between sessions.** All routing decisions are derived from the current session's messages and the classification result. This is a deliberate choice:

| Approach | Pros | Cons |
|---|---|---|
| Stateless (chosen) | Simple, no persistence, no drift, easy to debug | Can't learn per-user preferences across sessions |
| Stateful (rejected) | Could adapt to user preferences over time | Adds persistence dependency, risk of stale state, harder to debug |

**What the orchestrator DOES track within a session:**
- Current phase (`triage` | `thinking` | `executing` | `verifying` | `done`)
- Active model assignment (which model is the current worker)
- Completed tool results (for replay during failover)
- Failover count and history

These are held in-memory within the `OrchestratorSession` object, which lives for the duration of one gRPC `RunAgent` stream and is garbage-collected when the stream closes. Nothing is written to disk until the final audit event.

**Cross-session learning** (future Sprint 2: Harness Self-Evolution) will operate as an offline batch process — a daily cron job reads aggregate audit data, identifies patterns, and writes "harness patches" to memory-store. These patches influence future triage decisions but do not require the orchestrator itself to be stateful.

### Backward Compatibility: TESSERA_ORCHESTRATOR_ENABLED

The orchestrator is gated behind a single environment variable:

```
TESSERA_ORCHESTRATOR_ENABLED=false  # default — single-model mode
TESSERA_ORCHESTRATOR_ENABLED=true   # multi-model orchestration
```

**When `false` (default):**

```typescript
// packages/agent-runtime/src/index.ts

import { getConfig } from "@tessera/shared";

async function startAgentRuntime() {
  const orchestratorEnabled = getConfig("TESSERA_ORCHESTRATOR_ENABLED", "false");

  if (orchestratorEnabled === "true") {
    // ── New path: multi-model orchestration ──
    const orchestrator = createOrchestrator(providers);
    return startAgentGrpcServer(sessionManager, orchestrator, addr);
  }

  // ── Existing path: single-model (unchanged code path) ──
  const agentLoop = createSingleModelAgentLoop(selectedModel, selectedProvider);
  return startAgentGrpcServer(sessionManager, agentLoop, addr);
}
```

**Key backward-compatibility guarantees:**

1. **Same gRPC contract** — The `AgentService` proto definition is unchanged. The orchestrator implements the same interface as the existing `AgentLoop`. The gateway, CLI, and webchat see no difference.

2. **Same configuration surface** — When `TESSERA_ORCHESTRATOR_ENABLED=false`, all existing config keys (`MODEL`, `PROVIDER`, `API_KEY`, etc.) are read and used exactly as before. No new config is required.

3. **Same audit schema** — The `cost_ledger` table is created with `IF NOT EXISTS` and is only written to when orchestration is active. Existing audit queries continue to work.

4. **Zero cold-start regression** — The single-model path has zero additional latency. The first call goes directly to the selected model, exactly as it does today.

5. **Progressive rollout** — Operators can enable orchestration per-deployment, per-environment, or per-session via the environment variable. A future control-plane UI could toggle it per-tenant without a restart.

#### CreateSessionRequest.provider Field Behavior Under Orchestration

When `TESSERA_ORCHESTRATOR_ENABLED=true`, the existing `provider` field in `CreateSessionRequest` (values: `anthropic`, `openai`, `gemini`, `ollama`) becomes ambiguous — the orchestrator, not the user, selects which model handles each phase. We resolve this as follows:

| Orchestrator state | `provider` field | Behavior |
|---|---|---|
| `ENABLED=true` | `anthropic`, `openai`, `gemini`, `ollama` | **Ignored.** The orchestrator overrides with its own model selection. A `PROVIDER_OVERRIDDEN` audit event is emitted: `{ requested: "ollama", actual: "deepseek/v4-flash", reason: "orchestrator_enabled" }`. |
| `ENABLED=true` | Unset / default | No warning; orchestrator selects normally. |
| `ENABLED=false` | Any value | Existing single-model behavior — `provider` is honored exactly as today. |

**Special case — `provider: "ollama"` under orchestration:** Ollama models run locally and do not have a provider abstraction adapter in v1. When the orchestrator is enabled and `provider` is `ollama`, the orchestrator logs a `PROVIDER_NOT_SUPPORTED` warning and falls back to single-model mode for that session (using Ollama as the sole model). This is equivalent to `TESSERA_ORCHESTRATOR_ENABLED=false` for that specific session. We do NOT attempt to mix local Ollama models with cloud-based orchestration in v1.

**Future (Sprint 3):** If demand exists for Ollama-orchestrated workloads, we can add an Ollama adapter implementing the new `LLMProvider` interface. The mapping table approach (exposing Ollama models as triage/worker candidates) would then become straightforward.

## Consequences

### What Becomes Easier

- **Quality improvements are multiplicative** — improving any individual model (swapping in a better worker, tuning the verifier prompt) lifts overall system quality without rewriting orchestration logic.
- **Cost optimization is explicit** — the cost_ledger makes it trivial to answer "how much did we spend on Flash vs. Pro this month?" and adjust routing thresholds accordingly.
- **Provider experimentation** — adding a new provider (e.g., GLM-4.7 Flash as a cheaper triage option) requires only a new adapter implementing `LLMProvider`; the orchestrator uses it automatically once registered.
- **Hallucination reduction is built-in** — the verifier gate is not optional; complex tasks always pass through validation before reaching the user.

### What Becomes Harder

- **Debugging** — a single user message may trigger 3–6 model calls across 2–3 providers. The audit trail must clearly attribute each. The `cost_ledger.role` field and structured log entries mitigate this.
- **Latency SLA** — complex tasks add ~2–4s of orchestrator overhead (triage + verifier calls). This is acceptable for the target use case (autonomous agent tasks, not real-time chat), but must be monitored.
- **Test surface area** — each combination of (complexity, model, failover path) needs test coverage. We commit to parametrized integration tests covering all paths.
- **EU AI Act documentation** — multi-model systems require additional transparency: which model made which decision? The audit trail provides this, but the compliance dashboard (Phase 4C) must surface it.

### Streaming Regression and Latency Budget

**Existing behavior:** The current `AgentLoop.run()` method is an `AsyncGenerator<GrpcAgentChunk>` — it streams token-by-token responses to the user in real time. The user sees text appear as the model produces it.

**ADR proposal:** The orchestrator uses a sequential pipeline: Triage → (Thinker →) Worker → Verifier. Each phase involves a non-streaming `chat()` call. This means the user sees **nothing** until all phases complete, introducing a 4–8 second dead-air gap for complex tasks.

**This is a regression and must be acknowledged.** We propose two mitigations:

1. **Streaming variant (preferred):** The Worker phase streams token-by-token directly to the user while the Verifier runs in parallel on the final accumulated output. If the Verifier rejects the result, the orchestrator appends a corrective follow-up. This preserves the real-time feel of the existing `AgentLoop` while maintaining verifier protection. Implementation: the orchestrator's Worker phase uses `streamCompletion()` (the existing streaming interface) and the accumulated output is concurrently fed to the Verifier via `complete()`.

2. **Latency budget with SLA targets:** Until the streaming variant ships, we commit to latency budgets per complexity tier:
   | Tier | Max user-visible latency | Budget allocation |
   |---|---|---|
   | Simple | <1s | Triage only (1 Flash call) |
   | Medium | <3s | Triage + Pro with self-critique |
   | Complex | <6s | Triage + Thinker + Worker + Verifier |
   
   These budgets will be enforced by `AbortSignal` with deadlines. Breaches trigger a `LATENCY_BUDGET_EXCEEDED` audit event and escalate to the fallback model.

The streaming variant will be implemented in Sprint 2 (Harness Self-Evolution) and is tracked as issue #ADR007-STREAMING in the project backlog.

### What We Commit To

1. **No breaking changes to the gRPC contract** — `AgentService` stays stable.
2. **Single-model mode remains the default** until orchestration is validated in QA/CI.
3. **Every orchestrator decision is auditable** — triage result, model assignment, failover events, and verifier outcomes are all emitted as `audit_events`.
4. **Cost ledger is append-only** — same SQLite trigger protection as the main `audit_events` table (no UPDATE/DELETE).
5. **Vault refs never cross provider boundaries** — see Security Review below.

### Test Strategy

The orchestrator introduces a combinatorial test surface: complexity tiers × orchestration modes × failover paths × verifier outcomes. We define the following critical test paths:

#### Unit Tests (Vitest, co-located with source)

| Test class | What it covers |
|---|---|
| `Orchestrator.classify` | Triage prompt returns valid JSON for all three complexity tiers; handles truncated/malformed output |
| `Orchestrator.route` | Correct model assignment for each complexity tier (simple→Flash, medium→Pro+self-critique, complex→Thinker/Worker/Verifier) |
| `Orchestrator.failover` | Retryable errors retry (×2 for Pro, ×1 for Flash); non-retryable errors skip to next model; circuit breaker triggers after 3 consecutive failures |
| `Verifier.validate` | Structured verifier output parsing; PASS/FAIL/UNCERTAIN decisions; FP/FN tracking |

#### Integration Tests (Docker, `@tessera/integration`)

| Scenario | Complexity | Failover | Verifier | Expected outcome |
|---|---|---|---|---|
| `simple-happy-path` | Simple | None | N/A | Flash responds directly, ~€0.0005 cost |
| `medium-self-critique` | Medium | None | N/A | Pro executes with reflection, 1–3 calls |
| `complex-full-pipeline` | Complex | None | PASS | Triage→Thinker→Worker→Verifier, answer delivered |
| `complex-verifier-rejects` | Complex | None | FAIL (×2 then give up) | Worker→Verifier→reject→Worker retry→Verifier→PASS on 2nd attempt |
| `pro-fails-flash-catches` | Any | Pro→Flash | N/A | Pro timeout→Flash fallback→answer delivered |
| `all-fail-unavailable` | Any | Pro→Flash→M3→error | N/A | gRPC UNAVAILABLE returned to caller |
| `single-model-mode` | N/A | N/A | N/A | Orchestrator disabled; existing behavior unchanged |

#### Malformed Triage Output Fallback

The triage classifier returns structured JSON. If Flash produces malformed, truncated, or unparseable output, the orchestrator **defaults to the single-model Pro path** (equivalent to `complexity: "medium"` with self-critique). This is safe: Pro with self-critique handles any task competently, and a single-model session is strictly better than an error. The fallback is logged as `ORCHESTRATOR_TRIAGE_MALFORMED` with the raw Flash output for debugging:

```typescript
function parseTriageResult(raw: string): Classification {
  try {
    const parsed = JSON.parse(raw);
    const complexity = ClassificationSchema.shape.complexity.parse(parsed.complexity);
    return { complexity, roles: parsed.roles ?? [], reasoning: parsed.reasoning ?? "" };
  } catch {
    // Malformed — default to Pro single-model path
    auditClient.logEvent({ event_type: "ORCHESTRATOR_TRIAGE_MALFORMED", ... });
    return { complexity: "medium", roles: ["worker"], reasoning: "malformed triage output — defaulting to Pro" };
  }
}
```

This ensures the orchestrator is **fail-safe**: a broken triage prompt or Flash model regression cannot prevent the user from getting an answer.

## Security Review

### Verifier Isolation

The Verifier operates on **structured output only**, never on raw LLM context. This is the single most important security property of the architecture:

```
Worker (Pro)                     Verifier (Flash)
    │                                  │
    │ Full context:                    │ Sees ONLY:
    │ - user message                   │ - worker's final answer
    │ - tool results                   │ - task specification
    │ - vault references               │ - (no vault refs)
    │ - system prompt                  │ - (no tool results)
    │ - memory inserts                 │ - (no system prompt)
    │                                  │
    ▼                                  ▼
  Generates answer ────────▶  Validates: factual? complete? safe?
                                   │
                                   ├─ PASS → deliver to user
                                   └─ FAIL → return to worker with feedback
```

**Implementation:**

```typescript
interface VerifierInput {
  /** The task as specified by the user (no vault refs — resolved to placeholders) */
  task: string;
  /** The worker's final answer (no tool results, no intermediate reasoning) */
  workerOutput: string;
  /** Optional: the classification that routed this task */
  complexity: "medium" | "complex";
}

async function verify(verifier: LLMProvider, input: VerifierInput): Promise<VerifierResult> {
  // Flash never sees:
  // - messages before the final worker turn
  // - tool call results
  // - __VAULT_REF:id__ placeholders (scrubbed by input-sanitizer before this point)
  // - memory-store inserts
  //
  // It sees ONLY: { task, workerOutput }
  const result = await verifier.chat("deepseek/v4-flash", [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ task: input.task, output: input.workerOutput }) },
  ]);
  return parseVerifierResult(result.content);
}
```

### Vault Integration

Vault references (`__VAULT_REF:id__`) are resolved to their actual values only at the gRPC boundary of `credential-vault` — they never appear as plaintext in provider requests. The orchestrator enforces three rules:

1. **Vault refs are scoped per-role.** The `Thinker` (Flash) receives only the task description — no credentials. The `Worker` (Pro) receives credentials scoped to the specific skill being executed. The `Verifier` (Flash) receives no credentials at all.

2. **Credentials never cross provider boundaries.** If the primary worker (Pro on DeepSeek) fails and the fallback (M3 on MiniMax) takes over, credential refs are re-resolved through the vault for the new provider. No credential from a DeepSeek request is ever forwarded to MiniMax.

3. **Audit trail tracks credential scope.** Each `RUN_STARTED` audit event records `credential_scope: { provider, model, role, skill_id }` so that credential access is fully attributable.

### Audit Trail

Every orchestrator decision emits an audit event:

| Event | Trigger | Fields |
|---|---|---|
| `ORCHESTRATOR_TRIAGE` | After classification | `{ complexity, roles, reasoning, latency_ms }` |
| `ORCHESTRATOR_ASSIGN` | After model selection | `{ model, role, session_id }` |
| `FAILOVER_STARTED` | Primary model failed | `{ from_model, to_model, reason, error_kind }` |
| `FAILOVER_CRITICAL` | Second fallback triggered | `{ from_model, to_model, reason, error_kind }` |
| `VERIFIER_PASS` | Worker output validated | `{ model, criteria_met[], latency_ms }` |
| `VERIFIER_FAIL` | Worker output rejected | `{ model, criteria_failed[], retry_round }` |
| `COST_ENTRY` | After each model invocation | `{ model_key, role, input_tokens, output_tokens, cost_euro_cents }` |

All events are written to the append-only `audit_events` table (enforced by SQLite triggers — no UPDATE/DELETE permitted).

## EU AI Act Compliance

Multi-model orchestration introduces transparency obligations under the EU AI Act. We address them as follows:

**Per-model attribution:** The `SessionSummary` proto (delivered to end-users on request) will be extended with a `model_attribution` repeated field recording every model that contributed to the session output: `{ model_key, role, tokens_consumed }`. This satisfies the Act's requirement that users know which AI system produced which part of the output.

**Data minimization across providers:** The orchestrator sends only the minimum context each model needs — triage sees only the user's first message, the thinker sees the task specification, and the verifier sees only the worker's final answer. This reduces the surface area of personal data exposure across providers. Full conversation history stays within the gateway's control and is never forwarded to a provider that doesn't need it.

**Risk classification:** The orchestrator itself is classified as a **limited-risk AI system** under the EU AI Act (Article 52 transparency obligations apply). The individual models are general-purpose AI systems (GPAI) regulated under Article 53. The combination does not constitute a high-risk use case because (a) Tessera is an augmentation tool, not an automated decision-maker, (b) human users remain in the loop for all high-impact actions (approval gate), and (c) the verifier acts as a safety net, not a gatekeeper. A more detailed compliance assessment will be completed as part of Phase 4C.

## Observability: Per-Phase Metrics and Feedback Loops

Beyond the audit events already defined, we instrument each orchestrator phase with OpenTelemetry spans for latency tracking:

| Phase | Span name | Key attributes |
|---|---|---|
| Triage | `orchestrator.triage` | `complexity`, `latency_ms`, `model` |
| Thinker | `orchestrator.thinker` | `subtask_count`, `latency_ms`, `model` |
| Worker | `orchestrator.worker` | `tool_calls`, `turn_count`, `latency_ms`, `model` |
| Verifier | `orchestrator.verifier` | `verdict`, `latency_ms`, `model` |
| Failover | `orchestrator.failover` | `from_model`, `to_model`, `reason` |

These spans are children of the existing `agent.session` span and appear in any OTel-compatible backend (Jaeger, Grafana, Honeycomb).

**Triage accuracy feedback loop:** Each session's triage decision is stored alongside the session outcome. A daily batch job (Sprint 2: Harness Self-Evolution) will correlate triage classifications with session satisfaction signals (task completion rate, verifier pass rate, user feedback) to identify systematic misclassifications and suggest prompt refinements.

**Failover rate alerting:** Two thresholds are predefined:
- `FAILOVER_RATE > 5%` over a rolling 1-hour window → WARN alert
- `FAILOVER_RATE > 15%` over a rolling 1-hour window → CRITICAL alert (possible provider outage)

## Verifier Prompt Quality

### VERIFIER_SYSTEM_PROMPT (sketch)

```
You are a verification agent in a multi-model AI orchestration system.
Your task: validate the Worker model's answer against the user's original request.

Evaluate on three dimensions:
1. FACTUAL: Is every factual claim verifiable? Flag claims that appear fabricated.
2. COMPLETE: Does the answer fully address the user's request? Flag omissions.
3. SAFE: Does the answer contain harmful instructions, PII leaks, or policy violations?

Respond with JSON:
{
  "verdict": "PASS" | "FAIL" | "UNCERTAIN",
  "factual_issues": ["claim X is unverifiable", ...],
  "completeness_gaps": ["missing Y", ...],
  "safety_concerns": ["leaked PII in section Z", ...],
  "confidence": 0.0-1.0
}

If verdict is FAIL or UNCERTAIN, provide specific, actionable feedback the Worker can use to improve.
```

### Accuracy Measurement

Verifier accuracy is measured by tracking false positives (rejecting a correct answer) and false negatives (passing an incorrect answer) against a human-labeled validation set:

| Metric | Definition | Target | Measurement method |
|---|---|---|---|
| **FP rate** | Fraction of correct answers incorrectly rejected | <5% | Spot-check 100 sessions/month; human labeler confirms correctness |
| **FN rate** | Fraction of incorrect answers incorrectly passed | <10% | Spot-check 100 sessions/month; human labeler identifies errors missed by verifier |
| **F1 score** | Harmonic mean of precision/recall | >0.85 | Aggregated from monthly spot-checks |

**Calibration burden:** The verifier prompt requires iterative tuning. Each month's spot-check results feed into prompt refinements (additional criteria, sharper definitions, few-shot examples). This is a recurring cost that must be budgeted — we estimate ~2 hours/month of prompt engineering for the first 6 months, tapering to ~30 minutes/month once stable. DSPy 3.0 (see Alternatives Considered §5) may automate this calibration but is deferred to Sprint 2.

## Alternatives Considered

### 1. Static Rules ("if task contains 'code' → Pro, else → Flash")

**Rejected because:** Static rules cannot capture task nuance. A "write code" request could be trivial (rename a variable) or complex (implement a new gRPC service). The triage classifier costs ~€0.0005 and provides data-driven routing that adapts to actual task difficulty. Council Mode (2026) demonstrates that LLM-based triage reduces hallucinations by 35.9% compared to rule-based routing.

### 2. Complexity Score (numeric 0–100)

**Rejected because:** A numeric score adds latency (requires the model to introspect on difficulty) without providing actionable information beyond what "simple/medium/complex" captures. The score also requires calibration — what threshold maps to what model? The triage classifier's categorical output maps directly to routing decisions with no calibration step.

### 3. Full Council Mode (parallel generation + synthesis)

**Rejected for v1 because:** Running 3 models in parallel (e.g., Pro + M3 + Sonnet) and synthesizing their outputs would cost 3–6× more per session. While Council Mode's -35.9% hallucination reduction is compelling, TRINITY's serial Thinker→Worker→Verifier achieves comparable quality at lower cost. We leave full Council Mode as a future enhancement (Sprint 4: Multi-Agent Orchestration).

### 4. MoA-style Layered Architecture

**Rejected because:** Mixture-of-Agents requires each agent to see all outputs from the previous layer, which (a) increases token consumption multiplicatively and (b) exposes potentially sensitive intermediate results. MoA is better suited for benchmarking (AlpacaEval) than for an agent platform handling user data with vault-scoped credentials.

### 5. DSPy 3.0 for Optimized Prompting

**Deferred, not rejected.** DSPy's automatic optimization of prompts and few-shot examples is complementary to orchestration. We plan to evaluate DSPy in Sprint 2 (Harness Self-Evolution) for automatically tuning triage/verifier prompts based on historical outcomes.

### 6. Fugu-style Learned Orchestrator (sep-CMA-ES training)

**Rejected for v1 because:** Training an orchestrator with evolutionary strategies requires a substantial training corpus and compute budget. TRINITY (also sep-CMA-ES) achieves strong results, but for Tessera's scale (~10 sessions/day), a prompt-based triage classifier is simpler, cheaper, and easier to audit. We may revisit learned orchestration if session volume grows 10×+.

## References

- **Augustus Research Document** (2026-07-10) — Comprehensive analysis of 14 papers on multi-model orchestration for Tessera. Available at: `~/.hermes/cron/output/tessera-harness-research-jul2026.md`
- **TRINITY: Evolved LLM Coordinator** — arXiv 2512.04695, ICLR 2026. Thinker/Worker/Verifier architecture with <20K-param coordinator achieving 86.2% LiveCodeBench.
- **Conductor: RL-Trained Orchestrator** — arXiv 2512.04388, ICLR 2026. Qwen2.5-7B orchestrator beating GPT-5 via GRPO-trained routing.
- **Council Mode** — arXiv 2604.02923, 2026. Triage → parallel generation → synthesis achieving -35.9% hallucinations.
- **Sakana Fugu Technical Report** — arXiv 2606.21228, June 2026. Fugu-Ultra leads 10/11 major benchmarks via heterogeneous worker orchestration.
- **AgentCollab** — arXiv 2603.26034, 2026. "Cheap tries, expensive decides" cost-optimized multi-model collaboration.
- **Harness Updating Is Not Harness Benefit** — arXiv 2605.30621, May 2026. Cheap models (Qwen3.5-9B) match Opus 4.6 for harness updates.
- **S²-MAD: Sparse Multi-Agent Debate** — arXiv 2502.04790, 2025. 94.5% token reduction with <2% quality loss via verifier gate.
- **Mixture-of-Agents** — arXiv 2406.04692, ICLR 2025. Layered multi-agent architecture achieving 65.1% AlpacaEval 2.0.
- **TextGrad** — arXiv 2406.07496, 2024. Textual gradient descent for automatic prompt optimization.
- **Tessera Project Context** — `~/.hermes/projects/tessera/context.md`. Architecture, rules, and current state.
- **Tessera CLAUDE.md** — `/root/Tessera/CLAUDE.md`. Security invariants, TypeScript strictness rules, and package structure.
