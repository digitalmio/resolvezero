# ResolveZero Console

Design spike for the new ResolveZero control plane.

## Stack

- TanStack Start 1.x
- TanStack Router
- TanStack Query
- React 19
- Tailwind CSS 4
- lucide-react

No Hono in this app. The edge keeps its own Hono HTTP app; this is the control-plane replacement.

## Status

Implemented:

- App shell: sidebar, topbar, profile switcher, status pills
- Brand assets: `src/assets/logo-square.svg`
- Overview screen with status hero, live traffic, KPIs, query chart, top blocked domains, devices, recent changes
- Rules screen with static table, action tabs, filters, and summary cards
- Devices screen with DoH tags, UDP source-IP labeling, and the UDP attribution caveat
- Route placeholders for Blocklists, Logs, Analytics, Settings
- Responsive layout foundation
- TanStack Query provider

Not implemented yet:

- better-auth / login
- oRPC router
- public API
- real data
- favicon/app icon variants

## Run

```bash
pnpm install
pnpm --filter @resolvezero/console dev
```

Build:

```bash
pnpm --filter @resolvezero/console build
```

Typecheck:

```bash
pnpm --filter @resolvezero/console typecheck
```

## Design direction

- Ink/paper base with one signal accent
- Monospace for domains, IPs, and logs
- Dense but calm security dashboard
- The `RØ` mark is the brand anchor; favicon variants come later

## Next

1. Wire better-auth into TanStack Start.
2. Add oRPC v1 contracts + internal `/rpc` endpoint.
3. Add public `/v1` OpenAPI surface and API keys.
4. Replace static data with Postgres rollups and edge stats/logs.
5. Build the Rules, Devices, and Logs screens for real.
