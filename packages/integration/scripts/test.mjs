#!/usr/bin/env node
// test.mjs — Cross-platform test runner for the integration package.
//
// Replaces the previous POSIX shell one-liner that broke on Windows (cmd.exe)
// because it used `[ "$TESSERA_RUN_INTEGRATION" = "1" ]` bash syntax. Node's
// child_process.spawn gives us identical behavior on cmd.exe and sh without any
// shell-specific syntax.
//
// Behavior:
//   - TESSERA_RUN_INTEGRATION !== "1" → print skip message, exit 0.
//   - TESSERA_RUN_INTEGRATION === "1" → spawn vitest and propagate its exit code.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

if (process.env.TESSERA_RUN_INTEGRATION !== "1") {
  console.log("TESSERA_RUN_INTEGRATION not set, skipping integration tests");
  process.exit(0);
}

// Resolve vitest's CLI entry point from its package.json `bin` field, then
// invoke it via `node <entry>`. Running the JS entry directly (rather than
// `node_modules/.bin/vitest`, which is a shell shim / .cmd wrapper on Windows)
// keeps the invocation identical across operating systems.
function resolveVitestEntry() {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (!bin) {
    throw new Error("vitest package.json exposes no bin entry");
  }
  return resolve(dirname(pkgJsonPath), bin);
}

let vitestEntry;
try {
  vitestEntry = resolveVitestEntry();
} catch (err) {
  console.error(`Failed to locate vitest: ${err.message}`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [vitestEntry, "run", "--reporter=verbose"],
  { stdio: "inherit", shell: false }
);

child.on("error", (err) => {
  console.error(`Failed to start vitest: ${err.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`vitest terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
