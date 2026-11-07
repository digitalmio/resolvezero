# ResolveZero

**A DNS firewall you actually own.** Self-hostable, API-first, and built for households rather than enterprise tenants.

ResolveZero is a personal DNS and DNS-over-HTTPS resolver. It filters queries at the edge, answers local names, and keeps query history in storage you control. Think NextDNS or Pi-hole, but cloud-native and programmable from the start.

> **Status:** pre-1.0, running in production. The Rust edge serves live DNS, DoH, and DoT traffic; the hosted console at [my.resolvezero.com](https://my.resolvezero.com) uses passwordless email sign-in. Self-hosting works, but interfaces may change.

## Why ResolveZero

- **Profiles, not tenants.** Small isolated configs for `home`, `laptop`, or `phone`, each with its own rules, blocklists, devices, and DoH URL.
- **Cloud-native.** No local box to babysit and no DHCP integration. Run the edge as a single static binary, with Postgres.
- **Cheap by design.** Blocklist artifacts are loaded per profile on first use, so an idle PoP starts with an empty catalog and stays small. There is no need for a large machine in every region.
- **Privacy-respecting logs.** Raw query logs are optional and live in S3-compatible storage you choose. Postgres keeps bounded rollups, not raw logs.
- **Local names work.** Split-horizon `.lan` records and overrides are answered before blocklists or upstream.
- **API-first.** Edge endpoints and configuration are designed as data primitives, so the UI is not the only way to manage a profile.
- **No passwords.** Six-digit email codes via any SMTP provider, with invite-only signup if you want it.

## Features

| Area | What you get |
|---|---|
| Resolution | DNS-over-HTTPS, UDP 53, TCP 53, DNS-over-TLS 853 |
| Filtering | Per-profile block/allow rules, compiled blocklist artifacts, SafeSearch, blocked services |
| Local DNS | A/AAAA/CNAME/TXT records, exact and `*.` wildcard names |
| Profiles | Isolated configs, source-IP allowlists, per-device DoH tags, DoT profile selection |
| Observability | Query log, live stats, top domains/clients/devices, block rate, artifact and lazy-load state |
| Operations | Health, cache purge, config-version propagation, DNS presence probe |
| Access | Passwordless email OTP, optional GitHub OAuth, scoped API keys, session-guarded server functions |
| Hosted | Console at `my.resolvezero.com`; `AUTH_ALLOW_SIGNUP=0` makes signup invite-only; console/API data is owner-scoped |

## Architecture

```text
                 DoH / UDP / TCP / DoT
   Clients ─────────────────────────────▶ Edge (Rust)
                                          │  in-memory policy + DNS cache
                                          │  lazy per-profile artifact catalog
                                          │  DoH upstream / sinkhole
                                          │
                                          ▼
                                  Postgres (control plane)
                                          ▲
                                          │  config + blocklist watermarks
                                          │
                                  Console / API

   Compiler worker ──▶ S3-compatible storage (content-addressed artifacts)
        (Fly)                    │
                                 └──▶ Edge pulls on first use
```

**Edge data plane (`apps/edge`)**
- Holds profile policies in memory and resolves from an O(1) rule lookup.
- Authenticates via DoH profile token, per-device tag, UDP source-IP allowlist, or DoT SNI.
- Answers local zones first, then rules/blocklists, then cache or upstream DoH.
- Starts with zero blocklist tables. On the first query for a profile it pulls only that profile's artifacts from S3, verifies their SHA-256, and installs them. `EAGER_BLOCKLISTS=1` restores preloading.
- Emits raw logs to S3-compatible storage and bounded rollups to Postgres.
- Polls a Postgres watermark every few seconds; no `LISTEN`/`NOTIFY` on the hot path.

**Compiler worker (`apps/compiler/src/main.rs`, binary `rz-compiler`)**
- Runs on a dedicated Fly machine (`fly.compiler.toml`, `Dockerfile.compiler`), not on the request path.
- Polls every 30 seconds for new user lists and refreshes artifacts older than six hours.
- Uploads content-addressed blobs to S3 and bumps `blocklist_version` once per changed cycle.
- GitHub Actions keeps only a manual break-glass fallback; runtime freshness does not depend on it.

**Control plane**
- Postgres schema, migrations, and config state live in `packages/db`.
- Better Auth protects the console and every private server function.
- Console queries resolve profiles only through `profiles.owner_user_id`.
- API keys are minted from an authenticated session and can be bound to a single profile.

**Storage**
- Postgres: profiles, rules, blocklists, source IPs, zones, auth, API keys, and stats rollups.
- S3-compatible storage: optional compressed raw query logs, plus immutable compiled artifacts.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/edge` | Production DNS/DoH/DoT edge (Rust), policy cache, logs, stats |
| `apps/compiler` | Artifact compiler worker (`rz-compiler`) and one-shot `rz-compile` |
| `apps/console` | TanStack Start console, API docs, and authenticated server functions |
| `apps/agent` | Local DNS forwarding agent (TypeScript, shipped) |
| `apps/agent-rust` | Rust agent port, built/tested with the workspace |
| `crates/rz-core` | Shared artifact, parser, fingerprint, and SSRF primitives |
| `crates/rz-db` | Shared Postgres access for the edge and compiler |
| `packages/db` | Drizzle schema, migrations, database client |
| `scripts` | Operational TS/shell scripts: migrations, seeding, smoke tests, compiler fallback |
| `docs` | Artifact format, rules-at-scale, Rust edge security, token-at-rest notes |
| `Dockerfile.edge`, `fly.toml` | Production edge image and Fly config |
| `Dockerfile.compiler`, `fly.compiler.toml` | Dedicated artifact compiler worker |

## Self-hosting

### Requirements

- Node.js 24 (console, operational scripts)
- Rust 1.99+ (edge and compiler)
- pnpm 10
- Postgres
- Optional: an S3-compatible bucket for raw logs and compiled artifacts
- Optional: an SMTP endpoint for email sign-in
- Optional: a GitHub OAuth app if you want the GitHub button

### 1. Install

```sh
git clone https://github.com/digitalmio/resolvezero.git
cd resolvezero
pnpm install
cp .env.example .env
```

Edit `.env` and set at minimum:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/resolvezero
DATABASE_URL_ADMIN=postgres://user:password@localhost:5432/resolvezero
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl rand -base64 32>
SMTP_URL=smtps://user:pass@smtp.example.com:465
EMAIL_FROM="ResolveZero <login@example.com>"
```

`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` power the optional GitHub button. The current auth server reads them at boot, so set placeholders if you only want email OTP.

If your Postgres provider uses a separate pooled runtime port, point `DATABASE_URL` at that port and keep `DATABASE_URL_ADMIN` on the direct admin connection.

Register the GitHub callback as (only if using GitHub sign-in):

```text
http://localhost:3000/api/auth/callback/github
```

### 2. Migrate

```sh
node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/migrate.ts
```

`DATABASE_URL_ADMIN` is used only for migrations. Runtime uses `DATABASE_URL`.

### 3. Run the Rust edge

```sh
set -a
source .env
set +a

cd apps/edge
cargo run --release --bin resolvezero-edge
```

Port 53 requires root or `CAP_NET_BIND_SERVICE`. For local development, set `DNS_PORT=5353` and use DoH on `http://localhost:8080`, or set `DROP_PRIVILEGES=0` if you are not running as root.

With no S3 bucket configured, set `EAGER_BLOCKLISTS=1` so raw list text is fetched and parsed at startup instead of waiting for compiled artifacts that cannot exist.

### 4. Compile blocklist artifacts (optional but recommended)

Run the compiler as a long-lived worker (it polls every 30 seconds; stop it with Ctrl-C), or supervise it with your process manager:

```sh
set -a
source .env
set +a

cargo run --release -p resolvezero-compiler --bin rz-compiler
```

In production the compiler is a dedicated Fly app (`fly.compiler.toml`) with no public ingress. It only needs `DATABASE_URL` and the `S3_*` credentials. The edge pulls the resulting artifacts lazily.

### 5. Run the console

```sh
pnpm --filter @resolvezero/console dev
```

Open `http://localhost:3000`, enter your email, and use the six-digit code from the logs (development) or your inbox (SMTP configured).

### 6. Seed a first profile

The console expects a profile owned by your signed-in user. The dev seed creates a usable `home` profile:

```sh
node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/seed.ts
```

After signing in once, assign the seeded profile to your user:

```sql
UPDATE profiles
SET owner_user_id = '<your-user-id>'
WHERE name = 'home';
```

Your user id is the `user.id` row created by Better Auth after the first sign-in.

## Configuration

The full set of options lives in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime Postgres connection |
| `DATABASE_URL_ADMIN` | Migration-only Postgres connection |
| `PORT` | Edge HTTP/DoH port (default `8080`) |
| `DNS_PORT` | UDP/TCP DNS port (default `53`) |
| `DOT_ENABLED` / `DOT_PORT` | DNS-over-TLS toggle and port (default `853`) |
| `DOT_SUFFIX` | DoT hostname suffix used to select a profile |
| `EAGER_BLOCKLISTS=1` | Preload every list at startup instead of lazy loading |
| `BLOCKLIST_LAZY_RETRY_SECONDS` | Retry delay after a failed lazy load (default `60`) |
| `BETTER_AUTH_URL` | Public console origin |
| `BETTER_AUTH_SECRET` | Session signing key |
| `SMTP_URL` / `EMAIL_FROM` | Email OTP delivery |
| `AUTH_ALLOW_SIGNUP=0` | Make signup invite-only |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional GitHub OAuth credentials |
| `TRUSTED_ORIGINS` | Extra allowed console/API origins |
| `UPSTREAM_PRESET` / `UPSTREAM_DOH_URL` | Edge default upstream resolver |
| `S3_*` | Raw-log archive and artifact bucket credentials |
| `ARTIFACT_PREFIX` | Artifact key prefix (default `artifacts`) |
| `QUERY_LOG_STDOUT` | Send raw logs to stdout instead of S3 |
| `PROBE_DOMAIN` | Domain used by the DNS-presence canary |
| `ALLOW_TOKENLESS_PROFILES=1` | Local-dev escape hatch; rejected in hosted mode |

### Lazy artifact loading

By default the edge starts with no blocklist tables:

- `readyz` reports `lazyLists: true`, `artifactLists: 0`, `pendingLists: <n>`.
- The first DNS query for a profile pulls that profile's artifacts, verifies each SHA-256, and installs the tables.
- Later queries for the same profile are served from memory; other profiles stay unloaded.
- When `blocklist_version` changes, the markers are cleared and each profile reloads on its next query. The DNS cache is flushed at the same time.
- Failed loads are retried after `BLOCKLIST_LAZY_RETRY_SECONDS`; a failed list leaves the profile on its explicit rules until the retry.

This is what lets every PoP run the same small machine shape. If you prefer predictable cold starts over first-query latency, set `EAGER_BLOCKLISTS=1`.

## Security and privacy

- Every private console server function re-checks the session before reading tenant data.
- Profiles are resolved by `owner_user_id`; there is no global “latest profile” fallback.
- Sign-in is passwordless email OTP. Codes are hashed, expire quickly, and are rate-limited per recipient and globally.
- API keys are session-minted, scoped to one profile where configured, and re-checked against the owning user on every request.
- DoH tokens are kept server-side and never written to query logs. Database access should be treated as credential-bearing until token-at-rest hardening lands.
- Compiled artifacts are content-addressed and SHA-256 verified before use. Missing or corrupt artifacts fall back to raw text.
- The edge applies per-PoP ingress limits for DoH, UDP/TCP, DoT, blocklist sync, log export, and raw-log staging. Hosted deployments still need network-level DDoS protection and per-tenant quotas in front of them.
- Blocklist fetches go through an SSRF guard; private targets and non-HTTP schemes are rejected unless explicitly enabled for development.
- Raw query logging can be disabled per profile. When disabled, that profile's queries are not added to raw logs or stats rollups.
- UDP source addresses are spoofable. Use source-IP allowlists with that in mind.
- Do not run the console without authentication.

## Development

```sh
pnpm test
pnpm typecheck
pnpm typecheck:console
pnpm build:console

cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Useful package scripts:

```sh
cargo run -p resolvezero-edge --bin resolvezero-edge
pnpm --filter @resolvezero/console dev
pnpm --filter @resolvezero/agent dev
pnpm --filter @resolvezero/db db:studio
```

Source files should stay small and focused. See [`AGENTS.md`](AGENTS.md) for the 250–300 line guideline, verification commands, and tenant-safety rules.

## Roadmap

- Canary replay: run stored query logs against a canary and production edge and diff answers
- Idle eviction for lazily loaded list tables on very long-lived PoPs
- NextDNS import for easier migration
- Exploratory: AI-assisted weekly reports, anomaly explanations, and natural-language rule suggestions

## Documentation

- [`docs/artifact-format.md`](docs/artifact-format.md) — `RZA1` artifact layout and content addressing
- [`docs/rules-at-scale.md`](docs/rules-at-scale.md) — blocklist/rule compilation and distribution design
- [`docs/rust-edge-security.md`](docs/rust-edge-security.md) — parity status and security review
- [`docs/token-at-rest.md`](docs/token-at-rest.md) — DoH token hashing and edge-admin credential plan
- [`packages/db/src/schema.ts`](packages/db/src/schema.ts) — database schema
- [`AGENTS.md`](AGENTS.md) — repository conventions and guardrails

## Contributing

Issues and pull requests are welcome. Please:

- Keep changes tenant-scoped and session-guarded.
- Add or update tests for behavior changes.
- Do not commit real credentials, customer domains, or production logs.
- Run the checks above before opening a PR.

## License

A license has not been published yet. One should be added before the repository is made public.
