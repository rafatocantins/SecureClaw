/**
 * container-manager.ts — Docker container lifecycle management.
 *
 * Runs tool execution in hardened gVisor containers.
 * Enforces timeouts and resource limits.
 * Always cleans up containers after execution.
 */
import Docker from "dockerode";
import { SandboxError } from "@tessera/shared";
import { buildHardenedContainerOptions, type ContainerBuildConfig } from "./container-config.js";

export interface ToolRunResult {
  container_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  oom_killed: boolean;
}

export class ContainerManager {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  /**
   * Run a tool in a sandboxed container.
   *
   * The container is always removed after execution (even on error/timeout).
   * If the container exceeds the timeout, it is forcefully killed.
   */
  async runTool(cfg: ContainerBuildConfig): Promise<ToolRunResult> {
    const startMs = Date.now();
    const options = buildHardenedContainerOptions(cfg);
    let container: Docker.Container | null = null;

    try {
      // Create container (do not start yet)
      container = await this.docker.createContainer(options);
      const containerId = container.id;

      // Collect stdout/stderr via streaming attach before start
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });

      // Demultiplex Docker's multiplexed stream (stdout/stderr combined)
      container.modem.demuxStream(
        stream,
        { write: (chunk: Buffer): boolean => { stdoutChunks.push(chunk); return true; } },
        { write: (chunk: Buffer): boolean => { stderrChunks.push(chunk); return true; } }
      );

      // Start the container
      await container.start();

      // Race: container finishes vs timeout
      let timedOut = false;
      const timeoutMs = cfg.timeoutSeconds * 1000;

      const waitPromise = container.wait();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error(`Container timeout after ${cfg.timeoutSeconds}s`));
        }, timeoutMs);
      });

      let exitCode = 1;
      let oomKilled = false;

      try {
        const result = await Promise.race([waitPromise, timeoutPromise]) as { StatusCode: number };
        exitCode = result.StatusCode;
      } catch {
        if (timedOut) {
          // Kill container on timeout
          try {
            await container.kill({ signal: "SIGKILL" });
          } catch {
            // Container may already be dead
          }
        }
      }

      // Inspect to check OOM
      try {
        const inspectResult = await container.inspect();
        oomKilled = (inspectResult.State as { OOMKilled?: boolean }).OOMKilled ?? false;
        if (!timedOut) {
          exitCode = (inspectResult.State as { ExitCode?: number }).ExitCode ?? exitCode;
        }
      } catch {
        // Ignore inspect errors
      }

      const durationMs = Date.now() - startMs;

      return {
        container_id: containerId,
        exit_code: timedOut ? 124 : exitCode, // 124 = timeout exit code convention
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        duration_ms: durationMs,
        timed_out: timedOut,
        oom_killed: oomKilled,
      };
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      throw new SandboxError(
        `Container execution failed: ${err instanceof Error ? err.message : String(err)}`,
        { call_id: cfg.callId, error: String(err) }
      );
    } finally {
      // ALWAYS clean up — no container leaks
      if (container) {
        try {
          await container.remove({ force: true });
        } catch {
          // Ignore removal errors (container may already be gone)
        }
      }
    }
  }

  /**
   * Force-stop a container by ID (called from gRPC StopContainer).
   */
  async stopContainer(containerId: string, timeoutSeconds = 5): Promise<boolean> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: timeoutSeconds });
      await container.remove({ force: true });
      return true;
    } catch (err) {
      process.stderr.write(`[sandbox] Failed to stop container ${containerId}: ${String(err)}\n`);
      return false;
    }
  }
}
