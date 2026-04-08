/**
 * keychain.adapter.ts — Dual-backend credential storage.
 *
 * Backend selection (probed once at module load):
 *   1. keytar  — OS-backed secure storage (preferred)
 *        Windows : Windows Credential Manager (DPAPI, optionally TPM-backed)
 *        macOS   : macOS Keychain (Secure Enclave)
 *        Linux   : libsecret / GNOME Keyring (requires daemon + libsecret-1)
 *   2. Encrypted file — AES-256-GCM fallback for headless Linux / WSL / CI
 *        File: ${VAULT_DATA_DIR}/keys.enc.json  (mode 0600)
 *        Key : SHA-256(VAULT_MASTER_KEY env var)
 *        IV  : 12 random bytes per entry (stored alongside ciphertext)
 *        Tag : 16-byte GCM auth tag      (stored alongside ciphertext)
 *
 * Only MODULE_NOT_FOUND / runtime binding errors at import time cause the
 * fallback.  Runtime errors from keytar operations are rethrown so the caller
 * knows the OS keychain is broken.
 *
 * SECURITY NOTE: In production set VAULT_MASTER_KEY to a 256-bit random value
 * (env var from a secrets manager) and protect VAULT_DATA_DIR with filesystem
 * ACLs.  The raw secret value is never logged or returned to callers except
 * inside InjectCredential, where it is substituted directly into the tool
 * input JSON without being stored anywhere else.
 */
import { createRequire } from "node:module";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export const KEYCHAIN_SERVICE_PREFIX = "Tessera";

export interface KeychainAdapter {
  /** Store a secret */
  set(account: string, value: string): Promise<void>;
  /** Retrieve a secret (used only by the injector, never returned to callers) */
  get(account: string): Promise<string | null>;
  /** Delete a secret */
  delete(account: string): Promise<boolean>;
  /** List all accounts under this service (no values) */
  findAll(): Promise<Array<{ account: string }>>;
}

/**
 * Versioned file store format (v1).
 * key_id: first 16 hex chars of SHA-256(derived_key) — enough to detect
 * mismatch, not enough to brute-force the key.
 */
export interface VersionedStore {
  v: 1;
  key_id: string;
  entries: Record<string, string>;
}

// ── keytar probe ──────────────────────────────────────────────────────────

interface KeytarModule {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

const _require = createRequire(import.meta.url);
let _keytar: KeytarModule | null = null;

try {
  _keytar = _require("keytar") as KeytarModule;
  process.stdout.write("[vault] Backend: OS keychain (keytar)\n");
} catch {
  process.stdout.write(
    "[vault] Backend: encrypted file (keytar unavailable — headless/WSL/CI)\n"
  );
}

// ── AES-256-GCM encrypted file (fallback) ────────────────────────────────

const ALGO = "aes-256-gcm";

function deriveKey(): Buffer {
  const masterKey =
    process.env["VAULT_MASTER_KEY"] ??
    "dev-insecure-vault-key-change-in-prod";
  return createHash("sha256").update(masterKey, "utf8").digest();
}

/**
 * Derive a key from an explicit master key string (used by rotateFileStoreKey).
 */
export function deriveKeyFromMaster(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

/**
 * Compute a short identifier from the derived key.
 * First 16 hex chars of SHA-256(key) — safe to persist on disk.
 */
export function deriveKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

function decryptValue(stored: string, key: Buffer): string | null {
  try {
    const parts = stored.split(":");
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, ctHex] = parts as [string, string, string];
    const decipher = createDecipheriv(
      ALGO,
      key,
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return (
      decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") +
      decipher.final("utf8")
    );
  } catch {
    return null;
  }
}

function keysFilePath(): string {
  const dataDir = process.env["VAULT_DATA_DIR"] ?? "/tmp/tessera-vault";
  return join(dataDir, "keys.enc.json");
}

/**
 * Returns true if the parsed object is a VersionedStore (v1 envelope).
 */
function isVersionedStore(obj: unknown): obj is VersionedStore {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "v" in obj &&
    (obj as Record<string, unknown>)["v"] === 1 &&
    "key_id" in obj &&
    "entries" in obj
  );
}

/**
 * Load the versioned store from disk. Transparently migrates legacy flat files.
 * Validates key_id against the current key — throws on mismatch.
 */
function loadStore(filePath: string, key: Buffer): VersionedStore {
  const currentKeyId = deriveKeyId(key);

  if (!existsSync(filePath)) {
    return { v: 1, key_id: currentKeyId, entries: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return { v: 1, key_id: currentKeyId, entries: {} };
  }

  if (isVersionedStore(parsed)) {
    // Versioned file — validate key_id
    if (parsed.key_id !== currentKeyId) {
      throw new Error(
        "vault key mismatch: file was encrypted with a different key. " +
        "Run `tessera vault rotate-key --new-key <hex>` to re-encrypt."
      );
    }
    return parsed;
  }

  // Legacy flat Record<string, string> — migrate
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const entries = parsed as Record<string, string>;
    const migrated: VersionedStore = { v: 1, key_id: currentKeyId, entries };
    saveStore(filePath, migrated);
    return migrated;
  }

  return { v: 1, key_id: currentKeyId, entries: {} };
}

/**
 * Load a versioned store without key validation (for rotation: caller manages key checks).
 */
function loadStoreRaw(filePath: string): VersionedStore | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (isVersionedStore(parsed)) return parsed;
    // Legacy flat format
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { v: 1, key_id: "", entries: parsed as Record<string, string> };
    }
    return null;
  } catch {
    return null;
  }
}

function saveStore(filePath: string, store: VersionedStore): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ── Key rotation ─────────────────────────────────────────────────────────

/**
 * Re-encrypts every entry in the file store from oldKey to newKey atomically.
 * Throws if the file's key_id does not match oldKey.
 * Throws if keytar is active (OS manages key material).
 */
export async function rotateFileStoreKey(
  oldMasterKey: string,
  newMasterKey: string,
): Promise<{ rotated: number }> {
  if (_keytar !== null) {
    throw new Error("key rotation is not supported for OS keychain backends");
  }

  const oldKey = deriveKeyFromMaster(oldMasterKey);
  const newKey = deriveKeyFromMaster(newMasterKey);
  const oldKeyId = deriveKeyId(oldKey);
  const newKeyId = deriveKeyId(newKey);

  const filePath = keysFilePath();
  const store = loadStoreRaw(filePath);

  if (!store) {
    return { rotated: 0 };
  }

  // Verify old key matches
  if (store.key_id !== "" && store.key_id !== oldKeyId) {
    throw new Error(
      "vault key mismatch: the provided old key does not match the file's key_id"
    );
  }

  const entryKeys = Object.keys(store.entries);
  const reEncrypted: Record<string, string> = {};

  // Decrypt all entries with old key, re-encrypt with new key.
  // If any entry fails, abort without writing.
  for (const k of entryKeys) {
    const encrypted = store.entries[k];
    if (encrypted === undefined) continue;
    const plaintext = decryptValue(encrypted, oldKey);
    if (plaintext === null) {
      throw new Error(
        `rotation aborted: failed to decrypt entry "${k}" with the provided old key`
      );
    }
    reEncrypted[k] = encryptValue(plaintext, newKey);
  }

  const rotatedStore: VersionedStore = {
    v: 1,
    key_id: newKeyId,
    entries: reEncrypted,
  };

  // Atomic write: tmp file then rename
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(rotatedStore, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmpPath, filePath);

  return { rotated: entryKeys.length };
}

/**
 * Returns whether the keytar (OS keychain) backend is active.
 */
export function isKeytarActive(): boolean {
  return _keytar !== null;
}

// ── Public factory ────────────────────────────────────────────────────────

/**
 * Creates a keychain adapter scoped to a specific service namespace.
 *
 * When keytar is available the OS secure store is used for each operation.
 * All keys are stored under the compound service name
 * `Tessera:<serviceName>` so they're grouped in the OS credential manager.
 *
 * When keytar is unavailable the encrypted file backend is used instead;
 * keys are stored as `Tessera:<serviceName>:<account>` in the JSON file.
 */
export function createKeychainAdapter(serviceName: string): KeychainAdapter {
  const service = `${KEYCHAIN_SERVICE_PREFIX}:${serviceName}`;

  if (_keytar !== null) {
    // ── keytar path ──────────────────────────────────────────────────────
    const kt = _keytar; // capture for closure — never null in this branch
    return {
      async set(account: string, value: string): Promise<void> {
        await kt.setPassword(service, account, value);
      },

      async get(account: string): Promise<string | null> {
        return kt.getPassword(service, account);
      },

      async delete(account: string): Promise<boolean> {
        return kt.deletePassword(service, account);
      },

      async findAll(): Promise<Array<{ account: string }>> {
        const creds = await kt.findCredentials(service);
        return creds.map((c) => ({ account: c.account }));
      },
    };
  }

  // ── encrypted file path ──────────────────────────────────────────────
  const key = deriveKey();
  const storeKey = (account: string): string => `${service}:${account}`;

  return {
    async set(account: string, value: string): Promise<void> {
      const filePath = keysFilePath();
      const store = loadStore(filePath, key);
      store.entries[storeKey(account)] = encryptValue(value, key);
      saveStore(filePath, store);
    },

    async get(account: string): Promise<string | null> {
      const store = loadStore(keysFilePath(), key);
      const encrypted = store.entries[storeKey(account)];
      if (!encrypted) return null;
      return decryptValue(encrypted, key);
    },

    async delete(account: string): Promise<boolean> {
      const filePath = keysFilePath();
      const store = loadStore(filePath, key);
      const k = storeKey(account);
      if (!(k in store.entries)) return false;
      delete store.entries[k];
      saveStore(filePath, store);
      return true;
    },

    async findAll(): Promise<Array<{ account: string }>> {
      const store = loadStore(keysFilePath(), key);
      const prefix = `${service}:`;
      return Object.keys(store.entries)
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ account: k.slice(prefix.length) }));
    },
  };
}
