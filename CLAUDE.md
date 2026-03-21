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

- Optional properties: use spread pattern `...(arr.length > 0 ? { field: arr } : {})`
  rather than assigning `undefined` to an optional field.
- Array index access: always guard with `if (arr[i] !== undefined)` or use `arr[i]!`
  only when certain.
- Never use `as any` without a comment explaining why it's necessary.

---

## Credential injection pipeline (skills)

When adding a new skill that needs vault credentials:
1. Declare `credential_refs: ["my-key-name"]` in `manifest.template.json` under `permissions`
2. The agent-loop reads this at manifest load time — no other changes needed in runtime
3. Tell the user to run: `tessera vault store my-key-name <value>`
4. The vault namespace for all skill credentials is `service="skill-creds"`

---

## Subagent guidance

Use the built-in agent types as follows:

| Task type | Agent to use |
|---|---|
| Find files / search codebase across multiple locations | `Explore` (medium/very thorough) |
| Design a new feature with trade-offs | `Plan` |
| Quick single-file or keyword search | `Glob` / `Grep` directly (faster) |
| Multi-step autonomous tasks (research + code) | `general-purpose` |
| Questions about Claude Code CLI or API | `claude-code-guide` |

Run agents in **parallel** when their tasks are independent (e.g. build-check +
security-review at the same time).

---

## Design System & UI/Frontend Work

### When to use design-lead

Use the **`design-lead`** agent for:
- Defining UX flows and navigation architecture
- Creating component interaction patterns
- Establishing accessibility requirements (WCAG 2.1 AA+)
- Visual design direction and design tokens
- Component library architecture
- Design system strategy and documentation
- UX critique and refinement of existing interfaces

### Available UI tools & resources

| Tool | Use case |
|---|---|
| `mcp__shadcn__*` | Query shadcn/ui registry, view component source, get examples |
| `mcp__magic__21st_magic_component_builder` | Build new components with AI design inspiration |
| `mcp__magic__21st_magic_component_refiner` | Refine/redesign existing UI elements |
| `mcp__reactbits__*` | Search ReactBits component library (animations, patterns, effects) |

### Design system checklist

When establishing or extending the design system:

1. **Design tokens** — Define color palette, typography scales, spacing (8px grid), shadows, borders
   - Store in `apps/control-ui/src/theme/` or as CSS variables
   - Consume via Tailwind config (`tailwind.config.ts`)

2. **Component patterns** — Document in Storybook or `DESIGN_SYSTEM.md`
   - Atomic structure (atoms → molecules → organisms)
   - Props API and usage examples
   - Accessibility notes (ARIA roles, keyboard nav, focus management)

3. **Accessibility baseline (WCAG 2.1 AA)**
   - Color contrast ≥ 4.5:1 for body text (WCAG AA)
   - ≥ 3:1 for UI components
   - Keyboard navigation: Tab order, focus indicators (outline-2 offset-2)
   - Semantic HTML: `<button>`, `<input>`, `<label>` with `for` attribute
   - ARIA live regions for dynamic content
   - Screen reader testing with axe DevTools or similar
   - Test with keyboard only (no mouse)

4. **SEO considerations** (for public pages)
   - Semantic HTML (`<header>`, `<nav>`, `<main>`, `<article>`, `<footer>`)
   - Heading hierarchy (h1 → h2 → h3, no gaps)
   - Image `alt` text (descriptive, not "image of X")
   - Metadata: `<title>`, `<meta description>`, Open Graph tags
   - Structured data (schema.org) if applicable

5. **Responsive design**
   - Mobile-first approach
   - Tailwind breakpoints: `sm:`, `md:`, `lg:`, `xl:`, `2xl:`
   - Test at 320px (mobile), 768px (tablet), 1024px+ (desktop)
   - Touch targets ≥ 44px × 44px

6. **Dark mode** (if applicable)
   - Use Tailwind's `dark:` prefix
   - Define color pairs in design tokens
   - Test contrast in both light and dark

### Frontend architecture

- **React** 18+ with TypeScript strict mode
- **Vite** for bundling (dev server at 5173)
- **Tailwind CSS** for styling
- **shadcn/ui** for component library (pre-built, composable)
- **WebSocket** for real-time chat/streaming (see `apps/control-ui/src/components/Chat.tsx`)

### Design-lead → frontend-dev handoff

1. Design-lead creates flow documents + component specs + accessibility requirements
2. Add to `apps/control-ui/DESIGN_FLOWS.md` or similar
3. Frontend-lead reviews and creates task briefs for frontend-dev workers
4. Frontend-dev implements using shadcn, Tailwind, and existing patterns

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

## MCP servers configured for this project

See `.mcp.json`. Servers available:

- **shadcn** — shadcn/ui component registry (for control-ui React work)
- **context7** — up-to-date library docs (Fastify, gRPC, OTel, Vitest, Commander.js)
- **playwright** — browser E2E testing of control-ui and gateway HTTP routes
- **github** — CI status, PR management, issue creation (requires `GITHUB_PERSONAL_ACCESS_TOKEN`)
