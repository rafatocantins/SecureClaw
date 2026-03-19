Sprint 1 — MVP Gap (Start immediately)

  Goal: Ship what's needed before any real user touches this.
  Teams involved: Backend · Frontend · DevOps · QA · Design

  T-1-01 — @fastify/helmet

  Team chain: backend-lead → backend-dev

  Prompt for @backend-lead:
  "Plan and brief backend-dev on T-1-01: install @fastify/helmet on the gateway. Read packages/gateway/src/index.ts and all route registration 
  files first. Requirements: (1) register helmet as a Fastify plugin before route registration; (2) configure CSP to allow WebSocket
  connections from same origin; (3) verify the existing HMAC auth and rate-limit hooks are unaffected; (4) run pnpm --filter @tessera/gateway  
  test — all 38 tests must still pass; (5) add a test asserting X-Content-Type-Options: nosniff is present on /health. Effort: S. Branch:      
  task/T-1-01-helmet. After implementation, mark READY_FOR_QA and update changelog-buffer.md."

  ---
  T-1-02 — Token refresh in Control-UI

  Team chain: design-lead → frontend-lead → frontend-dev

  Prompt for @design-lead:
  "Finalise and APPROVE the 'Token Expiry + Refresh' flow in .claude/state/ux-flows.md. It currently has a DRAFT. Specifically decide: (1)     
  exact timing — when does the dot turn amber relative to expiry? (2) what text does the non-blocking banner show? (3) does the chat input     
  disable during reconnect or stay active? (4) what is the exact reconnect button behaviour — does it re-use the existing token endpoint or    
  redirect to a login page? Check apps/control-ui/src/components/Chat.tsx to understand the current SessionDot and WS reconnect logic before   
  deciding. Mark the flow APPROVED when done."

  Prompt for @frontend-lead (after design-lead approves the flow):
  "Read the approved Token Expiry + Refresh flow in .claude/state/ux-flows.md. Read apps/control-ui/src/components/Chat.tsx fully. Then brief  
  frontend-dev on T-1-02: implement token refresh before expiry. Requirements: (1) read GET /api/v1/token/config on mount to get
  expiry_seconds; (2) set a timer at (expiry_seconds - 60)s to call POST /api/v1/token/refresh; (3) on success: update token state, reconnect  
  WS silently, dot stays green; (4) on failure: dot turns red, show non-blocking amber banner per the approved UX flow; (5) preserve all chat  
  history in state during reconnect — no data loss; (6) no raw token in rendered HTML. Branch: task/T-1-02-token-refresh. Mark READY_FOR_QA    
  after passing build."

  ---
  T-1-03 — Cross-platform DX validation

  Team chain: devops-lead → devops-engineer

  Prompt for @devops-lead:
  "Assign T-1-03 to devops-engineer: verify and document that pnpm install && pnpm dev works on macOS 14 (Apple Silicon) and Windows 11        
  (native, no WSL). Read .github/workflows/cross-platform.yml and package.json root dev scripts first. The engineer should: (1) review the CI  
  workflow output for the last run on all 3 OS — check if there are any failures; (2) identify any dependency that could break on those        
  platforms that CI wouldn't catch (e.g., scripts that use Linux-only bash syntax); (3) write a one-page 'First Run Guide' as docs/FIRST_RUN.md
   with exact steps from clone to first chat; (4) document the validation result in .claude/state/leads-summary.md. If any issue is found,     
  create an issue file immediately. Branch: task/T-1-03-dx-validation."

  ---
  T-1-04 — QA baseline

  Team chain: qa-lead → qa-engineer

  Prompt for @qa-lead:
  "Brief qa-engineer on T-1-04: run the full test suite, establish the coverage baseline, and fill in .claude/state/qa-coverage.md with current
   data. Requirements: (1) run pnpm --filter '!@tessera/integration' -r test and report exact count per package; (2) confirm all 344 tests     
  still pass — if any fail, create an ISSUE immediately (P1); (3) identify and document 3 highest-priority coverage gaps in qa-coverage.md; (4)
   run the gateway tests specifically with pnpm --filter @tessera/gateway test and confirm auth, rate-limit, and health routes all covered; (5)
   check if tessera vault CLI commands have tests — they likely don't (document as gap). This task has no code changes — only test runs and    
  documentation. No branch needed."

  ---
  Sprint 2 — Observability + Quota Enforcement

  Goal: Make the system measurable and enforce spending limits.
  Teams involved: Backend · Frontend · QA · Security Reviewer

  B-03 — OTel gateway spans

  Prompt for @backend-lead:
  "Plan Sprint 2 task for B-03: add OpenTelemetry spans to the gateway. Read packages/agent-runtime/src/llm/agent-loop.ts to understand the    
  existing OTel span pattern (LLM calls, tool exec, approval wait). Apply the same pattern to the gateway: (1) span for each authenticated     
  request (route name, method, status code); (2) span for gRPC calls from gateway to agent-runtime; (3) OTLP_ENDPOINT env var — if set, export 
  via OTLP HTTP; if not set, log-only (no crash); (4) update .env.example with OTLP_ENDPOINT doc; (5) update the Jaeger docker-compose service 
  if needed. Brief backend-dev. Effort M."

  ---
  B-04 — Hard quota enforcement

  Prompt for @backend-lead:
  "Plan Sprint 2 task for B-04: enforce team spending quotas. Context: costs are tracked in cost_ledger in audit-system but never enforced.    
  Needs: (1) new team_quotas SQLite table in audit-system (team_id, quota_usd, period: monthly|rolling30d); (2) gateway routes: GET
  /api/v1/costs/teams/:teamId/quota and PUT /api/v1/costs/teams/:teamId/quota (admin token required — note: admin role doesn't exist yet, use a
   separate ADMIN_TOKEN env var as a short-term solution); (3) agent-loop checks quota before each LLM call — if exceeded, reject with clear   
  error chunk to the session; (4) the check must be fast — cache the quota result for 60s, don't hit SQLite on every token. Read
  packages/audit-system/ and packages/agent-runtime/src/llm/agent-loop.ts before briefing. Effort M."

  Prompt for @frontend-lead:
  "Plan Sprint 2 task for B-04 (UI part): add quota bar to Costs tab. Read apps/control-ui/src/ Costs component. Requirements: (1) fetch GET   
  /api/v1/costs/teams/:teamId/quota; (2) overlay a quota progress bar on the existing cost bar chart — red fill when >80%; (3) show quota      
  amount and remaining in the tab. Coordinate with backend-lead on the API shape before implementing. Effort S."

  ---
  B-05 — Webhook alerting

  Prompt for @backend-lead:
  "Plan Sprint 2 task for B-05: webhook alerting for key events. New module in gateway (not a separate package — avoid package bloat).
  Triggered on: APPROVAL_REQUESTED, QUOTA_BREACH, INJECTION_DETECTED, POLICY_DENIED. Config: WEBHOOK_URL env var + optional WEBHOOK_SECRET for 
  HMAC signing of webhook bodies. Payload must be signed the same way gateway tokens are signed — consistent pattern. Non-blocking: webhook    
  failures must not affect the main request path (fire-and-forget with retry backoff). Add WEBHOOK_URL and WEBHOOK_SECRET to .env.example.     
  Effort M."

  Mandatory gate: @security-reviewer must review B-04 and B-05 before merge — both touch auth and audit paths.

  ---
  Sprint 3 — Data Management (Ops Maturity)

  Goal: Operators can rotate keys and take backups without touching the database manually.
  Teams involved: Backend · CLI · QA

  B-06 — Vault key rotation

  Prompt for @backend-lead:
  "Plan Sprint 3 task for B-06: vault key rotation CLI. Read packages/credential-vault/ fully — understand the AES-256-GCM file backend and    
  keytar backend. Requirements: (1) tessera vault rotate-key --new-key <hex> CLI command; (2) rotation: decrypt all entries with old key →     
  re-encrypt with new key → atomic rename of JSON file; (3) key versioning: add {v: 1, key_id: <sha256-prefix>} to the vault JSON so the system
   detects a key mismatch; (4) rotation only applies to file-based backend — keytar users: print a clear message explaining OS manages key     
  material; (5) add to packages/cli/src/commands/vault.ts. Effort M. Security Reviewer gate required before merge."

  ---
  B-07 — Backup / restore

  Prompt for @backend-lead:
  "Plan Sprint 3 task for B-07: backup and restore CLI. Read all service gRPC proto files in packages/shared/src/proto/ — check if
  DumpState/RestoreState methods exist; if not, they need to be added. Scope: (1) add DumpState and RestoreState gRPC calls to audit-system,   
  credential-vault, skills-engine, memory-store; (2) tessera backup create --output <file> — calls each service, compresses to tar.gz; (3)     
  tessera backup restore --input <file> — validates integrity, calls each service in dependency order; (4) backup must include: audit DB, vault
   keys file, skills registry, memory DB. Effort L — plan to split into two sub-tasks: (a) gRPC endpoints (M), (b) CLI orchestration (M). CTO  
  should review the proto design before implementation starts."

  ---
  Sprint 4 — Enterprise Foundation (Phase 3 start)

  Goal: Ship RBAC as the foundation every enterprise feature depends on.
  Teams involved: Backend · Frontend · Security Reviewer · CTO (design review required first)

  B-08 — RBAC

  Prompt for @cto:
  "Before Sprint 4 starts, design the RBAC architecture for B-08. Current token format: {userId}.{timestamp}.{hmac}. Needed: add role claim.   
  Roles: admin, operator, viewer. Questions to answer in an ADR: (1) exact new token format — {userId}.{role}.{timestamp}.{hmac} or JWT-like?  
  (2) how does tessera token create assign a role — env var? config file? (3) what routes are admin-only? operator-only? viewer-only? — produce
   a table. (4) does requireRole() need to be a Fastify plugin or a per-route hook? Write ADR-006 in .claude/state/architecture-decisions.md   
  before any implementation begins."

  Prompt for @backend-lead (after CTO ADR-006 is written):
  "Implement B-08 RBAC per ADR-006. Key implementation points: (1) update token format and signing in gateway auth plugin; (2) add
  requireRole(...roles) Fastify hook; (3) apply to all routes per the ADR table; (4) CLI: tessera token create --role admin|operator|viewer;   
  (5) 20+ new gateway tests covering role enforcement — every admin route must have a test with operator/viewer token expecting 403. Security  
  Reviewer gate required. Effort L."

  ---
  Cross-sprint: GTM & Competitive Intel (runs in parallel, no blocking)

  Prompt for @gtm-lead:
  "Sprint 1–2 parallel track: research and update competitive-intel.md for these specific questions: (1) Does OpenClaw (mentioned in our       
  roadmap) have public docs or GitHub? What is their actual security posture? (2) What EU AI Act compliance tools exist in the market — any    
  direct competitors claiming Art. 12 compliance? (3) Research Anthropic's partner program — what are the requirements to become a listed      
  Claude-powered product? Write findings to .claude/state/competitive-intel.md. Flag any HIGH-priority competitive threat to Product Owner."   

  Prompt for @competitive-analyst (if invoked by gtm-lead):
  "Research OpenClaw specifically: find their GitHub repo, documentation, or any public information. Map their capabilities against Tessera's 8
   security invariants — which ones do they match? Which are gaps? Write a competitor entry in .claude/state/competitive-intel.md using the    
  standard format. Confidence-level everything — don't guess."

  ---
  Orchestrator decisions log

  Now writing the decisions file:

● Write(~/projects/SecureClaw/.claude/state/orchestrator-decisions.md)
  ⎿  Wrote 53 lines to ../state/orchestrator-decisions.md
     # Orchestrator Decisions — Tessera
                                                                                                                                                    ---
                                                                                                                                                    ## Decision — 2026-03-19 (Session: Sprint Planning)
                                                                                                                                               
     ### Context
     Phase 1 complete. 344 tests passing. No open issues. All security invariants active.
     Sprint 1 was pre-planned but not yet started. Need to confirm it and plan Sprints 2–4.

     … +43 lines (ctrl+o to expand)

● ---                      
  Summary for you (Rafael)
                                                                                                                                               
  Sprint 1 — run these agents now, in this order:                                                                                              
                                                                                                                                                 1. @design-lead   → approve token refresh UX flow (unblocks T-1-02)                                                                          
  2. @backend-lead  → T-1-01 helmet (no dependency, start immediately)                                                                         
  3. @frontend-lead → T-1-02 token refresh (after design-lead done)                                                                            
  4. @devops-lead   → T-1-03 cross-platform DX validation                                                                                      
  5. @qa-lead       → T-1-04 test baseline                                                                                                       6. @qa-engineer   → validate each task as it hits READY_FOR_QA                                                                               
  7. @security-reviewer → gate before any Sprint 1 branch merges to main                                                                       
                                                                                                                                                 Sprint 2 — after Sprint 1 closes:                                                                                                            
  - @backend-lead (OTel spans · quota enforcement · webhook alerting)                                                                            - @frontend-lead (quota bar UI)                                                                                                                - @security-reviewer gates B-04 + B-05 (mandatory)
                                                                                                                                               
  Sprint 3 — after Sprint 2:                                                                                                                   
  - @cto reviews backup proto design first                                                                                                       - @backend-lead (key rotation · backup/restore)                                                                                                - @security-reviewer gates B-06 (key rotation)                                                                                               
                                                                                                                                                 Sprint 4 — after Sprint 3:                                                                                                                     - @cto writes ADR-006 (RBAC design) before any code starts
  - @backend-lead + @frontend-lead implement                                                                                                     - @security-reviewer gates (role bypass = critical)
                                                                                                                                                 Running in parallel from Sprint 1:                                                                                                             - @gtm-lead → @competitive-analyst (OpenClaw research, Anthropic partner program, EU AI Act market)                                                                                                                                                                                           Each prompt above is ready to paste directly when invoking the corresponding agent.