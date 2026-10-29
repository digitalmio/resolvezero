# ResolveZero Console

TanStack Start console for ResolveZero — profiles, rules, local DNS, query logs, and analytics.

## Stack

- TanStack Start 1.x
- TanStack Router
- TanStack Query
- React 19
- Tailwind CSS 4
- lucide-react

The edge keeps its own Hono HTTP app; this app is the control-plane UI.

## Status

Implemented:

- GitHub OAuth via Better Auth, a root route guard, and session-scoped server functions
- Owner-scoped profile selection, a real profile switcher, and `rz_profile_id` preference cookie
- Overview with live traffic, KPIs, query chart, top blocked domains, devices, and Local DNS summary
- Rules screen backed by Postgres rules, zones, and blocklist subscriptions
- Devices screen backed by stats rollups: DoH tags and UDP source-IP counts
- Local DNS CRUD for `.lan` records (A/AAAA/CNAME/TXT, exact and wildcard)
- Blocklists screen backed by `profile_blocklists` (read-only subscription/status view)
- Analytics screen backed by 24h/7d/30d `stats_hourly` rollups
- Logs screen backed by the edge log archive (latest 100 entries)
- Settings screen backed by profile, upstream, linked IPs, and capacity counts
- Public `/waitlist` placeholder for hosted registration
- Favicon set generated from the `RØ` mark (SVG, PNG, ICO, Apple touch)
- Loading and error states instead of dummy data flashes
- "This device is using ResolveZero DNS" probe in the topbar. The browser
  looks up a random `<nonce>.probe.resolvezero.com` name (no public record);
  the edge records it only after profile/source-IP auth. No wildcard TLS
  certificate is needed because the lookup itself is the signal.

Not implemented yet:

- oRPC router
- Public `/v1` OpenAPI surface and API keys
- Automated console tests

## Run

The app loads the repo-root `.env` automatically. It expects:

```sh
DATABASE_URL=postgres://...
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl rand -base64 32>
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Register the GitHub callback as `http://localhost:3000/api/auth/callback/github`.

```bash
pnpm --filter @resolvezero/console dev
```

Build and typecheck:

```bash
pnpm --filter @resolvezero/console build
pnpm --filter @resolvezero/console typecheck
```

## Design direction

- Editorial ink/cream/orange system with hard 1px rules, zero-radius controls, and numbered sections
- Archivo Variable for expanded display type; Inter for body; monospace for domains, IPs, and logs
- Orange for brand and primary actions, green for healthy states, red for blocked/alerts
- Dense but calm data surfaces; the console should not become a marketing page
- The `RØ` mark and orange favicon are the brand anchors

## Next

1. Add console security regression tests for session guards, owner scoping, profile selection, and validators.
2. Add oRPC v1 contracts and an internal `/rpc` endpoint.
3. Add the public `/v1` OpenAPI surface and API keys.
4. Add first-run onboarding after the hosted registration flow is ready.
