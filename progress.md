# Progress Log

Status snapshot + running changelog so a fresh session (or future you) can pick up
without archaeology. The readme is the *spec*; this file is *where we are*.
Secrets (tokens, OAuth secrets, DB URLs) live in `.env` / Fly secrets / GitHub
secrets — never pasted here.

---

## Snapshot — 2026-10-14

### Fleet (app `resolvezero-edge`)
| Machine ID        | Name              | Region | Image                                | State |
|-------------------|-------------------|--------|--------------------------------------|-------|
| `683dd00ea79968`  | dry-resonance-8354| fra    | `resolvezero-edge:deployment-01M4VM8J7NFQ…` | 1/1 checks, started |
| `48edd3d9b14538`  | divine-hill-5264  | lhr    | same tag (parity verified)           | 1/1 checks, started |

- Dedicated anycast IPs (`fly ips list` is authoritative): **37.16.24.24** (dns1/UDP primary), **37.16.24.46** (dns2), **37.16.24.212** (dns/DoH) — all verified answering externally.
- Control app `resolvezero-control` (fra, machine `287d490fe96e08`, config `fly.control.toml`): `/api/healthz` 204, dashboard 200 at https://resolvezero-control.fly.dev.
- `dns.resolvezero.com` TLS done. `dash.`/`api.` domains not wired yet.

### Data plane
- DoH auth is token-gated: bare `/v1/{profileId}` → 404. Forms: `/v1/{id}/{token}`, `/v1/{id}/{device}`, `/v1/{id}/{device}/{token}`. Actual tokens per profile via `apps/edge/scripts/list-profiles.ts` (also hardcoded in `apps/edge/scripts/probe-blocks.ts`).
- Lookup order: zone → explicit rules → remote allow (cross-list ABP `@@`) → remote block → cache → upstream. Unknown UDP source → REFUSED (`UDP_UNKNOWN_SOURCE=refused|silent`), counted in `rz_dropped_total{reason}`.
- Blocklists (home profile, `last_status=ok`): AdGuard DNS Filter ~183.9k, Hagezi Multi NORMAL ~158.8k, KADhosts ~40.7k, Polish Pi-hole ~1.1k → **`rz_remote_list_rules` ≈ 384,566**, 4 tables; steady RSS 52–84MB of 256MB.
- Block ratio still far below NextDNS parity (0.18% vs 5.7%) — watch after the bigger lists settle.

### Control plane
- Better Auth (GitHub-only OAuth, app `Ov23liMHOqViptsPx9bm`, **secret rotation recommended** — it was pasted in chat); user `otuey6NkyUIL5JeoDWlEScC03AeMhvLb` owns `home` (adopted) + `test` profiles, both with auto-generated `doh_token`.
- Login button must POST `/api/auth/sign-in/social` (GET → 404). `BETTER_AUTH_URL=https://resolvezero-control.fly.dev`.

### CI / self-healing
- `deploy.yml` push-main → test (tsc edge/db/control + bun test) → migrate (`DATABASE_URL_ADMIN`) → deploy edge fra+lhr (healthz smoke gate + **machine parity gate**: unique `image_ref.tag`, healthy, `host_status=ok`) → deploy-control (smoke gate). Binary detection `FLYBIN=flyctl || fly`. Concurrency group `deploy`.
- `sentinel.yml` every 10 min: probes healthz + machine list jq (`.image_ref.tag`, `.checks[].status`, `.host_status`); auto-destroys + `fly scale count 1 --region <r>` zombies; alerting = GitHub's built-in failure email (user directive: *don't reinvent the wheel*).
- Known limiter: branch protection on a private repo needs GitHub Pro (parked in readme §7 checklist).

---

## Gotchas we paid for (keep this list)
- Dockerfile: `ARG` is build-time only → `ENV APP_ENTRY=$ENTRY`; fly `build-args` section is `[build.args]` (not `build_args` — silently ignored).
- `Bun.S3Client.list()` returns a paged result, not an async iterable; guard `page.contents ?? []`.
- Hosts/abp parsers must not feed `@@` allow rules through block-only paths; allow stored unexpanded in the fingerprint table (ABP semantics), checked before block tables.
- Fingerprint store keeps **rule** fingerprints only; the query probes its own suffixes (an inverted-semantics bug once made `||collector.github.com^` block apex `github.com`).
- Parallel `Promise.all` blocklist parsing OOMs 256MB VMs — parse sequentially, stage in typed arrays; boxed `bigint[]` + string sets ≈ 1.3GB at 5M rules vs ~150MB typed-array.
- `define` flags / build args get baked at image build; changing them needs a rebuild, not a restart.
- Fly UDP: real anycast traffic always works (watch per-machine `rz_queries_total`), but the **in-VM self-probe** (`apps/edge/scripts/self-udp-probe.ts`) can get "no reply" on long-lived VMs (return-path NAT quirk) — treat as suspicious, not proof of outage; fresh boots reply reliably. TCP probe included in the same script.
- A zombie machine can leave a half-purged UI record the CLI can't destroy (`machine not found`) — deleting from the Fly dashboard UI worked.
- Postgres TRIGGER: `NOTIFY blocklist_updates` trigger is guarded with `UPDATE OF` columns to avoid infinite sync loops; edge boot shows a harmless `ensureRuleNotifyTrigger failed at boot` warn (migrations ensure triggers).

---

## Done (chronological highlights)
1. S3 raw-log pipeline live (iDrive E2, `Bun.S3Client`; round-trip verified via `/v1/:p/logs?format=jsonl|csv`).
2. Custom-URL blocklists end-to-end: schema 0001 (`profile_blocklists`) + NOTIFY trigger; edge parser (hosts/abp/domains, `@@` exceptions); dashboard subscribe/toggle/force-sync.
3. London (lhr) region live; `scripts/deploy.sh` multi-region + FLY_CONFIG param (+ sed instead of grep -P for macOS).
4. Hourly usage rollup runner (`apps/edge/scripts/run-sql.ts` + `hourly-usage.sql`).
5. Upstream benching (`apps/edge/scripts/bench-upstream.ts`): DoH ≈ UDP (2ms vs 1ms) → DoH stays default. Quad9 needs HTTP/2 (done via `node:http2`); Mullvad dead from Fly egress; AdGuard/OpenDNS excluded as competitors.
6. Accounts groundwork: Better Auth + GitHub OAuth, migrations 0003 (auth tables + `profiles.owner_user_id`), UPDATE pruning for old tokens; no email-option; refresh/billing parked.
7. IP linking (NextDNS parity): `update-ip` action + dashboard button + `?ip=` URL; bootstrap-by-DNS-name leak idea rejected (competitors don't do it); per-profile anycast pools = later; `test.resolvezero.com` caller-IP echo = later.
8. REFUSED default for unauthorized UDP + `rz_dropped_total`; silent mode available via env.
9. CI: deploy.yml (4 jobs + gates) green; sentinel.yml green (10-min cron + manual dispatch).
10. Control plane dashboard (`apps/control`): login, onboarding (adopt/create), setup (accept+link IP, device `.mobileconfig` generator, DoH URL copy), rules (manual + allow toggle + list subscriptions), analytics, logs, settings (available IPs; token regen button parked — use `scripts/gen-token.ts`/admin for now).
11. Block ratio work: subscribed AdGuard DNS Filter + Hagezi multi + KADhosts + Polish lists → 384k rules; verified NXDOMAIN blocks, github forward, doubleclick sinkhole; Grafana dashboard JSON generated (`scripts/grafana-dashboard.ts` → `apps/edge/scripts/dashboard-grafana.json`) with `rz_remote_list_*` gauges.
12. Memory project: fingerprint module (`apps/edge/src/fingerprint.ts`) + shared per-URL catalog in ruleStore (`listCatalog`, `subscriptions`, `upsertList/hasList/setSubscriptions/consumeChanged/pruneCatalog`, `replaceAll` prunes dead profiles); OOM fixed (sequential parse, typed-array staging, semantics fix + regression test); deployed; 384,566 rules at 52–84MB RSS.
13. Incident trail (all caught/verified, no user-facing DNS outage): Dockerfile ARG crash → Fly host maintenance killed lhr VM (+ TS runbook in readme §7) → ghost machine record deleted via UI (this session's finale).
14. Self-probe + block-probe tooling hardened; committed with honest caveats.

## Active
- Fra in-VM UDP/TCP self-probe "no reply" on the long-lived fra machine — documented as a fleet-NAT quirk; cross-verified via external dig + `rz_queries_total` climbing. Closed unless it recurs on a fresh boot.
- blocklist-debug.ts `cacheKey` TS error stands as known red herring (tests pinned `typescript ^5.5.0` at root to dodge pre-release tsc noise).
- DNS cache TTL caps: positives ≤5 min, NODATA/NXDOMAIN ≤60s (`dnsCache.ts`). Motivated by the `howmuchpermile.co.uk` apex-A incident — a transient upstream NODATA was cached for the full SOA TTL (1800s) and hid a real record.
- DNS cache is still a single GLOBAL LRU (100k entries / 50 MB, key `name|type|class|DO|CD|upstream`) shared across all profiles — no per-user isolation. **Deferred by decision (2026-10-15):** per-profile scoping/caps and ingress rate limiting are parked to avoid friction during testing; revisit before hosted launch (a hot profile can currently evict others' entries — fairness, not correctness).
- **Rate limiting deferred (2026-10-19):** DoH, UDP 53, log download/delete, and blocklist-fetch throttles (plus the UDP penalty box) are intentionally **not implemented yet** while the product is under heavy development. The hosted edge should be treated as abuse-prone until this lands. Revisit before hosted launch; do not drop from the launch checklist.
- Security/correctness pass landed (2026-10-19): redirect-aware SSRF guard + DNS checks (`netGuard.ts`), bearer-only control→edge calls, OPT/0x20-safe DNS cache, advisory-locked hourly rollups, loop-based reconcile retry, `needsResync` blocklist coalescing, S3 continuation paging + bounded gunzip, healthcheck, and tests (edge 120).
- DNS cache TTLs now decrement on cache hits (RFC 1035/2181), with hard expiry at the cached TTL. TTL jumps between `dig`s are still expected across anycast PoPs: fra/lhr have independent caches and upstream cache ages (observed `227 → 68`); within one entry it counts down (`187 → 186`).
- **Incident 2026-10-20 — UDP/TCP DNS outage (fixed, versions 44–46):** the pass briefly added `USER 1000:1000`; UID 1000 cannot bind privileged port 53, so the edge ran DoH-only while `/healthz` stayed green. Replaced it with a runtime privilege drop (`dropPrivileges()`: bind 53 as root → `setgid`/`setuid` to 1000), made a port-53 bind failure fatal on Fly (`FLY_REGION`/`DNS53_REQUIRED`), fixed TCP to bind `0.0.0.0` + parse Fly PROXY protocol v1 for the real client IP, and added TCP/PROXY/framing tests. Verified `dig` UDP+TCP → NOERROR and logs show `uid:1000,gid:1000`. Lesson: smoke must hit port 53, not just healthz. `DROP_PRIVILEGES=0`, `DROP_UID`, `DROP_GID` are the escape hatches.

## Backlog (pick one next)
- `dash.` / `api.resolvezero.com` Fly certs + extra OAuth callback URL.
- DoT listener (~150 LOC, readme §4b) for Android Private DNS / native profiles.
- NextDNS CSV import — **parked** as hosted-launch "switch from NextDNS" feature (`apps/edge/scripts/import-nextdns.ts` skeleton exists).
- Hosted-launch runbook items: MR-only flip, branch protection (needs Pro), Unbound/live RRL gate, returned-A-record sanity pass, weekly Timescale/s3 eval (readme §7).
- Distroless: **evaluated 2026-10-20, deferred.** `oven/bun:1-distroless` exists (~same size as slim, no shell/apt) and `bun build --compile` works, but it costs `fly ssh console` debugging and adds little over the runtime privilege drop. Revisit at hosted launch.
- DDoS / L4 anycast (2026-10-20): **Gcore Edge Proxy is the promising option** — L4 anycast TCP/UDP, no ASN/BGP/GRE, dedicated proxy IP, ~€17/mo per mapping (UDP+TCP 53 ≈ €27), attack traffic not billed. **UDP client IP is covered by PROXY v2 (v1 is TCP-only)** — needs a v2 header parser + flow PoC. Use General UDP Countermeasure + Generic TCP Server; allowlist Gcore edge IPs and block direct origin. Cloudflare Spectrum = Enterprise + BYOIP (/24); Bunny Shield is website/API-only (not raw 53). Free first step: UDP penalty box/rate limit + silent unknown-source mode. Deferred until abuse appears.
- Multi-PoP readiness (2026-10-20): **P0 implemented and live** — S3 keys include region+machine+boot nonce; blocklist `initialSync()` before binding 53; prune primary-only; runtime DDL removed (migrate-only; app role has no schema DDL — boot warning was real); `/readyz` + TCP-53 check; rolling deploy + `kill_timeout=30` + listener-first drain. P1 remaining: DB pool sizing, rate limiting, token hashing, per-PoP Grafana panels. MVP hardening landed: CI UDP/TCP+DoH smoke, private metrics port, upstream validation/singleflight, `/readyz` status, sentinel probes.
- Config propagation (2026-10-20): switched from `pg-listen`/`LISTEN`/`NOTIFY` to **Postgres watermark polling** — `edge_config_state` single row (`config_version`, `blocklist_version`) bumped by statement-level triggers in migration 0005; each POP polls every 5s (`CONFIG_POLL_MS`), re-snapshots on config change and re-syncs lists on blocklist change. Works through PgBouncer, no missed-event/reconnect edge case. `pg-listen` dependency removed. Migration 0006 drops the legacy `notify_*` functions; only `bump_edge_config_version`/`bump_edge_blocklist_version` remain. Trigger/watermark/function presence is asserted by `migrate.ts`; legacy `notify_*` functions dropped in 0006 (only `bump_edge_*` remain). Also fixed subset-profile blocklist pruning (catalog 4→2 bug) and verified `remoteLists` back to 396,982. **Live-verified:** `config_version` 0→1 after a profile update; both fra+lhr logged `config snapshot loaded` within ~5s.
- **Node runtime migration (`node-runtime` branch, 2026-10-20):** replaced Bun with Node 24 + pnpm + tsx + Vitest. DNS transport now `node:dgram`/`node:net` (same UDP/TCP framing, PROXY v1, TC fallback); HTTP via `@hono/node-server` (main + private metrics 9091); S3 via `@aws-sdk/client-s3` with `forcePathStyle` (iDrive E2); fingerprints via xxhash64; gzip via `node:zlib`. Tests migrated to Vitest (133 pass), typechecks clean. Local parity verified: UDP/TCP forward/block/zone, DoH forward/sinkhole/zone, config-version polling, private metrics, and live S3 write/list/get/delete. `bench-upstream.ts` remains a Bun-only dev benchmark; not runtime.
- **Node staging (`resolvezero-edge-node`, 2026-10-20):** deployed Node 24 to fra+lhr, **512 MB each**, dedicated IP `149.248.204.122`, S3 prefix `node-test-logs`; production `resolvezero-edge` untouched. UDP/TCP 53, DoH forward/sinkhole/zone, `/readyz`, UID 1000 drop, config poll, and S3 writes all verified. **256 MB is not enough for Node**: the lhr machine stalled during the 397k-rule blocklist build; 512 MB recovered. RSS: Bun ~83–87 MB on 256 MB; Node ~156 MB on 512 MB. Bench (same client, p50/p95): DoH Bun 35.6/41.1 ms vs Node 37.1/41.6 ms; cached UDP/TCP comparable; upstream-miss sample was slower on Node but anycast/region routing confounds it. Node image 104 MB vs Bun 90 MB.
- **Production cutover + edge hardening (2026-10-23):** merged `control-v2` into `main` (`58d212c`) and deployed to production `resolvezero-edge`; CI run `39942630834` green. Both fra/lhr machines on image `deployment-01M5M6JB12DCK8ZV4FA8GSYS2Z` (version 60), 3/3 checks passing. `/readyz` shows 405,079 rules and scrubbed error fields; UDP/TCP 53 + DoH smoke pass; edge-served `.lan` verified. Hardening landed: IP-link ownership/409, TCP caps/timeouts, tokenless-profile boot guard, bounded body reads, device cap, log-export limits, pinned-IP SSRF fetch, dev scripts excluded from image. `CODE_REVIEW_EDGE_2026-10-23.md` has full remediation status. New console is merged but not deployed (needs auth first).
- **DNS-presence indicator (2026-10-23):** console generates `<nonce>.probe.resolvezero.com` (no public record) and the edge records it only after profile/source-IP auth, then answers NXDOMAIN. Console polls `dns_probes` and shows “Using ResolveZero” / “Not using ResolveZero” for that browser. No wildcard certificate needed. Migration 0007; production image version 61; DoH probe end-to-end verified (NXDOMAIN + DB row). UDP path covered by tests.
- **PgBouncer runtime cutover (2026-10-25):** runtime `DATABASE_URL` moved from direct Postgres port `5432` to PgBouncer `6432` on edge, control, staging, and local console; `DATABASE_URL_ADMIN` remains direct `5432` for migrations. This avoids the 25-connection direct cap (dashboard showed 9/25 direct vs 1/400 pooled) and keeps transaction pooling compatible with watermark polling. Both production edge machines restarted healthy (3/3 checks); control healthz 204. Pooler queries/transactions verified before cutover.
- **Query-log attribution (2026-10-25):** raw logs now carry `reason` (`manual`/`blocklist`/`zone`), `listId` for blocklist hits (ID only — never the URL/token), `transport` (doh/udp/tcp), safe `upstream` label (preset/custom/edge-default), POP `region`, and internal-only `machine`. Console Logs shows Reason + POP columns; machine is not rendered. Blocklist subscriptions now carry their `profile_blocklists.id`; detail lookup adds no DNS hash scans, only a few dozen bytes per blocked line. Production image version 65; 163 tests passing.
- **Logs + purge + deploy (2026-10-25):** raw-log windows moved to 1 minute and the sink checks completed windows every minute, so console lag is ~1–2 min instead of 15–30. `logs?order=desc` now lists only the last two UTC days so 1-minute object volume does not require a 50k-key prefix scan. Added per-POP cache purge: `POST /v1/:profile/cache/purge` (token-auth, 10/min, JSON name/type), `dns_cache_purges` rows polled by every edge every 5s, local `DnsCache.purge`, Settings UI, and prune after 1h. Upstream resolver caches remain TTL-bound. Deployment defaults to Fly blue-green; CI captures the previous image and auto-rolls back on smoke/parity failure; `scripts/rollback.sh` for manual rollback. Production deployed as version 67 with blue-green (both machines 3/3); cache-purge endpoint and per-POP poll verified live; 1-minute archive objects verified with ~1–2 min console lag.

- Mobileconfig polish + device tagging UX (topDevices rollups exist; UI chart pending).
- Remote `doh_token` regen from dashboard (admin RPC path already exists in `.env` admin).
- Rules-at-scale design documented in [`docs/rules-at-scale.md`](docs/rules-at-scale.md): compiled base bundles + tenant overlays, artifact store/manifest, 2 GB capacity estimates, Node-vs-Bun findings, and why Redis is not the rule path. Not implemented yet.

## Tooling cheat-sheet
- Deploy: push `main` (CI) or `scripts/deploy.sh local` (regions fra+lhr); control: `scripts/deploy.sh control`.
- Probes: `pnpm exec tsx apps/edge/scripts/probe-blocks.ts` (external, token hardcoded), `pnpm exec tsx apps/edge/scripts/self-udp-probe.ts` (in-VM via `fly ssh console`), `pnpm exec tsx apps/edge/scripts/check-lists.ts` (list health).
- SQL: `pnpm exec tsx apps/edge/scripts/run-sql.ts <file.sql>`; hourly rollup cron idea == run-sql + hourly-usage.sql.
- Grafana dashboard: `pnpm exec tsx scripts/grafana-dashboard.ts` refreshes the JSON.
- Tailscale: hardcodes DoH for NextDNS/ControlD only (ts#15724) — OS-native `.mobileconfig` is our path (generator already in dashboard).
