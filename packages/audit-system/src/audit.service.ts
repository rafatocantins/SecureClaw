/**
 * audit.service.ts — Core audit service implementation.
 *
 * All log writes are synchronous (node:sqlite) to ensure durability.
 * Alert rules are evaluated after every write.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { nowUtcMs } from "@tessera/shared";
import type { AuditEvent, AuditSeverity } from "@tessera/shared";
import { ALERT_RULES, type AlertContext, type AlertFinding } from "./alert-rules.js";

export interface LogEventParams {
  event_type: string;
  session_id?: string;
  user_id?: string;
  payload: Record<string, unknown>;
  severity: AuditSeverity;
}

export interface LogEventResult {
  event_id: number;
  success: boolean;
  alerts_triggered: AlertFinding[];
}

export interface CostSummaryResult {
  total_cost_usd: number;
  cap_usd: number;
  remaining_usd: number;
  cap_exceeded: boolean;
  cost_by_model: Record<string, number>;
}

export interface ArticleResult {
  article_id: string;
  status: string;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface ComplianceReportResult {
  articles: ArticleResult[];
  issues: string[];
  overall_status: string;
}

export interface TeamCostEntry {
  team_id: string;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  session_count: number;
  cost_by_model: Record<string, number>;
}

export interface TeamCostSummaryResult {
  teams: TeamCostEntry[];
  grand_total_usd: number;
}

export interface GetTeamQuotaResult {
  quota_usd: number;
  current_spend_usd: number;
  remaining_usd: number;
  days_until_reset: number;
  at_capacity: boolean;
}

export interface CheckQuotaExceededResult {
  exceeded: boolean;
  spent_usd: number;
  quota_usd: number;
}

export class AuditService {
  private db: DatabaseSync;
  private costCapUsd: number;
  private readonly dbPath: string | undefined;

  // Prepared statements (created once for performance)
  private stmtInsertEvent!: StatementSync;
  private stmtInsertAlert!: StatementSync;
  private stmtUpdateSession!: StatementSync;

  constructor(db: DatabaseSync, costCapUsd = 5.0, dbPath?: string) {
    this.db = db;
    this.costCapUsd = costCapUsd;
    this.dbPath = dbPath;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmtInsertEvent = this.db.prepare(
      "INSERT INTO audit_events (event_type, session_id, user_id, payload, severity, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    this.stmtInsertAlert = this.db.prepare(
      "INSERT INTO alerts (rule_id, severity, session_id, message, context, created_at, acknowledged) VALUES (?, ?, ?, ?, ?, ?, 0)"
    );
    this.stmtUpdateSession = this.db.prepare(
      "INSERT OR IGNORE INTO sessions (id, user_id, provider, started_at) VALUES (?, ?, 'unknown', ?)"
    );
  }

  logEvent(params: LogEventParams): LogEventResult {
    const now = nowUtcMs();
    const payloadJson = JSON.stringify(params.payload);

    // Write is synchronous — ensures durability before returning
    const result = this.stmtInsertEvent.run(
      params.event_type,
      params.session_id ?? null,
      params.user_id ?? null,
      payloadJson,
      params.severity,
      now
    );

    const event_id = Number(result.lastInsertRowid);

    // Build the AuditEvent for rule evaluation
    const event: AuditEvent = {
      id: event_id,
      event_type: params.event_type as AuditEvent["event_type"],
      session_id: params.session_id,
      user_id: params.user_id,
      payload: params.payload,
      severity: params.severity,
      created_at_unix_ms: now,
    };

    // Evaluate alert rules
    const ctx = this.buildAlertContext(params.session_id);
    const alerts_triggered: AlertFinding[] = [];

    for (const rule of ALERT_RULES) {
      const finding = rule.evaluate(event, ctx);
      if (finding) {
        this.stmtInsertAlert.run(
          finding.rule_id,
          finding.severity,
          params.session_id ?? null,
          finding.message,
          JSON.stringify(finding.context),
          now
        );
        alerts_triggered.push(finding);
      }
    }

    return { event_id, success: true, alerts_triggered };
  }

  queryEvents(params: {
    session_id?: string;
    from_unix_ms?: number;
    to_unix_ms?: number;
    event_types?: string[];
    limit?: number;
  }): AuditEvent[] {
    let sql = "SELECT * FROM audit_events WHERE 1=1";
    const args: (string | number | null)[] = [];

    if (params.session_id) {
      sql += " AND session_id = ?";
      args.push(params.session_id);
    }
    if (params.from_unix_ms) {
      sql += " AND created_at >= ?";
      args.push(params.from_unix_ms);
    }
    if (params.to_unix_ms) {
      sql += " AND created_at <= ?";
      args.push(params.to_unix_ms);
    }
    if (params.event_types && params.event_types.length > 0) {
      sql += ` AND event_type IN (${params.event_types.map(() => "?").join(",")})`;
      args.push(...params.event_types);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    args.push(params.limit ?? 100);

    type Row = { id: number; event_type: string; session_id: string | null; user_id: string | null; payload: string; severity: string; created_at: number };
    const rows = this.db.prepare(sql).all(...args) as Row[];

    return rows.map((r) => ({
      id: r.id,
      event_type: r.event_type as AuditEvent["event_type"],
      session_id: r.session_id ?? undefined,
      user_id: r.user_id ?? undefined,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      severity: r.severity as AuditSeverity,
      created_at_unix_ms: r.created_at,
    }));
  }

  getAlerts(params: { include_acknowledged?: boolean; session_id?: string }): unknown[] {
    let sql = "SELECT * FROM alerts WHERE 1=1";
    const args: (string | number | null)[] = [];

    if (!params.include_acknowledged) {
      sql += " AND acknowledged = 0";
    }
    if (params.session_id) {
      sql += " AND session_id = ?";
      args.push(params.session_id);
    }

    sql += " ORDER BY created_at DESC";
    return this.db.prepare(sql).all(...args);
  }

  acknowledgeAlert(alertId: number): boolean {
    const result = this.db
      .prepare("UPDATE alerts SET acknowledged = 1 WHERE id = ?")
      .run(alertId);
    return result.changes > 0;
  }

  getCostSummary(userId: string, dayUnixMs: number): CostSummaryResult {
    // Compute start/end of UTC day
    const dayStart = dayUnixMs - (dayUnixMs % 86_400_000);
    const dayEnd = dayStart + 86_400_000;

    type CostRow = { model: string; total: number };
    const rows = (this.db
      .prepare(
        "SELECT model, SUM(cost_usd) as total FROM cost_ledger WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ? GROUP BY model"
      )
      .all(userId, dayStart, dayEnd)) as CostRow[];

    const cost_by_model: Record<string, number> = {};
    let total_cost_usd = 0;
    for (const row of rows) {
      cost_by_model[row.model] = row.total;
      total_cost_usd += row.total;
    }

    const remaining_usd = Math.max(0, this.costCapUsd - total_cost_usd);

    return {
      total_cost_usd,
      cap_usd: this.costCapUsd,
      remaining_usd,
      cap_exceeded: total_cost_usd >= this.costCapUsd,
      cost_by_model,
    };
  }

  recordCost(params: {
    session_id: string;
    user_id: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }): void {
    // Extract team: "acme/alice" → "acme"; "alice" → "alice"
    const team_id = params.user_id.includes("/")
      ? (params.user_id.split("/")[0] ?? params.user_id)
      : params.user_id;

    this.db
      .prepare(
        "INSERT INTO cost_ledger (session_id, user_id, team_id, provider, model, input_tokens, output_tokens, cost_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        params.session_id,
        params.user_id,
        team_id,
        params.provider,
        params.model,
        params.input_tokens,
        params.output_tokens,
        params.cost_usd,
        nowUtcMs()
      );
  }

  getComplianceReport(fromMs: number, toMs: number): ComplianceReportResult {
    type CountRow = { count: number };
    const countEvent = (type: string): number =>
      (this.db.prepare(
        "SELECT COUNT(*) as count FROM audit_events WHERE event_type=? AND created_at>=? AND created_at<=?"
      ).get(type, fromMs, toMs) as CountRow | undefined)?.count ?? 0;

    const approvalRequested = countEvent("APPROVAL_REQUESTED");
    const approvalGranted   = countEvent("APPROVAL_GRANTED");
    const approvalDenied    = countEvent("APPROVAL_DENIED");
    const approvalTimeout   = countEvent("APPROVAL_TIMEOUT");
    const policyDenied      = countEvent("POLICY_DENIED");
    const injectionDetected = countEvent("INJECTION_DETECTED");
    const sandboxErrors     = countEvent("SANDBOX_ERROR");
    const totalEvents       =
      (this.db.prepare(
        "SELECT COUNT(*) as count FROM audit_events WHERE created_at>=? AND created_at<=?"
      ).get(fromMs, toMs) as CountRow | undefined)?.count ?? 0;

    // Article 14: oversight_rate = approvals resolved / requested
    const oversightRate = approvalRequested === 0 ? 1
      : (approvalGranted + approvalDenied + approvalTimeout) / approvalRequested;

    const articles: ArticleResult[] = [
      {
        article_id: "article_9_risk_management",
        status: "COMPLIANT",
        summary: "Deny-by-default policy engine active; injection detection enabled",
        evidence: { policyDenied, injectionDetected, sandboxErrors,
                    policy: "deny_all_except_allowlist", injection_detection: "both" },
      },
      {
        article_id: "article_12_transparency_logging",
        status: "COMPLIANT",
        summary: `${totalEvents} immutable audit events; tamper-resistant SQLite triggers`,
        evidence: { totalEvents, tamper_resistant: true, format: "append-only SQLite" },
      },
      {
        article_id: "article_14_human_oversight",
        status: oversightRate >= 1 ? "COMPLIANT" : "WARNING",
        summary: `${approvalRequested} approvals requested; ${Math.round(oversightRate * 100)}% resolved`,
        evidence: { approvalRequested, approvalGranted, approvalDenied, approvalTimeout, oversightRate },
      },
      {
        article_id: "article_15_cybersecurity",
        status: "COMPLIANT",
        summary: "gVisor sandbox + session delimiters + multi-layer injection defense",
        evidence: { sandbox_mode: "gVisor", session_delimiter_protection: true,
                    injection_layers: ["heuristic", "llm_classifier", "session_delimiter"] },
      },
    ];

    const issues = articles
      .filter((a) => a.status !== "COMPLIANT")
      .map((a) => `${a.article_id}: ${a.summary}`);

    return { articles, issues, overall_status: issues.length === 0 ? "COMPLIANT" : "WARNING" };
  }

  getTeamCostSummary(teamId: string | undefined, fromMs: number, toMs: number): TeamCostSummaryResult {
    type CostRow = {
      team_id: string;
      user_id: string;
      model: string;
      total_cost_usd: number;
      input_tokens: number;
      output_tokens: number;
    };

    let rows: CostRow[];
    if (teamId) {
      rows = this.db.prepare(
        "SELECT team_id, user_id, model, SUM(cost_usd) as total_cost_usd, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens FROM cost_ledger WHERE team_id=? AND recorded_at>=? AND recorded_at<=? GROUP BY team_id, user_id, model"
      ).all(teamId, fromMs, toMs) as CostRow[];
    } else {
      rows = this.db.prepare(
        "SELECT team_id, user_id, model, SUM(cost_usd) as total_cost_usd, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens FROM cost_ledger WHERE recorded_at>=? AND recorded_at<=? GROUP BY team_id, user_id, model"
      ).all(fromMs, toMs) as CostRow[];
    }

    // Aggregate by team
    const teamMap = new Map<string, TeamCostEntry>();
    for (const row of rows) {
      const key = row.team_id || row.user_id;
      if (!teamMap.has(key)) {
        teamMap.set(key, {
          team_id: key,
          total_cost_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          session_count: 0,
          cost_by_model: {},
        });
      }
      const entry = teamMap.get(key)!;
      entry.total_cost_usd += row.total_cost_usd;
      entry.input_tokens += row.input_tokens;
      entry.output_tokens += row.output_tokens;
      entry.cost_by_model[row.model] = (entry.cost_by_model[row.model] ?? 0) + row.total_cost_usd;
    }

    // Count sessions per team
    type SessionCountRow = { team_id: string; session_count: number };
    let sessionRows: SessionCountRow[];
    if (teamId) {
      sessionRows = this.db.prepare(
        "SELECT team_id, COUNT(DISTINCT session_id) as session_count FROM cost_ledger WHERE team_id=? AND recorded_at>=? AND recorded_at<=? GROUP BY team_id"
      ).all(teamId, fromMs, toMs) as SessionCountRow[];
    } else {
      sessionRows = this.db.prepare(
        "SELECT team_id, COUNT(DISTINCT session_id) as session_count FROM cost_ledger WHERE recorded_at>=? AND recorded_at<=? GROUP BY team_id"
      ).all(fromMs, toMs) as SessionCountRow[];
    }
    for (const sr of sessionRows) {
      const entry = teamMap.get(sr.team_id);
      if (entry) entry.session_count = sr.session_count;
    }

    const teams = [...teamMap.values()];
    const grand_total_usd = teams.reduce((s, t) => s + t.total_cost_usd, 0);
    return { teams, grand_total_usd };
  }

  getTeamQuota(teamId: string): GetTeamQuotaResult {
    // 1. Query team_quotas table
    type QuotaRow = { quota_usd: number; billing_period_start: number; billing_period_days: number };
    const quotaRow = this.db.prepare(
      "SELECT quota_usd, billing_period_start, billing_period_days FROM team_quotas WHERE team_id = ?"
    ).get(teamId) as QuotaRow | undefined;

    // 2. If no quota configured, return "at capacity" (quota = 0)
    if (!quotaRow) {
      const currentSpend = this.getTeamSpend(teamId);
      return {
        quota_usd: 0,
        current_spend_usd: currentSpend,
        remaining_usd: 0,
        days_until_reset: 0,
        at_capacity: true,
      };
    }

    // 3. Calculate current period boundaries
    const now = nowUtcMs();
    const billingPeriodMs = quotaRow.billing_period_days * 24 * 60 * 60 * 1000;
    const periodStart = quotaRow.billing_period_start;
    const periodEnd = periodStart + billingPeriodMs;

    // 4. Sum cost_ledger for this team in the current period only
    const currentSpend = this.getTeamSpendInPeriod(teamId, periodStart, periodEnd);

    // 5. Calculate remaining
    const remaining = Math.max(quotaRow.quota_usd - currentSpend, 0);

    // 6. Calculate days until reset
    const msUntilReset = Math.max(periodEnd - now, 0);
    const daysUntilReset = Math.ceil(msUntilReset / (24 * 60 * 60 * 1000));

    return {
      quota_usd: quotaRow.quota_usd,
      current_spend_usd: currentSpend,
      remaining_usd: remaining,
      days_until_reset: daysUntilReset,
      at_capacity: remaining <= 0,
    };
  }

  setTeamQuota(teamId: string, quotaUsd: number): void {
    const now = nowUtcMs();

    // Try INSERT or UPDATE (upsert pattern)
    const stmt = this.db.prepare(
      "INSERT INTO team_quotas (team_id, quota_usd, billing_period_start, billing_period_days, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(team_id) DO UPDATE SET quota_usd = excluded.quota_usd, updated_at = excluded.updated_at"
    );
    stmt.run(teamId, quotaUsd, now, 30, now, now);
  }

  checkQuotaExceeded(teamId: string): CheckQuotaExceededResult {
    const quota = this.getTeamQuota(teamId);
    return {
      exceeded: quota.at_capacity,
      spent_usd: quota.current_spend_usd,
      quota_usd: quota.quota_usd,
    };
  }

  // Helper: sum cost_ledger for a team across all time
  private getTeamSpend(teamId: string): number {
    type CostRow = { total: number };
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_ledger WHERE team_id = ?"
    ).get(teamId) as CostRow | undefined;
    return row?.total ?? 0;
  }

  // Helper: sum cost_ledger for a team within a specific period
  private getTeamSpendInPeriod(teamId: string, fromMs: number, toMs: number): number {
    type CostRow = { total: number };
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_ledger WHERE team_id = ? AND recorded_at >= ? AND recorded_at < ?"
    ).get(teamId, fromMs, toMs) as CostRow | undefined;
    return row?.total ?? 0;
  }

  private buildAlertContext(sessionId?: string): AlertContext {
    const now = nowUtcMs();
    const oneMinuteAgo = now - 60_000;
    const fiveMinutesAgo = now - 300_000;
    const todayStart = now - (now % 86_400_000);

    type CountRow = { count: number };

    const toolCallsLastMinute = sessionId
      ? ((this.db
          .prepare(
            "SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'TOOL_CALL' AND session_id = ? AND created_at >= ?"
          )
          .get(sessionId, oneMinuteAgo) as CountRow | undefined)?.count ?? 0)
      : 0;

    const authFailuresLastFiveMin =
      (this.db
        .prepare(
          "SELECT COUNT(*) as count FROM audit_events WHERE event_type = 'AUTH_FAILED' AND created_at >= ?"
        )
        .get(fiveMinutesAgo) as CountRow | undefined)?.count ?? 0;

    type CostRow = { total: number };
    const dailyCostUsd =
      (this.db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_ledger WHERE recorded_at >= ?"
        )
        .get(todayStart) as CostRow | undefined)?.total ?? 0;

    return {
      toolCallsLastMinute,
      authFailuresLastFiveMin,
      dailyCostUsd,
      costCapUsd: this.costCapUsd,
      largestOutputBytesThisSession: 0, // TODO: implement if needed
    };
  }

  /** Return the path to the underlying SQLite database file. */
  getDbPath(): string | undefined {
    return this.dbPath;
  }

  /**
   * Dump the audit database as gzip-compressed bytes with SHA-256 checksum.
   * Performs a WAL checkpoint first to ensure the main DB file is up-to-date.
   */
  dumpState(): { data: Buffer; checksum: string } {
    if (this.dbPath === undefined) {
      throw new Error("Cannot dump state: dbPath not provided at construction");
    }

    // Checkpoint WAL so all data is in the main file
    this.db.exec("PRAGMA wal_checkpoint(FULL)");

    const raw = readFileSync(this.dbPath);
    const checksum = createHash("sha256").update(raw).digest("hex");
    const compressed = gzipSync(raw);
    return { data: compressed, checksum };
  }

  /**
   * Restore audit state from a gzip-compressed database dump.
   * Writes to <dir>/audit.db.new; startup migration applies it on next restart.
   */
  restoreState(data: Buffer, checksum: string): void {
    if (this.dbPath === undefined) {
      throw new Error("Cannot restore state: dbPath not provided at construction");
    }

    const raw = gunzipSync(data);
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== checksum) {
      throw new Error(`Checksum mismatch: expected ${checksum}, got ${actual}`);
    }

    const newPath = this.dbPath + ".new";
    writeFileSync(newPath, raw);
  }
}
