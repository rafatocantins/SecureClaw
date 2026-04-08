export { AuditService } from "./audit.service.js";
export { ALERT_RULES } from "./alert-rules.js";
export { createAuditDatabase } from "./database/connection.js";
export { initSchema } from "./database/schema.js";
export { startAuditGrpcServer } from "./grpc/server.js";
export type { LogEventParams, LogEventResult, CostSummaryResult } from "./audit.service.js";
export type { AlertRule, AlertFinding, AlertContext } from "./alert-rules.js";

// ── Standalone server entry point ─────────────────────────────────────────
// Called when this package is run directly: node dist/index.js
const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  const { loadDotenv } = await import("@tessera/shared");
  loadDotenv();

  const { createAuditDatabase: createDb } = await import("./database/connection.js");
  const { initSchema: init } = await import("./database/schema.js");
  const { AuditService: Svc } = await import("./audit.service.js");
  const { startAuditGrpcServer: start } = await import("./grpc/server.js");

  const { existsSync, renameSync } = await import("node:fs");
  const { join } = await import("node:path");

  const dataDir = process.env["AUDIT_DATA_DIR"] ?? "/tmp/tessera-audit";
  const dbPath = join(dataDir, "audit.db");

  // Apply pending restore if present (written by RestoreState RPC)
  const pendingDb = dbPath + ".new";
  if (existsSync(pendingDb)) {
    renameSync(pendingDb, dbPath);
    process.stdout.write("[audit] Applied pending restore: audit.db replaced\n");
  }

  const db = createDb(dataDir);
  init(db);
  const costCapUsd = parseFloat(process.env["AUDIT_COST_CAP_USD"] ?? "5.0");
  const svc = new Svc(db, costCapUsd, dbPath);
  await start(svc);
  process.stdout.write("[audit] Service ready\n");
}
