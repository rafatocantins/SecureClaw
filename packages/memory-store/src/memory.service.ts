/**
 * memory.service.ts — Core business logic for the memory store.
 *
 * All database operations are synchronous (node:sqlite).
 * Prepared statements are compiled once in the constructor.
 *
 * Phase 3B: hybrid retrieval mixes FTS5 keyword ranking with cosine vector
 * similarity via sqlite-vec. If no embedding model is configured, or if
 * sqlite-vec fails to load, the service degrades gracefully to FTS5-only.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  EmbeddingClient,
  readEmbeddingConfig,
} from "./embeddings/embedding-client.js";

// Synchronous require helper — used to optionally load sqlite-vec at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _require = createRequire(import.meta.url);

export type LessonCategory = "mistake" | "preference" | "procedure" | "fact";

export interface StoredLesson {
  id: number;
  user_id: string;
  source_session_id: string;
  lesson_text: string;
  category: LessonCategory;
  created_at: number;
  access_count: number;
}

export interface StoreLessonsParams {
  source_session_id: string;
  user_id: string;
  lessons: Array<{ lesson_text: string; category: LessonCategory }>;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  tool_calls_json: string;
  tool_call_id: string;
  tool_name: string;
  created_at: number;
}

export interface StoreSessionParams {
  session_id: string;
  user_id: string;
  provider: string;
  created_at: number;
}

export interface AppendMessageParams {
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  tool_calls_json: string;
  tool_call_id: string;
  tool_name: string;
  created_at: number;
}

export interface FinalizeSessionParams {
  session_id: string;
  ended_at: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_call_count: number;
}

/**
 * Cosine similarity between two Float32Arrays. Returns 0 for zero-magnitude vectors.
 * Used as JS fallback when sqlite-vec is not available.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export class MemoryService {
  private readonly db: DatabaseSync;
  private readonly dbPath: string | undefined;

  // Phase 3B — embedding client (null = FTS5-only mode)
  private readonly embeddingClient: EmbeddingClient | null;
  // True when sqlite-vec is loaded and vec_distance_cosine() is available
  private vecEnabled = false;

  // Compiled prepared statements
  private stmtUpsertSession!: StatementSync;
  private stmtFinalizeSession!: StatementSync;
  private stmtInsertMessage!: StatementSync;
  private stmtRecentMessages!: StatementSync;
  private stmtCountUserMessages!: StatementSync;
  private stmtDeleteUserSessions!: StatementSync;
  // Lessons
  private stmtInsertLesson!: StatementSync;
  private stmtGetRelevantLessons!: StatementSync;
  private stmtListLessons!: StatementSync;
  private stmtIncrementLessonAccess!: StatementSync;
  private stmtDeleteUserLessons!: StatementSync;
  private stmtCountUserLessons!: StatementSync;
  // Embeddings
  private stmtUpsertEmbedding!: StatementSync;
  private stmtDeleteUserEmbeddings!: StatementSync;

  constructor(db: DatabaseSync, dbPath?: string, embeddingClient?: EmbeddingClient) {
    this.db = db;
    this.dbPath = dbPath;
    // Allow injection for tests; otherwise auto-configure from env
    this.embeddingClient = embeddingClient ?? this.buildEmbeddingClient();
    this.tryLoadVec();
    this.prepareStatements();
  }

  private buildEmbeddingClient(): EmbeddingClient | null {
    const cfg = readEmbeddingConfig();
    return cfg ? new EmbeddingClient(cfg) : null;
  }

  /**
   * Attempt to load the sqlite-vec extension for vector similarity queries.
   * Fails silently — FTS5-only mode remains fully functional.
   */
  private tryLoadVec(): void {
    try {
      const sqliteVec = _require("sqlite-vec") as { getLoadablePath: () => string };
      this.db.loadExtension(sqliteVec.getLoadablePath());
      this.vecEnabled = true;
    } catch {
      // sqlite-vec not installed, db not opened with allowExtension:true, or
      // unsupported platform. FTS5-only mode is fully functional.
      this.vecEnabled = false;
    }
  }

  private prepareStatements(): void {
    this.stmtUpsertSession = this.db.prepare(
      `INSERT INTO sessions (id, user_id, provider, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    );

    this.stmtFinalizeSession = this.db.prepare(
      `UPDATE sessions
       SET ended_at = ?, input_tokens = ?, output_tokens = ?,
           cost_usd = ?, tool_call_count = ?
       WHERE id = ?`
    );

    this.stmtInsertMessage = this.db.prepare(
      `INSERT INTO messages
         (session_id, user_id, role, content, tool_calls_json,
          tool_call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Fetch most-recent-first, then reverse in JS for chronological order
    this.stmtRecentMessages = this.db.prepare(
      `SELECT id, session_id, user_id, role, content, tool_calls_json,
              tool_call_id, tool_name, created_at
       FROM messages
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );

    this.stmtCountUserMessages = this.db.prepare(
      `SELECT COUNT(*) as count FROM messages WHERE user_id = ?`
    );

    // ON DELETE CASCADE on messages.session_id handles message cleanup automatically
    this.stmtDeleteUserSessions = this.db.prepare(
      `DELETE FROM sessions WHERE user_id = ?`
    );

    // ── Lessons ──────────────────────────────────────────────────────────────
    this.stmtInsertLesson = this.db.prepare(
      `INSERT OR IGNORE INTO lessons
         (user_id, source_session_id, lesson_text, category, created_at, access_count)
       VALUES (?, ?, ?, ?, ?, 0)`
    );

    // FTS5 relevance search
    this.stmtGetRelevantLessons = this.db.prepare(
      `SELECT l.id, l.user_id, l.source_session_id, l.lesson_text,
              l.category, l.created_at, l.access_count
       FROM lessons l
       JOIN lessons_fts fts ON l.id = fts.rowid
       WHERE fts.lessons_fts MATCH ?
         AND l.user_id = ?
       ORDER BY rank
       LIMIT ?`
    );

    this.stmtListLessons = this.db.prepare(
      `SELECT id, user_id, source_session_id, lesson_text,
              category, created_at, access_count
       FROM lessons
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );

    this.stmtIncrementLessonAccess = this.db.prepare(
      `UPDATE lessons SET access_count = access_count + 1 WHERE id = ?`
    );

    this.stmtDeleteUserLessons = this.db.prepare(
      `DELETE FROM lessons WHERE user_id = ?`
    );

    this.stmtCountUserLessons = this.db.prepare(
      `SELECT COUNT(*) as count FROM lessons WHERE user_id = ?`
    );

    // ── Embeddings (Phase 3B) ─────────────────────────────────────────────────
    this.stmtUpsertEmbedding = this.db.prepare(
      `INSERT INTO embeddings (source_table, source_id, vector, model_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_table, source_id) DO UPDATE SET
         vector     = excluded.vector,
         model_id   = excluded.model_id,
         created_at = excluded.created_at`
    );
    // Note: embedding retrieval uses inline db.prepare() since the source table
    // name varies and cannot be parameterised in a prepared statement.

    this.stmtDeleteUserEmbeddings = this.db.prepare(
      `DELETE FROM embeddings
       WHERE (source_table = 'messages' AND source_id IN
                (SELECT id FROM messages WHERE user_id = ?))
          OR (source_table = 'lessons' AND source_id IN
                (SELECT id FROM lessons WHERE user_id = ?))`
    );
  }

  /**
   * Upsert a session row. Idempotent — safe to call multiple times with the same id.
   */
  storeSession(params: StoreSessionParams): void {
    this.stmtUpsertSession.run(
      params.session_id,
      params.user_id,
      params.provider,
      params.created_at
    );
  }

  // ── Embedding helpers (Phase 3B) ───────────────────────────────────────────

  /** True if the embedding client is configured and sqlite-vec is loaded. */
  get isVectorEnabled(): boolean {
    return this.vecEnabled && this.embeddingClient !== null;
  }

  /**
   * Persist an embedding vector for a source row. Fire-and-forget async.
   * Errors are silently discarded — embeddings are best-effort.
   */
  private scheduleEmbed(sourceTable: "messages" | "lessons", sourceId: number, text: string): void {
    if (!this.embeddingClient) return;
    const client = this.embeddingClient;
    const modelId = client.modelId;
    void this.embeddingClient.embed(text).then((vector) => {
      if (vector === null) return;
      try {
        this.stmtUpsertEmbedding.run(
          sourceTable,
          sourceId,
          Buffer.from(vector.buffer),
          modelId,
          Date.now()
        );
      } catch {
        // DB may be closed on shutdown — discard
      }
    });
  }

  /**
   * Compute cosine similarity scores for a query against a source table.
   * Returns a Map<sourceId, similarity> where similarity ∈ [0, 1].
   * If sqlite-vec is loaded, uses vec_distance_cosine(); otherwise computes in JS.
   * Returns an empty map if embedding client is not configured.
   */
  private async getVectorScores(
    sourceTable: "messages" | "lessons",
    userId: string,
    queryText: string
  ): Promise<Map<number, number>> {
    if (!this.embeddingClient || !queryText.trim()) return new Map();

    const queryVec = await this.embeddingClient.embed(queryText);
    if (queryVec === null) return new Map();

    // Load candidate embeddings for this user's rows
    type EmbeddingRow = { source_id: number; vector: Buffer };
    const rows = this.db
      .prepare(
        `SELECT e.source_id, e.vector
         FROM embeddings e
         JOIN ${sourceTable} s ON s.id = e.source_id
         WHERE e.source_table = ?
           AND s.user_id = ?`
      )
      .all(sourceTable, userId) as unknown as EmbeddingRow[];

    const scores = new Map<number, number>();

    if (this.vecEnabled) {
      // Use sqlite-vec's vec_distance_cosine() for accuracy + speed
      const stmt = this.db.prepare(
        "SELECT vec_distance_cosine(?, ?) as dist"
      );
      for (const row of rows) {
        const result = stmt.get(
          Buffer.from(queryVec.buffer),
          row.vector
        ) as { dist: number };
        // distance ∈ [0, 2]: 0 = identical, 2 = opposite → similarity [0, 1]
        scores.set(row.source_id, 1 - result.dist / 2);
      }
    } else {
      // JS fallback: cosine similarity via dot product
      for (const row of rows) {
        const candidate = new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / 4
        );
        scores.set(row.source_id, cosineSimilarity(queryVec, candidate));
      }
    }

    return scores;
  }

  /**
   * Append one message. Returns the auto-incremented row id.
   */
  appendMessage(params: AppendMessageParams): number {
    const result = this.stmtInsertMessage.run(
      params.session_id,
      params.user_id,
      params.role,
      params.content,
      params.tool_calls_json,
      params.tool_call_id,
      params.tool_name,
      params.created_at
    );
    const rowId = Number(result.lastInsertRowid);
    // Fire-and-forget embedding generation (best-effort, never blocks the caller)
    if (params.content.trim()) {
      this.scheduleEmbed("messages", rowId, params.content);
    }
    return rowId;
  }

  /**
   * Finalize a session — sets ended_at and final token/cost counts.
   */
  finalizeSession(params: FinalizeSessionParams): void {
    this.stmtFinalizeSession.run(
      params.ended_at,
      params.input_tokens,
      params.output_tokens,
      params.cost_usd,
      params.tool_call_count,
      params.session_id
    );
  }

  /**
   * Return the N most recent messages for a user across all sessions.
   * Results are returned in chronological order (oldest first) — ready to
   * prepend to an LLM context window.
   */
  getRecentMessages(userId: string, limit = 30): StoredMessage[] {
    const capped = Math.min(limit, 100);
    const rows = this.stmtRecentMessages.all(userId, capped) as unknown as StoredMessage[];
    // SQL returned most-recent-first; reverse for chronological LLM order
    return rows.reverse();
  }

  /**
   * Full-text + vector hybrid search over a user's message history.
   * hybridScore = 0.3 × fts_score + 0.7 × vector_similarity when embeddings available.
   * Falls back to FTS5-only when no embedding model is configured.
   */
  async searchMessages(userId: string, query: string, limit = 20): Promise<StoredMessage[]> {
    const capped = Math.min(limit, 100);
    const ftsLimit = this.embeddingClient ? Math.min(capped * 4, 400) : capped;

    type FtsMessage = StoredMessage & { rank: number };
    const ftsRows = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.user_id, m.role, m.content,
                m.tool_calls_json, m.tool_call_id, m.tool_name, m.created_at,
                fts.rank
         FROM messages m
         JOIN messages_fts fts ON m.id = fts.rowid
         WHERE fts.messages_fts MATCH ?
           AND m.user_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, userId, ftsLimit) as unknown as FtsMessage[];

    if (!this.embeddingClient || ftsRows.length === 0) {
      return ftsRows.slice(0, capped) as StoredMessage[];
    }

    const vectorScores = await this.getVectorScores("messages", userId, query);

    if (vectorScores.size === 0) {
      return ftsRows.slice(0, capped) as StoredMessage[];
    }

    const ranks = ftsRows.map((r) => r.rank ?? 0);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const rankRange = maxRank - minRank || 1;

    const scored = ftsRows.map((r) => {
      const ftsScore = 1 - ((r.rank ?? 0) - minRank) / rankRange;
      const vecScore = vectorScores.get(r.id) ?? 0;
      return { row: r, score: 0.3 * ftsScore + 0.7 * vecScore };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, capped).map((s) => s.row as StoredMessage);
  }

  /**
   * Delete all sessions, messages, and lessons for a user (GDPR / right-to-erasure).
   * Returns the number of messages deleted before cascade removal.
   */
  deleteUserData(userId: string): number {
    const row = this.stmtCountUserMessages.get(userId) as { count: number };
    const messageCount = row.count;
    this.stmtDeleteUserEmbeddings.run(userId, userId); // two params: messages + lessons
    this.stmtDeleteUserLessons.run(userId);
    this.stmtDeleteUserSessions.run(userId); // cascades to messages
    return messageCount;
  }

  /**
   * Store extracted lessons for a session. Silently skips duplicates
   * (same user_id + lesson_text in the same session via OR IGNORE on a
   * unique index — see schema).
   * Returns the number of lessons actually inserted.
   */
  storeLessons(params: StoreLessonsParams): number {
    let stored = 0;
    const now = Date.now();
    for (const lesson of params.lessons) {
      const result = this.stmtInsertLesson.run(
        params.user_id,
        params.source_session_id,
        lesson.lesson_text,
        lesson.category,
        now,
      );
      if (result.changes > 0) {
        stored++;
        // Fire-and-forget embedding generation
        const rowId = Number(result.lastInsertRowid);
        this.scheduleEmbed("lessons", rowId, lesson.lesson_text);
      }
    }
    return stored;
  }

  /**
   * Retrieve relevant lessons for a user — hybrid FTS5 + vector similarity.
   *
   * When a query is provided and embeddings are available:
   *   hybridScore = 0.3 × fts_score + 0.7 × vector_similarity
   * Falls back to FTS5-only if no embeddings, or to recency if no query.
   * Increments access_count for every lesson returned.
   */
  async getRelevantLessons(userId: string, query: string, limit = 5): Promise<StoredLesson[]> {
    const capped = Math.min(limit, 20);
    let rows: StoredLesson[];

    if (query.trim().length > 0) {
      // FTS5 results — over-fetch so hybrid re-ranking has enough candidates
      const ftsLimit = Math.min(capped * 4, 80);
      const ftsRows = this.stmtGetRelevantLessons.all(
        query,
        userId,
        ftsLimit,
      ) as unknown as (StoredLesson & { rank: number })[];

      if (this.embeddingClient && ftsRows.length > 0) {
        const vectorScores = await this.getVectorScores("lessons", userId, query);

        if (vectorScores.size > 0) {
          // Normalize FTS5 rank (negative values, more negative = better)
          const ranks = ftsRows.map((r) => r.rank ?? 0);
          const minRank = Math.min(...ranks);
          const maxRank = Math.max(...ranks);
          const rankRange = maxRank - minRank || 1;

          const scored = ftsRows.map((r) => {
            const ftsScore = 1 - ((r.rank ?? 0) - minRank) / rankRange; // [0,1]
            const vecScore = vectorScores.get(r.id) ?? 0;               // [0,1]
            return { row: r, score: 0.3 * ftsScore + 0.7 * vecScore };
          });
          scored.sort((a, b) => b.score - a.score);
          rows = scored.slice(0, capped).map((s) => s.row);
        } else {
          rows = ftsRows.slice(0, capped);
        }
      } else {
        rows = ftsRows.slice(0, capped);
      }
    } else {
      rows = this.stmtListLessons.all(userId, capped) as unknown as StoredLesson[];
    }

    for (const row of rows) {
      this.stmtIncrementLessonAccess.run(row.id);
    }
    return rows;
  }

  /**
   * List all lessons for a user ordered by recency. Used by CLI and admin routes.
   */
  listLessons(userId: string, limit = 20): StoredLesson[] {
    const capped = Math.min(limit, 100);
    return this.stmtListLessons.all(userId, capped) as unknown as StoredLesson[];
  }

  /** Return the path to the underlying SQLite database file. */
  getDbPath(): string | undefined {
    return this.dbPath;
  }

  /**
   * Dump the memory database as gzip-compressed bytes with SHA-256 checksum.
   * Performs a WAL checkpoint first to ensure the main DB file is up-to-date.
   */
  dumpState(): { data: Buffer; checksum: string } {
    if (this.dbPath === undefined) {
      throw new Error("Cannot dump state: dbPath not provided at construction");
    }

    this.db.exec("PRAGMA wal_checkpoint(FULL)");

    const raw = readFileSync(this.dbPath);
    const checksum = createHash("sha256").update(raw).digest("hex");
    const compressed = gzipSync(raw);
    return { data: compressed, checksum };
  }

  /**
   * Restore memory state from a gzip-compressed database dump.
   * Writes to <path>.new; startup migration applies it on next restart.
   */
  restoreState(data: Buffer, checksum: string): void {
    if (this.dbPath === undefined) {
      throw new Error("Cannot restore state: dbPath not provided at construction");
    }

    const raw = gunzipSync(data);
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== checksum) {
      throw new Error(`Checksum mismatch: expected ${checksum}, got ${actual}`);
    }

    const newPath = this.dbPath + ".new";
    writeFileSync(newPath, raw);
  }
}
