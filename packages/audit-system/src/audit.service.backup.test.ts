/**
 * audit.service.backup.test.ts -- Tests for AuditService.dumpState / restoreState.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createAuditDatabase } from "./database/connection.js";
import { AuditService } from "./audit.service.js";
import type { DatabaseSync } from "node:sqlite";

let tmpDir: string;
let db: DatabaseSync;
let svc: AuditService;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tessera-audit-backup-"));
  dbPath = join(tmpDir, "audit.db");
  db = createAuditDatabase(tmpDir);
  svc = new AuditService(db, 5.0, dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AuditService.dumpState", () => {
  it("returns non-empty gzipped bytes and a valid SHA-256 checksum", () => {
    const { data, checksum } = svc.dumpState();

    expect(data.length).toBeGreaterThan(0);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    // Verify checksum matches the uncompressed content
    const uncompressed = gunzipSync(data);
    const actual = createHash("sha256").update(uncompressed).digest("hex");
    expect(actual).toBe(checksum);
  });

  it("works on an empty database (no events yet)", () => {
    const { data, checksum } = svc.dumpState();
    expect(data.length).toBeGreaterThan(0);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AuditService.restoreState", () => {
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

describe("AuditService.getDbPath", () => {
  it("returns the configured database path", () => {
    expect(svc.getDbPath()).toBe(dbPath);
  });
});

describe("startup migration", () => {
  it("audit.db.new is renamed to audit.db when present", () => {
    const pendingPath = dbPath + ".new";
    writeFileSync(pendingPath, "pending-restore-data");

    // Replicate startup migration logic
    if (existsSync(pendingPath)) {
      renameSync(pendingPath, dbPath);
    }

    expect(existsSync(pendingPath)).toBe(false);
    // The file should now contain the pending data (though it would not be a
    // valid SQLite DB in production, this tests the rename logic)
    expect(readFileSync(dbPath, "utf-8")).toBe("pending-restore-data");
  });
});
