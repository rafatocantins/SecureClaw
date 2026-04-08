/**
 * vault.service.ts — Core vault service implementation.
 *
 * Implements the VaultService gRPC interface.
 * Coordinates between the keychain adapter, ref store, injector, and scanner.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { CredentialError } from "@tessera/shared";
import { createKeychainAdapter, rotateFileStoreKey } from "./keychain.adapter.js";
import { RefStore } from "./ref-store.js";
import { injectAllCredentials } from "./injector.js";
import { scanDirectory } from "./scanner.js";

export interface SetSecretParams {
  service: string;
  account: string;
  value: string;
}

export interface SetSecretResult {
  ref_id: string;
  success: boolean;
  error_message: string;
}

export interface GetSecretRefResult {
  ref_id: string;
  exists: boolean;
}

export interface DeleteSecretResult {
  success: boolean;
}

export interface SecretRef {
  ref_id: string;
  service: string;
  account: string;
  created_at: string;
}

export interface ListRefsResult {
  refs: SecretRef[];
}

export interface InjectCredentialParams {
  ref_id: string;
  tool_input_json: string;
  placeholder_key: string;
}

export interface InjectCredentialResult {
  mutated_input_json: string;
  success: boolean;
  error_message: string;
}

export interface ScanResult {
  warnings: string[];
  errors: string[];
}

export class VaultService {
  private refStore: RefStore;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.refStore = new RefStore(dataDir);
  }

  async setSecret(params: SetSecretParams): Promise<SetSecretResult> {
    try {
      const keychain = createKeychainAdapter(params.service);
      await keychain.set(params.account, params.value);
      const ref_id = this.refStore.upsertRef(params.service, params.account);
      return { ref_id, success: true, error_message: "" };
    } catch (err) {
      return {
        ref_id: "",
        success: false,
        error_message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getSecretRef(service: string, account: string): GetSecretRefResult {
    const ref = this.refStore.findRef(service, account);
    return { ref_id: ref?.ref_id ?? "", exists: ref !== null };
  }

  async deleteSecret(service: string, account: string): Promise<DeleteSecretResult> {
    try {
      const keychain = createKeychainAdapter(service);
      await keychain.delete(account);
      this.refStore.deleteRef(service, account);
      return { success: true };
    } catch (err) {
      if (err instanceof Error) {
        throw new CredentialError(`Failed to delete secret: ${err.message}`);
      }
      throw err;
    }
  }

  listSecretRefs(): ListRefsResult {
    return { refs: this.refStore.listRefs() };
  }

  async injectCredential(params: InjectCredentialParams): Promise<InjectCredentialResult> {
    try {
      const ref = this.refStore.getRef(params.ref_id);
      if (!ref) {
        return {
          mutated_input_json: "",
          success: false,
          error_message: `Unknown credential reference: ${params.ref_id}`,
        };
      }

      const keychain = createKeychainAdapter(ref.service);
      const mutated = await injectAllCredentials(params.tool_input_json, keychain, this.refStore);

      return { mutated_input_json: mutated, success: true, error_message: "" };
    } catch (err) {
      return {
        mutated_input_json: "",
        success: false,
        error_message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rotateKey(
    oldMasterKey: string,
    newMasterKey: string,
  ): Promise<{ rotated: number }> {
    return rotateFileStoreKey(oldMasterKey, newMasterKey);
  }

  scanForPlaintextSecrets(path: string): ScanResult {
    return scanDirectory(path);
  }

  /**
   * Dump all vault state (keys.enc.json + vault-refs.db) as a gzip-compressed
   * tar archive. Returns the compressed bytes and a SHA-256 checksum of the
   * uncompressed tar for integrity verification.
   */
  async dumpState(): Promise<{ data: Buffer; checksum: string }> {
    // 1. Read keys.enc.json (may not exist on a fresh install)
    const keysPath = join(this.dataDir, "keys.enc.json");
    const keysData = existsSync(keysPath)
      ? readFileSync(keysPath)
      : Buffer.alloc(0);

    // 2. Checkpoint the WAL so vault-refs.db is fully up-to-date
    this.refStore.checkpoint();
    const dbPath = this.refStore.getDbPath();
    const dbData = existsSync(dbPath)
      ? readFileSync(dbPath)
      : Buffer.alloc(0);

    // 3. Pack into an in-memory tar
    const tarBuffer = await new Promise<Buffer>((resolve, reject) => {
      const pack = tar.pack();
      const chunks: Buffer[] = [];

      pack.on("data", (chunk: Buffer) => chunks.push(chunk));
      pack.on("end", () => resolve(Buffer.concat(chunks)));
      pack.on("error", reject);

      pack.entry({ name: "keys.enc.json" }, keysData);
      pack.entry({ name: "vault-refs.db" }, dbData);
      pack.finalize();
    });

    // 4. Compute checksum of uncompressed tar
    const checksum = createHash("sha256").update(tarBuffer).digest("hex");

    // 5. gzip
    const compressed = gzipSync(tarBuffer);
    return { data: compressed, checksum };
  }

  /**
   * Restore vault state from a gzip-compressed tar archive produced by dumpState().
   * Writes files to a staging directory; the actual swap happens on next restart.
   */
  async restoreState(data: Buffer, checksum: string): Promise<void> {
    // 1. Decompress
    const tarBuffer = gunzipSync(data);

    // 2. Verify checksum
    const actual = createHash("sha256").update(tarBuffer).digest("hex");
    if (actual !== checksum) {
      throw new CredentialError(
        `Checksum mismatch: expected ${checksum}, got ${actual}`
      );
    }

    // 3. Extract tar entries
    const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      const extract = tar.extract();
      const entries = new Map<string, Buffer>();

      extract.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          entries.set(header.name, Buffer.concat(chunks));
          next();
        });
        stream.on("error", reject);
      });

      extract.on("finish", () => resolve(entries));
      extract.on("error", reject);
      extract.end(tarBuffer);
    });

    // 4. Write to staging directory
    const stagingDir = join(this.dataDir, "restore-staging");
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

    const keysEntry = files.get("keys.enc.json");
    if (keysEntry !== undefined && keysEntry.length > 0) {
      writeFileSync(join(stagingDir, "keys.enc.json"), keysEntry, { mode: 0o600 });
    }

    const dbEntry = files.get("vault-refs.db");
    if (dbEntry !== undefined && dbEntry.length > 0) {
      writeFileSync(join(stagingDir, "vault-refs.db"), dbEntry);
    }

    // 5. Atomic renames: staging files → live location
    // keys.enc.json can be replaced in place (no open handles)
    const stagedKeys = join(stagingDir, "keys.enc.json");
    if (existsSync(stagedKeys)) {
      renameSync(stagedKeys, join(this.dataDir, "keys.enc.json"));
    }

    // vault-refs.db has an open connection — write as .new for startup migration
    const stagedDb = join(stagingDir, "vault-refs.db");
    if (existsSync(stagedDb)) {
      renameSync(stagedDb, join(this.dataDir, "vault-refs.db.new"));
    }

    // Clean up staging dir
    rmSync(stagingDir, { recursive: true, force: true });
  }

  close(): void {
    this.refStore.close();
  }
}
