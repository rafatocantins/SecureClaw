/**
 * memory.service.backup.test.ts -- Tests for MemoryService.dumpState / restoreState.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createMemoryDatabase } from "./db/connection.js";
import { MemoryService } from "./memory.service.js";
import { replaceFileSync } from "@tessera/shared";
import type { DatabaseSync } from "node:sqlite";

let tmpDir: string;
let db: DatabaseSync;
let svc: MemoryService;
let dbPath: string;
let dbClosed: boolean;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tessera-memory-backup-"));
  dbPath = join(tmpDir, "memory.db");
  db = createMemoryDatabase(tmpDir);
  svc = new MemoryService(db, dbPath);
  dbClosed = false;
});

afterEach(() => {
  if (!dbClosed) db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryService.dumpState", () => {
  it("returns non-empty gzipped bytes and a valid SHA-256 checksum", () => {
    const { data, checksum } = svc.dumpState();

    expect(data.length).toBeGreaterThan(0);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    const uncompressed = gunzipSync(data);
    const actual = createHash("sha256").update(uncompressed).digest("hex");
    expect(actual).toBe(checksum);
  });

  it("works on an empty database (no messages yet)", () => {
    const { data, checksum } = svc.dumpState();
    expect(data.length).toBeGreaterThan(0);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("MemoryService.restoreState", () => {
  it("writes .new file after restore", () => {
    const { data, checksum } = svc.dumpState();
    svc.restoreState(data, checksum);

    expect(existsSync(dbPath + ".new")).toBe(true);
  });

  it("throws on bad checksum", () => {
    const { data } = svc.dumpState();

    expect(() =>
      svc.restoreState(data, "0000000000000000000000000000000000000000000000000000000000000000"),
    ).toThrow("Checksum mismatch");
  });
});

describe("MemoryService.getDbPath", () => {
  it("returns the configured database path", () => {
    expect(svc.getDbPath()).toBe(dbPath);
  });
});

describe("startup migration", () => {
  it("memory.db.new is renamed to memory.db when present", () => {
    const pendingPath = dbPath + ".new";
    writeFileSync(pendingPath, "pending-restore-data");

    // Production runs this migration at startup BEFORE opening the connection.
    // Close the handle here too: on Windows, renaming over an open destination
    // fails with EPERM.
    db.close();
    dbClosed = true;

    if (existsSync(pendingPath)) {
      replaceFileSync(pendingPath, dbPath);
    }

    expect(existsSync(pendingPath)).toBe(false);
    expect(readFileSync(dbPath, "utf-8")).toBe("pending-restore-data");
  });
});
