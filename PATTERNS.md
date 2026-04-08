# Tessera — Pattern Details & Examples

> This file contains extended examples and checklists referenced by `CLAUDE.md`.
> It is NOT auto-loaded on every task — Claude reads it when needed.

---

## §A — Error Modeling Examples

**A.1** Domain errors must extend `TesseraError`:

```typescript
// ✅
import { ValidationError, SessionError } from "@tessera/shared";
throw new ValidationError("Token expired", { userId });

// ❌
throw new Error("token expired");       // no code, no context
throw { code: 401, msg: "oops" };      // not an Error instance
```

**A.4** Narrowing in catch blocks:

```typescript
// ✅
} catch (err) {
  if (err instanceof TesseraError) { /* use .code, .context */ }
  throw err; // re-throw unknowns
}

// ❌
} catch (err: any) { /* never */ }
```

---

## §E — TypeScript Strictness Examples

**E.1** Spread for optional properties (`exactOptionalPropertyTypes`):

```typescript
// ✅
const obj = { name, ...(expiresAt !== undefined && { expiresAt }) };
// ❌
const obj = { name, expiresAt }; // Error if expiresAt may be undefined
```

**E.2** Index access guards (`noUncheckedIndexedAccess`):

```typescript
// ✅
const first = items[0];
if (first === undefined) throw new ValidationError("empty", {});
// ❌
const first = items[0]!; // non-null assertion on index
```

---

## §G — Logging Examples

**G.2** Always pass context object as first argument to Pino:

```typescript
// ✅
fastify.log.info({ sessionId, userId }, "Session created");
// ❌
fastify.log.info("Session created for " + userId);
```

---

## §Design-System — UI/Frontend Work

### When to use design-lead agent

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
   - Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for UI components
   - Keyboard navigation: Tab order, focus indicators (`outline-2 offset-2`)
   - Semantic HTML: `<button>`, `<input>`, `<label for="">`
   - ARIA live regions for dynamic content
   - Screen reader testing with axe DevTools; test with keyboard only

4. **SEO** (public pages only)
   - Semantic HTML hierarchy, heading levels with no gaps
   - Image `alt` text, `<title>`, `<meta description>`, Open Graph tags

5. **Responsive design** — mobile-first, Tailwind `sm:`/`md:`/`lg:` breakpoints
   - Test at 320px, 768px, 1024px+. Touch targets ≥ 44px × 44px.

6. **Dark mode** — Tailwind `dark:` prefix, define color pairs in tokens

### Design-lead → frontend-dev handoff

1. Design-lead creates flow documents + component specs + accessibility requirements
2. Add to `apps/control-ui/DESIGN_FLOWS.md`
3. Frontend-lead reviews and creates task briefs for frontend-dev workers
4. Frontend-dev implements using shadcn, Tailwind, and existing patterns
