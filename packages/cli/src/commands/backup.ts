/**
 * backup.ts — `tessera backup` subcommands for system backup and restore.
 *
 * create  — Download a full backup archive from the gateway
 * restore — Restore from a backup archive
 */
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { apiGetBinary, apiPostBinary, printApiError } from "../http.js";

const DEFAULT_URL = "http://127.0.0.1:18789";

function addCommonOpts(cmd: Command): Command {
  return cmd
    .option("-t, --token <bearer>", "Bearer token (defaults to $GATEWAY_TOKEN)")
    .option(
      "--url <baseUrl>",
      `Gateway base URL (defaults to $GATEWAY_URL or ${DEFAULT_URL})`,
      process.env["GATEWAY_URL"] ?? DEFAULT_URL,
    );
}

function resolveToken(opts: { token?: string }): string {
  const token = opts.token ?? process.env["GATEWAY_TOKEN"];
  if (!token) {
    process.stderr.write(
      "error: no bearer token — set GATEWAY_TOKEN or pass --token\n",
    );
    process.exit(1);
  }
  return token;
}

export function backupCommand(): Command {
  const backup = new Command("backup").description(
    "Create or restore a full Tessera system backup",
  );

  // ── create ────────────────────────────────────────────────────────────────
  addCommonOpts(
    backup
      .command("create")
      .description(
        "Download a backup archive of all Tessera services. " +
        "Example: tessera backup create --output backup.gz",
      )
      .requiredOption("--output <file>", "Output file path for the backup archive"),
  ).action(async (opts: { token?: string; url: string; output: string }) => {
    const token = resolveToken(opts);
    try {
      process.stdout.write("Creating backup...\n");
      const data = await apiGetBinary(`${opts.url}/api/v1/backup`, token);
      writeFileSync(opts.output, data);
      process.stdout.write(
        `backup saved: ${opts.output} (${(data.length / 1024).toFixed(1)} KiB)\n`,
      );
      process.stdout.write(
        "ACTION REQUIRED: restart all Tessera services after a restore to apply changes.\n",
      );
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  // ── restore ───────────────────────────────────────────────────────────────
  addCommonOpts(
    backup
      .command("restore")
      .description(
        "Restore all Tessera services from a backup archive. " +
        "Example: tessera backup restore --input backup.gz",
      )
      .requiredOption("--input <file>", "Backup archive file to restore from"),
  ).action(async (opts: { token?: string; url: string; input: string }) => {
    const token = resolveToken(opts);

    let data: Buffer;
    try {
      data = readFileSync(opts.input);
    } catch (err) {
      process.stderr.write(
        `error: could not read file: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }

    try {
      process.stdout.write(`Restoring from ${opts.input} (${(data.length / 1024).toFixed(1)} KiB)...\n`);
      const res = await apiPostBinary(`${opts.url}/api/v1/backup/restore`, token, data) as {
        status: number;
        body: {
          success: boolean;
          backup_created_at_unix_ms: number;
          restart_required: boolean;
          services: Record<string, { success: boolean; restart_required: boolean; error?: string }>;
        };
      };

      const { body } = res;
      const createdAt = new Date(body.backup_created_at_unix_ms).toISOString();
      process.stdout.write(`backup created at: ${createdAt}\n`);

      for (const [svc, result] of Object.entries(body.services)) {
        const status = result.success ? "✓" : "✗";
        const detail = result.success
          ? (result.restart_required ? "(restart required)" : "")
          : `ERROR: ${result.error ?? "unknown"}`;
        process.stdout.write(`  ${status} ${svc.padEnd(8)} ${detail}\n`);
      }

      if (!body.success) {
        process.stderr.write("\nwarning: partial restore — some services failed (see above)\n");
        process.exit(1);
      }

      if (body.restart_required) {
        process.stdout.write(
          "\nACTION REQUIRED: restart all Tessera services to apply the restored state.\n",
        );
      }
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  return backup;
}
