/**
 * memory.client.ts — Lightweight gRPC client for the MemoryService (gateway side).
 *
 * Gateway only needs DumpState / RestoreState for backup orchestration.
 */
import { loadProto, grpc, clientCredentials } from "@tessera/shared";
import type {
  GrpcDumpStateResponse,
  GrpcRestoreStateRequest,
  GrpcRestoreStateResponse,
  GrpcListLessonsRequest,
  GrpcListLessonsResponse,
  GrpcStoredLesson,
} from "@tessera/shared";

export class MemoryGrpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  constructor(addr?: string) {
    const target = addr ?? process.env["MEMORY_ADDR"] ?? "127.0.0.1:19006";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = loadProto("memory.proto") as any;
    const MemoryServiceClient = proto.tessera?.memory?.v1?.MemoryService as grpc.ServiceClientConstructor;
    if (!MemoryServiceClient) {
      throw new Error("Failed to load MemoryService from memory.proto");
    }
    this.client = new MemoryServiceClient(target, clientCredentials("gateway"));
  }

  dumpState(): Promise<GrpcDumpStateResponse> {
    return new Promise((resolve, reject) => {
      this.client.DumpState(
        {},
        (err: grpc.ServiceError | null, res: GrpcDumpStateResponse) => {
          if (err) { reject(err); return; }
          if (!res.success) {
            reject(new Error(res.error_message || "DumpState failed"));
            return;
          }
          resolve(res);
        }
      );
    });
  }

  restoreState(data: Buffer, checksumSha256: string): Promise<GrpcRestoreStateResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcRestoreStateRequest = { data, checksum_sha256: checksumSha256 };
      this.client.RestoreState(
        req,
        (err: grpc.ServiceError | null, res: GrpcRestoreStateResponse) => {
          if (err) { reject(err); return; }
          if (!res.success) {
            reject(new Error(res.error_message || "RestoreState failed"));
            return;
          }
          resolve(res);
        }
      );
    });
  }

  listLessons(userId: string, limit = 20): Promise<GrpcStoredLesson[]> {
    return new Promise((resolve, reject) => {
      const req: GrpcListLessonsRequest = { user_id: userId, limit };
      this.client.ListLessons(
        req,
        (err: grpc.ServiceError | null, res: GrpcListLessonsResponse) => {
          if (err) { reject(err); return; }
          resolve(res.lessons ?? []);
        }
      );
    });
  }

  close(): void {
    this.client.close();
  }
}
