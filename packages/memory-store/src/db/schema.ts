import { DatabaseSync } from "node:sqlite";

/**
 * Initialize the memory-store SQLite schema.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 *
 * Tables:
 *   sessions    — one row per agent session (mutable: finalised on close)
 *   messages    — conversation history (append-only in practice; cascade deletes for GDPR)
 *   lessons     — extracted lessons from session reflection (Phase 3A)
 *   embeddings  — vector embeddings for hybrid retrieval (Phase 3B)
 *
 * FTS5:
 *   messages_fts — external-content FTS5 index over messages.content
 *   lessons_fts  — external-content FTS5 index over lesson_text
 *   Triggers keep the indexes in sync after INSERT and DELETE.
 */
export function initSchema(db: DatabaseSync): void {
  db.exec(`
    -- =========================================================================
    -- sessions
    -- =========================================================================
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      provider        TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL    NOT NULL DEFAULT 0.0,
      tool_call_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id);

    -- =========================================================================
    -- messages
    -- =========================================================================
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id         TEXT    NOT NULL,
      role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
      content         TEXT    NOT NULL DEFAULT '',
      tool_calls_json TEXT    NOT NULL DEFAULT '',
      tool_call_id    TEXT    NOT NULL DEFAULT '',
      tool_name       TEXT    NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_messages_user_time
      ON messages(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id);

    -- =========================================================================
    -- FTS5 full-text index (external content table)
    -- =========================================================================
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content=messages, content_rowid=id);

    -- Keep FTS in sync after inserts
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
      AFTER INSERT ON messages
    BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    -- Keep FTS in sync after deletes (required for external-content tables)
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
      AFTER DELETE ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    END;

    -- =========================================================================
    -- lessons
    -- =========================================================================
    CREATE TABLE IF NOT EXISTS lessons (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           TEXT    NOT NULL,
      source_session_id TEXT    NOT NULL,
      lesson_text       TEXT    NOT NULL,
      category          TEXT    NOT NULL CHECK(category IN ('mistake','preference','procedure','fact')),
      created_at        INTEGER NOT NULL,
      access_count      INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_lessons_user
      ON lessons(user_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_dedup
      ON lessons(user_id, lesson_text);

    CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts
      USING fts5(lesson_text, content=lessons, content_rowid=id);

    CREATE TRIGGER IF NOT EXISTS lessons_fts_insert
      AFTER INSERT ON lessons
    BEGIN
      INSERT INTO lessons_fts(rowid, lesson_text) VALUES (new.id, new.lesson_text);
    END;

    CREATE TRIGGER IF NOT EXISTS lessons_fts_delete
      AFTER DELETE ON lessons
    BEGIN
      INSERT INTO lessons_fts(lessons_fts, rowid, lesson_text)
        VALUES ('delete', old.id, old.lesson_text);
    END;

    -- =========================================================================
    -- embeddings (Phase 3B — vector/semantic memory)
    -- =========================================================================
    CREATE TABLE IF NOT EXISTS embeddings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_table TEXT    NOT NULL,   -- 'messages' | 'lessons'
      source_id    INTEGER NOT NULL,
      vector       BLOB    NOT NULL,   -- Float32Array (little-endian IEEE 754)
      model_id     TEXT    NOT NULL,
      created_at   INTEGER NOT NULL
    ) STRICT;

    -- One embedding per source row; overwrite on model change
    CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_source
      ON embeddings(source_table, source_id);

    -- =========================================================================
    -- harness_patches (HarnessEvolutionService persistence)
    -- =========================================================================
    CREATE TABLE IF NOT EXISTS harness_patches (
      id              TEXT PRIMARY KEY,
      patch_type      TEXT NOT NULL CHECK(patch_type IN ('prompt_update','tool_rule','system_instruction')),
      target          TEXT NOT NULL,
      proposed_change TEXT NOT NULL,
      confidence      REAL NOT NULL DEFAULT 0.0,
      recommendation  TEXT NOT NULL DEFAULT 'review',
      source_patterns TEXT NOT NULL DEFAULT '[]',  -- JSON array
      applied         INTEGER NOT NULL DEFAULT 0,
      applied_at      INTEGER,
      generated_at    INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_harness_patches_applied
      ON harness_patches(applied, confidence DESC);
  `);
}
