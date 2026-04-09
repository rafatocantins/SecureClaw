/**
 * token.ts — `tessera token` subcommands.
 *
 * generate: Creates a signed HMAC bearer token locally.
 * refresh:  Exchanges an existing valid token for a fresh one via the gateway.
 *
 * Token format: {userId}.{role}.{timestamp_ms}.{hmac_sha256(secret, userId:role:timestamp)}
 * This mirrors the logic in packages/gateway/src/plugins/auth.plugin.ts
 */
import { Command } from "commander";
import { signHmac, nowUtcMs } from "@tessera/shared";
import { printApiError } from "../http.js";

/** Replicate gateway token generation without importing the gateway package. */
function makeToken(userId: string, secret: string, role: "admin" | "user"): string {
  const timestamp = nowUtcMs().toString();
  const payload = `${userId}:${role}:${timestamp}`;
  const signature = signHmac(secret, payload);
  return `${userId}.${role}.${timestamp}.${signature}`;
}

export function tokenCommand(): Command {
  const cmd = new Command("token").description("Manage gateway auth tokens");

  cmd
    .command("generate")
    .description("Generate a signed HMAC bearer token")
    .requiredOption("-u, --user <userId>", "User ID to embed in the token (e.g. dev-user)")
    .option(
      "-s, --secret <secret>",
      "HMAC secret (defaults to $GATEWAY_HMAC_SECRET)"
    )
    .option(
      "-r, --role <role>",
      "Role to embed in the token: admin or user (default: user)",
      "user"
    )
    .action((opts: { user: string; secret?: string; role: string }) => {
      const secret = opts.secret ?? process.env["GATEWAY_HMAC_SECRET"];
      if (!secret) {
        process.stderr.write(
          "error: HMAC secret required — pass --secret or set GATEWAY_HMAC_SECRET\n"
        );
        process.exit(1);
      }
      if (opts.role !== "admin" && opts.role !== "user") {
        process.stderr.write(
          `error: invalid role '${opts.role}' — must be 'admin' or 'user'\n`
        );
        process.exit(1);
      }
      const role = opts.role as "admin" | "user";
      const token = makeToken(opts.user, secret, role);
      process.stdout.write(token + "\n");
    });

  cmd
    .command("refresh")
    .description("Exchange an existing valid token for a fresh one via the gateway")
    .option("-t, --token <token>", "Token to refresh (defaults to $GATEWAY_TOKEN)")
    .option("-u, --url <url>", "Gateway base URL (defaults to $GATEWAY_URL or http://127.0.0.1:18789)")
    .action(async (opts: { token?: string; url?: string }) => {
      const token = opts.token ?? process.env["GATEWAY_TOKEN"];
      if (!token) {
        process.stderr.write(
          "error: token required — pass --token or set GATEWAY_TOKEN\n"
        );
        process.exit(1);
      }

      const baseUrl = opts.url ?? process.env["GATEWAY_URL"] ?? "http://127.0.0.1:18789";

      try {
        const res = await fetch(`${baseUrl}/api/v1/token/refresh`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });

        const body: unknown = await res.json();
        if (!res.ok) throw { status: res.status, body };

        const data = body as { token: string; expires_in_seconds: number };
        process.stdout.write(data.token + "\n");
        process.stderr.write(
          `info: token refreshed — valid for ${data.expires_in_seconds}s\n`
        );
      } catch (err) {
        printApiError(err);
        process.exit(1);
      }
    });

  return cmd;
}
