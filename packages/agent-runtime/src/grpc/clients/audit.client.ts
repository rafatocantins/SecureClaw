/**
 * audit.client.ts — gRPC client for the AuditService.
 *
 * Fire-and-forget pattern for logEvent — audit failures must NOT crash the agent.
 */
import { loadProto, grpc, clientCredentials } from "@tessera/shared";
import type {
  GrpcLogEventRequest,
  GrpcGetCostSummaryRequest,
  GrpcGetCostSummaryResponse,
  GrpcRecordCostRequest,
  GrpcGetTeamQuotaRequest,
  GrpcGetTeamQuotaResponse,
  GrpcCheckQuotaExceededRequest,
  GrpcCheckQuotaExceededResponse,
} from "@tessera/shared";

export interface CostSummary {
  total_cost_usd: number;
  cap_usd: number;
  remaining_usd: number;
  cap_exceeded: boolean;
  cost_by_model: Record<string, number>;
}

export interface LogEventParams {
  event_type: string;
  session_id?: string | undefined;
  user_id?: string | undefined;
  payload: Record<string, unknown>;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
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
    this.client = new AuditServiceClient(target, clientCredentials("agent-runtime"));
  }

  /** Fire-and-forget — never throws, audit must not crash the agent */
  logEvent(params: LogEventParams): void {
    const req: GrpcLogEventRequest = {
      event_type: params.event_type,
      session_id: params.session_id ?? "",
      user_id: params.user_id ?? "",
      payload_json: JSON.stringify(params.payload),
      severity: params.severity,
    };
    this.client.LogEvent(req, (err: grpc.ServiceError | null) => {
      if (err) {
        process.stderr.write(`[audit-client] logEvent failed: ${err.message}\n`);
      }
    });
  }

  getCostSummary(userId: string, dayMs?: number): Promise<CostSummary> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetCostSummaryRequest = {
        user_id: userId,
        day_unix_ms: dayMs ?? Date.now(),
      };
      this.client.GetCostSummary(req, (err: grpc.ServiceError | null, res: GrpcGetCostSummaryResponse) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  }

  /** Fire-and-forget — records cost to ledger, errors are swallowed + stderr-logged */
  recordCost(params: {
    session_id: string;
    user_id: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }): void {
    const req: GrpcRecordCostRequest = {
      session_id: params.session_id,
      user_id: params.user_id,
      provider: params.provider,
      model: params.model,
      input_tokens: params.input_tokens,
      output_tokens: params.output_tokens,
      cost_usd: params.cost_usd,
    };
    this.client.RecordCost(req, (err: grpc.ServiceError | null) => {
      if (err) {
        process.stderr.write(`[audit-client] recordCost failed: ${err.message}\n`);
      }
    });
  }

  getTeamQuota(teamId: string): Promise<GrpcGetTeamQuotaResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetTeamQuotaRequest = { team_id: teamId };
      this.client.GetTeamQuota(req, (err: grpc.ServiceError | null, res: GrpcGetTeamQuotaResponse) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  }

  checkQuotaExceeded(teamId: string): Promise<GrpcCheckQuotaExceededResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcCheckQuotaExceededRequest = { team_id: teamId };
      this.client.CheckQuotaExceeded(req, (err: grpc.ServiceError | null, res: GrpcCheckQuotaExceededResponse) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  }

  close(): void {
    this.client.close();
  }
}
