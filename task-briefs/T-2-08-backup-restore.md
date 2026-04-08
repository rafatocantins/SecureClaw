# Task Brief: T-2-08 — Backup & Restore

**Phase:** 2C  
**Assignee:** backend-dev  
**Domain modules to load:** `CLAUDE-backend.md`  
**Security review required:** yes (touches credential-vault state and all persistent data)

---

## Goal

Let users snapshot and restore all Tessera persistent state with two CLI commands:

```
tessera backup create --output backup-2026-04-07.tar.gz
tessera backup restore --input backup-2026-04-07.tar.gz
```

Covers: credential-vault (`keys.enc.json` + `vault-refs.db`), audit DB, memory DB,
skills registry, marketplace registry.

---

## Architecture overview

```
CLI ──HTTP──▶ gateway
                 │
                 ├─gRPC──▶ credential-vault  DumpState / RestoreState
                 ├─gRPC──▶ audit-system      DumpState / RestoreState
                 ├─gRPC──▶ memory-store      DumpState / RestoreState
                 └─gRPC──▶ skills-engine     DumpState / RestoreState

gateway: packs responses into a tar.gz (backup) or
         distributes tar.gz entries to services (restore)
```

The CLI talks only to the gateway (existing pattern). The gateway orchestrates all
four services. Restore requires a tessera service restart to flush in-memory caches;
the CLI and gateway both emit a clear warning.

---

## Persistent state inventory

| Service | Env var | Default path | Files |
|---------|---------|-------------|-------|
| credential-vault | `VAULT_DATA_DIR` | `/tmp/tessera-vault` | `keys.enc.json`, `vault-refs.db` |
| audit-system | `AUDIT_DATA_DIR` | `/tmp/tessera-audit` | `audit.db` |
| memory-store | `MEMORY_DATA_DIR` | `/data/memory` | `memory.db` |
| skills-engine | `SKILLS_REGISTRY_PATH` | `/tmp/tessera-skills-registry.json` | (direct path) |
| skills-engine | `MARKETPLACE_REGISTRY_PATH` | `/tmp/tessera-marketplace-registry.json` | (direct path) |

---

## Archive format

```
tessera-backup/
  manifest.json                    # version, created_at, tessera_version, services[]
  credential-vault/
    keys.enc.json                  # AES-256-GCM encrypted — safe to store as-is
    vault-refs.db.sqlite3          # SQLite dump
  audit-system/
    audit.db.sqlite3               # SQLite dump
  memory-store/
    memory.db.sqlite3              # SQLite dump
  skills-engine/
    registry.json                  # raw JSON file
    marketplace.json               # raw JSON file
```

`manifest.json` schema:
```json
{
  "version": 1,
  "created_at": "2026-04-07T14:00:00.000Z",
  "tessera_version": "0.1.0",
  "services": ["credential-vault", "audit-system", "memory-store", "skills-engine"]
}
```

---

## Sub-tasks

| ID | Scope | What to build |
|----|-------|---------------|
| T-2-08a | all service packages | `DumpState` / `RestoreState` gRPC RPCs |
| T-2-08b | `packages/gateway` | HTTP backup/restore routes + orchestration |
| T-2-08c | `packages/cli` | `tessera backup create/restore` commands |

---

## T-2-08a — DumpState / RestoreState gRPC RPCs

### Proto additions (`packages/shared/src/proto/`)

Add to **each** of `vault.proto`, `audit.proto`, `memory.proto`, `skills.proto`:

```proto
// Dump service state for backup. Returns gzip-compressed bytes.
rpc DumpState(DumpStateRequest) returns (DumpStateResponse);

// Restore service state from a prior DumpState payload.
// The service writes to staging — a restart is required to complete the swap.
rpc RestoreState(RestoreStateRequest) returns (RestoreStateResponse);
```

Shared messages (add to `tessera.proto` or as top-level in each proto — your choice,
but keep consistent):

```proto
message DumpStateRequest {}

message DumpStateResponse {
  bytes data = 1;          // gzip-compressed archive of this service's files
  string checksum_sha256 = 2;  // hex SHA-256 of the uncompressed bytes (for verify)
  bool success = 3;
  string error_message = 4;
}

message RestoreStateRequest {
  bytes data = 1;          // same gzip-compressed archive from DumpState
  string checksum_sha256 = 2;
}

message RestoreStateResponse {
  bool success = 1;
  string error_message = 2;
  bool restart_required = 3;  // always true — caller must restart the service
}
```

Add matching `GrpcDumpState*` / `GrpcRestoreState*` TypeScript types to
`packages/shared/src/grpc/types.ts`.

---

### Implementation per service

#### credential-vault

**`DumpState`** (`packages/credential-vault/src/vault.service.ts`):

```ts
async dumpState(): Promise<{ data: Buffer; checksum: string }> {
  // 1. Read keys.enc.json as Buffer (or empty Buffer if file doesn't exist)
  // 2. Checkpoint vault-refs.db: this.refStore.checkpoint()  ← add this method
  // 3. Read vault-refs.db file as Buffer using readFileSync
  // 4. Pack both into an in-memory tar (use 'tar-stream' npm package — already add to package.json):
  //    tar entry "keys.enc.json" + tar entry "vault-refs.db"
  // 5. gzip the tar stream
  // 6. Return { data: gzipped Buffer, checksum: sha256hex(ungzipped) }
}
```

Add `checkpoint()` to `RefStore`:
```ts
checkpoint(): void {
  this.db.pragma("wal_checkpoint(FULL)");
}
```

**`RestoreState`** (`packages/credential-vault/src/vault.service.ts`):

```ts
async restoreState(data: Buffer, checksum: string): Promise<void> {
  // 1. Verify checksum
  // 2. Decompress + untar into a staging dir: <dataDir>/restore-staging/
  //    (create with mkdirSync, mode 0700)
  // 3. Write keys.enc.json to <dataDir>/restore-staging/keys.enc.json (mode 0600)
  // 4. Write vault-refs.db to <dataDir>/restore-staging/vault-refs.db
  // 5. Atomic renames: staging/keys.enc.json → keys.enc.json
  //                    staging/vault-refs.db  → vault-refs.db.new
  //    (do NOT replace the live vault-refs.db in place — the connection is open)
  //    Instead flag the service: this._pendingRestore = true
  //    On next start, the service's index.ts checks for vault-refs.db.new and renames it.
  // 6. Return (restart_required: true)
}
```

**index.ts startup migration** (`packages/credential-vault/src/index.ts`):
```ts
// After dataDir is known, before starting VaultService:
const pending = join(dataDir, "vault-refs.db.new");
if (existsSync(pending)) {
  renameSync(pending, join(dataDir, "vault-refs.db"));
  process.stdout.write("[vault] Applied pending restore: vault-refs.db replaced\n");
}
```

---

#### audit-system

**`DumpState`**: Checkpoint `audit.db` with `PRAGMA wal_checkpoint(FULL)`, then read the
file as bytes, gzip it, return with SHA-256.

Add `getDbPath(): string` to `AuditService` (returns the path passed at construction).

**`RestoreState`**: Write the incoming bytes to `<dataDir>/audit.db.new`. On next start,
`index.ts` checks for and applies it (same pattern as vault). **IMPORTANT**: the audit DB
has append-only triggers that BLOCK DELETE/UPDATE — do NOT try to merge; just replace the
file on the next restart.

Add `getDbPath()` to `AuditService` so the gRPC handler can find the file.

---

#### memory-store

Same pattern as audit-system:
- `DumpState`: `PRAGMA wal_checkpoint(FULL)` + read `memory.db` file + gzip + SHA-256.
- `RestoreState`: write to `memory.db.new`; startup migration applies it.

Add `getDbPath(): string` to `MemoryService`.

---

#### skills-engine

**`DumpState`**: Read both JSON files, pack into a two-entry tar, gzip.

**`RestoreState`**: Decompress + untar into staging. Write `registry.json.new` and
`marketplace.json.new` next to the live files. Startup migration in `index.ts` renames
them.

Expose `getRegistryPath()` and `getMarketplacePath()` on `SkillRegistry` and
`MarketplaceRegistry` respectively.

---

### gRPC handlers

Add `DumpState` and `RestoreState` handlers to each `*.impl.ts` following the same
promise-wrapping pattern as existing handlers. No new files needed — just additional
methods in the existing `make*Impl()` factory functions.

---

### Tests to add (per package)

Each service needs:
- `dumpState`: returns non-empty gzipped bytes; checksum matches content.
- `dumpState`: works on empty store (no files yet) — returns empty tar, no throw.
- `restoreState`: staging files are written; `.new` files exist after call.
- `restoreState`: bad checksum throws.
- Startup migration: `.new` file is renamed on init when present.

---

## T-2-08b — Gateway routes

### New file: `packages/gateway/src/routes/backup.route.ts`

#### `POST /api/v1/backup/create`

- **Auth**: `verifyToken` preHandler.
- **Rate limit**: max 2 per 10 minutes (large operation).
- **Body**: none.
- **Response**: binary stream (`application/gzip`), `Content-Disposition: attachment; filename="tessera-backup-<iso8601>.tar.gz"`.

Implementation:
1. Call `vaultClient.dumpState()`, `auditClient.dumpState()`, `memoryClient.dumpState()`, `skillsClient.dumpState()` in parallel (`Promise.all`).
2. Build the outer tar.gz in-memory:
   - `tessera-backup/manifest.json`
   - `tessera-backup/credential-vault/<tar from vault>` (the service already returns a gzipped tar — store it as a named blob)
   - repeat for other services
3. Send the tar.gz as the response body.

**Do not log DumpState payloads** — they contain encrypted vault data.

#### `POST /api/v1/backup/restore`

- **Auth**: `verifyToken` preHandler.
- **Rate limit**: max 1 per 10 minutes.
- **Body**: multipart/form-data or `application/octet-stream` upload of the tar.gz.
  Use Fastify's `@fastify/multipart` (already in the project? check first).
  If not available, accept `application/octet-stream` with a size limit of 100MB.
- **Response**: `200 { restored_services: string[], restart_required: true, message: string }`.

Implementation:
1. Parse the incoming tar.gz, extract per-service blobs.
2. Verify `manifest.json` version field is `1` — reject unknown versions with `400`.
3. Call each service's `restoreState()` in sequence (not parallel — vault first, then others).
4. Collect results. If any service fails, continue with the others (partial restore is better
   than no restore), but include failures in the response.
5. Emit audit event `BACKUP_RESTORED` with `{ services: [...], partial: boolean }`.
6. Return `{ restored_services, restart_required: true, message: "Restart tessera services to complete restore." }`.

---

### gRPC client additions

Add `dumpState()` and `restoreState(data, checksum)` to each existing gRPC client in
`packages/gateway/src/grpc/`:
- `vault.client.ts`
- `audit.client.ts`
- `memory.client.ts`
- `skills.client.ts`

Follow the same promise-wrapping pattern as existing methods.

---

### Register route

In `packages/gateway/src/app.ts`, register the backup route under prefix `/api/v1/backup`.

---

### Tests (`backup.route.test.ts`)

- `POST /api/v1/backup/create` 200: mocked services return dummy bytes → response is binary.
- `POST /api/v1/backup/create` 401: no token.
- `POST /api/v1/backup/restore` 200: valid archive → restored_services list returned.
- `POST /api/v1/backup/restore` 400: bad archive (missing manifest) → error.
- `POST /api/v1/backup/restore` 400: manifest version mismatch.
- `POST /api/v1/backup/restore` 207: one service fails → partial restore, others succeed.

---

## T-2-08c — CLI commands

**File:** `packages/cli/src/commands/backup.ts` (new file)

```ts
export function backupCommand(): Command {
  const backup = new Command("backup").description(
    "Create or restore a full Tessera state backup"
  );

  // ── create ────────────────────────────────────────────────────────────────
  addCommonOpts(
    backup
      .command("create")
      .description("Dump all service state to a local .tar.gz file")
      .requiredOption("-o, --output <path>", "Output file path (e.g. backup-2026-04-07.tar.gz)")
  ).action(async (opts) => {
    const token = resolveToken(opts);
    process.stdout.write("creating backup...\n");
    // POST /api/v1/backup/create → stream binary to file
    // Use Node's http module or fetch with streaming to write the response body
    // to the output file path without buffering the whole thing in memory.
    // Print: "backup saved to <path> (<size> bytes)"
  });

  // ── restore ───────────────────────────────────────────────────────────────
  addCommonOpts(
    backup
      .command("restore")
      .description("Restore all service state from a local .tar.gz backup file")
      .requiredOption("-i, --input <path>", "Input backup file path")
      .option("--yes", "Skip confirmation prompt")
  ).action(async (opts) => {
    const token = resolveToken(opts);

    if (!opts.yes) {
      // Print warning and require explicit confirmation:
      // "WARNING: This will overwrite all service state. Type 'yes' to continue: "
      const line = await promptLine();
      if (line.trim() !== "yes") {
        process.stdout.write("aborted\n");
        process.exit(0);
      }
    }

    // POST /api/v1/backup/restore with the file as the body
    // Print each service name as it's restored
    // Print: "ACTION REQUIRED: restart tessera services to complete restore"
  });

  return backup;
}
```

Register `backupCommand()` in `packages/cli/src/bin.ts`.

### Streaming upload helper

The restore command needs to stream a potentially large file to the gateway without
reading it all into memory. Add a helper `streamFileUpload(url, token, filePath)` to
`packages/cli/src/http.ts` that uses Node's `http`/`https` modules with a
`createReadStream`.

---

## Acceptance criteria

- [ ] `pnpm --filter @tessera/credential-vault test` — green, including new dump/restore tests.
- [ ] `pnpm --filter @tessera/audit-system test` — green.
- [ ] `pnpm --filter @tessera/memory-store test` — green.
- [ ] `pnpm --filter @tessera/skills-engine test` — green.
- [ ] `pnpm --filter @tessera/gateway test` — green, including new backup route tests.
- [ ] `pnpm -r build` — clean compile.
- [ ] Test count does not decrease from 435.
- [ ] `tessera backup create --output /tmp/test.tar.gz` produces a valid tar.gz with manifest + 4 service blobs.
- [ ] `tessera backup restore --input /tmp/test.tar.gz --yes` calls the gateway restore route and prints the restart notice.
- [ ] No vault key material appears anywhere in logs, audit events, or response bodies.

---

## File map

| File | Action |
|------|--------|
| `packages/shared/src/proto/vault.proto` | Add `DumpState` / `RestoreState` RPC + messages |
| `packages/shared/src/proto/audit.proto` | Same |
| `packages/shared/src/proto/memory.proto` | Same |
| `packages/shared/src/proto/skills.proto` | Same |
| `packages/shared/src/grpc/types.ts` | Add `GrpcDumpState*` / `GrpcRestoreState*` types |
| `packages/credential-vault/src/vault.service.ts` | `dumpState()` + `restoreState()` |
| `packages/credential-vault/src/ref-store.ts` | `checkpoint()` method |
| `packages/credential-vault/src/grpc/vault.impl.ts` | `DumpState` + `RestoreState` handlers |
| `packages/credential-vault/src/index.ts` | Startup pending-restore migration |
| `packages/audit-system/src/audit.service.ts` | `dumpState()` + `restoreState()` + `getDbPath()` |
| `packages/audit-system/src/grpc/audit.impl.ts` | Handlers |
| `packages/audit-system/src/index.ts` | Startup migration |
| `packages/memory-store/src/memory.service.ts` | `dumpState()` + `restoreState()` + `getDbPath()` |
| `packages/memory-store/src/grpc/memory.impl.ts` | Handlers |
| `packages/memory-store/src/index.ts` | Startup migration |
| `packages/skills-engine/src/registry.ts` | `dumpState()` + `restoreState()` + `getRegistryPath()` |
| `packages/skills-engine/src/marketplace.ts` | Same for marketplace |
| `packages/skills-engine/src/grpc/skills.impl.ts` | Handlers |
| `packages/skills-engine/src/index.ts` | Startup migration |
| `packages/gateway/src/grpc/vault.client.ts` | `dumpState()` + `restoreState()` |
| `packages/gateway/src/grpc/audit.client.ts` | Same |
| `packages/gateway/src/grpc/memory.client.ts` | Same |
| `packages/gateway/src/grpc/skills.client.ts` | Same |
| `packages/gateway/src/routes/backup.route.ts` | New file |
| `packages/gateway/src/routes/backup.route.test.ts` | New file |
| `packages/gateway/src/app.ts` | Register `/api/v1/backup` prefix |
| `packages/cli/src/commands/backup.ts` | New file |
| `packages/cli/src/http.ts` | `streamFileUpload()` helper |
| `packages/cli/src/bin.ts` | Register `backupCommand()` |

---

## Implementation order

1. **T-2-08a** — proto changes + all 4 service implementations (can do in parallel per service, but proto must come first so types compile).
2. **T-2-08b** — gateway routes (depends on service gRPC clients having `dumpState`/`restoreState`).
3. **T-2-08c** — CLI (depends on the gateway route existing).

Run `pnpm -r build` after T-2-08a and again after each subsequent sub-task.

---

## Dependencies to add

Check if `tar-stream` is already in the monorepo. If not, add it to the packages that need it:
```
pnpm --filter @tessera/credential-vault add tar-stream
pnpm --filter @tessera/gateway add tar-stream
```
`tar-stream` is a streaming tar parser/packer that works well in Node ESM with no native bindings.

---

## Security notes

- The backup archive contains the **encrypted** vault file (`keys.enc.json`) — the raw
  secrets are never exposed, but the archive is sensitive because it includes all
  credential references and encrypted secrets. Document this in CLI output.
- `restoreState` on the vault must verify the checksum before writing any files.
- The gateway restore route must enforce a body size limit (100MB) to prevent DoS.
- Never log the raw bytes of a `DumpState` or `RestoreState` payload.
- Audit event `BACKUP_CREATED` (on create) and `BACKUP_RESTORED` (on restore) must be emitted.
  Both events must include `{ services, size_bytes }` but NOT the data bytes themselves.
