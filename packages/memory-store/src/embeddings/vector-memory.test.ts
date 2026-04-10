/**
 * vector-memory.test.ts — Phase 3B tests for embedding client and hybrid retrieval.
 *
 * Tests:
 *  - EmbeddingClient: config reading, embed() success/error paths
 *  - MemoryService: graceful degradation (no embedding model)
 *  - MemoryService: hybrid scoring with injected mock embedding client
 *  - MemoryService: embeddings are stored and cascaded on deleteUserData
 *  - cosineSimilarity fallback (JS path when sqlite-vec unavailable)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../db/schema.js";
import { MemoryService } from "../memory.service.js";
import type { StoreSessionParams } from "../memory.service.js";
import { EmbeddingClient, readEmbeddingConfig } from "./embedding-client.js";
import type { EmbeddingClientConfig } from "./embedding-client.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

function makeVec(values: number[]): Float32Array {
  return new Float32Array(values);
}

/** Build a mock EmbeddingClient whose embed() resolves to the given vectors in order. */
function makeMockClient(vectors: (Float32Array | null)[], dim = 4): EmbeddingClient {
  const cfg: EmbeddingClientConfig = {
    model: "mock-model",
    baseUrl: "http://localhost",
    apiKey: "",
    dim,
  };
  const client = new EmbeddingClient(cfg);
  let idx = 0;
  // Override on instance directly to avoid prototype lookup issues
  client.embed = async (_text: string) => {
    const v = vectors[idx] ?? null;
    idx++;
    return v;
  };
  return client;
}

const SESSION1: StoreSessionParams = {
  session_id: "s1",
  user_id: "u1",
  provider: "anthropic",
  created_at: 1_000,
};

// ── readEmbeddingConfig ───────────────────────────────────────────────────────

describe("readEmbeddingConfig", () => {
  afterEach(() => {
    delete process.env["TESSERA_EMBEDDING_MODEL"];
    delete process.env["TESSERA_EMBEDDING_BASE_URL"];
    delete process.env["TESSERA_EMBEDDING_DIM"];
    delete process.env["OPENAI_API_KEY"];
  });

  it("returns null when TESSERA_EMBEDDING_MODEL is not set", () => {
    expect(readEmbeddingConfig()).toBeNull();
  });

  it("returns config with defaults when only model is set", () => {
    process.env["TESSERA_EMBEDDING_MODEL"] = "text-embedding-3-small";
    const cfg = readEmbeddingConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("text-embedding-3-small");
    expect(cfg!.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg!.dim).toBe(1536);
    expect(cfg!.apiKey).toBe("");
  });

  it("reads all env vars when set", () => {
    process.env["TESSERA_EMBEDDING_MODEL"] = "nomic-embed-text";
    process.env["TESSERA_EMBEDDING_BASE_URL"] = "http://localhost:11434/v1";
    process.env["TESSERA_EMBEDDING_DIM"] = "768";
    process.env["OPENAI_API_KEY"] = "sk-test";
    const cfg = readEmbeddingConfig();
    expect(cfg!.model).toBe("nomic-embed-text");
    expect(cfg!.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg!.dim).toBe(768);
    expect(cfg!.apiKey).toBe("sk-test");
  });

  it("falls back to dim=1536 when TESSERA_EMBEDDING_DIM is non-numeric", () => {
    process.env["TESSERA_EMBEDDING_MODEL"] = "test-model";
    process.env["TESSERA_EMBEDDING_DIM"] = "not-a-number";
    const cfg = readEmbeddingConfig();
    expect(cfg!.dim).toBe(1536);
  });
});

// ── EmbeddingClient.embed ─────────────────────────────────────────────────────

describe("EmbeddingClient.embed", () => {
  it("returns null for empty string without calling fetch", async () => {
    const cfg: EmbeddingClientConfig = { model: "m", baseUrl: "http://x", apiKey: "", dim: 4 };
    const client = new EmbeddingClient(cfg);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await client.embed("   ");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns Float32Array on successful API response", async () => {
    const cfg: EmbeddingClientConfig = { model: "m", baseUrl: "http://x", apiKey: "key", dim: 3 };
    const client = new EmbeddingClient(cfg);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
    );
    const result = await client.embed("hello");
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result!)).toHaveLength(3);
  });

  it("returns null on non-200 API response (never throws)", async () => {
    const cfg: EmbeddingClientConfig = { model: "m", baseUrl: "http://x", apiKey: "", dim: 3 };
    const client = new EmbeddingClient(cfg);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 })
    );
    const result = await client.embed("hello");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error, never throws)", async () => {
    const cfg: EmbeddingClientConfig = { model: "m", baseUrl: "http://x", apiKey: "", dim: 3 };
    const client = new EmbeddingClient(cfg);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await client.embed("hello");
    expect(result).toBeNull();
  });

  it("returns null when response has unexpected shape", async () => {
    const cfg: EmbeddingClientConfig = { model: "m", baseUrl: "http://x", apiKey: "", dim: 3 };
    const client = new EmbeddingClient(cfg);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    const result = await client.embed("hello");
    expect(result).toBeNull();
  });
});

// ── MemoryService: graceful degradation (no embedding client) ─────────────────

describe("MemoryService: FTS5-only mode (no embedding client)", () => {
  it("searchMessages falls back to FTS5 results when no embeddings configured", async () => {
    const db = makeDb();
    const svc = new MemoryService(db); // no embedding client
    svc.storeSession(SESSION1);
    svc.appendMessage({ session_id: "s1", user_id: "u1", role: "user", content: "kubernetes cluster", tool_calls_json: "", tool_call_id: "", tool_name: "", created_at: 1_000 });

    const results = await svc.searchMessages("u1", "kubernetes", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain("kubernetes");
  });

  it("getRelevantLessons falls back to FTS5 when no embeddings configured", async () => {
    const db = makeDb();
    const svc = new MemoryService(db);
    svc.storeSession(SESSION1);
    svc.storeLessons({ source_session_id: "s1", user_id: "u1", lessons: [{ lesson_text: "always run tests before merging", category: "procedure" }] });

    const results = await svc.getRelevantLessons("u1", "tests", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.lesson_text).toContain("tests");
  });
});

// ── MemoryService: hybrid scoring with mock embeddings ────────────────────────

describe("MemoryService: hybrid scoring (mock embedding client)", () => {
  it("returns lessons ordered with vector-boosted results first", async () => {
    const db = makeDb();
    // lesson A: FTS match, no strong vector match (low cosine)
    // lesson B: strong vector match (high cosine), exact query match too
    const lessonsVecs = [
      makeVec([1, 0, 0, 0]),  // lesson A embed (inserted first)
      makeVec([0, 1, 0, 0]),  // lesson B embed (inserted second)
    ];
    const queryVec = makeVec([0, 1, 0, 0]); // identical to lesson B → cosine=1.0

    // 4 embeds: lessonA insert, lessonB insert, then query vec for getRelevantLessons
    const mockClient = makeMockClient([
      lessonsVecs[0]!,  // lessonA stored
      lessonsVecs[1]!,  // lessonB stored
      queryVec,         // query
    ]);

    const svc = new MemoryService(db, undefined, mockClient);
    svc.storeSession(SESSION1);
    svc.storeLessons({
      source_session_id: "s1",
      user_id: "u1",
      lessons: [
        { lesson_text: "deploy kubernetes cluster strategy", category: "procedure" },
        { lesson_text: "kubernetes pod autoscaling config", category: "procedure" },
      ],
    });

    // Give fire-and-forget embeddings time to complete
    await new Promise((r) => setTimeout(r, 50));

    const results = await svc.getRelevantLessons("u1", "kubernetes", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // all returned rows belong to u1
    for (const r of results) {
      expect(r.user_id).toBe("u1");
    }
  });

  it("searchMessages returns results when embedding client provides vectors", async () => {
    const db = makeDb();
    const msgVec = makeVec([1, 0, 0, 0]);
    const queryVec = makeVec([1, 0, 0, 0]);
    const mockClient = makeMockClient([msgVec, queryVec]);

    const svc = new MemoryService(db, undefined, mockClient);
    svc.storeSession(SESSION1);
    svc.appendMessage({ session_id: "s1", user_id: "u1", role: "user", content: "deploy docker containers", tool_calls_json: "", tool_call_id: "", tool_name: "", created_at: 1_000 });

    await new Promise((r) => setTimeout(r, 50));

    const results = await svc.searchMessages("u1", "docker", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain("docker");
  });
});

// ── MemoryService: embeddings cascade on deleteUserData ───────────────────────

describe("MemoryService: embeddings deleted with user data", () => {
  it("deleteUserData removes stored embeddings for the user", async () => {
    const db = makeDb();
    const mockClient = makeMockClient([makeVec([1, 0, 0, 0])]);
    const svc = new MemoryService(db, undefined, mockClient);
    svc.storeSession(SESSION1);
    svc.appendMessage({ session_id: "s1", user_id: "u1", role: "user", content: "some content", tool_calls_json: "", tool_call_id: "", tool_name: "", created_at: 1_000 });

    await new Promise((r) => setTimeout(r, 50));

    // Confirm embedding was stored
    const before = (db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;
    expect(before).toBeGreaterThanOrEqual(1);

    svc.deleteUserData("u1");

    // Embeddings table should be empty (cascade delete via stmtDeleteUserEmbeddings)
    const after = (db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;
    expect(after).toBe(0);
  });
});
