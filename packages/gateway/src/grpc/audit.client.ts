/**
 * audit.client.ts — Lightweight gRPC client for the AuditService (gateway side).
 *
 * The gateway only needs GetCostSummary to enforce the daily cost cap before
 * forwarding messages. Full audit logging is handled by agent-runtime.
 */
import { loadProto, grpc, clientCredentials } from "@tessera/shared";
import type {
  GrpcGetCostSummaryRequest,
  GrpcGetCostSummaryResponse,
  GrpcQueryEventsRequest,
  GrpcAuditEvent,
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
} from "@tessera/shared";

export interface CostSummary {
  total_cost_usd: number;
  cap_usd: number;
  remaining_usd: number;
  cap_exceeded: boolean;
}

export class AuditGrpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  constructor(addr?: string) {
    const target = addr ?? process.env["AUDIT_ADDR"] ?? "127.0.0.1:19003";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = loadProto("audit.proto") as any;
    const AuditServiceClient = proto.tessera?.audit?.v1?.AuditService as grpc.ServiceClientConstructor;
    if (!AuditServiceClient) {
      throw new Error("Failed to load AuditService from audit.proto");
    }
    this.client = new AuditServiceClient(target, clientCredentials("gateway"));
  }

  getCostSummary(userId: string, dayMs?: number): Promise<CostSummary> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetCostSummaryRequest = {
        user_id: userId,
        day_unix_ms: dayMs ?? Date.now(),
      };
      this.client.GetCostSummary(
        req,
        (err: grpc.ServiceError | null, res: GrpcGetCostSummaryResponse) => {
          if (err) { reject(err); return; }
          resolve({
            total_cost_usd: res.total_cost_usd,
            cap_usd: res.cap_usd,
            remaining_usd: res.remaining_usd,
            cap_exceeded: res.cap_exceeded,
          });
        }
      );
    });
  }

  queryEvents(req: GrpcQueryEventsRequest): Promise<GrpcAuditEvent[]> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call = this.client.QueryEvents(req) as any;
      const events: GrpcAuditEvent[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      call.on("data", (event: any) => events.push(event as GrpcAuditEvent));
      call.on("end", () => resolve(events));
      call.on("error", (err: Error) => reject(err));
    });
  }

  getComplianceReport(fromMs: number, toMs: number): Promise<GrpcComplianceReportResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetComplianceReportRequest = { from_unix_ms: fromMs, to_unix_ms: toMs };
      this.client.GetComplianceReport(
        req,
        (err: grpc.ServiceError | null, res: GrpcComplianceReportResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  getTeamCostSummary(teamId: string, fromMs: number, toMs: number): Promise<GrpcGetTeamCostSummaryResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetTeamCostSummaryRequest = { team_id: teamId, from_unix_ms: fromMs, to_unix_ms: toMs };
      this.client.GetTeamCostSummary(
        req,
        (err: grpc.ServiceError | null, res: GrpcGetTeamCostSummaryResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  getTeamQuota(teamId: string): Promise<GrpcGetTeamQuotaResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetTeamQuotaRequest = { team_id: teamId };
      this.client.GetTeamQuota(
        req,
        (err: grpc.ServiceError | null, res: GrpcGetTeamQuotaResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  setTeamQuota(teamId: string, quotaUsd: number): Promise<GrpcSetTeamQuotaResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcSetTeamQuotaRequest = { team_id: teamId, quota_usd: quotaUsd };
      this.client.SetTeamQuota(
        req,
        (err: grpc.ServiceError | null, res: GrpcSetTeamQuotaResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  checkQuotaExceeded(teamId: string): Promise<GrpcCheckQuotaExceededResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcCheckQuotaExceededRequest = { team_id: teamId };
      this.client.CheckQuotaExceeded(
        req,
        (err: grpc.ServiceError | null, res: GrpcCheckQuotaExceededResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  logEvent(params: {
    event_type: string;
    session_id?: string;
    user_id?: string;
    payload: Record<string, unknown>;
    severity: string;
  }): Promise<{ event_id: number; success: boolean; alerts_triggered: unknown[] }> {
    return new Promise((resolve) => {
      const req = {
        event_type: params.event_type,
        session_id: params.session_id ?? "",
        user_id: params.user_id ?? "",
        payload_json: JSON.stringify(params.payload),
        severity: params.severity,
      };
      this.client.LogEvent(req, (err: grpc.ServiceError | null, res: { event_id: number; success: boolean }) => {
        if (err) {
          // Fire and forget, don't reject
          return;
        }
        resolve({ event_id: res.event_id, success: res.success, alerts_triggered: [] });
      });
    });
  }

  close(): void {
    this.client.close();
  }
}
