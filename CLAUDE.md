# Tessera — Claude Code Project Instructions

## Document maintenance (MANDATORY after every task)

After completing any non-trivial task, you MUST update these files before marking the work done:

1. **`ROADMAP.md`** — Mark completed items with ✅ in the "Immediate next actions" table
   and in the phase feature list. Update the test count if it changed.

2. **`memory/MEMORY.md`** (in `/home/rafael/.claude/projects/-home-rafael-projects-SecureClaw/memory/`)
   — Update the "Build Status" test count, add new patterns or architecture decisions,
   update "Remaining Work" priority order.

Do this in the same session, not as a follow-up. If the task adds new env vars, also
update `.env.example`.

---

## Build & test discipline

- Always run `pnpm -r build` after changing TypeScript files.
- Always run affected package tests (`pnpm --filter @tessera/<pkg> test`) before
  considering a task done.
- The integration tests (package `@tessera/integration`) require Docker — skip them
  with `pnpm --filter '!@tessera/integration' -r test` for unit-only runs.
- Test count target: all existing tests must stay green. Never suppress a test to make
  CI pass.

---

## Security invariants — NEVER relax these

1. Gateway bound to `127.0.0.1` only (no `0.0.0.0`)
2. HMAC auth on every authenticated route — no bypass, no skip
3. Tokens in `Authorization` header only; `?token=` ONLY permitted for WebSocket upgrades
4. gVisor required for tool execution (`TESSERA_ALLOW_RUNC=true` is a dev escape hatch only)
5. LLM sees only `__VAULT_REF:id__` placeholders — raw secrets never in context or logs
6. Audit log: SQLite triggers block UPDATE/DELETE on `audit_events`
7. All tool output scanned for injection before entering LLM context
8. SSRF: `checkUrlSafetyResolved` validates hostname + DNS-resolved IPs; fail-closed on DNS error

If a task would require relaxing any of these, stop and ask the user explicitly.

---

## TypeScript strictness

This project uses `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`.

- Optional properties: use spread pattern `...(val !== undefined && { field: val })`.
- Array index access: always guard with `if (arr[i] !== undefined)`.
- Never use `as any` without a comment explaining why.

See `PATTERNS.md §E` for examples.

---

## Credential injection pipeline (skills)

When adding a new skill that needs vault credentials:
1. Declare `credential_refs: ["my-key-name"]` in `manifest.template.json` under `permissions`
2. The agent-loop reads this at manifest load time — no other changes needed in runtime
3. Tell the user to run: `tessera vault store my-key-name <value>`
4. The vault namespace for all skill credentials is `service="skill-creds"`

---

## Subagent guidance

| Task type | Agent to use |
|---|---|
| Find files / search codebase across multiple locations | `Explore` (medium/very thorough) |
| Design a new feature with trade-offs | `Plan` |
| Quick single-file or keyword search | `Glob` / `Grep` directly (faster) |
| Multi-step autonomous tasks (research + code) | `general-purpose` |
| Questions about Claude Code CLI or API | `claude-code-guide` |

Run agents in **parallel** when their tasks are independent.

---

## Design System & UI/Frontend Work

See `PATTERNS.md §Design-System` for full checklist, accessibility requirements, and component patterns.

**Stack**: React 18 + TypeScript strict, Vite (5173), Tailwind CSS, shadcn/ui, WebSocket.
**Tools**: `mcp__shadcn__*`, `mcp__magic__21st_magic_component_builder`, `mcp__reactbits__*`.
**Handoff**: design-lead → `DESIGN_FLOWS.md` → frontend-lead briefs → frontend-dev.

---

## Package structure quick reference

| Path | Package | Port |
|---|---|---|
| `packages/shared` | `@tessera/shared` | — |
| `packages/credential-vault` | `@tessera/credential-vault` | 19002 |
| `packages/audit-system` | `@tessera/audit-system` | 19003 |
| `packages/input-sanitizer` | `@tessera/input-sanitizer` | — |
| `packages/sandbox-runtime` | `@tessera/sandbox-runtime` | 19004 |
| `packages/agent-runtime` | `@tessera/agent-runtime` | 19001 |
| `packages/gateway` | `@tessera/gateway` | 18789 |
| `packages/skills-engine` | `@tessera/skills-engine` | 19005 |
| `packages/memory-store` | `@tessera/memory-store` | 19006 |
| `packages/cli` | `@tessera/cli` | — |
| `apps/control-ui` | control-ui (Vite/React) | 5173 |
| `skills/tessera/read-url` | bundled skill | — |
| `skills/tessera/web-search` | bundled skill (SerpAPI) | — |

---

## MCP servers

See `.mcp.json`: **shadcn** (shadcn/ui registry), **context7** (library docs), **playwright** (E2E), **github** (CI/PR).

---

## Domain context modules

Load these in addition to this file when working in a specific domain.
The task brief specifies which to load — do not load all of them by default.

| Domain | File | Load when |
|--------|------|-----------|
| Backend / gRPC / Fastify / DB | `CLAUDE-backend.md` | Any TypeScript service work |
| Frontend / React / UI | `CLAUDE-frontend.md` | Any `apps/control-ui/` work |

---

## Code & Architecture Patterns (core — universal rules)

> Domain-specific rules (§A–§D, §G–§J for backend; §K for frontend) live in the domain modules above.
> Full examples live in `PATTERNS.md`. Open issues in `PATTERN-ISSUES.md`.

### E. TypeScript Strictness

**E.1** Spread for optional properties — `...(val !== undefined && { field: val })`. See `PATTERNS.md §E`.

**E.2** Guard index access — `if (arr[i] === undefined) throw ...`.

**E.3** No `as any` without a comment + issue # or TODO.

**E.4** Zod is single source of truth for external shapes. Use `z.infer<typeof Schema>`, never a parallel interface. Use `z.enum(["a","b"])` not TypeScript `enum`.

**E.5** `.js` extension on all relative imports — required for Node ESM.

---

### F. Testing Patterns

**F.1** Co-locate tests: `src/services/foo.service.test.ts` alongside source.

**F.2** Naming: `describe("ClassName", () => { it("method: what it does", ...) })`. Never `it("should ...")`.

**F.3** Manual test doubles inline. Never `vi.mock(...)` on in-process service classes — only for external I/O.

**F.4** All async test functions MUST be `async`. No floating promises.

**F.5** Never `.skip` without a `// TODO: https://github.com/...` comment above.

---

### G–H. Logging, Observability, Config

See `CLAUDE-backend.md §G` and `§H` — these rules apply to all service code.

---

### I. Module / Import Rules

**I.1** All packages are ESM (`"type": "module"`). Always `.js` extension on relative imports.

**I.2** Import from `@tessera/<pkg>` — never relative paths crossing package boundaries.

**I.3** Proto files only through `packages/shared/src/grpc/loader.ts`. All `.proto` in `packages/shared/src/proto/`.

**I.4** `export * from` OK for `@tessera/shared`. For other packages, export only public API.

---

### J. Security Coding Rules

See `CLAUDE-backend.md §J` — applies to all service code. Summary: Zod on every body, bound SQL params, no logging auth headers, strip vault refs before LLM.

---

### K. Frontend Patterns

See `CLAUDE-frontend.md §K` — load when working on `apps/control-ui/`.

---

### L. PR & Task Workflow

**L.1** Task IDs: `T-{phase}-{seq:02d}` format (`T-3-01`, `T-3-12`). Never free-form names.

**L.2** Every non-trivial PR MUST update `ROADMAP.md` + `MEMORY.md` in the same commit set.

**L.3** Test count MUST NOT decrease. Deleting a test requires explicit justification.

**L.4** PRs touching `packages/gateway`, `packages/credential-vault`, `packages/audit-system`, or `packages/input-sanitizer` MUST include a `## Security Review` section.
