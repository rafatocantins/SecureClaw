/**
 * memory-store — persistent conversation memory for Tessera agents.
 *
 * SQLite-backed (better-sqlite3), gRPC server on port 19006.
 * FTS5 full-text search over message content.
 */

export { MemoryService } from "./memory.service.js";
export type { StoredMessage, StoreSessionParams, AppendMessageParams, FinalizeSessionParams, StoredLesson, LessonCategory, StoreLessonsParams } from "./memory.service.js";
export { createMemoryDatabase } from "./db/connection.js";
export { initSchema } from "./db/schema.js";
export { startMemoryGrpcServer } from "./grpc/server.js";

export const MEMORY_STORE_VERSION = "0.2.0";

// ── Standalone server entry point ────────────────────────────────────────────
// Runs when executed directly: node packages/memory-store/dist/index.js
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("index.js");

if (isMain) {
  const { loadDotenv } = await import("@tessera/shared");
  loadDotenv();

  const { createMemoryDatabase: createDb } = await import("./db/connection.js");
  const { MemoryService: Svc } = await import("./memory.service.js");
  const { startMemoryGrpcServer: startServer } = await import("./grpc/server.js");

  const { existsSync, renameSync } = await import("node:fs");
  const { join } = await import("node:path");

  const dataDir = process.env["MEMORY_DATA_DIR"] ?? "/data/memory";
  const dbPath = join(dataDir, "memory.db");

  // Apply pending restore if present (written by RestoreState RPC)
  const pendingDb = dbPath + ".new";
  if (existsSync(pendingDb)) {
    renameSync(pendingDb, dbPath);
    process.stdout.write("[memory-store] Applied pending restore: memory.db replaced\n");
  }

  try {
    const db = createDb(dataDir);
    const svc = new Svc(db, dbPath);
    const server = await startServer(svc);

    process.stdout.write("[memory-store] Service ready\n");

    const shutdown = (): void => {
      process.stdout.write("[memory-store] Shutting down...\n");
      server.tryShutdown((err) => {
        if (err) {
          process.stderr.write(`[memory-store] Shutdown error: ${String(err)}\n`);
          process.exit(1);
        }
        db.close();
        process.exit(0);
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    process.stderr.write(`[memory-store] Fatal: ${String(err)}\n`);
    process.exit(1);
  }
}
