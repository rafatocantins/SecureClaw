import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initSchema } from "./schema.js";

/**
 * Open (or create) the memory SQLite database.
 * Creates the data directory if it does not exist.
 * Applies WAL mode and optimised pragmas before returning.
 *
 * Uses the built-in node:sqlite module (Node.js 22.13+ / 23.4+) — no native
 * compilation required, works on all platforms without build tools.
 *
 * allowExtension: true is required for Phase 3B sqlite-vec loading.
 */
export function createMemoryDatabase(dataDir: string): DatabaseSync {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const db = new DatabaseSync(join(dataDir, "memory.db"), { allowExtension: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA cache_size = -4000"); // 4 MB
  db.exec("PRAGMA temp_store = MEMORY");

  initSchema(db);
  return db;
}
