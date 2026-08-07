/**
 * sandbox.impl.ts — SandboxService gRPC handler implementations.
 *
 * Delegates to SandboxService (gVisor + Dockerode).
 */
import type * as grpc from "@grpc/grpc-js";
import type { SandboxService } from "../sandbox.service.js";
import type {
  GrpcCheckRuntimeRequest,
  GrpcCheckRuntimeResponse,
  GrpcRunToolRequest,
  GrpcRunToolResponse,
  GrpcStopContainerRequest,
  GrpcStopContainerResponse,
} from "@tessera/shared";

type UnaryCall<Req, Res> = grpc.ServerUnaryCall<Req, Res>;
type Callback<Res> = grpc.sendUnaryData<Res>;

export function makeSandboxImpl(sandboxSvc: SandboxService): grpc.UntypedServiceImplementation {
  return {
    CheckRuntime(
      _call: UnaryCall<GrpcCheckRuntimeRequest, GrpcCheckRuntimeResponse>,
      callback: Callback<GrpcCheckRuntimeResponse>
    ): void {
      sandboxSvc
        .checkRuntime()
        .then((info) => {
          callback(null, {
            gvisor_available: info.gvisor_available,
            runtime_name: info.runtime_name,
            docker_version: info.docker_version,
            ready: info.ready,
            error_message: info.error_message ?? "",
          });
        })
        .catch((err: unknown) => {
          callback(null, {
            gvisor_available: false,
            runtime_name: "",
            docker_version: "",
            ready: false,
            error_message: err instanceof Error ? err.message : String(err),
          });
        });
    },

    RunTool(
      call: UnaryCall<GrpcRunToolRequest, GrpcRunToolResponse>,
      callback: Callback<GrpcRunToolResponse>
    ): void {
      const req = call.request;
      sandboxSvc
        .runTool({
          call_id: req.call_id,
          tool_id: req.tool_id,
          image: req.image,
          input_json: req.input_json,
          timeout_seconds: req.timeout_seconds || 60,
          memory_bytes: req.limits?.memory_bytes ?? 256 * 1024 * 1024,
          cpu_shares: req.limits?.cpu_shares ?? 0.5,
          pids_limit: req.limits?.pids_limit ?? 64,
          env_vars: req.env_vars ?? [],
          network_mode: (req.network_mode as "none" | "restricted" | "host_dev_only") || "none",
          allowed_domains: req.allowed_domains?.length ? req.allowed_domains : undefined,
          workspace_volume: req.workspace_volume || undefined,
        })
        .then((result) => {
          callback(null, {
            container_id: result.container_id,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.duration_ms,
            timed_out: result.timed_out,
            oom_killed: result.oom_killed,
          });
        })
        .catch((err: unknown) => {
          callback(null, {
            container_id: "",
            exit_code: -1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            duration_ms: 0,
            timed_out: false,
            oom_killed: false,
          });
        });
    },

    StopContainer(
      call: UnaryCall<GrpcStopContainerRequest, GrpcStopContainerResponse>,
      callback: Callback<GrpcStopContainerResponse>
    ): void {
      const req = call.request;
      sandboxSvc
        .stopContainer(req.container_id, req.timeout_seconds || 5)
        .then((success) => callback(null, { success }))
        .catch(() => callback(null, { success: false }));
    },
  };
}
