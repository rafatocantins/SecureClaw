#!/usr/bin/env node
/**
 * bin.ts — Tessera CLI entry point.
 *
 * Commands:
 *   tessera init
 *   tessera token generate --user <id> [--secret <secret>]
 *   tessera session create  [--provider anthropic] [--token <t>] [--url <url>]
 *   tessera session status  <sessionId>            [--token <t>] [--url <url>]
 *   tessera session delete  <sessionId>            [--token <t>] [--url <url>]
 *   tessera health                                              [--url <url>]
 *   tessera skill keygen|sign|install-local|publish|list|install|installed
 *   tessera vault store|list|delete|rotate-key
 *   tessera backup create|restore
 *   tessera memory lessons --user <id>
 *
 * Environment variables (can be set in .env — run `tessera init`):
 *   GATEWAY_HMAC_SECRET  — HMAC secret for token generation
 *   GATEWAY_TOKEN        — Bearer token for API calls
 *   GATEWAY_URL          — Gateway base URL (default: http://127.0.0.1:18789)
 */
import { loadDotenv } from "@tessera/shared";
loadDotenv(); // load .env before any command reads process.env

import { Command } from "commander";
import { tokenCommand } from "./commands/token.js";
import { sessionCommand } from "./commands/session.js";
import { healthCommand } from "./commands/health.js";
import { skillCommand } from "./commands/skill.js";
import { vaultCommand } from "./commands/vault.js";
import { initCommand } from "./commands/init.js";
import { backupCommand } from "./commands/backup.js";
import { memoryCommand } from "./commands/memory.js";

const program = new Command();

program
  .name("tessera")
  .description("Tessera — secure personal AI agent CLI")
  .version("0.1.0");

program.addCommand(initCommand());
program.addCommand(tokenCommand());
program.addCommand(sessionCommand());
program.addCommand(healthCommand());
program.addCommand(skillCommand());
program.addCommand(vaultCommand());
program.addCommand(backupCommand());
program.addCommand(memoryCommand());

program.parse();
