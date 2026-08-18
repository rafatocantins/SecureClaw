export { VaultService } from "./vault.service.js";
export { createKeychainAdapter, KEYCHAIN_SERVICE_PREFIX } from "./keychain.adapter.js";
export { RefStore } from "./ref-store.js";
export { injectCredential, injectAllCredentials } from "./injector.js";
export { scanDirectory } from "./scanner.js";
export { startVaultGrpcServer } from "./grpc/server.js";
export type { KeychainAdapter } from "./keychain.adapter.js";
export type { SecretRef } from "./ref-store.js";

// ── Standalone server entry point ─────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const { loadDotenv, replaceFileSync } = await import("@tessera/shared");
  loadDotenv();

  const { VaultService: Svc } = await import("./vault.service.js");
  const { startVaultGrpcServer: start } = await import("./grpc/server.js");

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const dataDir = process.env["VAULT_DATA_DIR"] ?? "/tmp/tessera-vault";

  // Apply pending restore if present (written by RestoreState RPC)
  const pendingDb = join(dataDir, "vault-refs.db.new");
  if (existsSync(pendingDb)) {
    replaceFileSync(pendingDb, join(dataDir, "vault-refs.db"));
    process.stdout.write("[vault] Applied pending restore: vault-refs.db replaced\n");
  }

  const svc = new Svc(dataDir);
  await start(svc);
  process.stdout.write("[vault] Service ready\n");
}
