/**
 * vault.ts — `tessera vault` subcommands for managing skill credentials.
 *
 * store  — Store a skill credential in the vault under (skill-creds, <name>)
 * list   — List all stored credential references (names only, values never echoed)
 * delete — Remove a credential by service/account
 */
import { Command } from "commander";
import { apiGet, apiPost, apiDelete, printApiError } from "../http.js";

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

export function vaultCommand(): Command {
  const vault = new Command("vault").description(
    "Manage skill credentials stored in the Tessera vault"
  );

  // ── store ────────────────────────────────────────────────────────────────
  addCommonOpts(
    vault
      .command("store <name> <value>")
      .description(
        'Store a skill credential under (skill-creds, <name>). ' +
        'Example: tessera vault store serpapi-key "sk-..."'
      )
  ).action(async (name: string, value: string, opts: { token?: string; url: string }) => {
    const token = resolveToken(opts);
    try {
      const res = await apiPost(`${opts.url}/api/v1/credentials`, token, {
        service: "skill-creds",
        account: name,
        value,
      }) as { body: { ref_id: string; service: string; account: string } };
      const { ref_id, account } = res.body;
      process.stdout.write(`stored: ${account} (ref: ${ref_id})\n`);
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  // ── list ─────────────────────────────────────────────────────────────────
  addCommonOpts(
    vault
      .command("list")
      .description("List all stored credential references (values are never shown)")
  ).action(async (opts: { token?: string; url: string }) => {
    const token = resolveToken(opts);
    try {
      const body = await apiGet(`${opts.url}/api/v1/credentials`, token) as {
        credentials: Array<{ ref_id: string; service: string; account: string }>;
      };
      const skillCreds = body.credentials.filter((c) => c.service === "skill-creds");
      if (skillCreds.length === 0) {
        process.stdout.write("no skill credentials stored\n");
        return;
      }
      process.stdout.write(`${"NAME".padEnd(32)}  REF ID\n`);
      process.stdout.write(`${"────".padEnd(32)}  ──────────────────────────────────────\n`);
      for (const c of skillCreds) {
        process.stdout.write(`${c.account.padEnd(32)}  ${c.ref_id}\n`);
      }
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  // ── delete ───────────────────────────────────────────────────────────────
  addCommonOpts(
    vault
      .command("delete <name>")
      .description(
        "Remove a skill credential by name. Example: tessera vault delete serpapi-key"
      )
  ).action(async (name: string, opts: { token?: string; url: string }) => {
    const token = resolveToken(opts);
    try {
      await apiDelete(`${opts.url}/api/v1/credentials/skill-creds/${encodeURIComponent(name)}`, token);
      process.stdout.write(`deleted: ${name}\n`);
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  // ── rotate-key ───────────────────────────────────────────────────────────
  addCommonOpts(
    vault
      .command("rotate-key")
      .description(
        "Re-encrypt all vault entries with a new master key (file backend only). " +
        "After rotation, update VAULT_MASTER_KEY to the new value."
      )
      .requiredOption("--new-key <hex>", "New master key (hex string or passphrase)")
      .option("--old-key <hex>", "Old master key (defaults to $VAULT_MASTER_KEY)")
  ).action(async (opts: { token?: string; url: string; newKey: string; oldKey?: string }) => {
    const token = resolveToken(opts);
    const oldKey = opts.oldKey ?? process.env["VAULT_MASTER_KEY"];
    if (!oldKey) {
      process.stderr.write("error: --old-key or VAULT_MASTER_KEY required\n");
      process.exit(1);
    }
    try {
      const res = await apiPost(
        `${opts.url}/api/v1/vault/rotate-key`,
        token,
        { old_master_key: oldKey, new_master_key: opts.newKey },
      ) as { body: { rotated_count: number } };
      process.stdout.write(
        `key rotation complete: ${res.body.rotated_count} entries re-encrypted\n`,
      );
      process.stdout.write(
        "ACTION REQUIRED: update VAULT_MASTER_KEY to the new value and restart tessera vault\n",
      );
    } catch (err) {
      printApiError(err);
      process.exit(1);
    }
  });

  return vault;
}
