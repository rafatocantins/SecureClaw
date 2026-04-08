# Tessera — Backend Pattern Rules (§A–§D, §G–§J)

> Load this file when working on TypeScript services, gRPC, Fastify routes, or database code.
> Quick-load: agents read this when task brief specifies `context: CLAUDE-backend`.

---

### A. Error Modeling

**A.1** All domain errors MUST extend `TesseraError` from `@tessera/shared`. Never `throw new Error(...)` in service or handler code. See `PATTERNS.md §A` for examples.

**A.2** Use existing subclasses: `AuthenticationError`, `AuthorizationError`, `PolicyDeniedError`, `CostCapError`, `InjectionDetectedError`, `SandboxError`, `CredentialError`, `SessionError`, `ValidationError`.

**A.3** gRPC handler responses: `{ success: false, error_message: string }` — never throw inside a handler. Streaming handlers use `call.write({ error: { code, message } })`.

**A.4** Catch blocks MUST narrow with `instanceof TesseraError` before accessing `.code` or `.context`. Never `catch (err: any)`.

---

### B. gRPC Patterns

**B.1** ALWAYS use `loadProto(filename)` from `@tessera/shared`. Never `@grpc/proto-loader` directly outside `packages/shared/`.

**B.2** One class per service in `src/grpc/clients/<service>.client.ts`. Constructor takes `addr?: string` defaulting to env var.

**B.3** Use `serverCredentials(name)` / `clientCredentials(name)` from `@tessera/shared`. Never `grpc.credentials.createInsecure()` unconditionally.

**B.4** Wrap every gRPC call in try/catch. Check `isServiceError(err)` before accessing `.code`. Never return `null` silently.

**B.5** Use factory functions `makeXxxImpl(service)` returning handler objects. Zero DB calls inside handlers.

> Context block: `.claude/context-blocks/new-grpc-client.md`

---

### C. Fastify Route Patterns

**C.1** One plugin per resource: `src/routes/<resource>.route.ts`. Export `async function xxxRoute(fastify: FastifyInstance)`.

**C.2** Every route with a body: Zod `.safeParse(req.body)`. Respond `400` with `{ error: "validation_error", issues: [...] }`.

**C.3** `preHandler: [verifyToken]` on authenticated routes. Global `blockTokenInQueryParams` is in `server.ts` — do NOT add per-route.

**C.4** All error responses: `{ error: string }`. Never `{ message: string }`.

**C.5** Rate limiting: `config: { rateLimit: { max: N, timeWindow: "1 minute" } }` with `keyGenerator`.

> Context block: `.claude/context-blocks/new-fastify-route.md`

---

### D. Service Class Patterns

**D.1** Pass all deps (db, logger, config, gRPC clients) as constructor parameters. No singleton imports. No `process.env` inside service methods.

**D.2** Synchronous init in constructors OK. Async init → standalone async factory function.

**D.3** Gateway services decorated onto Fastify: `app.decorate("agentClient", ...)`, accessed as `fastify.agentClient`.

**D.4** Services with open resources MUST clean up in SIGTERM handler in `index.ts`.

---

### G. Logging & Observability

**G.1** Fastify's Pino logger only (`fastify.log` / `req.log`). `console.log/error/warn` FORBIDDEN in `src/`.

**G.2** Context object first: `fastify.log.info({ sessionId }, "msg")`. See `PATTERNS.md §G`.

**G.3** Never log `req.headers.authorization`, tokens, secrets, vault refs, or `req.body.value`.

**G.4** OTel span names: `service.operation` snake_case, always static — no dynamic IDs in name.

---

### H. Environment / Config

**H.1** Read env vars in `index.ts` — not inside service methods.

**H.2** Validate numeric/enum env vars at startup.

**H.3** Shell env wins over `.env` file values.

**H.4** All env vars in `.env.example` with comment.

> Context block: `.claude/context-blocks/add-env-var.md`

---

### J. Security Coding Rules

**J.1** Every Fastify route with a body: Zod `.safeParse(req.body)`. No exceptions.

**J.2** All SQLite statements with runtime values: bound parameters only. Template literals in SQL FORBIDDEN.

**J.3** Never log auth headers. Don't bypass Pino `redact` by logging `req.headers`.

**J.4** Vault refs (`__VAULT_REF:uuid__`) stripped before logging or LLM. Use `stripVaultRefs()` from `@tessera/alerting`.
