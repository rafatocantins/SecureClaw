# Tessera — Frontend Pattern Rules (§K)

> Load this file when working on `apps/control-ui/` React/TypeScript code.
> Quick-load: agents read this when task brief specifies `context: CLAUDE-frontend`.

---

### K. Frontend (control-ui) Patterns

**K.1** Functional components only. No class components.

**K.2** New code: Tailwind utility classes. Existing inline styles are a known issue (UI-003 in PATTERN-ISSUES.md).

**K.3** WebSocket logic in a custom hook (`src/hooks/use*.ts`). Never inline WebSocket in components.

**K.4** HMAC token generation via `useToken(secret)` hook (`src/hooks/useToken.ts`). Never inline.

**K.5** Token in React state only — never `localStorage` or `sessionStorage` (XSS risk).

**K.6** shadcn/ui first — check `mcp__shadcn__*` before building custom components.

**K.7** No component over 200 lines — split into smaller components + hooks.

**K.8** No direct `fetch` in components — extract to service functions or hooks.

---

### WebSocket streaming pattern

Follow the pattern in `apps/control-ui/src/components/Chat.tsx`:
- Handle all types: `chunk`, `tool_pending`, `tool_result`, `complete`, `error`, `injection_warning`, `pong`
- Reconnect with exponential backoff
- Ping/pong heartbeat for token expiry detection
- Buffer chunks — don't re-render on every character

---

### Accessibility baseline (WCAG 2.1 AA)

- Keyboard navigable (Tab order logical, Enter/Space for buttons)
- ARIA labels on icon-only buttons: `aria-label="Send message"`
- `aria-live` on streaming output
- Respect `prefers-reduced-motion` for animations

---

### Token security rule

Auth token: only in WebSocket URL `?token=` param or `Authorization: Bearer` header.
NEVER in: rendered HTML, `data-*` attributes, `localStorage`, `console.log`.

---

### Build check

```bash
cd apps/control-ui && pnpm build   # zero TypeScript errors before READY_FOR_QA
```

> Full design system checklist: `PATTERNS.md §Design-System`
