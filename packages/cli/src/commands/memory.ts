/**
 * memory.ts — `tessera memory` subcommands.
 *
 * lessons  — List stored lessons for a user (extracted from past sessions)
 */
import { Command } from "commander";
import { apiGet, printApiError } from "../http.js";

const DEFAULT_URL = "http://127.0.0.1:18789";

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

export function memoryCommand(): Command {
  const memory = new Command("memory").description(
    "Inspect memory and learned lessons for Tessera users"
  );

  // ── lessons ───────────────────────────────────────────────────────────────
  // NOTE: the gateway derives user_id from the verified token, not from a query param.
  // The --user flag is for display purposes only.
  addCommonOpts(
    memory
      .command("lessons")
      .description("List lessons learned from past sessions (for the authenticated user)")
      .option("--user <userId>", "User ID label for display (informational only)")
      .option("--limit <n>", "Maximum number of lessons to show (default 20)", "20")
  ).action(async (opts: { token?: string; url: string; user?: string; limit: string }) => {
    const token = resolveToken(opts);
    const limit = Math.min(parseInt(opts.limit, 10) || 20, 100);
    try {
      const body = await apiGet(
        `${opts.url}/api/v1/memory/lessons?limit=${limit}`,
        token
      ) as { lessons: Array<{ id: number; lesson_text: string; category: string; created_at: number; access_count: number }> };

      const userLabel = opts.user ?? "authenticated user";
      if (body.lessons.length === 0) {
        process.stdout.write(`no lessons stored for ${userLabel}\n`);
        return;
      }

      process.stdout.write(`Lessons for ${userLabel} (${body.lessons.length}):\n\n`);
      for (const l of body.lessons) {
        const date = new Date(l.created_at).toISOString().slice(0, 10);
        const accessed = l.access_count > 0 ? ` (accessed ${l.access_count}×)` : "";
        process.stdout.write(`[${l.category.padEnd(9)}] ${l.lesson_text}${accessed}  (${date})\n`);
      }
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  return memory;
}
