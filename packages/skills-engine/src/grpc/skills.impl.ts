/**
 * skills.impl.ts — SkillsService gRPC handler implementations.
 *
 * Delegates to SkillRegistry for install/list/get/remove and to
 * SandboxGrpcClient for tool execution.
 */
import type * as grpc from "@grpc/grpc-js";
import type { SkillRegistry } from "../registry.js";
import type { SandboxGrpcClient } from "../sandbox.client.js";
import type { MarketplaceRegistry } from "../marketplace.js";
import { verifySkillManifest } from "../verifier.js";
import type {
  GrpcInstallSkillRequest,
  GrpcInstallSkillResponse,
  GrpcListSkillsRequest,
  GrpcListSkillsResponse,
  GrpcSkillSummary,
  GrpcGetSkillRequest,
  GrpcGetSkillResponse,
  GrpcRemoveSkillRequest,
  GrpcRemoveSkillResponse,
  GrpcExecuteSkillToolRequest,
  GrpcExecuteSkillToolResponse,
  GrpcPublishSkillRequest,
  GrpcPublishSkillResponse,
  GrpcListMarketplaceSkillsRequest,
  GrpcListMarketplaceSkillsResponse,
  GrpcMarketplaceSkillSummary,
  GrpcGetMarketplaceSkillRequest,
  GrpcGetMarketplaceSkillResponse,
  GrpcInstallFromMarketplaceRequest,
  GrpcDumpStateRequest,
  GrpcDumpStateResponse,
  GrpcRestoreStateRequest,
  GrpcRestoreStateResponse,
} from "@tessera/shared";
import { dumpSkillsState, restoreSkillsState } from "../backup.js";

type UnaryCall<Req, Res> = grpc.ServerUnaryCall<Req, Res>;
type Callback<Res> = grpc.sendUnaryData<Res>;

export function makeSkillsImpl(registry: SkillRegistry, sandbox: SandboxGrpcClient, marketplace?: MarketplaceRegistry): grpc.UntypedServiceImplementation {
  return {
    InstallSkill(
      call: UnaryCall<GrpcInstallSkillRequest, GrpcInstallSkillResponse>,
      callback: Callback<GrpcInstallSkillResponse>
    ): void {
      try {
        const result = registry.install(call.request.manifest_json, call.request.force ?? false);
        callback(null, {
          success: result.success,
          message: result.message,
          skill_id: result.skill_id ?? "",
          skill_version: result.skill_version ?? "",
          tools_registered: result.tools_registered ?? 0,
        });
      } catch (err) {
        callback(null, {
          success: false,
          message: `Unexpected error: ${String(err)}`,
          skill_id: "",
          skill_version: "",
          tools_registered: 0,
        });
      }
    },

    ListSkills(
      call: UnaryCall<GrpcListSkillsRequest, GrpcListSkillsResponse>,
      callback: Callback<GrpcListSkillsResponse>
    ): void {
      try {
        const skills = registry.list(
          call.request.namespace_filter || undefined,
          call.request.tag_filter || undefined
        );
        const summaries: GrpcSkillSummary[] = skills.map((s) => ({
          id: s.manifest.id,
          name: s.manifest.name,
          version: s.manifest.version,
          description: s.manifest.description,
          author_name: s.manifest.author.name,
          published_at: s.manifest.published_at,
          tags: s.manifest.tags,
          tool_count: s.manifest.tools.length,
          installed_at: s.installed_at,
        }));
        callback(null, { skills: summaries });
      } catch (err) {
        process.stderr.write(`[skills-grpc] ListSkills error: ${String(err)}\n`);
        callback(null, { skills: [] });
      }
    },

    GetSkill(
      call: UnaryCall<GrpcGetSkillRequest, GrpcGetSkillResponse>,
      callback: Callback<GrpcGetSkillResponse>
    ): void {
      try {
        const skill = registry.get(
          call.request.skill_id,
          call.request.version || undefined
        );
        if (!skill) {
          callback(null, { found: false, manifest_json: "", installed_at: "" });
          return;
        }
        callback(null, {
          found: true,
          manifest_json: JSON.stringify(skill.manifest),
          installed_at: skill.installed_at,
        });
      } catch (err) {
        process.stderr.write(`[skills-grpc] GetSkill error: ${String(err)}\n`);
        callback(null, { found: false, manifest_json: "", installed_at: "" });
      }
    },

    RemoveSkill(
      call: UnaryCall<GrpcRemoveSkillRequest, GrpcRemoveSkillResponse>,
      callback: Callback<GrpcRemoveSkillResponse>
    ): void {
      try {
        const result = registry.remove(
          call.request.skill_id,
          call.request.version || undefined
        );
        callback(null, {
          success: result.success,
          message: result.message,
          versions_removed: result.versions_removed,
        });
      } catch (err) {
        callback(null, {
          success: false,
          message: `Unexpected error: ${String(err)}`,
          versions_removed: 0,
        });
      }
    },

    ExecuteSkillTool(
      call: UnaryCall<GrpcExecuteSkillToolRequest, GrpcExecuteSkillToolResponse>,
      callback: Callback<GrpcExecuteSkillToolResponse>
    ): void {
      const req = call.request;
      const entry = registry.getTool(req.skill_id, req.skill_version, req.tool_id);

      if (!entry) {
        callback(null, {
          call_id: req.call_id,
          success: false,
          stdout: "",
          stderr: `Tool "${req.tool_id}" not found in skill "${req.skill_id}@${req.skill_version}"`,
          exit_code: -1,
          duration_ms: 0,
          timed_out: false,
          oom_killed: false,
        });
        return;
      }

      const { tool } = entry;
      const image = `${tool.image.repository}:${tool.image.tag}@${tool.image.digest}`;

      sandbox
        .runTool({
          call_id: req.call_id,
          tool_id: req.tool_id,
          image,
          input_json: req.input_json,
          timeout_seconds: tool.resource_limits.timeout_seconds,
          memory_bytes: tool.resource_limits.memory_bytes,
          pids_limit: tool.resource_limits.pids_limit,
          network_mode: tool.resource_limits.network,
          allowed_domains: [],
          env_vars: [],
        })
        .then((result) => {
          callback(null, {
            call_id: req.call_id,
            success: result.exit_code === 0,
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            timed_out: result.timed_out,
            oom_killed: result.oom_killed,
          });
        })
        .catch((err: unknown) => {
          callback(null, {
            call_id: req.call_id,
            success: false,
            stdout: "",
            stderr: String(err),
            exit_code: -1,
            duration_ms: 0,
            timed_out: false,
            oom_killed: false,
          });
        });
    },

    // ── Marketplace handlers ───────────────────────────────────────────────

    PublishSkill(
      call: UnaryCall<GrpcPublishSkillRequest, GrpcPublishSkillResponse>,
      callback: Callback<GrpcPublishSkillResponse>
    ): void {
      if (!marketplace) {
        callback(null, { success: false, skill_id: "", version: "", message: "Marketplace not enabled" });
        return;
      }
      try {
        const req = call.request;
        // Verify signature first
        const verifyResult = verifySkillManifest(req.manifest_json);
        if (!verifyResult.valid) {
          callback(null, { success: false, skill_id: "", version: "", message: `Invalid signature: ${verifyResult.error}` });
          return;
        }
        const result = marketplace.publish(req.manifest_json, req.trivy_scan_passed ?? false);
        callback(null, {
          success: result.success,
          skill_id: result.skill_id,
          version: result.version,
          message: result.message,
        });
      } catch (err) {
        process.stderr.write(`[skills-grpc] PublishSkill error: ${String(err)}\n`);
        callback(null, { success: false, skill_id: "", version: "", message: String(err) });
      }
    },

    ListMarketplaceSkills(
      call: UnaryCall<GrpcListMarketplaceSkillsRequest, GrpcListMarketplaceSkillsResponse>,
      callback: Callback<GrpcListMarketplaceSkillsResponse>
    ): void {
      if (!marketplace) {
        callback(null, { skills: [] });
        return;
      }
      try {
        const req = call.request;
        const entries = marketplace.list(
          req.namespace || undefined,
          req.tag || undefined,
          req.search || undefined
        );
        const skills: GrpcMarketplaceSkillSummary[] = entries.map((e) => {
          let name = e.skill_id;
          let description = "";
          let author_name = "";
          let tags: string[] = [];
          try {
            const m = JSON.parse(e.manifest_json) as { name?: string; description?: string; author?: { name?: string }; tags?: string[] };
            name = m.name ?? e.skill_id;
            description = m.description ?? "";
            author_name = m.author?.name ?? "";
            tags = m.tags ?? [];
          } catch { /* use defaults */ }
          return {
            skill_id: e.skill_id,
            version: e.skill_version,
            name,
            description,
            author_name,
            download_count: e.download_count,
            trivy_scan_passed: e.trivy_scan_passed,
            tags,
          };
        });
        callback(null, { skills });
      } catch (err) {
        process.stderr.write(`[skills-grpc] ListMarketplaceSkills error: ${String(err)}\n`);
        callback(null, { skills: [] });
      }
    },

    GetMarketplaceSkill(
      call: UnaryCall<GrpcGetMarketplaceSkillRequest, GrpcGetMarketplaceSkillResponse>,
      callback: Callback<GrpcGetMarketplaceSkillResponse>
    ): void {
      if (!marketplace) {
        callback(null, { found: false, manifest_json: "", download_count: 0 });
        return;
      }
      try {
        const req = call.request;
        const entry = marketplace.get(req.skill_id, req.version || undefined);
        if (!entry) {
          callback(null, { found: false, manifest_json: "", download_count: 0 });
          return;
        }
        callback(null, {
          found: true,
          manifest_json: entry.manifest_json,
          download_count: entry.download_count,
        });
      } catch (err) {
        process.stderr.write(`[skills-grpc] GetMarketplaceSkill error: ${String(err)}\n`);
        callback(null, { found: false, manifest_json: "", download_count: 0 });
      }
    },

    InstallFromMarketplace(
      call: UnaryCall<GrpcInstallFromMarketplaceRequest, GrpcInstallSkillResponse>,
      callback: Callback<GrpcInstallSkillResponse>
    ): void {
      if (!marketplace) {
        callback(null, { success: false, message: "Marketplace not enabled", skill_id: "", skill_version: "", tools_registered: 0 });
        return;
      }
      try {
        const req = call.request;
        const entry = marketplace.get(req.skill_id, req.version || undefined);
        if (!entry) {
          callback(null, { success: false, message: `Skill ${req.skill_id}@${req.version} not found in marketplace`, skill_id: req.skill_id, skill_version: req.version, tools_registered: 0 });
          return;
        }
        // Install into local registry
        const installResult = registry.install(entry.manifest_json, false);
        if (installResult.success) {
          marketplace.recordInstall(entry.skill_id, entry.skill_version);
        }
        callback(null, {
          success: installResult.success,
          message: installResult.message,
          skill_id: installResult.skill_id ?? "",
          skill_version: installResult.skill_version ?? "",
          tools_registered: installResult.tools_registered ?? 0,
        });
      } catch (err) {
        process.stderr.write(`[skills-grpc] InstallFromMarketplace error: ${String(err)}\n`);
        callback(null, { success: false, message: String(err), skill_id: "", skill_version: "", tools_registered: 0 });
      }
    },

    DumpState(
      _call: UnaryCall<GrpcDumpStateRequest, GrpcDumpStateResponse>,
      callback: Callback<GrpcDumpStateResponse>
    ): void {
      dumpSkillsState(
        registry.getRegistryPath(),
        marketplace?.getMarketplacePath(),
      )
        .then(({ data, checksum }) => {
          callback(null, {
            data,
            checksum_sha256: checksum,
            success: true,
            error_message: "",
          });
        })
        .catch((err: unknown) => {
          callback(null, {
            data: Buffer.alloc(0),
            checksum_sha256: "",
            success: false,
            error_message: err instanceof Error ? err.message : String(err),
          });
        });
    },

    RestoreState(
      call: UnaryCall<GrpcRestoreStateRequest, GrpcRestoreStateResponse>,
      callback: Callback<GrpcRestoreStateResponse>
    ): void {
      restoreSkillsState(
        Buffer.from(call.request.data),
        call.request.checksum_sha256,
        registry.getRegistryPath(),
        marketplace?.getMarketplacePath(),
      )
        .then(() => {
          callback(null, {
            success: true,
            error_message: "",
            restart_required: true,
          });
        })
        .catch((err: unknown) => {
          callback(null, {
            success: false,
            error_message: err instanceof Error ? err.message : String(err),
            restart_required: false,
          });
        });
    },
  };
}
