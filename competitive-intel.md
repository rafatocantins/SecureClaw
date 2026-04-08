# Tessera -- Competitive Intelligence Report

**Date:** 2026-04-02
**Purpose:** Identify feature gaps vs leading agent frameworks, inform Phase 3 roadmap.

---

## 1. Competitor Overview

### 1A. Hermes Agent (Nous Research)

**Positioning:** "An agent that learns from mistakes and grows with the user."

**Key capabilities:**
- **Reflection loop:** After each task, the agent reviews what went well/wrong and stores structured "lessons learned" in a persistent memory layer. On future tasks, relevant lessons are retrieved (by semantic similarity) and injected into the system prompt.
- **Mistake detection:** Uses a self-critique step -- after tool execution, the agent evaluates whether the tool output achieved the sub-goal. If not, it generates a correction plan before retrying.
- **User preference learning:** Tracks implicit preferences (e.g., coding style, communication verbosity, tool preferences) from approved/rejected actions across sessions. Builds a user profile that adapts the system prompt over time.
- **Memory architecture:** Hierarchical: (1) working memory (current session context), (2) episodic memory (key facts from past sessions), (3) semantic memory (long-term knowledge graph). Uses vector embeddings for retrieval.
- **Tool use:** Standard function-calling interface, supports MCP tools.
- **Multi-agent:** Single-agent focused, but can spawn "sub-tasks" that share the memory layer.
- **Security model:** Minimal -- no sandbox, no injection defense, no audit trail. Consumer-grade.

**Tessera gap:** Hermes's learning/adaptation mechanisms are its primary differentiator. Tessera has zero reflection, zero preference learning, and no semantic (vector) memory.

### 1B. AutoGen v0.4+ (Microsoft)

**Key capabilities:**
- **Multi-agent orchestration:** First-class citizen. Agents can be composed into teams with different topologies (sequential, round-robin, group chat, hierarchical). Each agent has a role and system prompt.
- **Memory:** `MemoryStore` interface with pluggable backends (ChromaDB, Qdrant, custom). Supports both text and vector retrieval.
- **Learning:** No built-in self-improvement loop. Learning happens through human-designed agent configurations, not autonomously.
- **Tool ecosystem:** Registry-based, any Python function can be a tool. No signing/verification.
- **Security:** Execution in Docker containers. No injection defense, no audit, no vault.

**Tessera gap:** Multi-agent orchestration is AutoGen's killer feature. Tessera is single-agent only.

### 1C. CrewAI

**Key capabilities:**
- **Multi-agent:** Role-based agents in a "crew" with defined delegation patterns. Supports hierarchical (manager delegates to workers) and sequential (pipeline) flows.
- **Memory:** Short-term (session), long-term (persistent across sessions), entity memory (knowledge about specific topics/people). Uses embeddings for retrieval.
- **Learning:** "Training" feature -- human feedback on agent outputs is stored and used to improve future performance via few-shot examples.
- **Tool ecosystem:** Decorator-based tool definition. No signing or sandbox.
- **Security:** None. No sandbox, no audit, no injection defense.

**Tessera gap:** CrewAI's training/feedback loop and entity memory are notable.

### 1D. LangGraph / LangChain

**Key capabilities:**
- **Orchestration:** Graph-based agent workflows. Nodes are processing steps, edges are conditional transitions. First-class support for human-in-the-loop via "interrupt" nodes.
- **Memory:** `BaseCheckpointSaver` for full graph state persistence. LangMem for long-term memory extraction and consolidation.
- **Learning:** LangMem extracts "memories" (facts, preferences, procedures) from conversations and stores them for future retrieval. User can review/edit extracted memories.
- **Tool ecosystem:** Large ecosystem via LangChain integrations.
- **Security:** Minimal. Some sandboxing via LangSmith hosted execution.

**Tessera gap:** Graph-based orchestration and LangMem-style memory extraction.

### 1E. OpenAI Assistants API

**Key capabilities:**
- **Threads:** Persistent conversation threads with automatic context management and truncation.
- **Memory:** Thread-level memory only (no cross-thread long-term memory as of early 2026). File search (vector store) for RAG.
- **Tool use:** Function calling, code interpreter (sandboxed), file search. Limited to OpenAI models.
- **Security:** OpenAI manages sandbox execution. No user-controlled audit, no self-hosted option.

**Tessera gap:** File search / RAG (vector store) is a significant capability Tessera lacks.

### 1F. Mem0

**Key capabilities:**
- **Persistent memory layer:** Pluggable memory service that sits between the application and LLM. Automatically extracts and consolidates memories from conversations.
- **Memory types:** Facts, preferences, procedures. Each stored with metadata (source session, confidence, last accessed).
- **Retrieval:** Hybrid: keyword + vector similarity. Supports memory decay (less-accessed memories deprioritized).
- **Integration:** Works with any LLM framework as a middleware layer.
- **Security:** API-key auth only. No encryption at rest, no audit.

**Tessera gap:** Automatic memory extraction and consolidation. Mem0's architecture maps well to Tessera's existing memory-store.

---

## 2. Feature Comparison Matrix

| Capability | Tessera | Hermes Agent | AutoGen | CrewAI | LangGraph | OpenAI Assistants |
|---|---|---|---|---|---|---|
| **Session memory** | FTS5 SQLite, last 30 msgs | Full session | Configurable | Short-term | Checkpoint | Thread |
| **Cross-session memory** | FTS text search only | Episodic + semantic | Plugin backends | Long-term + entity | LangMem | None (thread-only) |
| **Vector/semantic retrieval** | None | Yes (embeddings) | Yes (Chroma/Qdrant) | Yes | Yes | Yes (file search) |
| **Reflection / self-critique** | None | Core feature | None | None | Optional node | None |
| **Learn from mistakes** | None | Lessons learned store | None | Training data | LangMem procedures | None |
| **User preference learning** | None | Implicit tracking | None | Training feedback | LangMem facts | None |
| **Memory extraction** | None (raw msg storage) | Auto-extract | Manual | Auto-extract | LangMem | None |
| **Multi-agent orchestration** | None (single agent) | Sub-tasks only | Core feature | Core feature | Graph-based | None |
| **Parallel tool execution** | None (sequential) | None | Yes (in teams) | Yes (async) | Yes (parallel nodes) | Yes (parallel calls) |
| **Human-in-the-loop** | Full (approval gate) | Basic | Basic | Basic | First-class (interrupt) | None |
| **Tool sandbox** | gVisor (strong) | None | Docker (basic) | None | None | OpenAI managed |
| **Injection defense** | Multi-layer (strong) | None | None | None | None | None |
| **Audit trail** | Append-only SQLite | None | LangSmith (opt) | None | LangSmith (opt) | None (self-hosted) |
| **Credential vault** | AES-256-GCM + keytar | None | None | None | None | None |
| **SSRF prevention** | DNS-resolved + fail-closed | None | None | None | None | N/A |
| **Ed25519 skill signing** | Yes | None | None | None | None | N/A |
| **Cost tracking + quotas** | Per-team, enforced | None | None | None | None | API-level |
| **EU AI Act compliance** | Art. 9,12,14,15 dashboard | None | None | None | None | None |
| **Self-hosted / on-premise** | Yes (core design) | Yes | Yes | Yes | Partial | No |

---

## 3. Gap Analysis -- Top 5 Gaps (Prioritized)

### Gap 1: No Learning from Past Interactions (CRITICAL)

**What competitors do:** Hermes stores structured "lessons learned" after mistakes. CrewAI has a training feedback loop. LangMem extracts procedures and preferences.

**Tessera today:** Memory store records raw messages and supports FTS5 text search. The agent loop loads the last 30 messages on session start. There is zero reflection, zero lesson extraction, and zero mistake detection. If the agent makes the same mistake in 100 sessions, it will repeat it every time.

**Impact:** This is the #1 differentiator of modern agent frameworks. Without it, Tessera is a stateless tool executor with a chat log.

**Feasibility:** HIGH. The memory-store SQLite schema can be extended with a `lessons` table. The agent loop already has the hook point (post-tool-execution, session finalization). Extraction can use the same LLM provider already configured.

### Gap 2: No Semantic/Vector Memory Retrieval (HIGH)

**What competitors do:** Every major framework supports vector embeddings for memory retrieval. This enables "find conversations similar to this one" rather than just keyword match.

**Tessera today:** FTS5 full-text search only. This means the agent cannot retrieve contextually relevant past interactions unless the exact keywords match.

**Impact:** Without vector retrieval, even if we add lesson extraction, the retrieval quality will be poor. Semantic search is foundational for all learning features.

**Feasibility:** MEDIUM. Options: (a) SQLite `sqlite-vec` extension (zero new infrastructure), (b) External vector DB (Qdrant, ChromaDB), (c) LLM-based embedding via the existing provider interface. Option (a) is most aligned with Tessera's "easy install" philosophy.

### Gap 3: No Multi-Agent Orchestration (HIGH)

**What competitors do:** AutoGen and CrewAI both support multi-agent teams. Agents can delegate sub-tasks, work in parallel, and specialize (researcher, coder, reviewer).

**Tessera today:** Strictly single-agent. One `AgentLoop` instance per session. No delegation, no sub-agent spawning, no parallel tool execution.

**Impact:** Complex tasks (research + code + review) require multiple sequential turns with a single agent, which is slower and less capable than specialized agents working in parallel.

**Feasibility:** MEDIUM-HIGH. The gRPC architecture already supports multiple agent-runtime instances. The main work is an orchestration layer that manages agent-to-agent communication and shared context.

### Gap 4: No User Preference / Personalization (MEDIUM)

**What competitors do:** Hermes tracks implicit preferences (tool choices, approved/rejected actions, communication style). LangMem extracts "facts" about the user.

**Tessera today:** Every session starts identically. The system prompt is the same for every user. No user profile, no preference storage, no adaptive behavior.

**Impact:** Users expect agents to "know them" over time. Without personalization, Tessera feels generic.

**Feasibility:** HIGH. The approval gate already produces approve/deny signals. Storing these and extracting patterns is straightforward. User preferences can be injected into the system prompt via `buildSecuritySystemPrompt`.

### Gap 5: No Parallel Tool Execution (MEDIUM)

**What competitors do:** OpenAI Assistants, AutoGen, and LangGraph all support calling multiple tools in parallel when they are independent.

**Tessera today:** Tools are executed strictly sequentially in the agent loop. Even if the LLM requests two independent tool calls, they run one at a time.

**Impact:** Performance penalty for multi-tool workflows. A research task needing 3 URL fetches takes 3x longer than necessary.

**Feasibility:** HIGH. The LLM providers already return multiple tool calls in a single response. The sandbox client supports concurrent gRPC calls. The loop just needs to `Promise.all()` independent calls.

---

## 4. Secondary Gaps (Lower Priority)

| Gap | Competitors | Feasibility | Notes |
|---|---|---|---|
| RAG / file search | OpenAI, LangChain | MEDIUM | Chunk + embed uploaded docs into vector store |
| Graph-based workflows | LangGraph | LOW | Significant architecture change; evaluate after multi-agent |
| Memory decay / consolidation | Mem0 | HIGH | Time-weighted relevance scoring on retrieval |
| Entity memory (knowledge graph) | CrewAI | MEDIUM | Named entity extraction + relationship storage |
| Auto-retry with correction | Hermes | HIGH | Wrap tool execution in evaluate-correct-retry loop |

---

## 5. Tessera's Competitive Advantages (Retain and Emphasize)

These are areas where Tessera is *ahead* of every competitor listed above:

1. **Security depth:** No competitor has multi-layer injection defense, gVisor sandboxing, SSRF prevention, and append-only audit in the same product.
2. **Credential management:** AES-256-GCM vault with `__VAULT_REF__` placeholder injection is unique.
3. **Compliance:** EU AI Act dashboard is a differentiator for enterprise.
4. **Skill provenance:** Ed25519 signing + digest pinning is enterprise-grade supply chain security.
5. **Cost governance:** Per-team quotas with hard enforcement.
6. **Self-hosted first:** Every competitor except AutoGen/CrewAI requires cloud services for full functionality.

The strategy should be: **add adaptive intelligence capabilities while maintaining security advantages.** No competitor combines learning + security. This is Tessera's opportunity for a unique market position: "The agent that learns AND is safe."

---

## 6. Recommended Phase 3 Roadmap

See ROADMAP.md Phase 3-AI section for the concrete epics derived from this analysis.
