/**
 * skills-engine — Phase 2: Versioned, signed, sandboxed tool bundles.
 *
 * Startup sequence:
 *   1. Load skill registry from disk (SKILLS_REGISTRY_PATH or default)
 *   2. Create sandbox gRPC client (connects to sandbox-runtime)
 *   3. Start SkillsService gRPC server on SKILLS_ADDR (default :19005)
 *
 * Each installed skill is verified with Ed25519 on every load.
 * Tool execution is delegated to sandbox-runtime (gVisor containers).
 */

import { SkillRegistry } from "./registry.js";
import { SandboxGrpcClient } from "./sandbox.client.js";
import { MarketplaceRegistry } from "./marketplace.js";
import { startSkillsGrpcServer } from "./grpc/server.js";

// ── Public API (for consumers / tests) ───────────────────────────────────

export { SkillRegistry } from "./registry.js";
export { verifySkillManifest, verifySkillManifestTrusted } from "./verifier.js";
export type { SkillVerificationResult } from "./verifier.js";
export type { InstalledSkill, InstallResult, RemoveResult } from "./registry.js";
export { SandboxGrpcClient } from "./sandbox.client.js";
export { MarketplaceRegistry } from "./marketplace.js";
export type { MarketplaceEntry, PublishResult } from "./marketplace.js";

// ── Entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { loadDotenv } = await import("@tessera/shared");
  loadDotenv();

  const { existsSync, renameSync } = await import("node:fs");

  const registryPath =
    process.env["SKILLS_REGISTRY_PATH"] ?? "/tmp/tessera-skills-registry.json";
  const marketplacePath =
    process.env["MARKETPLACE_REGISTRY_PATH"] ?? "/tmp/tessera-marketplace-registry.json";

  // Apply pending restore if present (written by RestoreState RPC)
  const pendingRegistry = registryPath + ".new";
  if (existsSync(pendingRegistry)) {
    renameSync(pendingRegistry, registryPath);
    process.stdout.write("[skills-engine] Applied pending restore: registry.json replaced\n");
  }
  const pendingMarketplace = marketplacePath + ".new";
  if (existsSync(pendingMarketplace)) {
    renameSync(pendingMarketplace, marketplacePath);
    process.stdout.write("[skills-engine] Applied pending restore: marketplace.json replaced\n");
  }

  process.stdout.write("[skills-engine] Starting Phase 2 skills engine\n");
  process.stdout.write(`[skills-engine] Registry path: ${registryPath}\n`);
  process.stdout.write(`[skills-engine] Marketplace path: ${marketplacePath}\n`);

  const registry = new SkillRegistry(registryPath);
  const marketplace = new MarketplaceRegistry(marketplacePath);
  const sandbox = new SandboxGrpcClient();

  const server = await startSkillsGrpcServer(registry, sandbox, marketplace);

  // Graceful shutdown
  const shutdown = (signal: string): void => {
    process.stdout.write(`[skills-engine] Received ${signal} — shutting down\n`);
    server.tryShutdown((err) => {
      if (err) {
        process.stderr.write(`[skills-engine] Shutdown error: ${String(err)}\n`);
        process.exit(1);
      }
      sandbox.close();
      process.stdout.write("[skills-engine] Shutdown complete\n");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.stdout.write(
    `[skills-engine] Ready. Skills installed: ${registry.size()}, Marketplace entries: ${marketplace.size()}\n`
  );
}

// Run when executed directly (not imported)
if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`[skills-engine] Fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
