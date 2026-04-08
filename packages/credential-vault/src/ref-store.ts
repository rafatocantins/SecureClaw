/**
 * ref-store.ts — SQLite store mapping opaque ref_id → {service, account}.
 *
 * The ref_id is what external code (LLM, gateway, agent-runtime) uses.
 * The actual {service, account} is only used here to look up the secret
 * from the keychain. Raw values are NEVER stored in SQLite.
 */
import Database from "better-sqlite3";
import { randomUuid, nowUtcIso } from "@tessera/shared";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface SecretRef {
  ref_id: string;
  service: string;
  account: string;
  created_at: string;
}

export class RefStore {
  private db: Database.Database;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "vault-refs.db"), {
      fileMustExist: false,
    });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secret_refs (
        ref_id     TEXT PRIMARY KEY,
        service    TEXT NOT NULL,
        account    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(service, account)
      ) STRICT;
    `);
  }

  /** Create or replace a ref for the given service+account pair */
  upsertRef(service: string, account: string): string {
    const existing = this.db
      .prepare<[string, string], { ref_id: string }>(
        "SELECT ref_id FROM secret_refs WHERE service = ? AND account = ?"
      )
      .get(service, account);

    if (existing) {
      return existing.ref_id;
    }

    const ref_id = randomUuid();
    this.db
      .prepare(
        "INSERT INTO secret_refs (ref_id, service, account, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(ref_id, service, account, nowUtcIso());

    return ref_id;
  }

  /** Retrieve a ref by its ID */
  getRef(refId: string): SecretRef | null {
    return (
      this.db
        .prepare<[string], SecretRef>(
          "SELECT ref_id, service, account, created_at FROM secret_refs WHERE ref_id = ?"
        )
        .get(refId) ?? null
    );
  }

  /** Find the ref for a service+account pair */
  findRef(service: string, account: string): SecretRef | null {
    return (
      this.db
        .prepare<[string, string], SecretRef>(
          "SELECT ref_id, service, account, created_at FROM secret_refs WHERE service = ? AND account = ?"
        )
        .get(service, account) ?? null
    );
  }

  /** List all refs (no values) */
  listRefs(): SecretRef[] {
    return this.db
      .prepare<[], SecretRef>(
        "SELECT ref_id, service, account, created_at FROM secret_refs ORDER BY created_at DESC"
      )
      .all();
  }

  /** Delete a ref (called when the secret is deleted from keychain) */
  deleteRef(service: string, account: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM secret_refs WHERE service = ? AND account = ?"
      )
      .run(service, account);
    return result.changes > 0;
  }

  /** Force a WAL checkpoint so the main DB file is fully up-to-date on disk. */
  checkpoint(): void {
    this.db.pragma("wal_checkpoint(FULL)");
  }

  /** Return the path to the SQLite database file. */
  getDbPath(): string {
    return join(this.dataDir, "vault-refs.db");
  }

  close(): void {
    this.db.close();
  }
}
