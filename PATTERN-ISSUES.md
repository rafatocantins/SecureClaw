# Tessera — Pattern Issues

Issues found by auditing the codebase against the rules in `CLAUDE.md` sections A–L.
Each issue has: severity (P1=blocking/security, P2=quality, P3=style), rule violated, file:line, and recommended fix.

Generated: 2026-04-02

---

## P1 — Blocking / Security

### PATT-001: Unconditional `createInsecure()` not guarded by env check
- **Rule**: B.3 — never `createInsecure()` without a `NODE_ENV` guard
- **File**: `packages/shared/src/grpc/loader.ts` (fallback path when certs missing)
- **Detail**: When cert files are absent and `GRPC_TLS` ≠ `"required"`, insecure credentials are used silently. This is logged to stderr but not blocked in production.
- **Fix**: Add a check: if `NODE_ENV === "production"` and certs are missing, throw — don't fall back to insecure.

### PATT-002: `process.env` accessed inside service methods (not at startup)
- **Rule**: H.1 — env vars must be read at startup, not inside service methods
- **File**: `packages/agent-runtime/src/grpc/agent.impl.ts:45-46`
  - `process.env[\`${req.provider.toUpperCase()}_API_KEY\`]` — read at request time
- **Risk**: If env var is absent, the service starts successfully but fails on first use. Should fail at startup.
- **Fix**: Read and validate API keys at startup in `index.ts`; pass to `AgentImpl` constructor.

### PATT-003: SQL injection surface — no parameterization audit completed
- **Rule**: J.2 — all SQLite statements with runtime values must use bound parameters
- **Status**: Needs grep audit across all packages
- **Grep**: `\.prepare\(\`\`` or `\.exec\(\`` (template literals in SQL)
- **Note**: Main audit-system and credential-vault appear clean, but a full sweep is needed.

---

## P2 — Quality

### PATT-004: Mixed error handling contract in VaultService
- **Rule**: A.3 — choose one pattern per layer; don't mix throw + Result-like returns
- **File**: `packages/credential-vault/src/vault.service.ts`
  - `setSecret()` returns `{ success, error_message }` (Result pattern)
  - `deleteSecret()` throws `CredentialError` on failure
- **Impact**: Callers must handle two different error contracts from the same class.
- **Fix**: Unify to throwing `CredentialError` subclasses everywhere; remove `{ success, error_message }` returns.

### PATT-005: No centralized config modules (`config.ts`)
- **Rule**: H.1 — each package should have a typed `config.ts`; `process.env` only there
- **Files**: Multiple — `packages/gateway/src/server.ts`, `packages/shared/src/grpc/loader.ts`, `packages/agent-runtime/src/grpc/agent.impl.ts`
- **Impact**: Required env vars fail at first use, not at startup. Hard to audit what env vars a service needs.
- **Fix**: Add `src/config.ts` to gateway and agent-runtime that reads + validates all required env vars at module load time.

### PATT-006: `export * from` in shared barrel file
- **Rule**: I.4 — barrel files should explicitly list public API
- **File**: `packages/shared/src/index.ts:1-21`
  - `export * from "./schemas/config.schema.js"` — re-exports all internals
- **Impact**: Any symbol added to those modules becomes public API automatically.
- **Fix**: Replace `export *` with explicit named exports for the public surface.

### PATT-007: `AuditService` calls `prepareStatements()` in constructor
- **Rule**: D.2 — constructors may do sync init but should not have async side effects
- **File**: `packages/audit-system/src/audit.service.ts:75-100`
- **Detail**: `this.prepareStatements()` is synchronous — this is acceptable. However, it is worth noting as a pattern to watch: if prepare logic grows to require async DB setup, it will need to be moved to a factory function.
- **Status**: Currently acceptable (sync only). Track for future migration.

### PATT-008: Fire-and-forget async in WebSocket handler
- **Rule**: F.4 — no floating promises
- **File**: `packages/gateway/src/routes/chat.route.ts:136`
  - `void (async () => { ... })()`
- **Detail**: Errors are caught and logged, but if the inner block throws in a branch that isn't caught, the error is swallowed. Not a security risk currently; degrades observability.
- **Fix**: Wrap with explicit error handler: `(async () => { ... })().catch(err => fastify.log.error({ err }, "WebSocket async block error"))`.

### PATT-009: Manual TS types duplicating proto definitions
- **Rule**: E.4 — Zod/schemas as single source of truth
- **File**: `packages/shared/src/grpc/types.ts`
- **Detail**: TypeScript interfaces mirror `.proto` message shapes — these can drift. Comment says "kept in sync manually".
- **Fix**: Long-term: generate TypeScript types from protos using `protoc-gen-ts` or `ts-proto`. Short-term: add a CI check that compares field names.

### PATT-010: No `.env.example` per-package (only root level)
- **Rule**: H.4 — all env vars documented in `.env.example`
- **Detail**: Each package reads different env vars but there's only one root `.env.example`. Service-specific vars (e.g., `GRPC_CERTS_DIR`, `AGENT_RUNTIME_ADDR`) may not be obvious for per-service deployments.
- **Fix**: Either document all vars in root `.env.example` (acceptable) or add per-package `.env.example.partial` files.

---

## P3 — Style / Technical Debt

### UI-001: Frontend uses inline style objects instead of Tailwind
- **Rule**: K.2 — new code should use Tailwind; inline styles are legacy
- **File**: `apps/control-ui/src/App.tsx:206-254` — entire `const s = { ... }` block at bottom of file
- **Detail**: Color palette uses raw hex (`#0f0f0f`, `#e0e0e0`, `#4caf50`) — not design tokens.
- **Fix**: Migrate to Tailwind + design tokens in `src/theme/`. Phase 3 UI work should use Tailwind exclusively.

### UI-002: WebSocket created directly in Chat component, not a custom hook
- **Rule**: K.3 — WebSocket logic must live in `src/hooks/use*.ts`
- **File**: `apps/control-ui/src/components/Chat.tsx:100+`
- **Detail**: All WebSocket state, connection, message parsing logic is inline in the component (~150 lines). Hard to test and reuse.
- **Fix**: Extract to `src/hooks/useAgentStream.ts`. Component becomes a pure presenter.

### UI-003: Pending approval count passed as prop callback instead of shared state
- **Rule**: K.2 (implicit) — global state should use Context API or a hook, not prop drilling
- **File**: `apps/control-ui/src/App.tsx` → `<Chat onCountChange={setPendingCount} />`
- **Detail**: Works at current scale. Will become unwieldy if more components need approval state.
- **Fix**: When Phase 3 adds more UI panels, introduce a `useAgentState` context.

### PATT-011: Test naming uses free-form descriptions in some files
- **Rule**: F.2 — `it("method: description")` format
- **Grep**: `it\(['"]should ` across `*.test.ts` files — check for "should" prefix violations
- **Fix**: Rename to present-tense imperative format during test maintenance passes.

### PATT-012: `process.stdout.write` for startup messages instead of structured logging
- **Rule**: G.1 — Pino logger preferred; `process.stderr.write` acceptable only at startup
- **Files**: `packages/shared/src/grpc/loader.ts` (TLS status), `packages/agent-runtime/src/grpc/server.ts` (server start)
- **Detail**: These are startup-only and emit before the logger is initialized — acceptable. Document this as the approved pattern for pre-logger boot messages.
- **Status**: Acceptable as-is. Document in CLAUDE.md as the approved exception.

---

## Summary by Priority

| Count | Priority | Action |
|-------|----------|--------|
| 3 | P1 | Fix before next release |
| 7 | P2 | Fix in sprint alongside feature work |
| 5 | P3 | Fix during UI migration / tech debt sprints |

## Grep Commands for CI Enforcement

```bash
# PATT-001: Unconditional insecure gRPC (outside shared loader)
grep -rn "createInsecure()" packages/ --include="*.ts" | grep -v "packages/shared/src/grpc/loader.ts"

# PATT-002: process.env inside service/handler files (not index.ts or config.ts)
grep -rn "process\.env" packages/ --include="*.ts" | grep -v "index\.ts\|config\.ts\|env\.ts\|loader\.ts\|auth\.plugin\.ts"

# PATT-003: Template literals in SQL
grep -rn "\.prepare(\`\|\.exec(\`" packages/ --include="*.ts"

# PATT-006: export * in barrel files
grep -rn "export \* from" packages/*/src/index.ts apps/*/src/index.ts

# PATT-011: "should" in test names
grep -rn "it(['\"]should " packages/ apps/ --include="*.test.ts"

# F.5: skipped tests without issue link
grep -rn "it\.skip\|xit\b\|xdescribe\b" packages/ apps/ --include="*.test.ts"

# J.2: console.log in production code
grep -rn "console\.\(log\|error\|warn\|debug\)" packages/ apps/ --include="*.ts" | grep -v "\.test\.ts"
```
