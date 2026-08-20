/**
 * agent.client.ts — gRPC client for the AgentService.
 *
 * Used by the gateway to forward WebSocket messages to the agent runtime.
 * The sendMessage call returns an async iterable of AgentChunk messages.
 */
import { loadProto, grpc, clientCredentials } from "@tessera/shared";
import type {
  GrpcCreateSessionRequest,
  GrpcCreateSessionResponse,
  GrpcSendMessageRequest,
  GrpcAgentChunk,
  GrpcApproveToolCallRequest,
  GrpcTerminateSessionRequest,
  GrpcTerminateSessionResponse,
  GrpcGetSessionStatusRequest,
  GrpcGetSessionStatusResponse,
  GrpcListSessionsRequest,
  GrpcListSessionsResponse,
  GrpcSessionSummary,
  GrpcListPendingApprovalsRequest,
  GrpcListPendingApprovalsResponse,
  GrpcPendingApprovalSummary,
  GrpcListHarnessPatchesRequest,
  GrpcListHarnessPatchesResponse,
  GrpcHarnessPatchInfo,
  GrpcApplyHarnessPatchRequest,
  GrpcApplyHarnessPatchResponse,
  GrpcRunHarnessEvolutionRequest,
  GrpcRunHarnessEvolutionResponse,
} from "@tessera/shared";

export interface SessionStatus {
  session_id: string;
  status: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  tool_call_count: number;
}

export class AgentGrpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  constructor(addr?: string) {
    const target = addr ?? process.env["AGENT_RUNTIME_ADDR"] ?? "127.0.0.1:19001";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = loadProto("agent.proto") as any;
    const AgentServiceClient = proto.tessera?.agent?.v1?.AgentService as grpc.ServiceClientConstructor;
    if (!AgentServiceClient) {
      throw new Error("Failed to load AgentService from agent.proto");
    }
    this.client = new AgentServiceClient(target, clientCredentials("gateway"));
  }

  createSession(
    userId: string,
    provider: string,
    metadata: Record<string, string> = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const req: GrpcCreateSessionRequest = { user_id: userId, provider, metadata };
      this.client.CreateSession(
        req,
        (err: grpc.ServiceError | null, res: GrpcCreateSessionResponse) => {
          if (err) { reject(err); return; }
          if (!res.success) { reject(new Error(res.error_message || "CreateSession failed")); return; }
          resolve(res.session_id);
        }
      );
    });
  }

  /**
   * Stream agent chunks for a user message.
   * Returns an async generator that yields GrpcAgentChunk objects.
   */
  sendMessage(sessionId: string, content: string): AsyncGenerator<GrpcAgentChunk> {
    const req: GrpcSendMessageRequest = {
      session_id: sessionId,
      content,
      content_type: "user_instruction",
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = this.client.SendMessage(req) as any;

    return (async function* (): AsyncGenerator<GrpcAgentChunk> {
      for await (const chunk of call) {
        yield chunk as GrpcAgentChunk;
      }
    })();
  }

  approveToolCall(sessionId: string, callId: string, approved: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const req: GrpcApproveToolCallRequest = { session_id: sessionId, call_id: callId, approved };
      this.client.ApproveToolCall(req, (err: grpc.ServiceError | null) => {
        if (err) { reject(err); return; }
        resolve();
      });
    });
  }

  terminateSession(sessionId: string): Promise<{ success: boolean; total_cost_usd: number }> {
    return new Promise((resolve, reject) => {
      const req: GrpcTerminateSessionRequest = { session_id: sessionId };
      this.client.TerminateSession(
        req,
        (err: grpc.ServiceError | null, res: GrpcTerminateSessionResponse) => {
          if (err) { reject(err); return; }
          resolve({ success: res.success, total_cost_usd: res.total_cost_usd });
        }
      );
    });
  }

  getSessionStatus(sessionId: string): Promise<SessionStatus> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetSessionStatusRequest = { session_id: sessionId };
      this.client.GetSessionStatus(
        req,
        (err: grpc.ServiceError | null, res: GrpcGetSessionStatusResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  listSessions(): Promise<GrpcSessionSummary[]> {
    return new Promise((resolve, reject) => {
      const req: GrpcListSessionsRequest = {};
      this.client.ListSessions(
        req,
        (err: grpc.ServiceError | null, res: GrpcListSessionsResponse) => {
          if (err) { reject(err); return; }
          resolve(res.sessions ?? []);
        }
      );
    });
  }

  listPendingApprovals(): Promise<GrpcPendingApprovalSummary[]> {
    return new Promise((resolve, reject) => {
      const req: GrpcListPendingApprovalsRequest = {};
      this.client.ListPendingApprovals(
        req,
        (err: grpc.ServiceError | null, res: GrpcListPendingApprovalsResponse) => {
          if (err) { reject(err); return; }
          resolve(res.approvals ?? []);
        }
      );
    });
  }

  /**
   * List stored + pending harness self-evolution patches.
   */
  listHarnessPatches(): Promise<GrpcHarnessPatchInfo[]> {
    return new Promise((resolve, reject) => {
      const req: GrpcListHarnessPatchesRequest = {};
      this.client.ListHarnessPatches(
        req,
        (err: grpc.ServiceError | null, res: GrpcListHarnessPatchesResponse) => {
          if (err) { reject(err); return; }
          resolve(res.patches ?? []);
        }
      );
    });
  }

  /**
   * Run the harness self-evolution pipeline (analyze → generate → validate).
   */
  runHarnessEvolution(limit = 50): Promise<GrpcRunHarnessEvolutionResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcRunHarnessEvolutionRequest = { limit };
      this.client.RunHarnessEvolution(
        req,
        (err: grpc.ServiceError | null, res: GrpcRunHarnessEvolutionResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  /**
   * Apply a harness patch by ID through the security gate.
   */
  applyHarnessPatch(patchId: string): Promise<GrpcApplyHarnessPatchResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcApplyHarnessPatchRequest = { patch_id: patchId };
      this.client.ApplyHarnessPatch(
        req,
        (err: grpc.ServiceError | null, res: GrpcApplyHarnessPatchResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  close(): void {
    this.client.close();
  }
}
