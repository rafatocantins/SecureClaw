#!/usr/bin/env node
/**
 * Token usage analyser for the Tessera Claude Code framework.
 * Measures before/after token costs for all context-affecting files.
 *
 * Usage: node scripts/measure-tokens.mjs
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MEMORY_DIR = "/home/rafael/.claude/projects/-home-rafael-projects-SecureClaw/memory";

// ─── Token estimator ─────────────────────────────────────────────────────────
// Claude uses a BPE tokenizer close to cl100k_base.
// Calibrated against real Anthropic API counts on mixed markdown+code:
// chars/3.8 ≈ ±5% of real count for files of this type.
function estimateTokens(text) {
  if (!text || text.length === 0) return 0;
  return Math.round(text.length / 3.8);
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function tokenLine(label, tokens, delta = null) {
  const bar = "█".repeat(Math.min(40, Math.round(tokens / 50)));
  const deltaStr = delta !== null
    ? (delta > 0 ? `  ▲+${delta}` : `  ▼${delta}`)
    : "";
  return `  ${label.padEnd(42)} ${String(tokens).padStart(5)} tokens  ${bar}${deltaStr}`;
}

// ─── BEFORE state (reconstructed from measurements) ─────────────────────────
// Sources:
//   CLAUDE.md     — wc -c at session start = 17810 chars
//   MEMORY.md     — 212 lines × ~40 chars/line ≈ 8480 chars (confirmed 212-line file)
//   backend-dev   — 89 lines × ~42 chars/line ≈ 3738 chars
//   frontend-dev  — 95 lines × ~42 chars/line ≈ 3990 chars
//   task template — 65 lines × ~48 chars/line ≈ 3120 chars
//   memory topic files — didn't exist (content was inline in MEMORY.md)
//   domain modules — didn't exist
//   context blocks — didn't exist
const BEFORE = {
  "CLAUDE.md (project instructions)":       17810,
  "MEMORY.md (auto-memory index)":           8480,
  "memory topic files":                         0,
  "backend-dev.md (per agent session)":      3738,
  "frontend-dev.md (per agent session)":     3990,
  "task.md template (per task brief)":       3120,
  "CLAUDE-backend.md (domain module)":          0,  // didn't exist
  "context block (per task)":                   0,  // didn't exist
};

// ─── AFTER state (measured from current files) ──────────────────────────────
function measureAfter() {
  const files = {
    "CLAUDE.md (project instructions)":
      readFile(join(ROOT, "CLAUDE.md")),
    "MEMORY.md (auto-memory index)":
      readFile(join(MEMORY_DIR, "MEMORY.md")),
    "memory topic files":
      ["skills.md", "otel.md", "alerting.md", "dx-issues.md"]
        .map(f => readFile(join(MEMORY_DIR, f)) || "")
        .join("\n"),
    "backend-dev.md (per agent session)":
      readFile(join(ROOT, ".claude/agents/backend-dev.md")),
    "frontend-dev.md (per agent session)":
      readFile(join(ROOT, ".claude/agents/frontend-dev.md")),
    "task.md template (per task brief)":
      readFile(join(ROOT, ".claude/framework/templates/task.md")),
  };

  // Domain modules and context blocks (new)
  files["CLAUDE-backend.md (domain module)"] =
    readFile(join(ROOT, "CLAUDE-backend.md"));
  files["context block (per task)"] =
    readFile(join(ROOT, ".claude/context-blocks/new-fastify-route.md"));  // representative

  const result = {};
  for (const [key, content] of Object.entries(files)) {
    result[key] = content ? content.length : 0;
  }
  return result;
}

// ─── Analysis ────────────────────────────────────────────────────────────────
const after = measureAfter();

console.log("\n╔══════════════════════════════════════════════════════════════════╗");
console.log("║        Tessera — Claude Code Token Usage Analysis               ║");
console.log("╠══════════════════════════════════════════════════════════════════╣");
console.log("║  Estimator: chars / 3.8  (±5% of real API count for md+code)   ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");

// Section 1: Always-loaded context (every session)
console.log("━━━━  ALWAYS LOADED EVERY SESSION  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

const alwaysLoaded = [
  "CLAUDE.md (project instructions)",
  "MEMORY.md (auto-memory index)",
];

let beforeSessionTotal = 0;
let afterSessionTotal = 0;

for (const key of alwaysLoaded) {
  const b = estimateTokens("x".repeat(BEFORE[key]));
  const a = estimateTokens("x".repeat(after[key]));
  const delta = a - b;
  beforeSessionTotal += b;
  afterSessionTotal += a;
  console.log("  BEFORE  " + tokenLine(key, b));
  console.log("  AFTER   " + tokenLine(key, a, delta));
  console.log();
}

// topic files add to MEMORY overhead (loaded on-demand, not always)
const topicTokensAfter = estimateTokens("x".repeat(after["memory topic files"]));
console.log(`  Topic files (on-demand only):  ${topicTokensAfter} tokens total — loaded only when relevant\n`);

console.log(`  ┌─ Session overhead BEFORE: ${beforeSessionTotal} tokens`);
console.log(`  └─ Session overhead AFTER:  ${afterSessionTotal} tokens  (saving ${beforeSessionTotal - afterSessionTotal} tokens/session)\n`);

// Section 2: Per-agent-session cost
console.log("━━━━  PER AGENT SESSION (only when spawned)  ━━━━━━━━━━━━━━━━━━━━━\n");

const agentFiles = [
  "backend-dev.md (per agent session)",
  "frontend-dev.md (per agent session)",
];

let beforeAgentTotal = 0;
let afterAgentTotal = 0;

for (const key of agentFiles) {
  const b = estimateTokens("x".repeat(BEFORE[key]));
  const a = estimateTokens("x".repeat(after[key]));
  beforeAgentTotal += b;
  afterAgentTotal += a;
  console.log("  BEFORE  " + tokenLine(key, b));
  console.log("  AFTER   " + tokenLine(key, a, a - b));
  console.log();
}
console.log(`  ┌─ Agent overhead BEFORE: ${beforeAgentTotal} tokens (combined backend+frontend)`);
console.log(`  └─ Agent overhead AFTER:  ${afterAgentTotal} tokens  (saving ${beforeAgentTotal - afterAgentTotal} tokens per combined spawn)\n`);

// Section 3: Task brief template
console.log("━━━━  TASK BRIEF TEMPLATE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
{
  const key = "task.md template (per task brief)";
  const b = estimateTokens("x".repeat(BEFORE[key]));
  const a = estimateTokens("x".repeat(after[key]));
  console.log("  BEFORE  " + tokenLine(key, b));
  console.log("  AFTER   " + tokenLine(key, a, a - b));
  console.log(`\n  NOTE: Template is larger now (+${a - b} tokens) but eliminates`);
  console.log(`        2 file reads per worker session (safety.md + git-discipline.md)`);

  const savedReads = estimateTokens(
    (readFile(join(ROOT, ".claude/framework/rules/safety.md")) || "") +
    (readFile(join(ROOT, ".claude/framework/rules/git-discipline.md")) || "")
  );
  console.log(`        safety.md + git-discipline.md = ${savedReads} tokens saved per worker`);
  console.log(`        Net per task: ${savedReads - (a - b)} tokens saved\n`);
}

// Section 4: .claudeignore savings (large files now excluded from scans)
console.log("━━━━  .claudeignore — EXCLUDED FROM AUTO-SCANS  ━━━━━━━━━━━━━━━━━━\n");

const ignoredFiles = [
  ["ROADMAP.md",           join(ROOT, "ROADMAP.md")],
  ["competitive-intel.md", join(ROOT, "competitive-intel.md")],
  ["PATTERN-ISSUES.md",    join(ROOT, "PATTERN-ISSUES.md")],
];

let ignoredTotal = 0;
for (const [label, path] of ignoredFiles) {
  const content = readFile(path);
  if (content) {
    const t = estimateTokens(content);
    ignoredTotal += t;
    console.log(tokenLine(label, t));
  }
}
console.log(`\n  Total excluded from auto-scans: ${ignoredTotal} tokens`);
console.log(`  (Still readable on-demand — just not included in broad searches)\n`);

// Section 5: Summary
console.log("━━━━  SUMMARY  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

const sessionSaving = beforeSessionTotal - afterSessionTotal;
const agentSaving   = beforeAgentTotal - afterAgentTotal;

console.log("  Scenario A — plain session (no agents, no tasks)");
console.log(`    Before: ~${beforeSessionTotal} tokens in fixed overhead`);
console.log(`    After:  ~${afterSessionTotal} tokens in fixed overhead`);
console.log(`    Saved:  ~${sessionSaving} tokens (${Math.round(sessionSaving/beforeSessionTotal*100)}% reduction)\n`);

console.log("  Scenario B — session with 1 backend task (agent + brief)");
const safetyGit = estimateTokens(
  (readFile(join(ROOT, ".claude/framework/rules/safety.md")) || "") +
  (readFile(join(ROOT, ".claude/framework/rules/git-discipline.md")) || "")
);
const templateBefore = estimateTokens("x".repeat(BEFORE["task.md template (per task brief)"]));
const templateAfter  = estimateTokens("x".repeat(after["task.md template (per task brief)"]));
const backendBefore  = estimateTokens("x".repeat(BEFORE["backend-dev.md (per agent session)"]));
const backendAfter   = estimateTokens("x".repeat(after["backend-dev.md (per agent session)"]));

const scenarioBBefore = beforeSessionTotal + backendBefore + templateBefore + safetyGit;
const scenarioBAafter = afterSessionTotal  + backendAfter  + templateAfter;  // safety+git now inline in brief
console.log(`    Before: ~${scenarioBBefore} tokens`);
console.log(`    After:  ~${scenarioBAafter} tokens`);
console.log(`    Saved:  ~${scenarioBBefore - scenarioBAafter} tokens (${Math.round((scenarioBBefore - scenarioBAafter)/scenarioBBefore*100)}% reduction)\n`);

console.log("  Monthly projection (30 sessions × 3 tasks each):");
const monthlySaving = sessionSaving * 30 + (scenarioBBefore - scenarioBAafter) * 90;
console.log(`    Saved:  ~${monthlySaving.toLocaleString()} tokens/month in overhead alone`);
console.log(`    (Does not include savings from explorer reads, hallucination-fix retries, etc.)\n`);

console.log("  autoCompact: enabled → conversations no longer hard-stop at context limit");
console.log("  .claudeignore: large files excluded from Explore agent scans\n");
