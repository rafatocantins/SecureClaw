/**
 * memory.service.ts — Core business logic for the memory store.
 *
 * All database operations are synchronous (node:sqlite).
 * Prepared statements are compiled once in the constructor.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync, StatementSync } from "node:sqlite";

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

export class MemoryService {
  private readonly db: DatabaseSync;
  private readonly dbPath: string | undefined;

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

  constructor(db: DatabaseSync, dbPath?: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.prepareStatements();
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
    return Number(result.lastInsertRowid);
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
   * Full-text search over a user's message history using FTS5.
   * Results are ordered by FTS5 relevance rank.
   */
  searchMessages(userId: string, query: string, limit = 20): StoredMessage[] {
    const capped = Math.min(limit, 100);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.user_id, m.role, m.content,
                m.tool_calls_json, m.tool_call_id, m.tool_name, m.created_at
         FROM messages m
         JOIN messages_fts fts ON m.id = fts.rowid
         WHERE fts.messages_fts MATCH ?
           AND m.user_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, userId, capped) as unknown as StoredMessage[];
    return rows;
  }

  /**
   * Delete all sessions, messages, and lessons for a user (GDPR / right-to-erasure).
   * Returns the number of messages deleted before cascade removal.
   */
  deleteUserData(userId: string): number {
    const row = this.stmtCountUserMessages.get(userId) as { count: number };
    const messageCount = row.count;
    this.stmtDeleteUserLessons.run(userId);
    this.stmtDeleteUserSessions.run(userId);
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
      if (result.changes > 0) stored++;
    }
    return stored;
  }

  /**
   * Retrieve relevant lessons for a user.
   * If `query` is non-empty, performs an FTS5 search ranked by relevance.
   * If `query` is empty, returns the most-recent lessons by created_at.
   * Increments access_count for every lesson returned.
   */
  getRelevantLessons(userId: string, query: string, limit = 5): StoredLesson[] {
    const capped = Math.min(limit, 20);
    let rows: StoredLesson[];

    if (query.trim().length > 0) {
      rows = this.stmtGetRelevantLessons.all(
        query,
        userId,
        capped,
      ) as unknown as StoredLesson[];
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
