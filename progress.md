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
- Security/correctness pass landed (2026-10-19): redirect-aware SSRF guard + DNS checks (`netGuard.ts`), bearer-only control→edge calls, OPT/0x20-safe DNS cache, advisory-locked hourly rollups, loop-based reconcile retry, `needsResync` blocklist coalescing, S3 continuation paging + bounded gunzip, healthcheck, and tests (edge 118).
- **Incident 2026-10-20 — UDP/TCP DNS outage (fixed, versions 44–46):** the pass briefly added `USER 1000:1000`; UID 1000 cannot bind privileged port 53, so the edge ran DoH-only while `/healthz` stayed green. Replaced it with a runtime privilege drop (`dropPrivileges()`: bind 53 as root → `setgid`/`setuid` to 1000), made a port-53 bind failure fatal on Fly (`FLY_REGION`/`DNS53_REQUIRED`), fixed TCP to bind `0.0.0.0` + parse Fly PROXY protocol v1 for the real client IP, and added TCP/PROXY/framing tests. Verified `dig` UDP+TCP → NOERROR and logs show `uid:1000,gid:1000`. Lesson: smoke must hit port 53, not just healthz. `DROP_PRIVILEGES=0`, `DROP_UID`, `DROP_GID` are the escape hatches.

## Backlog (pick one next)
- `dash.` / `api.resolvezero.com` Fly certs + extra OAuth callback URL.
- DoT listener (~150 LOC, readme §4b) for Android Private DNS / native profiles.
- NextDNS CSV import — **parked** as hosted-launch "switch from NextDNS" feature (`apps/edge/scripts/import-nextdns.ts` skeleton exists).
- Hosted-launch runbook items: MR-only flip, branch protection (needs Pro), Unbound/live RRL gate, returned-A-record sanity pass, weekly Timescale/s3 eval (readme §7).
- Mobileconfig polish + device tagging UX (topDevices rollups exist; UI chart pending).
- Remote `doh_token` regen from dashboard (admin RPC path already exists in `.env` admin).

## Tooling cheat-sheet
- Deploy: push `main` (CI) or `scripts/deploy.sh local` (regions fra+lhr); control: `scripts/deploy.sh control`.
- Probes: `bun run apps/edge/scripts/probe-blocks.ts` (external, token hardcoded), `bun run apps/edge/scripts/self-udp-probe.ts` (in-VM via `fly ssh console`), `bun run apps/edge/scripts/check-lists.ts` (list health).
- SQL: `bun x tsx apps/edge/scripts/run-sql.ts <file.sql>`; hourly rollup cron idea == run-sql + hourly-usage.sql.
- Grafana dashboard: `bun run scripts/grafana-dashboard.ts` refreshes the JSON.
- Tailscale: hardcodes DoH for NextDNS/ControlD only (ts#15724) — OS-native `.mobileconfig` is our path (generator already in dashboard).
