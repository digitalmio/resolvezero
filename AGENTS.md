# AGENTS.md

## File size

Keep source files small and focused.

- **Hard ceiling: 300 lines** per source file.
- **Target: 250 lines.** If a file crosses 250, look for a clean split before adding more.
- Split by responsibility (route, data loader, card, hook, parser), not just to move lines around.
- A split that creates a vague `utils.ts` or `helpers.ts` grab bag is worse than leaving the file alone.

Allowed exceptions:

- Test files (`*.test.ts`, `*.spec.ts`, fixtures).
- Generated files (route trees, migrations, lock files).
- Long static data: rule catalogs, region maps, blocklist constants, schema/type definitions.
- Thin re-export barrels and directory indexes.
- Genuinely indivisible definitions where splitting would only add indirection.

If an exception is used, keep the reason obvious in the file or the PR description.

## Project shape

- `apps/edge` — DNS/DoH data plane (Node 24). Keep the hot path allocation-light.
- `apps/agent` — per-host agent.
- `apps/console` — TanStack Start console and authenticated server functions (React 19 + Vite + Tailwind 4).
- `packages/db` — Drizzle schema and client. Schema changes need a migration.

## Working rules

- Every private server function re-checks the session and scopes queries to the owning user. Never add a global "latest profile" fallback.
- UI data must be real and tenant-scoped. No dummy metrics or placeholder numbers.
- DNS names accepted by the console stay validated in `apps/console/src/lib/zone.ts`.
- Preserve the Cadence design language: sage page, bone cards, white nav/sidebar, deep-green data, lime accents, orange only for blocked/alerts.
- Prefer existing components and tokens in `apps/console/src/styles.css` over new one-off styles.
- Do not expose the console without auth.

## Verification

Run before calling work done:

```sh
pnpm test
pnpm --filter @resolvezero/console typecheck
pnpm --filter @resolvezero/console build
```

For edge or schema work, also run the relevant package typecheck (`pnpm typecheck`) and check `progress.md` for deploy/runtime caveats.

## Git

- Keep changes on the active feature branch unless asked to merge.
- Commit messages: short imperative summary; append `[skip ci]` for docs/design-only changes when a deploy is not intended.
- Never force-push or rewrite `main`.
