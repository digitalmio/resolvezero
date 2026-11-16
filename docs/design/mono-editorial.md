# Console design — mono/editorial (experiment)

Status: **experimental branch** (`design/mono-editorial`). Not merged, not deployed.

Reference: <https://mega.dev/> — flat ink canvas, mono UI labels, editorial serif
headlines, acid signal accent, hard 1px rules, no soft shadows.

Actions are deep green (`--green`) so they read as "go / secure" and stay distinct
from the acid selection highlight; orange is kept for the small brand mark and
the focus ring.

## Tokens (`apps/console/src/styles.css`)

| Token | Value | Role |
|---|---|---|
| `--paper` | `#f1efe7` | bone canvas |
| `--card` | `#faf8f1` | card surface |
| `--sidebar` | `#0c0b09` | ink chrome |
| `--brand` | `#ff3b00` | brand mark, focus ring, warm accent |
| `--green` | `#0b6b46` | primary CTA, healthy states |
| `--signal` | `#e8ff00` | active nav, selected range, ticks |
| `--line` / `--line-strong` | ink 16% / 42% | hairline and hard rules |
| `--radius` | `2px` | square-ish edges |
| `--font-serif` | Instrument Serif | hero and page titles |
| `--font-mono` | Geist Mono | labels, numbers, statuses |

## Surfaces

- `apps/console/src/styles/components.css` — `rz-*` primitives (cards, pills, ticks)
- `components/app-shell.tsx`, `shell/nav.tsx`, `shell/profile-menu.tsx`,
  `shell/timezone-menu.tsx` — ink header/sidebar, lime active row
- `routes/login.tsx`, `components/auth/sign-in-card.tsx` — flat ink brand panel,
  serif headline, hard-shadow form card
- `routes/index.tsx`, `components/overview/*` — serif greeting, mono metric strip,
  flat ink traffic card, mono chart axes
- `routes/blocklists.tsx` — mono table, quota-exceeded banner and status tag
- `routes/rules.tsx`, `routes/devices.tsx`, `routes/waitlist.tsx` — consistency pass

## Preview

```sh
cd apps/console
node --env-file-if-exists=../../.env node_modules/vite/bin/vite.js dev --port 3100 --strictPort
```

Do not touch the developer's server on port 3000.

## Verification

`pnpm --filter @resolvezero/console typecheck && pnpm --filter @resolvezero/console build`
and `pnpm test` (294 tests) pass on this branch.

## Rollback

Drop the branch. No server, schema, or auth changes; only presentation.
