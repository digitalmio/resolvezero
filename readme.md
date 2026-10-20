# ResolveZero

**Your NextDNS replacement, in the cloud — API-first from ground up.** Open source, self-hostable, with a hosted option.

## 1. Product Overview

ResolveZero is a personal DNS & DoH (DNS-over-HTTPS) resolver you fully control. Think NextDNS or Pi-hole, but running in the cloud (no DHCP, no local box to babysit) and **programmatic at its core**: every config knob, rule, and log is an API, not a web form.

* **Profiles** instead of enterprise tenants: small, isolated configs (`home`, `laptop`, `phone`), each with its own rules, blocklists, and DoH URL — the NextDNS model.
* **Open source first**: the edge is a Node 24 TypeScript service you can run anywhere with Postgres. The hosted option runs the same code on Fly.io.
* **Privacy-respecting logs**: all queries are logged for the dashboard unless a profile opts out.
* **Encrypted upstream**: edge → resolver traffic goes over DoH (Quad9 by default), not plain UDP.

## 2. Core Tech Stack

* **Edge Runtime:** Node 24 LTS (TypeScript via `tsx`). UDP/TCP 53 use `node:dgram` / `node:net` for legacy device support.
* **Infrastructure (hosted option):** Fly.io. Edge compute + BGP Anycast + one shared dedicated IPv4 (UDP requires it; all profiles share it).
* **Database:** PlanetScale Postgres (Metal) — profiles, rules, query logs, and the central source of truth.
    * Managed PgBouncer runs in transaction-pooling mode. Config propagation is **watermark polling** (below), so it works through the pool; no `LISTEN`/dedicated connection is required.
* **ORM / Migrations:** Drizzle (package `packages/db`) + custom SQL migrations for triggers.
* **Config Propagation:** `edge_config_state` single-row watermark (`config_version`, `blocklist_version`) bumped by statement-level triggers in the same transaction as writes; each edge POP polls every ~5 s (`CONFIG_POLL_MS`) and re-snapshots/re-syncs when it moves. No `LISTEN`/`NOTIFY` on the hot path.
* **Policy Cache:** A plain in-memory `Map` of ALL profiles' policies. Bounded set — NEVER evict (LRU is reserved for the resolver cache only).
* **DNS Response Cache:** `lru-cache`, the only unbounded-by-nature data — safe to evict.
* **DNS Parsing:** `dns2` or `dns-packet` (npm).
* **Upstream Resolver:** DoH, **selectable per profile**: presets `cloudflare` (default), `google`, or a custom `upstream_url` (self-hosters can point it at a local Unbound DoH listener with a 1-line change).
    * `quad9` exists as a preset but is **HTTP/2-only** ("505 requires HTTP/2" on Node/undici h1 fetch); it runs through the h2 transport where reachable (verified 13ms p50 from lhr via `node:http2`) — needs verification from every deploy PoP before being offered in the UI.
    * **Bench decision (2026-10-09, `apps/edge/scripts/bench-upstream.ts`, fra+lhr):** warm per-query RTT: DoH-h1 ≈ 2ms vs UDP 53 ≈ 1ms (CF, fra); Google 4 vs 2ms (lhr); Quad9 13 vs 11ms (lhr). UDP wins **1–2ms p50** — rejected: not worth the drop in transport privacy (plaintext to the provider), a second socket stack, and a per-profile protocol column. DoH-h1 is the default path; warm conns make the protocol overhead irrelevant.
    * Mullvad was excluded as a preset: dead from Fly egress (300/300 timeouts on all transports) and from the PL home ISP — provider emits no EU-reachable endpoint for our vantages.
* **Custom zones:** per-profile DNS records (`profile_zones`: A/AAAA/CNAME/TXT, exact or `*.` suffix-wildcard, TTL) served from the edge cache via the config watermark — split-horizon names (`nas.lan`), LAN rewrites, and explicit overrides **win over blocklists** (user-authored config). Updated within one poll interval, no upstream round-trip.
* **Raw Log Storage:** S3-compatible object storage (`@aws-sdk/client-s3` — iDrive E2 / R2 / Tigris / AWS via env endpoint, path-style). Postgres holds **stats rollups only** (raw logs never in PG).

## 3. System Architecture

Strictly decoupled: **Control Plane** (slow, persistent, Postgres) and **Data Plane** (fast, in-memory, edge).

### A. The Control Plane (Postgres)

Stores profiles, rules, blocklist picks, source-IP whitelists, log opt-outs, and the query log.
Config writes bump `edge_config_state.config_version` (or `.blocklist_version`) in the same transaction via statement-level triggers. There is no `pg_notify` on the hot path.

### B. The Edge Data Plane (Node on Fly.io)

1. **Boot Phase (race-free sync):** read the current `config_version` → `SELECT` snapshot into the policy `Map` → poll the watermark every ~5 s and re-snapshot when it moves. A change during the snapshot bumps the version and is caught next tick.
2. **Resolution Phase:** authenticate (`profile id` from DoH path, or `senderAddress`→profile for UDP), then check the domain (`O(1)` exact + longest-suffix wildcard, `O(domain depth)`) against the profile's rules.
    * **Blocked** → sinkhole (`0.0.0.0`) — answerable locally, log, return.
    * **Allowed** → DNS response LRU cache; on miss, forward upstream **over DoH**, log, cache with capped TTL (positives ≤5 min, NODATA/NXDOMAIN ≤60s — a transient empty must never hide a record).
3. **Geo behavior:** upstream is Anycast DoH, so requests from the Tokyo node resolve via Quad9's Tokyo PoP — end-device geo stays natural.

### C. Query Logging & Analytics (the differentiator)

**Raw logs live in S3-compatible object storage — Postgres never touches raw logs.**

1. **Raw events →** batcher flush → one compressed NDJSON object per profile per 15-min window (`{S3_FLUSH_MINUTES}`): `s3://…/logs/{profile_id}/{date}/{HHmm}.{seq}.jsonl.gz` (`@aws-sdk/client-s3`, works with iDrive E2 / R2 / Tigris / AWS). Event shape: `{kind:"query", time, profile, domain, action, rttMs, clientIp}`. Cost at household scale: ~90 MB compressed/month → **pennies for two years of history**.
2. **Stats →** the same flush updates **rollup rows** in Postgres:
    * `stats_minute` (totals only, PK profile+minute) — powers the live charts; hard-pruned after 6 h.
    * `stats_hourly` (totals, blocked, RTT mean, top-200 domains, top-100 blocked, top-50 clients — all bounded) — powers dashboard tiles + long ranges; pruned by `log_retention_days`.
    * `/stats` serves an adaptive-resolution ladder (NextDNS parity, ~30 points/chart): `30m`→1-min, `6h`→15-min (from `stats_minute`), `24h`→1-h, `7d`→6-h, `30d`/`90d`→daily (from `stats_hourly`). **Raw-log lifetime in S3 = bucket lifecycle rules** (deploy-side, NextDNS-style 1h→730d).
3. **Ingestion paths (exactly one on):** `QUERY_LOG_STDOUT=1` → pino `kind:"query"` lines on stdout → [Fly Log Shipper](https://github.com/superfly/fly-log-shipper) (Vector) S3 sink writes the same key layout (hosted default; raw-log delivery is best-effort, stats unaffected); or `S3_*` env → in-process sink (self-host default, any platform). Neither → rollups-only mode (OSS no-config case), stats still work.

## 4. Authentication (Profiles)

Every query must be authenticated before processing. Unauthenticated/unknown UDP packets are answered **REFUSED (RCODE 5)** by default (`UDP_UNKNOWN_SOURCE=refused`; set `=silent` to restore full-silence) — standard "not serving you" semantics, debuggable via any `dig`, counted in `rz_dropped_total{reason="unauthorized_source"}`. Query-log events are never emitted for unauthorized sources.

1. **DoH Token Auth (primary):**
    * *Path shapes:* `https://dns.resolvezero.com/v1/{profile_id}/{profile_token}` — or device-tagged variants:
        * `https://dns.resolvezero.com/v1/{profile_id}/{device}` (token-free profile)
        * `https://dns.resolvezero.com/v1/{profile_id}/{device}/{profile_token}` (tokened profile)
    * Device slugs: NextDNS-style `[a-zA-Z0-9_-]{1,32}`; round-trip into raw logs (`device` field), `profile_devices` rows (lazy first-seen insert) and `stats_hourly.top_devices` (top 50).
    * Never log the raw token/path (hash comparison).
2. **Source IP Whitelisting (UDP ingress, for routers/legacy devices):**
    * Optional per profile; checked against `senderAddress` (Fly preserves the real client IP). Unknown source → REFUSED (above). Since UDP source IPs are spoofable, apply a per-source rate limit / penalty box in front of policy checks.
3. **What's deliberately NOT here:** per-tenant dedicated Anycast IPs. (Fly rewrites all of an app's UDP destinations to `fly-global-services`, so destination-based identity is impossible; per-tenant infra would mean one app per profile — pointless for a personal product.)

### 4a. Accounts (login-first SHIPPED — `apps/control`)

* **Status:** `apps/control` deploys `resolvezero-control` (fra). Better Auth 1.7 (GitHub OAuth only, no email flows) owns `user`/`session`/`account`/`verification` tables (migration 0003, shapes mirror @better-auth/core exactly — text ids, cascade FKs). `GET /api/me` is the post-login smoke route; profile CRUD + auto-profiles are PARKED until the app-design session.
* **Auth flow**: `/api/auth/sign-in/github` → consent → callback → session cookie (server crypto via `BETTER_AUTH_SECRET`). `TRUSTED_ORIGINS` env gates redirect targets; CORS is dev-open (`CORS_ORIGINS=*` default) until the UI lands, tightened at productionalization.
* Mutations (rules/zones/blocklists/profile CRUD) move to the control-plane API (dashboard app); the edge stays a token-authed data plane consuming the config watermark only.
* Linked-IP (parity with NextDNS): dashboard button + `?ip=` update URL (both live); later: DDNS hostname re-resolution; multi-profile-per-IP later via **per-profile anycast IP pools** (NextDNS pattern — not dedicated per-user IPs). Tailscale hardcodes DoH for NextDNS/ControlD only (ts#15724) — not supported by design; OS-native DoH profiles are our path.
* Deployed via the shared pipeline: `deploy-control` job (FLY_CONFIG=fly.control.toml), same migrate-first ordering as the edge.
* Deferred: teams/sharing, billing/quotas, per-profile rate limits.

### 4b. DNS-over-TLS (planned)

TLS listener on port 853 (`node:tls` server) with profile identity in SNI: `{device-tag}.dns.resolvezero.com`. Enables Android Private DNS (system, no app), iOS/macOS DoT profiles, and exit-node survival (plaintext UDP gets hijacked by Mullvad-style exit nodes; TLS does not). Requires: fly.toml service, cert reuse, RuleStore SNI lookup — ~150 LOC + tests.

## 5. Database Schema (drizzle sources: `packages/db/src/schema.ts`)

```sql
-- Owner-managed resolver configurations ("tenants" of one)
CREATE TABLE profiles (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,          -- 'home', 'laptop', 'phone'
    doh_token VARCHAR(255) UNIQUE,       -- optional shared secret (nil = id-only)
    log_queries BOOLEAN NOT NULL DEFAULT TRUE,
    log_retention_days INT NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Flat domain rules (fast edge lookups; suffix semantics: stored
-- "corp.example.com" blocks "*.corp.example.com")
CREATE TABLE profile_rules (
    profile_id UUID REFERENCES profiles(id),
    domain VARCHAR(255) NOT NULL,
    action VARCHAR(20) NOT NULL,         -- 'block' | 'allow'
    PRIMARY KEY (profile_id, domain)
);

-- Optional UDP ingress whitelist per profile
CREATE TABLE profile_source_ips (
    ip_address INET PRIMARY KEY,
    profile_id UUID REFERENCES profiles(id)
);

-- Minute rollups: live-chart data (totals only). Hard-pruned after 6h.
CREATE TABLE stats_minute (
    profile_id UUID NOT NULL REFERENCES profiles(id),
    minute TIMESTAMPTZ NOT NULL,
    total_queries INT NOT NULL DEFAULT 0,
    blocked INT NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, minute)
);

-- Hourly stats rollups: the ONLY query-log-derived PG data (raw logs → S3).
-- Bounded rows (one per profile per hour, top-lists capped in app code).
CREATE TABLE stats_hourly (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id),
    hour TIMESTAMPTZ NOT NULL,                    -- UTC hour floor
    total_queries INT NOT NULL DEFAULT 0,
    blocked INT NOT NULL DEFAULT 0,
    rtt_sum_ms BIGINT NOT NULL DEFAULT 0,
    rtt_count INT NOT NULL DEFAULT 0,
    top_domains JSONB NOT NULL DEFAULT '[]',      -- capped 200
    top_blocked JSONB NOT NULL DEFAULT '[]',      -- capped 100
    top_clients JSONB NOT NULL DEFAULT '[]'       -- capped 50
);
CREATE INDEX stats_hourly_profile_hour_idx ON stats_hourly (profile_id, hour);

-- Config propagation watermark (single row)
CREATE TABLE edge_config_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  config_version BIGINT NOT NULL DEFAULT 0,
  blocklist_version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION bump_edge_config_version()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE edge_config_state SET config_version = config_version + 1, updated_at = now() WHERE id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER edge_config_rules_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_rules
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();
-- same pattern on profiles / profile_zones / profile_source_ips;
-- profile_blocklists bumps blocklist_version instead (status write-backs excluded)
```

## 6. Phase 1 Build Order

1. **Database layer** (`packages/db`) ✅ — drizzle schema + migrations + `ensureRuleNotifyTrigger()` at edge boot.
2. **Policy sync** ✅ — race-free boot (subscribe → buffer → snapshot → reconcile) into the policy `Map`; unit-tested.
3. **DoH endpoint + DoH upstream:**
    * Node HTTP server (`@hono/node-server`): `POST/GET /v1/{profile_id}[/{token}]` (RFC 8484 style), auth profile, parse wire format, resolve, answer.
    * Allowed/uncached queries → **DoH upstream** (Quad9); LRU-cache by upstream TTL incl. NXDOMAIN.
4. **UDP ingress (legacy devices):**
    * Single `dgram` UDP socket bound to `fly-global-services:53` (mandatory on Fly; same port in/out).
    * Silent-drop unauthenticated; rate-limit permitted sources; TC flag fallback for oversized responses.
5. **Query log batching:** async ring-buffer flushes (2 s / 500 rows): raw events → S3 object per 15-min window (or stdout → Fly Log Shipper), rollup upserts → `stats_minute` + `stats_hourly`; flush failure = retain + exponential backoff, DNS resolution never blocked; respects `log_queries = false`; daily prune of rollups by `log_retention_days`.
6. **Log manager + stats endpoints** (NextDNS parity): `GET /v1/:p/logs?format=csv|jsonl[&date=]` (streamed download), `DELETE /v1/:p/logs` (prefix clear), `GET /v1/:p/stats?range=30m|6h|24h|7d|30d|90d` (adaptive ~30-pt chart ladder + aggregates).
7. **Profile config API + dashboard** (CRUD rules, fetch stats) — the "API-based from ground up" surface.

## 7. Deployment Notes (hosted)

### CI/CD pipeline (GitHub Actions, readme §7)

`.github/workflows/deploy.yml` — one run per push to `main`:

```
push main → test (tsc edge/db/control + Vitest) → migrate (drizzle+triggers, idempotent) → deploy (fra+lhr via scripts/deploy.sh)
```

* Secrets: `DATABASE_URL_ADMIN` (migrations only, never runtime) + `FLY_API_TOKEN` (app-scoped). Runtime secrets (`DATABASE_URL`, `S3_*`) stay in Fly.
* `concurrency: deploy` — no overlapping deploys; migrate runs BEFORE deploy so additive migrations exist before the new edge boots.
* `scripts/deploy.sh` auto-detects `fly` (local) vs `flyctl` (CI binary name).
* Prod sweep from the first green run: healthz 204; DoH forward/sinkhole/zone answers green; `top_devices` rollups writing; check-lists 41k remote entries ok.
* **Productionalization checklist (pipe-related):**
    * [ ] Flip to MR-only: require PRs + `enforce_admins` in branch protection (GitHub Pro needed for required-checks on a private repo — free tier rejected our `PUT /branches/main/protection`; unlock by GitHub Pro or making the repo public).
    * [ ] Add `apps/control` + dashboard deploy jobs to the same workflow.
    * [ ] Smoke test job (post-deploy DoH probe) auto-rollback on failure (currently manual re-run only).
    * [ ] Post-deploy machine-image parity check: `fly machines list` must show ALL machines on the same deployment tag + `app` process group. Drift happened when manual `fly machine start/restart` ops ran during an OOM incident (Fly advisory "running multiple images"; lhr machine was even detached from the app group). Rule: after manual machine surgery, ALWAYS recreate the affected region via `fly scale count N --region X` (never resurrect a drifted machine).
    * [ ] Release notes/bot on tags if/when releasing versions.

* One Fly app = one edge binary; deploy per region (anycast handles routing). `scripts/deploy.sh` pushes to every region in `FLY_REGIONS` and sizes machines via `FLY_SCALE`.
* `fly.toml`: three dedicated anycast IPv4s (`66.51.122.23` era replaced by the 37.16.x trio), HTTP/TLS handled by Fly for DoH, port 53 TCP+UDP services enabled for router ingress.
* **Published addresses (Miral IP set):**
    * `dns1.resolvezero.com` → `37.16.24.24` (UDP primary, router/Deco)
    * `dns2.resolvezero.com` → `37.16.24.46` (UDP secondary)
    * `dns.resolvezero.com` → `37.16.24.212` (DoH; `fly certs add` after DNS glues)
    * All three IPs serve BOTH DoH and UDP (app services are IP-agnostic); the naming is pure user-side DNS.
* Postgres keeps the app-shaped `DATABASE_URL`; version polling works through PgBouncer (no `LISTEN`/direct connection).
* Log shipper (hosted): deploy [fly-log-shipper](https://github.com/superfly/fly-log-shipper) with `SUBJECT="logs.<edge-app>.>"`, Vector S3 sink keyed `logs/{profile}/{date}/{HHmm}.{instance}.{seq}.jsonl.gz` (`instance` = region+machine+boot nonce), bucket region = data-residency choice. Raw-log lifetime via bucket lifecycle (up to 730 d).

### Scaling model (warm machines, not scale-to-zero)

* **Anycast keep-warm rule:** a stopped Machine drops out of BGP, and UDP traffic cannot wake a stopped machine (`auto_start` doesn't apply to UDP) — so the DNS edge runs **always-warm**, N machines per region (`min_machines_running = N`, `auto_stop_machines = "off"` in fly.toml).
* **Signal = CPU, not requests.** Fly's proxy meters HTTP but does **not count UDP datagrams**, so req-count-based autoscaling is impossible for the DNS path. Each edge exposes `GET /metrics` on a **private port 9091** (`fly.toml [metrics]`; public 8080 returns 404):
    * `rz_cpu_percent` — in-process CPU% delta since last scrape (the autoscale signal; stable across HTTP/UDP/DoH load)
    * `rz_queries_total{action}` — block/forward counters · `rz_query_rtt_ms` — upstream RTT histogram
    * `rz_rules`, `rz_dns_cache_entries` — memory-safety gauges
* **Autoscale path (when load demands it):** run [fly-autoscaler](https://github.com/superfly/fly-autoscaler) reading `rz_cpu_percent` per machine → `fly machines run --region …` scale-up, idle-timeout scale-down *only between machines* (never below 1 warm per anycast region). Simpler interim lever: `FLY_SCALE=2 ./scripts/deploy.sh`.
* Verification: deploy smoke runs UDP/TCP 53 + DoH forward/sinkhole/zone (`apps/edge/scripts/smoke-edge.ts`); sentinel probes `/readyz` + DNS every 10 min and alerts via failed scheduled run.

## 8. Infra Growth Ladder

| Stage | Setup | Cost |
|---|---|---|
| Now (household / early) | Fly anycast + dedicated IPv4, PlanetScale, S3 logs | ~$10–30/mo total |
| Growth (10M+ queries/day) | Leased /24 + own ASN + **Vultr BGP** VMs in ~8 regions (the edge binary deploys unchanged) | ~$300/mo all-in |
| NextDNS-scale endgame | Owned /24 (~$20–40k) + own metal in carrier-hotel PoPs, DPDK Go resolvers | capex + $1k+/mo/PoP — only pays for itself after years of sustained volume |
| DoH capacity bolt-on (any stage) | Cloudflare Workers DoH-only edge (blocklist via KV, upstream DoH fetch) — **no UDP possible on Workers** | ~$5/mo tier |
