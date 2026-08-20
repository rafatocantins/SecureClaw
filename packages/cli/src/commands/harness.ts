/**
 * harness.ts — `tessera harness` subcommands for the self-evolution system.
 *
 * list    — List stored + pending harness patches
 * analyze — Run the self-evolution pipeline (analyze → generate → validate)
 * apply   — Apply a patch by ID through the security gate (validatePatch)
 */
import { Command } from "commander";
import { apiGet, apiPost, printApiError } from "../http.js";

const DEFAULT_URL = "http://127.0.0.1:18789";

interface HarnessPatchDto {
  id: string;
  type: string;
  target: string;
  proposed_change: string;
  confidence: number;
  recommendation: string;
  applied: boolean;
}

function addCommonOpts(cmd: Command): Command {
  return cmd
    .option("-t, --token <bearer>", "Bearer token (defaults to $GATEWAY_TOKEN)")
    .option(
      "--url <baseUrl>",
      `Gateway base URL (defaults to $GATEWAY_URL or ${DEFAULT_URL})`,
      process.env["GATEWAY_URL"] ?? DEFAULT_URL
    );
}

function resolveToken(opts: { token?: string }): string {
  const token = opts.token ?? process.env["GATEWAY_TOKEN"];
  if (!token) {
    process.stderr.write(
      "error: no bearer token — set GATEWAY_TOKEN or pass --token\n"
    );
    process.exit(1);
  }
  return token;
}

export function harnessCommand(): Command {
  const harness = new Command("harness").description(
    "Inspect and manage the harness self-evolution system"
  );

  // ── list ────────────────────────────────────────────────────────────────
  addCommonOpts(
    harness
      .command("list")
      .description("List stored + pending harness self-evolution patches")
  ).action(async (opts: { token?: string; url: string }) => {
    const token = resolveToken(opts);
    try {
      const body = await apiGet(`${opts.url}/api/v1/harness/patches`, token) as {
        patches: HarnessPatchDto[];
      };
      if (body.patches.length === 0) {
        process.stdout.write("no harness patches stored\n");
        return;
      }
      process.stdout.write(
        `${"ID".padEnd(40)}  ${"TYPE".padEnd(12)}  ${"CONF".padEnd(6)}  ${"REC".padEnd(8)}  STATUS\n`
      );
      for (const p of body.patches) {
        const status = p.applied ? "applied" : "pending";
        process.stdout.write(
          `${p.id.padEnd(40)}  ${p.type.padEnd(12)}  ${p.confidence.toFixed(2).padEnd(6)}  ${p.recommendation.padEnd(8)}  ${status}\n`
        );
      }
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  // ── analyze ─────────────────────────────────────────────────────────────
  addCommonOpts(
    harness
      .command("analyze")
      .description("Run the harness self-evolution pipeline")
      .option("--limit <n>", "Maximum sessions to analyze (default 50)", "50")
  ).action(async (opts: { token?: string; url: string; limit: string }) => {
    const token = resolveToken(opts);
    const limit = Math.min(parseInt(opts.limit, 10) || 50, 500);
    try {
      const res = await apiPost(`${opts.url}/api/v1/harness/analyze`, token, {
        limit,
      });
      const body = res.body as {
        sessions_analyzed: number;
        patches_generated: number;
        patches_applied: number;
        patches_rejected: number;
        summary: Array<{
          pattern_type: string;
          total_occurrences: number;
          affected_sessions: number;
        }>;
      };
      process.stdout.write(
        `analyzed ${body.sessions_analyzed} sessions → ${body.patches_generated} patches generated, ` +
          `${body.patches_applied} applied, ${body.patches_rejected} rejected\n`
      );
      for (const s of body.summary) {
        process.stdout.write(
          `  [${s.pattern_type}] ${s.total_occurrences} occurrences across ${s.affected_sessions} sessions\n`
        );
      }
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  // ── apply ───────────────────────────────────────────────────────────────
  addCommonOpts(
    harness
      .command("apply <id>")
      .description(
        "Apply a harness patch by ID (always passes through validatePatch security gate)"
      )
  ).action(async (id: string, opts: { token?: string; url: string }) => {
    const token = resolveToken(opts);
    try {
      const res = await apiPost(
        `${opts.url}/api/v1/harness/apply/${encodeURIComponent(id)}`,
        token,
        {}
      );
      const body = res.body as { id: string; applied: boolean; reason: string };
      if (body.applied) {
        process.stdout.write(`applied: ${body.id}\n`);
      } else {
        process.stdout.write(`rejected: ${body.id} — ${body.reason}\n`);
        process.exit(1);
      }
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  return harness;
}
