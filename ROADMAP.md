# Tessera — Project Roadmap

## Project goal

Security-first personal AI agent that enterprises and individuals can deploy
on-premise with full auditability, EU AI Act compliance, and zero trust toward
the LLM. Competes on security depth where general-purpose agents (OpenClaw,
etc.) cut corners.

---

## What is done today

### Core infrastructure (Blocks 1–7, commits 92f5b55–e9e1e4d) ✅

| Component | Port | Notes |
|---|---|---|
| `@tessera/shared` | — | Zod schemas, proto loader, gRPC type interfaces |
| `@tessera/credential-vault` | 19002 | AES-256-GCM file + keytar dual-backend |
| `@tessera/audit-system` | 19003 | Append-only SQLite, tamper-resistant triggers |
| `@tessera/input-sanitizer` | — | Heuristic + LLM injection classifier |
| `@tessera/sandbox-runtime` | 19004 | gVisor container execution, resource limits |
| `@tessera/agent-runtime` | 19001 | Session manager, policy engine, approval gate |
| `@tessera/gateway` | 18789 | Fastify, HMAC auth, rate limiting, 127.0.0.1 only |
| `@tessera/channel-webchat` | — | Static HTML + WebSocket chat client |
| `@tessera/skills-engine` | 19005 | Ed25519-signed tool bundles, gRPC registry |
| `@tessera/memory-store` | 19006 | SQLite + FTS5, session/message persistence |
| `@tessera/control-ui` | 5173 | React dashboard (Vite) — full chat panel |
| `@tessera/cli` | — | `tessera` CLI (token, session, skill keygen/sign/install-local) |
| Telegram channel | — | Bot adapter (profile: channels) |
| Slack channel | — | Socket Mode adapter (profile: channels) |
| Integration tests | — | Docker Compose stack, mock LLM, E2E suite |

### Phase 1 — Enterprise foundation (commit e624dff)

| Feature | Status |
|---|---|
| EU AI Act compliance dashboard (Art. 9, 12, 14, 15) | ✅ complete |
| Cost showback / chargeback (team_id, CSV export) | ✅ complete |
| OpenTelemetry SDK wiring (`telemetry.ts`, Jaeger compose) | ✅ complete |
| **OTel spans in agent-loop** (LLM calls, tool exec, approval wait) | ✅ complete |
| Skills marketplace (publish, list, install, download count) | ✅ complete |
| CLI `skill` commands (publish, list, install, installed) | ✅ complete |
| Control UI: Compliance, Costs, Marketplace tabs | ✅ complete |
| Dual-backend keychain (keytar + AES-256-GCM fallback) | ✅ complete |
| Unit tests: 344 total | ✅ passing |
| Integration compose stack fixed (3-file chain, profiles) | ✅ complete |
| **SSRF prevention** (`checkUrlSafety` — 7 ordered checks, 36 tests) | ✅ complete |
| **DNS rebinding defence** (`checkUrlSafetyResolved` — async DNS resolve + IP check) | ✅ complete |
| **Tool output injection defence** (all tool results piped through `sanitizeExternalContent`) | ✅ complete |
| **Agent turn cap** (`AGENT_MAX_TURNS_PER_SESSION`, default 20) | ✅ complete |
| **Control-UI chat panel** (streaming WS, tool approval, cost receipt) | ✅ complete |
| **`tessera/read-url` skill** (first bundled skill — Node.js URL fetcher) | ✅ complete |
| **CLI skill tooling** (`tessera skill keygen`, `sign`, `install-local`) | ✅ complete |
| **Gateway `/api/v1/skills`** (`GET` list + `POST` install-local) | ✅ complete |
| **Dockerfile COPY fix** (removed `2>/dev/null \|\| true` from all 9 service Dockerfiles) | ✅ complete |
| **`tessera/web-search` skill** (SerpAPI, `credential_refs`, vault injection end-to-end) | ✅ complete |
| **Credential injection pipeline** (`SkillToolRoute.credential_refs` → `getSecretRef` → `injectCredential`) | ✅ complete |
| **`tessera vault` CLI** (`store`, `list`, `delete` under `skill-creds` namespace) | ✅ complete |
| **`docker/agent-runtime.Dockerfile`** — added missing `input-sanitizer` layer | ✅ complete |
| **OTel gateway spans** (`telemetry.ts`, onRequest/onResponse hooks, token-leak-safe http.url) | ✅ complete |
| Unit tests: 356 total (+7 gateway OTel tests, +5 helmet tests) | ✅ passing |

### Security invariants (permanent, never relax)

1. Gateway bound to 127.0.0.1 only
2. HMAC auth on every authenticated route — no bypass
3. Tokens in `Authorization` header only; `?token=` only permitted on WebSocket upgrades (browsers cannot set custom WS headers)
4. gVisor required for tool execution (dev escape hatch: `TESSERA_ALLOW_RUNC=true`)
5. LLM sees only `__VAULT_REF:id__` placeholders, never raw secrets
6. Audit log: SQLite triggers block UPDATE/DELETE on `audit_events`
7. All tool output scanned for injection before entering LLM context
8. SSRF: `checkUrlSafetyResolved` validates hostname string + DNS-resolved IPs; fail-closed on DNS error

---

## Cross-cutting requirement: easy install & cross-platform

> **Requirement:** Tessera must be easy to install, easy to test locally,
> and must work on Windows, macOS, and Linux without extra steps.
> This is a prerequisite for every other phase — there is no point building
> enterprise features if developers cannot run the project in five minutes.

### Summary

| Sub-phase | What | Why it matters |
|---|---|---|
| **DX-A** ✅ | Replace `better-sqlite3` with built-in `node:sqlite` | Zero native compilation — no Visual Studio Build Tools, no prebuilt binary lookups; requires Node 22.13+ |
| **DX-B** ✅ | `pnpm dev` single command via `concurrently` | Replaces 6 terminal tabs with one colour-coded command |
| **DX-C** ✅ | `tessera init` wizard + `.env` support | Generates secrets, asks for API key, prints next steps — first chat in under 5 minutes from a clean clone |
| **DX-D** ✅ | GitHub Actions CI matrix (Windows × macOS × Linux × Node 20 / 22) | `.github/workflows/cross-platform.yml`: Node 22 = build+test on all 3 OS; Node 20 = build-only (node:sqlite unavailable) |

### Current problems

| Problem | Root cause | Affected OS |
|---|---|---|
| `better-sqlite3` fails without Visual Studio Build Tools | Native addon compiled from C++ source, no prebuilt binary found for Node 24 | Windows |
| `keytar` fails on headless Linux/WSL | libsecret / D-Bus not available | Linux headless, WSL |
| Starting the project requires 6 terminal tabs | No process orchestrator | All |
| No guided first-run experience | No `init` command or setup wizard | All |
| Tokens expire in 5 min (hardcoded) | Hardcoded constant in gateway | All |

### Phase DX-A — Eliminate native compilation requirement

**Problem:** `better-sqlite3` compiles a C++ addon at install time. On Windows
this requires Visual Studio Build Tools + Python. If the prebuilt binary is
not available for the exact Node.js version the install silently produces a
broken `node_modules`.

**Solution — replace `better-sqlite3` with `@libsql/client` (libSQL)**

`@libsql/client` is a drop-in SQLite-compatible client maintained by Turso. It
ships prebuilt WASM + native binaries for Windows x64, macOS arm64/x64, and
Linux x64/arm64. No compilation step. No build tools required.

Migration scope:
- `packages/audit-system` — largest consumer (cost_ledger, audit_events, schema)
- `packages/memory-store` — sessions + messages + FTS5
- Both use the sync `better-sqlite3` API (`db.prepare().get()` / `.run()`)
- `@libsql/client` is async; all service methods become `async` + `await`
- FTS5 is supported by libSQL (same SQLite engine underneath)
- SQLite triggers (append-only guard) are supported

Alternative (lower effort): use `better-sqlite3-multiple-ciphers` or pin to a
`better-sqlite3` version that publishes prebuilt binaries for Node 24 Windows
via `node-pre-gyp`. Less reliable long-term.

Estimated effort: 2 sessions.

### Phase DX-B — Single-command local start

Replace the 6-terminal-tab workflow with one command:

```bash
pnpm dev          # starts all services concurrently with colour-coded output
```

Implementation:
- Add `concurrently` to the root devDependencies.
- Root `package.json` script:
  ```json
  "dev": "concurrently --names \"vault,audit,memory,skills,sandbox,agent,gateway,ui\" ..."
  ```
- Each service printed in a distinct colour; crash of any one service is
  immediately visible and labelled.
- `pnpm dev:services` — all backend services only (no UI), for API testing.
- `pnpm dev:ui` — only the Vite dev server, assumes services are already up.

Estimated effort: 0.5 sessions.

### Phase DX-C — First-run setup wizard

```bash
tessera init
```

Interactive CLI that:
1. Detects the platform (Windows/macOS/Linux).
2. Generates a cryptographically random `GATEWAY_HMAC_SECRET` and
   `VAULT_MASTER_KEY` and writes them to a `.env` file (git-ignored).
3. Asks for the LLM provider API key (optional — can skip for offline/Ollama).
4. Asks for the Anthropic model to use (default: `claude-sonnet-4-6`).
5. Prints a quick-start summary:
   ```
   ✓ .env created
   Run:  pnpm dev
   Then: open http://127.0.0.1:5173
   ```

Add `.env` support to all services (load via `dotenv` at startup if `.env`
exists, so users do not need to export variables manually).

Estimated effort: 1 session.

### Phase DX-D — Cross-platform CI matrix ✅

**Implemented:** `.github/workflows/cross-platform.yml`

Matrix: `os: [ubuntu-latest, windows-latest, macos-latest]` × `node: [20, 22]`

| Node version | Steps | Reason |
|---|---|---|
| 22 | install → build → **test** | Minimum supported version; `node:sqlite` unflagged in 22.13+ |
| 20 | install → **build only** | `node:sqlite` not available; verifies TypeScript compilation only |

Features:
- `fail-fast: false` — all 6 combinations run even if one fails
- Concurrency cancellation — in-flight runs for same PR are cancelled
- `pnpm/action-setup@v4` with `cache: pnpm` for fast installs

This makes cross-platform regressions visible immediately instead of
discovered when a user tries to run on a new OS.

### DX acceptance criteria

Before any Phase 2 work starts, the following must all be true:

- [ ] `pnpm install && pnpm dev` works on Windows 11 (native, no WSL, no Build Tools)
- [ ] `pnpm install && pnpm dev` works on macOS 14 (Apple Silicon)
- [ ] `pnpm install && pnpm dev` works on Ubuntu 22.04 (no GUI, no libsecret)
- [x] `tessera init` creates a valid `.env` and prints clear next steps (DX-C ✅)
- [x] CI runs and passes on all three OS + Node 22 matrix (DX-D ✅)
- [ ] First successful chat achievable in under 5 minutes from a clean clone

---

## Remaining Phase 1 work

All Phase 1 items complete. ✅

---

## Phase 2 — Hardening & operational maturity

Target: production-ready for single-org self-hosted deployment.
Prerequisite: Phase 1 OTel spans complete.

### 2A — Usage quotas & alerting ✅ (1/2 items complete)

**Hard per-team spending caps** ✅ COMPLETE

Currently costs are tracked and reported but never enforced. A team can spend
unlimited money. This phase adds:

- `cost_ledger` enforcement: when a team's spend in the current billing period
  reaches `team_quota_usd`, subsequent LLM calls are rejected with a clear
  error returned to the session.
- Quota config stored in a new `team_quotas` SQLite table in audit-system.
- Gateway: `GET /api/v1/costs/teams/:teamId/quota` and
  `PUT /api/v1/costs/teams/:teamId/quota` (admin token required).
- Control UI: quota bar overlay on cost bars (red = over 80%).

**Webhook alerting**

New `@tessera/alerting` package (or module in gateway) that fires HTTP
webhooks on configurable events:

| Trigger | Example payload |
|---|---|
| `APPROVAL_REQUESTED` | session_id, tool_id, user_id, timestamp |
| `QUOTA_BREACH` | team_id, spent_usd, quota_usd |
| `INJECTION_DETECTED` | session_id, severity, excerpt (sanitised) |
| `POLICY_DENIED` | session_id, tool_id, reason |

Config: `WEBHOOK_URL` env var + optional `WEBHOOK_SECRET` for HMAC signing of
webhook bodies (same pattern as gateway token).

Estimated effort: 2 sessions.

### 2B — Vault key rotation

The vault currently has a single master key (SHA-256 of `VAULT_MASTER_KEY`).
If the key is compromised all secrets are exposed. This phase adds:

- `tessera vault rotate-key --new-key <hex>` CLI command.
- Rotation procedure: decrypt all entries with old key → re-encrypt with new
  key → atomic rename of the JSON file → update env var.
- Key versioning: store `{"v":1, "key_id":"sha256-prefix", "entries":{...}}`
  so the system can detect a mismatch between the file's key version and the
  current `VAULT_MASTER_KEY`.

On Windows/macOS, keytar handles this differently (OS manages key material),
so rotation only applies to the file-based fallback backend.

Estimated effort: 1 session.

### 2C — Backup & restore

Export/import of all persistent state:

```
tessera backup create --output backup-2026-02-26.tar.gz
tessera backup restore --input backup-2026-02-26.tar.gz
```

Covers: audit DB, vault keys file, skills registry, marketplace registry,
memory DB. Each service exposes a `DumpState` / `RestoreState` gRPC call, and
the CLI orchestrates the sequence.

Estimated effort: 2 sessions.

### 2D — Configurable token expiry & refresh ✅

- `TOKEN_EXPIRY_SECONDS` env var (default: 300, range: 30–604800).
- `GET /api/v1/token/config` — public endpoint returns `{ expiry_seconds }`.
- `POST /api/v1/token/refresh` — accepts a valid token, returns a fresh one.
- CLI: `tessera token refresh [--token <t>] [--url <url>]`.
- Control UI: heartbeat interval at `(expiry_seconds - 60)s`; pings `/health`;
  forces re-login if session expires. Green/amber/red dot in header.
- 38 new gateway tests (auth plugin + token route); 266 total.

### 2E — Advanced injection detection

Current detection: heuristic regex + optional LLM classifier. Gaps:

- No detection of encoded payloads (base64, URL-encoding, Unicode homoglyphs).
- No rate-based detection (many small injections across turns).

Additions:
- Decode-then-scan: strip common encodings before heuristic check.
- Turn-level injection score: accumulate suspicion across the conversation;
  escalate to `INJECTION_DETECTED` when score crosses threshold.
- Configurable sensitivity: `INJECTION_SENSITIVITY=low|medium|high` (default:
  `medium`).

Estimated effort: 1.5 sessions.

---

## Phase 3 — Enterprise multi-tenancy

Target: support multiple independent organisations on one Tessera instance.
Prerequisite: Phase 2 complete.

### 3A — RBAC (role-based access control)

Three built-in roles per organisation:

| Role | Capabilities |
|---|---|
| `admin` | Full access — manage quotas, rotate keys, manage skills |
| `operator` | Chat, view audit log, manage own credentials |
| `viewer` | Read-only — audit log, compliance report, cost report |

- Roles encoded in the HMAC token claims (`{userId}.{role}.{timestamp}.{hmac}`).
- Gateway enforces role checks per route via a `requireRole()` plugin.
- Control UI hides write actions for viewer/operator roles.

Estimated effort: 2 sessions.

### 3B — SSO / OIDC integration

Allow organisations to authenticate via their existing identity provider
(Auth0, Okta, Azure AD, Google Workspace):

- New `@tessera/auth-oidc` package: OIDC callback endpoint at
  `GET /api/v1/auth/callback`.
- On successful OIDC login, exchange the ID token for a Tessera HMAC token
  (short-lived, role derived from OIDC claims / group membership).
- Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` env vars.
- Fallback: HMAC tokens still work for service accounts and CI.

Estimated effort: 2 sessions.

### 3C — Policy-as-code

Currently tool policy is hardcoded in `agent-runtime/src/index.ts`. Replace
with a declarative YAML policy file:

```yaml
# tessera-policy.yaml
default: deny
tools:
  - id: file_read
    allow: true
    requires_approval: false
    sandbox: true
    max_per_session: 50
  - id: shell_exec
    allow: true
    requires_approval: true
    sandbox: true
    timeout_seconds: 60
    max_per_session: 10
    allowed_for_roles: [admin, operator]
```

- Policy hot-reload: `SIGHUP` triggers policy reload without restart.
- Validation: Zod schema + `tessera policy validate <file>` CLI command.
- Audit: policy changes logged as `POLICY_UPDATED` events.

Estimated effort: 1.5 sessions.

### 3D — Audit export (SIEM integration)

Stream audit events to external systems in real time:

- **Webhook stream**: `POST` each event to a configured URL as it is inserted.
- **Syslog**: RFC 5424 UDP/TCP syslog output (for Splunk, Elastic SIEM, etc.).
- **File export**: `tessera audit export --format jsonl --from <date>` for
  bulk historical export.
- Control UI: "Export audit log" button with date range picker.

Estimated effort: 1.5 sessions.

### 3E — Organisation isolation

Full data isolation between organisations (multi-tenant):

- Each org gets its own SQLite databases (audit, memory) in an
  `ORGS_DATA_DIR/<org_id>/` subdirectory.
- Vault: each org has its own `keys.enc.json` under a separate data dir.
- Skills: separate registries per org (org-scoped marketplace namespace).
- Gateway: org extracted from token (`{orgId}/{userId}.{role}.{ts}.{hmac}`),
  all gRPC calls carry org_id in metadata.
- Migration: existing single-org data becomes `default` org.

Estimated effort: 3 sessions (significant structural change).

---

## Phase 4 — AI safety & adversarial robustness

Target: research-grade safety controls suitable for high-risk AI Act categories.
Prerequisite: Phase 3 complete.

### 4A — Output filtering

Inspect LLM responses before they reach the user:

- PII detection: regex + NER model scan on assistant messages; redact detected
  PII (names, emails, phone numbers, credit cards) unless explicitly permitted.
- Content policy: configurable blocklist for response content categories.
- Logged as `OUTPUT_FILTERED` audit events with redacted excerpt.

### 4B — Red team / adversarial testing framework

- `tessera redteam run --scenario <file>` command: loads a YAML file of
  adversarial prompts, runs them through the agent, reports which were blocked.
- Built-in scenario library: prompt injection, jailbreak attempts, data
  exfiltration probes.
- CI integration: run red team scenarios in CI on every PR; fail if a
  previously-blocked scenario now passes.

### 4C — Formal policy verification

- Model tool policies as a finite state machine.
- Use a lightweight model checker to verify that no sequence of tool calls can
  reach a forbidden state (e.g. "write to filesystem without prior approval").
- `tessera policy verify <file>` — exits non-zero if policy has reachable
  unsafe states.

### 4D — Skill provenance chain

Extend the marketplace with a full provenance chain:

- Each published skill records: author key fingerprint, build timestamp, source
  repo hash, Trivy scan result, reviewer signatures (optional multi-sig).
- `tessera skill inspect <ns/name>` prints the full provenance chain.
- Gateway can be configured to only install skills with `trivy_scan_passed=true`
  and at least one reviewer signature.

---

## Immediate next actions (priority order)

| # | Task | Effort | Phase |
|---|---|---|---|
| 1 | ~~Replace `better-sqlite3` with `node:sqlite` (built-in)~~ ✅ | done | DX-A |
| 2 | ~~`pnpm dev` single-command start~~ ✅ | done | DX-B |
| 3 | ~~`tessera init` wizard + `.env` support~~ ✅ | done | DX-C |
| 4 | ~~GitHub Actions CI matrix~~ ✅ | done | DX-D |
| 5 | ~~OTel spans in agent-loop~~ ✅ | done | Phase 1 |
| 6 | ~~Token expiry + refresh endpoint~~ ✅ | done | Phase 2D |
| 7 | ~~SSRF prevention + DNS rebinding defence~~ ✅ | done | Security |
| 8 | ~~Tool output injection defence~~ ✅ | done | Security |
| 9 | ~~Agent turn cap (`AGENT_MAX_TURNS_PER_SESSION`)~~ ✅ | done | Security |
| 10 | ~~Control-UI chat panel~~ ✅ | done | UX |
| 11 | ~~First bundled skill (`tessera/read-url`) + CLI tooling~~ ✅ | done | Skills |
| 12 | ~~`tessera/web-search` skill + `tessera vault` CLI + credential injection pipeline~~ ✅ | done | Skills |
| 13 | ~~Security headers (`@fastify/helmet` on gateway)~~ ✅ | done | Security |
| 14 | ~~OTel completion — gateway spans + OTLP export~~ ✅ | done | Phase 1 |
| 15 | ~~Token refresh in Control-UI (proactive refresh + silent reconnect, history preserved)~~ ✅ | done | UX |
| 16 | ~~Hard quota enforcement per team~~ ✅ | done | Phase 2A |
| 17 | Webhook alerting (approvals, quota, injection) | ~1 session | Phase 2A |
| 18 | Vault key rotation CLI command | ~1 session | Phase 2B |
| 19 | Backup / restore CLI commands | ~2 sessions | Phase 2C |
| 20 | RBAC roles in token + gateway enforcement | ~2 sessions | Phase 3A |

---

## Architecture principles (never compromise)

- **Zero trust toward the LLM**: the model cannot access credentials, approve
  its own tool calls, or see raw secrets. These controls are structural, not
  prompt-based.
- **Append-only audit**: every action is recorded; records cannot be modified
  or deleted. This is the foundation of EU AI Act Art. 12 compliance.
- **Deny by default**: new tool IDs are automatically denied until explicitly
  listed in policy. There is no opt-out of this.
- **Defence in depth**: injection detection at input (sanitizer), session
  boundary (delimiter), policy layer (deny), and audit layer (INJECTION_DETECTED
  event). No single layer is relied upon alone.
- **Minimal blast radius**: gateway on loopback, services on internal network,
  no cross-tenant data access, no root processes.
