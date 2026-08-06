export { SandboxService } from "./sandbox.service.js";
export { ContainerManager } from "./container-manager.js";
export { detectRuntime } from "./runtime-detector.js";
export { buildHardenedContainerOptions } from "./container-config.js";
export { startSandboxGrpcServer } from "./grpc/server.js";
export type { RuntimeInfo } from "./runtime-detector.js";
export type { ToolRunResult } from "./container-manager.js";
export type { RunToolParams } from "./sandbox.service.js";
export type { ContainerBuildConfig } from "./container-config.js";

// ── Standalone server entry point ─────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const { loadDotenv } = await import("@tessera/shared");
  loadDotenv();

  const { SandboxService: Svc } = await import("./sandbox.service.js");
  const { startSandboxGrpcServer: start } = await import("./grpc/server.js");

  const svc = new Svc();

  // Start gRPC server immediately so the health check can succeed.
  // Docker connectivity is probed in the background — the service
  // accepts connections right away and lazily initializes on first tool call.
  await start(svc);
  process.stdout.write("[sandbox] Service ready\n");

  // Probe Docker/gVisor availability in background for diagnostics.
  // Failures here are non-fatal: each RunTool call re-checks lazily.
  svc.initialize()
    .then((runtimeInfo) => {
      process.stdout.write(
        `[sandbox] Runtime: ${runtimeInfo.runtime_name} (gVisor: ${runtimeInfo.gvisor_available})\n`
      );
    })
    .catch((err) => {
      process.stderr.write(
        `[sandbox] Runtime init failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    });
}
