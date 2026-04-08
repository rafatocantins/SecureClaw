/**
 * skills.client.ts — Lightweight gRPC client for the SkillsService (gateway side).
 *
 * Provides marketplace operations: publish, list, get, install.
 * Also provides direct install (without marketplace) and listing of installed skills.
 */
import { loadProto, grpc, clientCredentials } from "@tessera/shared";
import type {
  GrpcPublishSkillRequest,
  GrpcPublishSkillResponse,
  GrpcListMarketplaceSkillsRequest,
  GrpcListMarketplaceSkillsResponse,
  GrpcGetMarketplaceSkillRequest,
  GrpcGetMarketplaceSkillResponse,
  GrpcInstallFromMarketplaceRequest,
  GrpcInstallSkillRequest,
  GrpcInstallSkillResponse,
  GrpcListSkillsRequest,
  GrpcListSkillsResponse,
  GrpcDumpStateResponse,
  GrpcRestoreStateRequest,
  GrpcRestoreStateResponse,
} from "@tessera/shared";

export class SkillsGrpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  constructor(addr?: string) {
    const target = addr ?? process.env["SKILLS_ADDR"] ?? "127.0.0.1:19005";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = loadProto("skills.proto") as any;
    const SkillsServiceClient = proto.tessera?.skills?.v1?.SkillsService as grpc.ServiceClientConstructor;
    if (!SkillsServiceClient) {
      throw new Error("Failed to load SkillsService from skills.proto");
    }
    this.client = new SkillsServiceClient(target, clientCredentials("gateway"));
  }

  publishSkill(manifestJson: string, trivyScanPassed: boolean): Promise<GrpcPublishSkillResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcPublishSkillRequest = { manifest_json: manifestJson, trivy_scan_passed: trivyScanPassed };
      this.client.PublishSkill(
        req,
        (err: grpc.ServiceError | null, res: GrpcPublishSkillResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  listMarketplaceSkills(namespace?: string, tag?: string, search?: string): Promise<GrpcListMarketplaceSkillsResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcListMarketplaceSkillsRequest = {
        namespace: namespace ?? "",
        tag: tag ?? "",
        search: search ?? "",
      };
      this.client.ListMarketplaceSkills(
        req,
        (err: grpc.ServiceError | null, res: GrpcListMarketplaceSkillsResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  getMarketplaceSkill(skillId: string, version?: string): Promise<GrpcGetMarketplaceSkillResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcGetMarketplaceSkillRequest = { skill_id: skillId, version: version ?? "" };
      this.client.GetMarketplaceSkill(
        req,
        (err: grpc.ServiceError | null, res: GrpcGetMarketplaceSkillResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  installFromMarketplace(skillId: string, version: string): Promise<GrpcInstallSkillResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcInstallFromMarketplaceRequest = { skill_id: skillId, version };
      this.client.InstallFromMarketplace(
        req,
        (err: grpc.ServiceError | null, res: GrpcInstallSkillResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  /** Install a signed manifest directly (bypasses marketplace). */
  installSkill(manifestJson: string, force = false): Promise<GrpcInstallSkillResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcInstallSkillRequest = { manifest_json: manifestJson, force };
      this.client.InstallSkill(
        req,
        (err: grpc.ServiceError | null, res: GrpcInstallSkillResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
  }

  /** List all locally installed skills. */
  listInstalledSkills(namespace?: string, tag?: string): Promise<GrpcListSkillsResponse> {
    return new Promise((resolve, reject) => {
      const req: GrpcListSkillsRequest = {
        namespace_filter: namespace ?? "",
        tag_filter: tag ?? "",
      };
      this.client.ListSkills(
        req,
        (err: grpc.ServiceError | null, res: GrpcListSkillsResponse) => {
          if (err) { reject(err); return; }
          resolve(res);
        }
      );
    });
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

  close(): void {
    this.client.close();
  }
}
