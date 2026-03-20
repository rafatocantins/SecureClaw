/**
 * audit.service.test.ts — Unit tests for AuditService.
 *
 * Covers the new Phase 1 methods: recordCost (team_id extraction),
 * getTeamCostSummary, and getComplianceReport.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./database/schema.js";
import { AuditService } from "./audit.service.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

function makeSvc(db?: DatabaseSync): AuditService {
  return new AuditService(db ?? makeDb());
}

// ── recordCost — team_id extraction ──────────────────────────────────────────

describe("AuditService — recordCost team_id extraction", () => {
  it("extracts org prefix from 'org/user' userId", () => {
    const svc = makeSvc();
    svc.recordCost({
      session_id: "sess-1",
      user_id: "acme/alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
    });
    const result = svc.getTeamCostSummary("acme", 0, Date.now() + 1_000_000);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.team_id).toBe("acme");
  });

  it("uses userId as team for solo users (no slash)", () => {
    const svc = makeSvc();
    svc.recordCost({
      session_id: "sess-2",
      user_id: "alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
    });
    const result = svc.getTeamCostSummary("alice", 0, Date.now() + 1_000_000);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.team_id).toBe("alice");
  });

  it("keeps only the first segment for deeply nested users", () => {
    const svc = makeSvc();
    svc.recordCost({
      session_id: "sess-3",
      user_id: "acme/eng/alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
    });
    const result = svc.getTeamCostSummary("acme", 0, Date.now() + 1_000_000);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.team_id).toBe("acme");
  });
});

// ── getTeamCostSummary ────────────────────────────────────────────────────────

describe("AuditService — getTeamCostSummary", () => {
  let svc: AuditService;
  const TO = Date.now() + 1_000_000;

  beforeEach(() => {
    svc = makeSvc();

    // acme team: two users, three cost records, two models
    svc.recordCost({
      session_id: "sess-alice-1",
      user_id: "acme/alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.01,
    });
    svc.recordCost({
      session_id: "sess-alice-2",
      user_id: "acme/alice",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.05,
    });
    svc.recordCost({
      session_id: "sess-bob-1",
      user_id: "acme/bob",
      provider: "openai",
      model: "gpt-4o",
      input_tokens: 500,
      output_tokens: 200,
      cost_usd: 0.02,
    });

    // demo team: one user
    svc.recordCost({
      session_id: "sess-demo-1",
      user_id: "demo/carol",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 300,
      output_tokens: 100,
      cost_usd: 0.005,
    });
  });

  it("returns all teams when teamId is undefined", () => {
    const result = svc.getTeamCostSummary(undefined, 0, TO);
    expect(result.teams).toHaveLength(2);
    expect(result.teams.map((t) => t.team_id).sort()).toEqual(["acme", "demo"]);
  });

  it("returns only the specified team", () => {
    const result = svc.getTeamCostSummary("acme", 0, TO);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.team_id).toBe("acme");
  });

  it("sums total_cost_usd across all users in team", () => {
    const result = svc.getTeamCostSummary("acme", 0, TO);
    expect(result.teams[0]!.total_cost_usd).toBeCloseTo(0.01 + 0.05 + 0.02, 6);
  });

  it("sums input and output tokens across team", () => {
    const result = svc.getTeamCostSummary("acme", 0, TO);
    const team = result.teams[0]!;
    expect(team.input_tokens).toBe(1000 + 2000 + 500);
    expect(team.output_tokens).toBe(500 + 1000 + 200);
  });

  it("counts distinct sessions per team", () => {
    const result = svc.getTeamCostSummary("acme", 0, TO);
    expect(result.teams[0]!.session_count).toBe(3);
  });

  it("builds cost_by_model breakdown", () => {
    const result = svc.getTeamCostSummary("acme", 0, TO);
    const models = result.teams[0]!.cost_by_model;
    expect(models["claude-3-5-haiku-20241022"]).toBeCloseTo(0.01, 6);
    expect(models["claude-sonnet-4-5"]).toBeCloseTo(0.05, 6);
    expect(models["gpt-4o"]).toBeCloseTo(0.02, 6);
  });

  it("computes grand_total_usd across all teams", () => {
    const result = svc.getTeamCostSummary(undefined, 0, TO);
    expect(result.grand_total_usd).toBeCloseTo(0.01 + 0.05 + 0.02 + 0.005, 6);
  });

  it("returns empty teams array for an unknown teamId", () => {
    const result = svc.getTeamCostSummary("unknown-team", 0, TO);
    expect(result.teams).toHaveLength(0);
    expect(result.grand_total_usd).toBe(0);
  });

  it("excludes records outside the time window", () => {
    // Very narrow future window that contains no records
    const futureFrom = Date.now() + 500_000;
    const result = svc.getTeamCostSummary(undefined, futureFrom, futureFrom + 1000);
    expect(result.teams).toHaveLength(0);
    expect(result.grand_total_usd).toBe(0);
  });

  it("grand_total_usd equals sum of individual team totals", () => {
    const result = svc.getTeamCostSummary(undefined, 0, TO);
    const summed = result.teams.reduce((s, t) => s + t.total_cost_usd, 0);
    expect(result.grand_total_usd).toBeCloseTo(summed, 10);
  });
});

// ── getComplianceReport ───────────────────────────────────────────────────────

describe("AuditService — getComplianceReport", () => {
  let svc: AuditService;
  const FROM = 0;
  const TO = Date.now() + 1_000_000;

  beforeEach(() => {
    svc = makeSvc();
  });

  it("returns exactly 4 articles", () => {
    const report = svc.getComplianceReport(FROM, TO);
    expect(report.articles).toHaveLength(4);
  });

  it("includes all required article IDs", () => {
    const report = svc.getComplianceReport(FROM, TO);
    const ids = report.articles.map((a) => a.article_id);
    expect(ids).toContain("article_9_risk_management");
    expect(ids).toContain("article_12_transparency_logging");
    expect(ids).toContain("article_14_human_oversight");
    expect(ids).toContain("article_15_cybersecurity");
  });

  it("overall_status is COMPLIANT with no events", () => {
    const report = svc.getComplianceReport(FROM, TO);
    expect(report.overall_status).toBe("COMPLIANT");
    expect(report.issues).toHaveLength(0);
  });

  it("article_14 is COMPLIANT when no approvals were requested", () => {
    const report = svc.getComplianceReport(FROM, TO);
    const art14 = report.articles.find((a) => a.article_id === "article_14_human_oversight")!;
    expect(art14.status).toBe("COMPLIANT");
  });

  it("article_14 is COMPLIANT when all approvals are resolved (granted)", () => {
    svc.logEvent({ event_type: "APPROVAL_REQUESTED", payload: {}, severity: "INFO" });
    svc.logEvent({ event_type: "APPROVAL_GRANTED",   payload: {}, severity: "INFO" });
    const report = svc.getComplianceReport(FROM, TO);
    const art14 = report.articles.find((a) => a.article_id === "article_14_human_oversight")!;
    expect(art14.status).toBe("COMPLIANT");
  });

  it("article_14 is COMPLIANT when all approvals are resolved via denied/timeout", () => {
    svc.logEvent({ event_type: "APPROVAL_REQUESTED", payload: {}, severity: "INFO" });
    svc.logEvent({ event_type: "APPROVAL_REQUESTED", payload: {}, severity: "INFO" });
    svc.logEvent({ event_type: "APPROVAL_DENIED",    payload: {}, severity: "INFO" });
    svc.logEvent({ event_type: "APPROVAL_TIMEOUT",   payload: {}, severity: "INFO" });
    const report = svc.getComplianceReport(FROM, TO);
    const art14 = report.articles.find((a) => a.article_id === "article_14_human_oversight")!;
    expect(art14.status).toBe("COMPLIANT");
  });

  it("article_14 is WARNING when an approval is unresolved", () => {
    svc.logEvent({ event_type: "APPROVAL_REQUESTED", payload: {}, severity: "INFO" });
    // No grant/deny/timeout
    const report = svc.getComplianceReport(FROM, TO);
    const art14 = report.articles.find((a) => a.article_id === "article_14_human_oversight")!;
    expect(art14.status).toBe("WARNING");
    expect(report.overall_status).toBe("WARNING");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toContain("article_14");
  });

  it("article_9 evidence includes policyDenied and injectionDetected counts", () => {
    svc.logEvent({ event_type: "POLICY_DENIED",      payload: {}, severity: "WARN" });
    svc.logEvent({ event_type: "POLICY_DENIED",      payload: {}, severity: "WARN" });
    svc.logEvent({ event_type: "INJECTION_DETECTED", payload: {}, severity: "CRITICAL" });
    const report = svc.getComplianceReport(FROM, TO);
    const art9 = report.articles.find((a) => a.article_id === "article_9_risk_management")!;
    expect(art9.evidence["policyDenied"]).toBe(2);
    expect(art9.evidence["injectionDetected"]).toBe(1);
  });

  it("article_12 evidence totalEvents reflects all logged events", () => {
    svc.logEvent({ event_type: "TOOL_CALL", payload: {}, severity: "INFO" });
    svc.logEvent({ event_type: "TOOL_CALL", payload: {}, severity: "INFO" });
    svc.logEvent({ event_type: "TOOL_CALL", payload: {}, severity: "INFO" });
    const report = svc.getComplianceReport(FROM, TO);
    const art12 = report.articles.find((a) => a.article_id === "article_12_transparency_logging")!;
    expect(art12.evidence["totalEvents"]).toBe(3);
    expect(art12.evidence["tamper_resistant"]).toBe(true);
  });

  it("respects time window — events outside range are not counted", () => {
    svc.logEvent({ event_type: "APPROVAL_REQUESTED", payload: {}, severity: "INFO" });
    // Query a time window in the far past: all events at nowUtcMs() will be excluded
    const report = svc.getComplianceReport(0, 1);
    const art14 = report.articles.find((a) => a.article_id === "article_14_human_oversight")!;
    // 0 approvals requested in that window → COMPLIANT
    expect(art14.status).toBe("COMPLIANT");
  });

  it("article_9 is always COMPLIANT regardless of event counts", () => {
    svc.logEvent({ event_type: "POLICY_DENIED", payload: {}, severity: "WARN" });
    const report = svc.getComplianceReport(FROM, TO);
    const art9 = report.articles.find((a) => a.article_id === "article_9_risk_management")!;
    expect(art9.status).toBe("COMPLIANT");
  });

  it("article_15 is always COMPLIANT (static evidence)", () => {
    const report = svc.getComplianceReport(FROM, TO);
    const art15 = report.articles.find((a) => a.article_id === "article_15_cybersecurity")!;
    expect(art15.status).toBe("COMPLIANT");
    expect(art15.evidence["sandbox_mode"]).toBe("gVisor");
  });
});

// ── Team quotas ──────────────────────────────────────────────────────────────

describe("AuditService — team quotas", () => {
  it("getTeamQuota returns unconfigured (at_capacity=true) when no quota set", () => {
    const svc = makeSvc();
    svc.recordCost({
      session_id: "sess-1",
      user_id: "acme/alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 10.0,
    });
    const quota = svc.getTeamQuota("acme");
    expect(quota.quota_usd).toBe(0);
    expect(quota.at_capacity).toBe(true);
  });

  it("setTeamQuota creates a new quota row", () => {
    const svc = makeSvc();
    svc.setTeamQuota("acme", 500.0);
    const quota = svc.getTeamQuota("acme");
    expect(quota.quota_usd).toBe(500.0);
    expect(quota.current_spend_usd).toBe(0);
    expect(quota.remaining_usd).toBe(500.0);
    expect(quota.at_capacity).toBe(false);
  });

  it("getTeamQuota calculates spend within billing period", () => {
    const svc = makeSvc();
    svc.setTeamQuota("acme", 500.0);

    // Record cost
    svc.recordCost({
      session_id: "sess-1",
      user_id: "acme/alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 100.0,
    });

    const quota = svc.getTeamQuota("acme");
    expect(quota.current_spend_usd).toBe(100.0);
    expect(quota.remaining_usd).toBe(400.0);
    expect(quota.at_capacity).toBe(false);
  });

  it("checkQuotaExceeded returns exceeded=true when over quota", () => {
    const svc = makeSvc();
    svc.setTeamQuota("acme", 100.0);
    svc.recordCost({
      session_id: "sess-1",
      user_id: "acme/alice",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 150.0,
    });
    const result = svc.checkQuotaExceeded("acme");
    expect(result.exceeded).toBe(true);
    expect(result.spent_usd).toBe(150.0);
    expect(result.quota_usd).toBe(100.0);
  });
});
