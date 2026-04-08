/**
 * keychain.adapter.test.ts — Tests for versioned store format, key mismatch
 * detection, legacy migration, and key rotation (file backend).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKeychainAdapter,
  deriveKeyId,
  deriveKeyFromMaster,
  rotateFileStoreKey,
  type VersionedStore,
} from "./keychain.adapter.js";

let tmpDir: string;
const MASTER_KEY = "test-master-key-abc123";
const ALT_MASTER_KEY = "alt-master-key-xyz789";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tessera-vault-test-"));
  process.env["VAULT_DATA_DIR"] = tmpDir;
  process.env["VAULT_MASTER_KEY"] = MASTER_KEY;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["VAULT_DATA_DIR"];
  delete process.env["VAULT_MASTER_KEY"];
});

describe("deriveKeyId", () => {
  it("returns a 16-char hex string", () => {
    const key = deriveKeyFromMaster("some-key");
    const id = deriveKeyId(key);
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("same key produces same id", () => {
    const key = deriveKeyFromMaster("same-key");
    expect(deriveKeyId(key)).toBe(deriveKeyId(key));
  });

  it("different keys produce different ids", () => {
    const k1 = deriveKeyFromMaster("key-one");
    const k2 = deriveKeyFromMaster("key-two");
    expect(deriveKeyId(k1)).not.toBe(deriveKeyId(k2));
  });
});

describe("VersionedStore format", () => {
  it("set then get: round-trip with same key returns the value", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("my-account", "secret-value-123");
    const result = await adapter.get("my-account");
    expect(result).toBe("secret-value-123");
  });

  it("written file uses versioned format with v=1 and key_id", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc", "val");

    const filePath = join(tmpDir, "keys.enc.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as VersionedStore;
    expect(raw.v).toBe(1);
    expect(raw.key_id).toHaveLength(16);
    expect(typeof raw.entries).toBe("object");
    expect(Object.keys(raw.entries).length).toBeGreaterThan(0);
  });

  it("findAll returns stored accounts", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc-a", "val-a");
    await adapter.set("acc-b", "val-b");

    const all = await adapter.findAll();
    const accounts = all.map((a) => a.account).sort();
    expect(accounts).toEqual(["acc-a", "acc-b"]);
  });

  it("delete removes an entry", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("del-me", "val");
    const deleted = await adapter.delete("del-me");
    expect(deleted).toBe(true);
    const result = await adapter.get("del-me");
    expect(result).toBeNull();
  });

  it("delete returns false for non-existent entry", async () => {
    const adapter = createKeychainAdapter("test-svc");
    const deleted = await adapter.delete("nope");
    expect(deleted).toBe(false);
  });
});

describe("Legacy migration", () => {
  it("transparently migrates a v0 flat file on first access", async () => {
    // Write a legacy flat file directly
    const filePath = join(tmpDir, "keys.enc.json");
    const key = deriveKeyFromMaster(MASTER_KEY);

    // Manually create an encrypted entry in the old flat format
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedValue = `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;

    const legacyStore: Record<string, string> = {
      "Tessera:test-svc:legacy-acc": encryptedValue,
    };
    writeFileSync(filePath, JSON.stringify(legacyStore), { mode: 0o600 });

    // Access via adapter — should migrate
    const adapter = createKeychainAdapter("test-svc");
    const value = await adapter.get("legacy-acc");
    expect(value).toBe("legacy-secret");

    // Verify file is now in versioned format
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as VersionedStore;
    expect(raw.v).toBe(1);
    expect(raw.key_id).toHaveLength(16);
    expect(raw.entries["Tessera:test-svc:legacy-acc"]).toBeDefined();
  });
});

describe("Key mismatch detection", () => {
  it("throws on key mismatch when loading store", async () => {
    // Write a store with the current key
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc", "val");

    // Change the master key
    process.env["VAULT_MASTER_KEY"] = ALT_MASTER_KEY;

    // Attempt to access — should throw
    const adapter2 = createKeychainAdapter("test-svc");
    await expect(adapter2.get("acc")).rejects.toThrow("vault key mismatch");
  });

  it("error message suggests rotate-key command", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc", "val");

    process.env["VAULT_MASTER_KEY"] = ALT_MASTER_KEY;
    const adapter2 = createKeychainAdapter("test-svc");
    await expect(adapter2.get("acc")).rejects.toThrow("tessera vault rotate-key");
  });
});

describe("rotateFileStoreKey", () => {
  it("re-encrypts all entries; entries readable with new key after rotation", async () => {
    // Store entries with the original key
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc-1", "secret-1");
    await adapter.set("acc-2", "secret-2");

    // Rotate
    const result = await rotateFileStoreKey(MASTER_KEY, ALT_MASTER_KEY);
    expect(result.rotated).toBe(2);

    // Switch to new key and read
    process.env["VAULT_MASTER_KEY"] = ALT_MASTER_KEY;
    const adapter2 = createKeychainAdapter("test-svc");
    expect(await adapter2.get("acc-1")).toBe("secret-1");
    expect(await adapter2.get("acc-2")).toBe("secret-2");
  });

  it("wrong old key throws", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc", "val");

    await expect(
      rotateFileStoreKey("wrong-old-key", ALT_MASTER_KEY)
    ).rejects.toThrow("vault key mismatch");
  });

  it("partial failure (corrupted entry) aborts without touching the file", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("good-acc", "good-val");

    // Manually corrupt an entry in the file
    const filePath = join(tmpDir, "keys.enc.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as VersionedStore;
    raw.entries["Tessera:test-svc:bad-acc"] = "not:valid:ciphertext";
    writeFileSync(filePath, JSON.stringify(raw, null, 2), { mode: 0o600 });

    // Rotation should abort
    await expect(
      rotateFileStoreKey(MASTER_KEY, ALT_MASTER_KEY)
    ).rejects.toThrow("rotation aborted");

    // Original file should still be readable with original key
    const adapter2 = createKeychainAdapter("test-svc");
    expect(await adapter2.get("good-acc")).toBe("good-val");
  });

  it("returns rotated=0 when no file exists", async () => {
    // Point to a fresh empty dir
    const emptyDir = mkdtempSync(join(tmpdir(), "tessera-vault-empty-"));
    process.env["VAULT_DATA_DIR"] = emptyDir;
    try {
      const result = await rotateFileStoreKey(MASTER_KEY, ALT_MASTER_KEY);
      expect(result.rotated).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("file after rotation has correct key_id for new key", async () => {
    const adapter = createKeychainAdapter("test-svc");
    await adapter.set("acc", "val");

    await rotateFileStoreKey(MASTER_KEY, ALT_MASTER_KEY);

    const filePath = join(tmpDir, "keys.enc.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as VersionedStore;
    const expectedKeyId = deriveKeyId(deriveKeyFromMaster(ALT_MASTER_KEY));
    expect(raw.key_id).toBe(expectedKeyId);
  });
});
