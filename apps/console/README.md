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
- Server-side `getOverview` querying Postgres `stats_hourly` (with a design-preview fallback)

Not implemented yet:

- better-auth / login
- oRPC router
- public API
- favicon/app icon variants

## Run

The overview reads real Postgres rollups. Set `DATABASE_URL` (and optionally
`DASHBOARD_PROFILE_ID`) before starting:

```bash
DATABASE_URL=postgres://... pnpm --filter @resolvezero/console dev
```

Without a database, the UI falls back to the design-preview data and shows a warning.

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
4. Replace the remaining static Rules/Devices/Logs data with real edge/DB queries.
5. Add authentication before exposing server functions publicly.
