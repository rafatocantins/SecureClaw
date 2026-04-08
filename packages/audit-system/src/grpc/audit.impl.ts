/**
 * audit.impl.ts — AuditService gRPC handler implementations.
 *
 * Delegates all calls to the AuditService class (SQLite-backed).
 * The LogEvent handler is critical path — it must always succeed.
 */
import type * as grpc from "@grpc/grpc-js";
import type { AuditService } from "../audit.service.js";
import type {
  GrpcLogEventRequest,
  GrpcLogEventResponse,
  GrpcQueryEventsRequest,
  GrpcAuditEvent,
  GrpcGetAlertsRequest,
  GrpcGetAlertsResponse,
  GrpcAcknowledgeAlertRequest,
  GrpcAcknowledgeAlertResponse,
  GrpcGetCostSummaryRequest,
  GrpcGetCostSummaryResponse,
  GrpcRecordCostRequest,
  GrpcRecordCostResponse,
  GrpcGetComplianceReportRequest,
  GrpcComplianceReportResponse,
  GrpcGetTeamCostSummaryRequest,
  GrpcGetTeamCostSummaryResponse,
  GrpcGetTeamQuotaRequest,
  GrpcGetTeamQuotaResponse,
  GrpcSetTeamQuotaRequest,
  GrpcSetTeamQuotaResponse,
  GrpcCheckQuotaExceededRequest,
  GrpcCheckQuotaExceededResponse,
  GrpcDumpStateRequest,
  GrpcDumpStateResponse,
  GrpcRestoreStateRequest,
  GrpcRestoreStateResponse,
} from "@tessera/shared";
import type { AuditSeverity } from "@tessera/shared";

type UnaryCall<Req, Res> = grpc.ServerUnaryCall<Req, Res>;
type StreamCall<Req, Res> = grpc.ServerWritableStream<Req, Res>;
type Callback<Res> = grpc.sendUnaryData<Res>;

export function makeAuditImpl(auditSvc: AuditService) {
  return {
    LogEvent(
      call: UnaryCall<GrpcLogEventRequest, GrpcLogEventResponse>,
      callback: Callback<GrpcLogEventResponse>
    ): void {
      try {
        const req = call.request;
        const logParams: import("../audit.service.js").LogEventParams = {
          event_type: req.event_type,
          payload: (() => {
            try { return JSON.parse(req.payload_json) as Record<string, unknown>; }
            catch { return { raw: req.payload_json }; }
          })(),
          severity: (req.severity as AuditSeverity) || "INFO",
        };
        if (req.session_id) logParams.session_id = req.session_id;
        if (req.user_id) logParams.user_id = req.user_id;
        const result = auditSvc.logEvent(logParams);
        callback(null, { event_id: result.event_id, success: result.success });
      } catch (err) {
        // Audit errors must not propagate — log to stderr and return success=false
        process.stderr.write(`[audit-grpc] logEvent error: ${String(err)}\n`);
        callback(null, { event_id: 0, success: false });
      }
    },

    QueryEvents(call: StreamCall<GrpcQueryEventsRequest, GrpcAuditEvent>): void {
      try {
        const req = call.request;
        const queryParams: Parameters<typeof auditSvc.queryEvents>[0] = {
          limit: req.limit || 100,
        };
        if (req.session_id) queryParams.session_id = req.session_id;
        if (req.from_unix_ms) queryParams.from_unix_ms = req.from_unix_ms;
        if (req.to_unix_ms) queryParams.to_unix_ms = req.to_unix_ms;
        if (req.event_types?.length) queryParams.event_types = req.event_types;

        const events = auditSvc.queryEvents(queryParams);

        for (const e of events) {
          const auditEvent: GrpcAuditEvent = {
            id: e.id ?? 0,
            event_type: e.event_type,
            session_id: e.session_id ?? "",
            user_id: e.user_id ?? "",
            payload_json: JSON.stringify(e.payload),
            severity: e.severity,
            created_at_unix_ms: e.created_at_unix_ms,
          };
          call.write(auditEvent);
        }
        call.end();
      } catch (err) {
        process.stderr.write(`[audit-grpc] queryEvents error: ${String(err)}\n`);
        call.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },

    GetAlerts(
      call: UnaryCall<GrpcGetAlertsRequest, GrpcGetAlertsResponse>,
      callback: Callback<GrpcGetAlertsResponse>
    ): void {
      try {
        const req = call.request;
        type AlertRow = { id: number; rule_id: string; severity: string; session_id: string | null; message: string; context: string; created_at: number; acknowledged: number };
        const alertParams: Parameters<typeof auditSvc.getAlerts>[0] = {
          include_acknowledged: req.include_acknowledged,
        };
        if (req.session_id) alertParams.session_id = req.session_id;
        const rows = auditSvc.getAlerts(alertParams) as AlertRow[];

        callback(null, {
          alerts: rows.map((r) => ({
            id: r.id,
            rule_id: r.rule_id,
            severity: r.severity,
            session_id: r.session_id ?? "",
            message: r.message,
            context_json: r.context ?? "{}",
            created_at_unix_ms: r.created_at,
            acknowledged: r.acknowledged === 1,
          })),
        });
      } catch (err) {
        process.stderr.write(`[audit-grpc] getAlerts error: ${String(err)}\n`);
        callback(null, { alerts: [] });
      }
    },

    AcknowledgeAlert(
      call: UnaryCall<GrpcAcknowledgeAlertRequest, GrpcAcknowledgeAlertResponse>,
      callback: Callback<GrpcAcknowledgeAlertResponse>
    ): void {
      try {
        const success = auditSvc.acknowledgeAlert(call.request.alert_id);
        callback(null, { success });
      } catch (err) {
        process.stderr.write(`[audit-grpc] acknowledgeAlert error: ${String(err)}\n`);
        callback(null, { success: false });
      }
    },

    GetCostSummary(
      call: UnaryCall<GrpcGetCostSummaryRequest, GrpcGetCostSummaryResponse>,
      callback: Callback<GrpcGetCostSummaryResponse>
    ): void {
      try {
        const req = call.request;
        const summary = auditSvc.getCostSummary(req.user_id, req.day_unix_ms || Date.now());
        callback(null, summary);
      } catch (err) {
        process.stderr.write(`[audit-grpc] getCostSummary error: ${String(err)}\n`);
        callback(null, {
          total_cost_usd: 0,
          cap_usd: 0,
          remaining_usd: 0,
          cap_exceeded: false,
          cost_by_model: {},
        });
      }
    },

    RecordCost(
      call: UnaryCall<GrpcRecordCostRequest, GrpcRecordCostResponse>,
      callback: Callback<GrpcRecordCostResponse>
    ): void {
      try {
        const req = call.request;
        auditSvc.recordCost({
          session_id: req.session_id,
          user_id: req.user_id,
          provider: req.provider,
          model: req.model,
          input_tokens: req.input_tokens,
          output_tokens: req.output_tokens,
          cost_usd: req.cost_usd,
        });
        callback(null, { success: true });
      } catch (err) {
        process.stderr.write(`[audit-grpc] recordCost error: ${String(err)}\n`);
        callback(null, { success: false });
      }
    },

    GetComplianceReport(
      call: UnaryCall<GrpcGetComplianceReportRequest, GrpcComplianceReportResponse>,
      callback: Callback<GrpcComplianceReportResponse>
    ): void {
      try {
        const req = call.request;
        const fromMs = req.from_unix_ms || 0;
        const toMs = req.to_unix_ms || Date.now();
        const result = auditSvc.getComplianceReport(fromMs, toMs);
        callback(null, {
          generated_at_iso: new Date().toISOString(),
          framework_version: "EU AI Act 2024/1689",
          overall_status: result.overall_status,
          articles: result.articles.map((a) => ({
            article_id: a.article_id,
            status: a.status,
            summary: a.summary,
            evidence_json: JSON.stringify(a.evidence),
          })),
          issues: result.issues,
        });
      } catch (err) {
        process.stderr.write(`[audit-grpc] getComplianceReport error: ${String(err)}\n`);
        callback(null, {
          generated_at_iso: new Date().toISOString(),
          framework_version: "EU AI Act 2024/1689",
          overall_status: "UNKNOWN",
          articles: [],
          issues: [`Error generating report: ${String(err)}`],
        });
      }
    },

    GetTeamCostSummary(
      call: UnaryCall<GrpcGetTeamCostSummaryRequest, GrpcGetTeamCostSummaryResponse>,
      callback: Callback<GrpcGetTeamCostSummaryResponse>
    ): void {
      try {
        const req = call.request;
        const teamId = req.team_id || undefined;
        const fromMs = req.from_unix_ms || 0;
        const toMs = req.to_unix_ms || Date.now();
        const result = auditSvc.getTeamCostSummary(teamId, fromMs, toMs);
        callback(null, {
          teams: result.teams.map((t) => ({
            team_id: t.team_id,
            total_cost_usd: t.total_cost_usd,
            input_tokens: t.input_tokens,
            output_tokens: t.output_tokens,
            session_count: t.session_count,
            cost_by_model: t.cost_by_model,
          })),
          grand_total_usd: result.grand_total_usd,
        });
      } catch (err) {
        process.stderr.write(`[audit-grpc] getTeamCostSummary error: ${String(err)}\n`);
        callback(null, { teams: [], grand_total_usd: 0 });
      }
    },

    GetTeamQuota(
      call: UnaryCall<GrpcGetTeamQuotaRequest, GrpcGetTeamQuotaResponse>,
      callback: Callback<GrpcGetTeamQuotaResponse>
    ): void {
      try {
        const quota = auditSvc.getTeamQuota(call.request.team_id);
        callback(null, quota);
      } catch (err) {
        process.stderr.write(`[audit-grpc] getTeamQuota error: ${String(err)}\n`);
        callback(null, {
          quota_usd: 0,
          current_spend_usd: 0,
          remaining_usd: 0,
          days_until_reset: 0,
          at_capacity: true,
        });
      }
    },

    SetTeamQuota(
      call: UnaryCall<GrpcSetTeamQuotaRequest, GrpcSetTeamQuotaResponse>,
      callback: Callback<GrpcSetTeamQuotaResponse>
    ): void {
      try {
        auditSvc.setTeamQuota(call.request.team_id, call.request.quota_usd);
        callback(null, { success: true });
      } catch (err) {
        process.stderr.write(`[audit-grpc] setTeamQuota error: ${String(err)}\n`);
        callback(null, { success: false });
      }
    },

    CheckQuotaExceeded(
      call: UnaryCall<GrpcCheckQuotaExceededRequest, GrpcCheckQuotaExceededResponse>,
      callback: Callback<GrpcCheckQuotaExceededResponse>
    ): void {
      try {
        const result = auditSvc.checkQuotaExceeded(call.request.team_id);
        callback(null, result);
      } catch (err) {
        process.stderr.write(`[audit-grpc] checkQuotaExceeded error: ${String(err)}\n`);
        callback(null, {
          exceeded: false,
          spent_usd: 0,
          quota_usd: 0,
        });
      }
    },

    DumpState(
      _call: UnaryCall<GrpcDumpStateRequest, GrpcDumpStateResponse>,
      callback: Callback<GrpcDumpStateResponse>
    ): void {
      try {
        const { data, checksum } = auditSvc.dumpState();
        callback(null, {
          data,
          checksum_sha256: checksum,
          success: true,
          error_message: "",
        });
      } catch (err) {
        callback(null, {
          data: Buffer.alloc(0),
          checksum_sha256: "",
          success: false,
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    RestoreState(
      call: UnaryCall<GrpcRestoreStateRequest, GrpcRestoreStateResponse>,
      callback: Callback<GrpcRestoreStateResponse>
    ): void {
      try {
        auditSvc.restoreState(Buffer.from(call.request.data), call.request.checksum_sha256);
        callback(null, {
          success: true,
          error_message: "",
          restart_required: true,
        });
      } catch (err) {
        callback(null, {
          success: false,
          error_message: err instanceof Error ? err.message : String(err),
          restart_required: false,
        });
      }
    },
  };
}
