# Task Brief: T-2-07 — Vault Key Rotation

**Phase:** 2B  
**Assignee:** backend-dev  
**Domain modules to load:** `CLAUDE-backend.md`  
**Security review required:** yes (touches `packages/credential-vault` and `packages/gateway`)

---

## Goal

Add the ability to rotate the master encryption key of the file-based vault backend without
any credential loss. Today `keys.enc.json` is a flat `Record<string, string>` with no
versioning — a rotated key silently fails to decrypt entries, leaving credentials
inaccessible with no error message. This task fixes that and adds the rotation workflow.

Rotation applies **only to the encrypted-file backend** (headless Linux / WSL / CI).
When keytar is active (OS keychain), `rotate-key` must print a clear error explaining
that the OS manages key material and exit with code 1.

---

## Sub-tasks

| ID | Scope | What to build |
|----|-------|---------------|
| T-2-07a | `packages/credential-vault` | Key versioning in the file store |
| T-2-07b | `packages/credential-vault` | `rotateKey()` on `VaultService` + gRPC RPC |
| T-2-07c | `packages/gateway` | HTTP route + gRPC client method |
| T-2-07d | `packages/cli` | `tessera vault rotate-key` CLI command |

---

## T-2-07a — Key versioning in the file store

**File:** `packages/credential-vault/src/keychain.adapter.ts`

### Current state

```ts
type EncryptedStore = Record<string, string>;
```

`loadStore` / `saveStore` read/write this flat shape directly.
`deriveKey()` computes `SHA-256(VAULT_MASTER_KEY)` but never persists any identifier
alongside the ciphertext, so a wrong key silently returns `null` from `decryptValue`.

### Target shape

```ts
interface VersionedStore {
  v: 1;
  key_id: string;      // first 16 hex chars of SHA-256(VAULT_MASTER_KEY) — enough to detect mismatch, not enough to brute-force the key
  entries: Record<string, string>;  // same format as today: "iv:tag:ct" hex strings
}
```

### Changes required

1. **`deriveKeyId(key: Buffer): string`** — new helper.
   `createHash('sha256').update(key).digest('hex').slice(0, 16)`.

2. **`loadStore`** — read the file; if it parses as `VersionedStore` (has `v` field), use it.
   If it parses as a legacy flat `Record<string, string>`, wrap it in the versioned shape
   (with `key_id` derived from the current key) and save immediately so the migration is
   one-way.  
   After migration/load: **compare `stored.key_id` with `deriveKeyId(currentKey)`**.
   If they differ, throw:
   ```
   Error("vault key mismatch: file was encrypted with a different key. " +
         "Run `tessera vault rotate-key --new-key <hex>` to re-encrypt.")
   ```

3. **`saveStore`** — always writes the `VersionedStore` shape with the current `key_id`.

4. Update the `EncryptedStore` type alias to `VersionedStore` throughout the adapter.
   The `get`, `set`, `delete`, `findAll` methods access `store.entries[key]` instead of
   `store[key]`.

5. **No changes to `deriveKey()`** — the derivation algorithm stays the same.

### Tests to add (`keychain.adapter.test.ts`)

- Legacy flat file is transparently migrated on first `set()`.
- Mismatched key_id throws with the expected message (not silently returns null).
- Round-trip: `set` then `get` with same key returns the value.
- Round-trip: `set` then `get` with different key throws key-mismatch error.

---

## T-2-07b — `rotateKey()` on VaultService + gRPC RPC

### `packages/credential-vault/src/keychain.adapter.ts`

Export a new function (not on the `KeychainAdapter` interface — it's a file-level
operation, not per-service):

```ts
/**
 * Re-encrypts every entry in the file store from oldKey to newKey atomically.
 * Throws if the file's key_id does not match oldKey.
 * No-op (returns 0) when keytar is active.
 */
export async function rotateFileStoreKey(
  oldMasterKey: string,
  newMasterKey: string,
): Promise<{ rotated: number }>;
```

Implementation:

1. If `_keytar !== null` → throw `Error("key rotation is not supported for OS keychain backends")`.
2. Derive `oldKey = SHA-256(oldMasterKey)` and `newKey = SHA-256(newMasterKey)`.
3. Load the versioned store; verify `key_id` matches `deriveKeyId(oldKey)` (throw if not).
4. For each entry in `entries`: decrypt with `oldKey`, re-encrypt with `newKey`.
   If any entry fails to decrypt → abort and throw (do not write a partial file).
5. Write the re-encrypted store atomically:
   - Write to `<filePath>.tmp` (mode 0600).
   - `renameSync(tmpPath, filePath)` — atomic on POSIX; best-effort on Windows.
6. Return `{ rotated: N }` where N is the count of re-encrypted entries.

### `packages/credential-vault/src/vault.service.ts`

Add method:

```ts
async rotateKey(oldMasterKey: string, newMasterKey: string): Promise<{ rotated: number }>;
```

Delegates to `rotateFileStoreKey`. No keychain adapter instance needed here — it's a
file-level operation. Import `rotateFileStoreKey` directly.

### `packages/shared/src/proto/vault.proto`

Add to `VaultService`:

```proto
rpc RotateKey(RotateKeyRequest) returns (RotateKeyResponse);
```

Add messages:

```proto
message RotateKeyRequest {
  string old_master_key = 1;
  string new_master_key = 2;
}

message RotateKeyResponse {
  bool success = 1;
  int32 rotated_count = 2;
  string error_message = 3;
}
```

Add matching TypeScript types to `packages/shared/src/grpc/vault-types.ts` (or wherever
the other `Grpc*` types live).

### `packages/credential-vault/src/grpc/vault.impl.ts`

Add `RotateKey` handler following the same pattern as `SetSecret`.

### Tests to add (`vault.service.test.ts`)

- `rotateKey`: re-encrypts all entries; entries readable with new key after rotation.
- `rotateKey`: wrong old key throws.
- `rotateKey`: partial failure (corrupted entry) aborts without touching the file.

---

## T-2-07c — Gateway HTTP route + gRPC client method

### `packages/gateway/src/grpc/vault.client.ts`

Add:

```ts
rotateKey(oldMasterKey: string, newMasterKey: string): Promise<{ rotated_count: number }>;
```

Pattern: same promise-wrapping style as `setSecret`.

### New file: `packages/gateway/src/routes/vault-admin.route.ts`

```
POST /api/v1/vault/rotate-key
```

- **Auth**: `verifyToken` preHandler (same as `credentials.route.ts`).
- **Body schema** (Zod):
  ```ts
  const RotateKeyBody = z.object({
    old_master_key: z.string().min(1),
    new_master_key: z.string().min(1),
  });
  ```
- **Rate limit**: max 3 per minute (this is an admin operation, not a hot path).
- **On success**: respond `200 { rotated_count: N }`.
- **On vault error**: `502 { error: "vault_unavailable" }`.
- **Audit log**: emit an audit event `VAULT_KEY_ROTATED` with `{ rotated_count }` (no key
  material in the log).

Register the route in `packages/gateway/src/app.ts` under prefix `/api/v1/vault`.

### Security review checklist (include in PR)

- [ ] No key material appears in log output (Fastify logger must not serialize `body`).
  Add `{ config: { noBodyLog: true } }` or strip keys in a `onSend` hook.
- [ ] Confirm `verifyToken` is enforced (no public access).
- [ ] Rate limit is 3/min (not the default 30).
- [ ] Audit event written even on failure.
- [ ] `old_master_key` and `new_master_key` are not returned in any response field.

### Tests to add (`vault-admin.route.test.ts`)

- 200 path: mocked vault client returns `{ rotated_count: 5 }` → response matches.
- 400: missing body fields.
- 401: no token.
- 502: vault client throws → route returns `vault_unavailable`.

---

## T-2-07d — CLI command

**File:** `packages/cli/src/commands/vault.ts`

Add a new subcommand inside `vaultCommand()`:

```
tessera vault rotate-key --new-key <hex>
```

Options:
- `--new-key <hex>` (required) — the new master key as a hex or plain string.
- `--old-key <hex>` (optional) — if omitted, read `VAULT_MASTER_KEY` from the environment.
- `-t / --token`, `--url` — same common opts as other vault commands.

Implementation:

```ts
addCommonOpts(
  vault
    .command("rotate-key")
    .description(
      "Re-encrypt all vault entries with a new master key (file backend only). " +
      "After rotation, update VAULT_MASTER_KEY to the new value."
    )
    .requiredOption("--new-key <hex>", "New master key (hex string or passphrase)")
    .option("--old-key <hex>", "Old master key (defaults to $VAULT_MASTER_KEY)")
).action(async (opts) => {
  const token = resolveToken(opts);
  const oldKey = opts.oldKey ?? process.env["VAULT_MASTER_KEY"];
  if (!oldKey) {
    process.stderr.write("error: --old-key or VAULT_MASTER_KEY required\n");
    process.exit(1);
  }
  try {
    const res = await apiPost(
      `${opts.url}/api/v1/vault/rotate-key`,
      token,
      { old_master_key: oldKey, new_master_key: opts.newKey }
    ) as { body: { rotated_count: number } };
    process.stdout.write(
      `key rotation complete: ${res.body.rotated_count} entries re-encrypted\n`
    );
    process.stdout.write(
      "ACTION REQUIRED: update VAULT_MASTER_KEY to the new value and restart tessera vault\n"
    );
  } catch (err) {
    printApiError(err);
    process.exit(1);
  }
});
```

---

## Acceptance criteria

- [ ] `pnpm --filter @tessera/credential-vault test` — all tests green, including new ones.
- [ ] `pnpm --filter @tessera/gateway test` — all tests green, including new route tests.
- [ ] `pnpm -r build` — clean compile, no new TypeScript errors.
- [ ] Total test count does not decrease (currently 410).
- [ ] `tessera vault rotate-key --new-key abc --old-key xyz` hits the route and prints the
      success message.
- [ ] Running with keytar active returns a clear error, not a crash.
- [ ] No key material in `pnpm --filter @tessera/credential-vault test` output or gateway
      access logs.

---

## File map

| File | Action |
|------|--------|
| `packages/shared/src/proto/vault.proto` | Add `RotateKey` RPC + messages |
| `packages/shared/src/grpc/vault-types.ts` | Add `GrpcRotateKey*` types |
| `packages/credential-vault/src/keychain.adapter.ts` | Versioned store + `rotateFileStoreKey` |
| `packages/credential-vault/src/vault.service.ts` | `rotateKey()` method |
| `packages/credential-vault/src/grpc/vault.impl.ts` | `RotateKey` gRPC handler |
| `packages/credential-vault/src/keychain.adapter.test.ts` | New (or extend existing) |
| `packages/credential-vault/src/vault.service.test.ts` | New rotation tests |
| `packages/gateway/src/grpc/vault.client.ts` | `rotateKey()` client method |
| `packages/gateway/src/routes/vault-admin.route.ts` | New file |
| `packages/gateway/src/app.ts` | Register `/api/v1/vault` prefix |
| `packages/gateway/src/routes/vault-admin.route.test.ts` | New file |
| `packages/cli/src/commands/vault.ts` | `rotate-key` subcommand |

---

## Implementation order

1. **T-2-07a** (versioned store) — foundational, no other sub-task compiles without it.
2. **T-2-07b** (VaultService + proto + gRPC handler) — depends on T-2-07a.
3. **T-2-07c** (gateway route) — depends on T-2-07b (new vault client method).
4. **T-2-07d** (CLI) — depends on T-2-07c (route must exist to hit).

Run `pnpm -r build` after each sub-task before starting the next.

---

## Security notes

- **Never log key material.** `old_master_key` / `new_master_key` must never appear in
  `fastify.log`, `process.stderr`, or audit event payloads. Treat them like passwords.
- The gateway route body must not be serialised in access logs. Use Fastify's
  `redact` option or ensure the route config suppresses body logging.
- The `key_id` stored in `keys.enc.json` is safe to have on disk (it's a 16-char prefix
  of the SHA-256 of the master key hash — not reversible to the key itself).
- `rotateFileStoreKey` must be atomic. A crash mid-rotation must leave the original file
  intact (write to `.tmp`, then `rename`).
