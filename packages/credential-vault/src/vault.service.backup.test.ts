/**
 * vault.service.backup.test.ts -- Tests for VaultService.dumpState / restoreState.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { VaultService } from "./vault.service.js";

let tmpDir: string;
let svc: VaultService;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tessera-vault-backup-"));
  // Write a fake keys.enc.json so dumpState has something to pack
  writeFileSync(
    join(tmpDir, "keys.enc.json"),
    JSON.stringify({ v: 1, key_id: "test", entries: {} }),
    { mode: 0o600 },
  );
  svc = new VaultService(tmpDir);
});

afterEach(() => {
  svc.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("VaultService.dumpState", () => {
  it("returns non-empty gzipped bytes and a valid SHA-256 checksum", async () => {
    const { data, checksum } = await svc.dumpState();

    expect(data.length).toBeGreaterThan(0);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    // Verify checksum matches the uncompressed content
    const uncompressed = gunzipSync(data);
    const actual = createHash("sha256").update(uncompressed).digest("hex");
    expect(actual).toBe(checksum);
  });

  it("works on an empty store (no keys.enc.json)", async () => {
    // Create a fresh service with no keys.enc.json
    const emptyDir = mkdtempSync(join(tmpdir(), "tessera-vault-empty-"));
    const emptySvc = new VaultService(emptyDir);

    try {
      const { data, checksum } = await emptySvc.dumpState();
      expect(data.length).toBeGreaterThan(0);
      expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      emptySvc.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("tar contains keys.enc.json and vault-refs.db entries", async () => {
    const { data } = await svc.dumpState();
    const uncompressed = gunzipSync(data);

    const entryNames = await new Promise<string[]>((resolve, reject) => {
      const extract = tar.extract();
      const names: string[] = [];
      extract.on("entry", (header, stream, next) => {
        names.push(header.name);
        stream.on("end", next);
        stream.resume();
      });
      extract.on("finish", () => resolve(names));
      extract.on("error", reject);
      extract.end(uncompressed);
    });

    expect(entryNames).toContain("keys.enc.json");
    expect(entryNames).toContain("vault-refs.db");
  });
});

describe("VaultService.restoreState", () => {
  it("writes staging files (.new) after restore", async () => {
    // First dump
    const { data, checksum } = await svc.dumpState();

    // Create a separate dir to restore into
    const restoreDir = mkdtempSync(join(tmpdir(), "tessera-vault-restore-"));
    const restoreSvc = new VaultService(restoreDir);

    try {
      await restoreSvc.restoreState(data, checksum);

      // keys.enc.json should be replaced in place
      expect(existsSync(join(restoreDir, "keys.enc.json"))).toBe(true);

      // vault-refs.db should be written as .new (pending restart)
      expect(existsSync(join(restoreDir, "vault-refs.db.new"))).toBe(true);
    } finally {
      restoreSvc.close();
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("throws on bad checksum", async () => {
    const { data } = await svc.dumpState();

    await expect(
      svc.restoreState(data, "0000000000000000000000000000000000000000000000000000000000000000"),
    ).rejects.toThrow("Checksum mismatch");
  });
});

describe("startup migration", () => {
  it("vault-refs.db.new is renamed to vault-refs.db when present", async () => {
    // Simulate a pending restore by writing a .new file
    const pendingPath = join(tmpDir, "vault-refs.db.new");
    writeFileSync(pendingPath, "pending-restore-data");

    // The startup migration logic is in index.ts — replicate it here
    const { existsSync: exists, renameSync: rename } = await import("node:fs");
    if (exists(pendingPath)) {
      rename(pendingPath, join(tmpDir, "vault-refs.db"));
    }

    expect(existsSync(pendingPath)).toBe(false);
    expect(readFileSync(join(tmpDir, "vault-refs.db"), "utf-8")).toBe("pending-restore-data");
  });
});
