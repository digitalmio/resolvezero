# ResolveZero — Code Review v2 (2026-10-19)

Scope: `apps/edge`, `apps/control`, `apps/control-plane`, `packages/db`, `packages/shared`, `Dockerfile`, `fly*.toml`, `.github/workflows`, vs `readme.md` + `progress.md`.

Method: re-read of the v1 findings against the **current working tree** (20 modified files, +482/−103, uncommitted), full diff review, hot-path verification, plus:
- `cd apps/edge && bun test` → **98 pass, 0 fail**
- `cd apps/control && bun test` → **6 pass, 0 fail**
- `cd apps/edge && bunx tsc --noEmit` → clean
- `cd apps/control && bunx tsc --noEmit` → clean

> ⚠️ Everything marked “fixed” below lives in the **uncommitted working tree**, not on `main`. Review + commit/CI before treating it as deployed.

---

## 0. Verdict

The v1 report was accurate. The current working tree fixes **most** of the high-impact functional and data-correctness bugs (UDP remote lists, dashboard Clients data, FQDN canonicalization, rule normalization, cache keying, drain order, CSV injection, update-ip validation).

Remaining hosted-launch blockers, in priority order:

1. **SSRF guards are bypassable** — redirects are followed without revalidation, hostnames are never resolved, and private upstreams are allowed by default (`STRICT_UPSTREAM_SSRF` off). The new guards raise the bar but do not close the hole.
2. **No ingress rate limiting** (DoH, UDP 53, logs) — explicitly deferred in `progress.md`, but readme still promises a UDP penalty box. Required before hosting untrusted users.
3. **Tokens still travel in URLs** on dashboard→edge calls (stats/logs/sync/update-ip), and tokens are stored plaintext.
4. **UDP/DoH policy parity is still incomplete** — remote blocks are now honored on UDP, but an explicit `allow` rule no longer overrides a remote block on UDP (it does on DoH).
5. **S3 download/delete still cannot see >1000 objects**, and the gzip bomb guard does not actually bound inflation.
6. **Hourly rollup is still read-modify-write** — cross-region last-writer-wins remains.
7. **Blocklist syncs that arrive during a running sync are silently dropped.**
8. **DNS cache ignores EDNS/DO/CD and replays the upstream OPT + original question case** across profiles; TTL 0 is still never cached.
9. **`ruleSync` retry uses unbounded async recursion** — a long DB outage grows the promise chain indefinitely.
10. **Container runs as root, no HEALTHCHECK; CI smoke only checks `/healthz`.**

---

## 1. Status of the v1 findings

### Security (v1 §1)

| ID | Status | Evidence / note |
|---|---|---|
| S1 SSRF via list URLs + `upstream_url` | **Partial** | Guards added: `blocklists.ts:175-190,239-265` (https-only, literal private/metadata host block) and `upstream.ts:74-98`. Still bypassable — see R1. |
| S2 CSRF on dashboard mutations | **Partial** | Origin/Referer gate on `/dash/*` (`dash.ts:268-294`). No CSRF token; requests without Origin/Referer are allowed; `SameSite` not set/verified here. |
| S3 Tokens in URLs + HTML | **Partial** | Stats/logs/admin now accept `Authorization: Bearer` (`stats.ts`, `logs.ts`, `admin.ts`). Dashboard still sends `?token=` (`dash.ts:180,223,553,573,587,674`). Tokens still plaintext at rest (`ruleStore.ts:193`). |
| S4 `update-ip` open/spoofable | **Partial** | Real IP validation via `isIP` (`admin.ts:55-78`), rate limit, and upsert-move. Token-free profiles are still unauthenticated by design; no ownership check on move. |
| S5 No rate limiting | **Partial** | Only `update-ip` (30/min) and `blocklist sync` (10/min) (`admin.ts:12-27`). DoH/UDP/logs still unlimited. |
| S6 UDP source-IP auth spoofable | **Open** | `dns53.ts:143-160`; REFUSED remains the default. Docs still call the whitelist “auth”. |
| S7 Unbounded device slugs | **Fixed (cap)** | `seenDevices` capped at 200/profile (`ruleStore.ts:368-386`). Still no per-profile ingress rate limit. |
| S8 CSV formula injection | **Fixed** | `csvField()` quotes + neutralizes formula prefixes (`logs.ts:23-31,107-113`). |
| S9 Unbounded DoH bodies | **Fixed** | GET `dns` ≤4096, POST ≤65535 (`doh.ts:91-99`). Chunked bodies are checked after buffering; acceptable. |
| S10 Whole-gzip inflate OOM | **Partial / ineffective** | See R5. The cap is checked against **compressed** size, then gunzip runs fully (`logs.ts:86-98`). |
| S11 Zone `values[]` validation | **Partial** | Type/count/length validated (`dash.ts:606-609`), but A/AAAA values are not syntax-validated and `zoneAnswer()` is still not try/caught in either ingress. |
| S12 Auth oracles | **Mostly unchanged** | 404 paths are still shape-dependent; low impact. |
| S13 Dash→edge timeouts / wrong IP | **Partial** | Stats fetch has 8s timeout; link-ip now sends token + caller IP (`dash.ts:222-225,378-405`). **Logs page fetch still has no timeout** and reads the whole day (`dash.ts:674`). |
| S14 CORS `*` / missing headers | **Open** | `control/src/index.ts:49-58`; no CSP, frame-ancestors, HSTS, or Referrer-Policy. |
| S15 Root container / signal handling | **Partial** | `Dockerfile:28` now `exec`s Bun (SIGTERM reaches PID1). Still root, no `HEALTHCHECK`. |
| S16 Unauthenticated `/metrics` + list regex CPU | **Open** | `/metrics` is on the public 8080 app (`metrics.ts:119-132`). Blocklist parsing regexes unchanged. |

### Bugs & logic (v1 §2)

| ID | Status | Evidence / note |
|---|---|---|
| B1 UDP ignores remote lists | **Fixed (block), parity gap left** | `dns53.ts:183-188` now calls `resolveRemote`. Explicit `allow` precedence differs — see R4. |
| B2 `mergeTop(clientIp)` empty + Clients tile | **Fixed** | `stats.ts:50-57`; `dash.ts:171-174,316-319` uses `queriesPerClient`. |
| B3 `canonical()` regex typo / bare-TLD probe | **Fixed** | `fingerprint.ts:166-168,203-210`. |
| B4 Cache key profile/upstream-agnostic | **Partial** | Key now `name|type|class|upstream` (`dnsCache.ts:66-73`); TTL caps added. OPT/EDNS/DO/CD/case still unhandled — see R8. |
| B5 Rule writes not normalized | **Fixed** | `normalizeRuleDomain()` on snapshot/event/read (`ruleStore.ts:151,208-220,229-231`). |
| B6 `in` prototype-chain check | **Fixed** | `Object.hasOwn` (`upstream.ts:24,48`). |
| B7 Reconcile race / unbounded buffer | **Fixed (mutex/cap), new recursion risk** | `ruleSync.ts:118-139,146-153`. Retry recursion is now the risk — see R9. |
| B8 Hourly rollup RMW race | **Open** | `rollup.ts:162-215` unchanged. |
| B9 Drain order / batcher overflow | **Partial** | Drain order fixed (`index.ts:157-168`); batcher honors backoff and drains in `stop()` (`batcher.ts:65-110`). **Blocklist coalescing still drops syncs** (`blocklists.ts:46`). |
| B10 Hosts multi-name lines | **Fixed** | `blocklists.ts:211-225` iterates all name tokens. |
| B11 IP move leaves stale whitelist | **Addressed** | `update-ip` now upserts the owner (`admin.ts:75-78`); IP key is stable so the map updates in place. Verify trigger path on a real move. |
| B12 `seenDevices` unbounded | **Fixed (cap)** | 200/profile. |
| B13 TTL 0 never cached / SOA minimum | **Open** | `dnsCache.ts:47` still returns. |
| B14 Prune retention=0 | **Low / open** | `prune.ts` uses `log_retention_days`; a DB-level 0 still deletes the current hour. |
| B15 S3 seq/retry/concurrency | **Partial** | `S3_FLUSH_MINUTES` wired (`index.ts:55-57`), `flushAll` drains staged + pending. `listAllKeys` still single-page; parallel delete unbounded — see R5. |

### Spec drift (v1 §3)

| Drift | Status |
|---|---|
| a) `upstream_url` dead end-to-end | **Fixed** — schema, sync, store, UI, edge all wired (`schema.ts:100`, `ruleSync.ts:161,202`, `dash.ts:739,762-769`). |
| b) UDP rate limiting promised, absent | **Open** |
| c) `S3_FLUSH_MINUTES` not read | **Fixed** (`index.ts:55`) |
| d) Two DB configs (pooled + direct) | **Open** — still single `DATABASE_URL`. |
| e) Cache hits never logged | **Open** — `doh.ts:177-181`, `dns53.ts:191-195` record metrics but skip `logQuery`. |
| f) Zone answers counted as `forward` | **Open** — `doh.ts:137`, `dns53.ts:173`; no `override` recorder series. |
| g) Stale silent-drop comment | **Fixed** — `dns53.ts:40-45`. Readme §6 still stale (see R11). |

---

## 2. Remaining findings (new/verified)

### R1. SSRF guards are bypassable [High]

Current guards only inspect the **literal hostname string** of the **initial** URL:

- `blocklists.ts:180` uses `redirect: "follow"`; `upstream.ts` lets ofetch follow redirects by default. An attacker-controlled `https://evil.example/list` can 302 to `http://169.254.169.254/...`.
- Never resolves DNS: `https://localtest.me/...`, `https://169.254.169.254.nip.io/...`, `https://2130706433/...` (decimal 127.0.0.1), `https://0x7f000001/`, `https://[::ffff:127.0.0.1]/` all bypass the string checks.
- `upstream.ts:87` blocks private ranges **only** when `STRICT_UPSTREAM_SSRF=1`. A hosted deployment that forgets the env var permits `http://10.x`, `http://[::1]`, etc.
- `isPrivateHost()` misses IPv6 ULA (`fc00::/7`), link-local v6, `0.0.0.0`, and CGNAT (`100.64/10`).

**Fix:** fetch redirects manually (`redirect: "manual"`, max 3 hops) and re-run the full check on every `Location`; resolve the hostname and reject any resolved private/link-local/loopback/metadata address (or pin the dial IP); make strict/private-deny the default for hosted and require an explicit self-host opt-in; allowlist https only for lists.

### R2. Ingress rate limiting [High]

No throttle on DoH or UDP. A token holder can cache-bust random names, grow log storage via `batcher.add`, trigger repeated 30 MB list fetches, and exhaust upstream quota. UDP REFUSED replies remain a reflection/amplification surface for spoofed sources (`dns53.ts:143-160`).

The current admin limiter is also process-local and **unbounded**: `hits` is never pruned (`admin.ts:12-23`), so an attacker cycling keys leaks memory; keys are spoofable off-Fly via `x-forwarded-for`.

**Fix:** bounded token buckets (LRU) keyed by `profileId + client IP`, applied before policy/upstream; a UDP penalty box that drops (not REFUSED) over-limit sources; per-profile daily quotas for list fetches, log download, and delete; share limits across regions if running multi-region (Redis or PG).

### R3. Token handling still leaks [High]

- Dashboard→edge stats/logs/sync/update-ip still put `?token=` in URLs (`dash.ts:180,223,553,573,587,674`). These URLs land in proxy/access logs and can leak via `Referer` (no `Referrer-Policy`).
- Tokens remain plaintext in Postgres (`ruleStore.ts:193`); readme §4 itself says hash before launch.
- DoH path tokens are protocol-mandated, but should still be treated as secrets in logs (never log the path).

**Fix:** use `Authorization: Bearer` for all management calls; introduce short-lived signed download URLs for `/logs`; hash tokens at rest (compare hash); add `Referrer-Policy: no-referrer` on setup pages and redact path tokens from access logs.

### R4. UDP/DoH parity: explicit `allow` does not beat remote blocks [Medium-High]

- DoH: `const explicit = resolve(...)`; remote block only `if (!explicit)` (`doh.ts:140-158`).
- UDP: explicit check is `=== "block"` only, then `resolveRemote() === "block"` unconditionally (`dns53.ts:178-188`).

So a user-authored `allow` rule works on DoH but is overridden by a remote list on UDP. Also remote `@@` allow vs explicit block is consistent, but the table is not tested across both ingresses.

**Fix:** extract one `decide(profileId, name, type)` pipeline used by both transports, and add a parity matrix test (zone / explicit allow / explicit block / remote allow / remote block / cache hit / upstream).

### R5. S3 completeness + decompression bound [High]

- `listAllKeys()` (`sinks/s3.ts:18-29`) reads exactly one page. Bun’s client has no continuation token, so it sets `truncated` — honest, but download/delete are still incomplete beyond ~1000 objects (≈10 days/profile at 15-min windows). `DELETE` then reports only what it saw.
- `truncated` is also true at exactly 1000 keys (false positive).
- Delete fires all keys concurrently: `Promise.all(keys.map(delete))` (`logs.ts:151`) — up to 50k parallel deletes.
- Gzip cap is ineffective: `compressed.length > MAX` then `Bun.gunzipSync(compressed.slice(...))` (`logs.ts:86-98`). A 32 MB gzip bomb still inflates fully before `raw.length` is checked. `slice()` on gzip bytes also makes truncated streams fail and be skipped.
- The dashboard `/logs` page fetches a whole day and `slice(-400)`s it in memory (`dash.ts:674-690`), with no timeout.

**Fix:** read the gzip ISIZE trailer (last 4 bytes) before inflating and stream via `DecompressionStream` with a hard byte counter; use S3 continuation tokens when the client exposes them (or partition keys and list per day); batch deletes with concurrency ~8; add `limit`/tail support to the edge logs endpoint and use it from the dashboard.

### R6. Hourly rollup last-writer-wins [High]

`rollup.ts:162-215` still does `SELECT` → merge in JS → absolute `INSERT … ON CONFLICT DO UPDATE`. With fra+lhr writing the same `(profile, hour)`, one region’s increments are lost. Same-bucket `Promise.all` compounds it.

**Fix (recommended):** make the PK `(profile_id, hour, region)` and sum at read time; or use per-bucket advisory locks / `SELECT … FOR UPDATE`; or SQL-side additive upsert for scalar fields plus a merge strategy for top lists. Add a two-writer test.

### R7. Blocklist syncs are dropped during a long fetch [Medium-High]

`if (syncing) return;` (`blocklists.ts:46`) has no `needsResync` flag. A NOTIFY that arrives while a 30 MB list is downloading is lost until the 6-hour interval. (The 3 s `syncNow` debounce only coalesces bursts before the sync starts.)

**Fix:** set `needsResync = true` when busy and loop once at the end; add jitter to the periodic timer.

### R8. DNS cache answers leak transport/EDNS state [Medium]

The key improvement is correct, but the cached **response wire** is replayed verbatim (only the transaction ID is patched, `dnsCache.ts:35,96`):

- Upstream OPT/EDNS payload size is replayed to clients that didn’t send one.
- `DO`/`CD`/`RD` flags are not part of the key, so DNSSEC records can be served to non-DO clients (and vice versa).
- 0x20/case-randomizing stub resolvers may reject a response whose question case differs from their query (name is lowercased in the key).
- `ttl <= 0` still disables caching instead of applying the RFC 2308 SOA-minimum negative TTL (`dnsCache.ts:47`).

**Fix:** strip OPT before storing, rebuild the response question from the request, include `DO`/`CD` in the key (or bypass cache for `DO=1`), preserve the request’s question name, and use SOA minimum for negative TTL.

### R9. Reconcile retry is unbounded async recursion [Medium]

`await reconcile()` inside `catch` (`ruleSync.ts:226-234`) retains every prior call frame across the 2 s sleep. A multi-hour DB outage grows the promise chain without bound.

**Fix:** replace recursion with a `while` loop + exponential backoff + jitter, and stop retrying on shutdown.

### R10. Dashboard log page can hang / over-read [Medium]

`dash.ts:674` fetches a full day of JSONL with no timeout, buffers it, then keeps the last 400 lines. An edge slowdown hangs the SSR request; a busy profile transfers/allocates megabytes.

**Fix:** pass `limit`/`since` to the edge, timeout at 8 s, stream/parse incrementally.

### R11. Config + docs drift [Medium/Low]

- `readme.md` still says Quad9 is the default in §1/§6.3, but code defaults to Cloudflare (`upstream.ts:24`).
- §6.3 says “cache by upstream TTL incl. NXDOMAIN” — now capped (positives ≤5 min, negatives ≤60 s).
- §6.4 says “silent-drop unauthenticated; rate-limit permitted sources” — code defaults to REFUSED and has no rate limit.
- Settings accepts `http://` custom upstreams (regex `^https?://`) while the list UI requires https; the edge allows private hosts by default.
- Still a single `DATABASE_URL` despite the readme’s pooled + direct design; PgBouncer transaction mode would break `LISTEN` at scale.
- Cache-hit queries are still not written to query logs despite “all queries are logged”.
- Zone overrides are still counted as `forward`, so the dashboard/Grafana conflate them.

### R12. Ops / CI [Medium]

- `Dockerfile`: root user, no `HEALTHCHECK`; `sh -c exec` is correct but an `ENTRYPOINT` + explicit `CMD` would be clearer.
- CI smoke only checks `/healthz` / `/api/healthz`; no DoH forward, sinkhole, zone, or list-sync probe despite readme §7.
- `sentinel.yml` still has its own concurrency group, so it can race `deploy.yml`.
- Public `/metrics` (`metrics.ts:119-132`) — require a bearer token or bind it to a separate/internal port.
- No test for the new guards or the new dashboard paths.

---

## 3. Test gaps introduced by the fixes

New behavior is largely untested. Add, in priority order:

1. **Transport parity matrix** — one table-driven test over DoH + UDP: zone, explicit allow, explicit block, remote allow, remote block, cache hit, upstream failure. Catches R4.
2. **SSRF guard** — redirect-to-metadata, `localtest.me`/decimal IP/IPv6 forms, private ranges, credential URLs; assert both list fetch and upstream reject.
3. **DNS cache** — same name different upstream, different class, DO/CD, OPT stripping, case preservation, TTL caps, TTL 0.
4. **`mergeTop(clientIp)`** round-trip through `/v1/:id/stats` (currently only domain is unit-tested).
5. **Logs/S3** — >1000 keys truncation flag, gzip bomb, corrupt object skip, DELETE completeness/batching.
6. **`update-ip`** — invalid IPs (`999…`, `:::::`), move between profiles, token-free behavior, rate limit.
7. **Batcher drain** — multiple full batches flushed on `stop()`, failure retains and does not spin.
8. **RuleStore** — mixed-case/trailing-dot rule ingest and lookup (partially covered).
9. **Dashboard** — zero tests today; at minimum Clients tile, link-ip token/IP forwarding, CSRF Origin rejection.

---

## 4. Recommended next steps

### Phase 0 — land the current batch (today)
1. Review `git diff` for the 20 files; ensure no secrets/debug artifacts.
2. Add the parity + SSRF + cache tests above (at least 1–3) alongside the fixes.
3. Run `bun test` + `tsc --noEmit` in both apps; push through CI; deploy to a staging app before `main`.

### Phase 1 — hosted-launch blockers
4. **SSRF**: manual redirects, DNS-resolution check, private-deny by default. *Done when a redirect to `169.254.169.254` and a hostname resolving to `127.0.0.1` both fail.*
5. **Rate limiting**: DoH + UDP + logs + list fetch; bounded keys; UDP penalty box. *Done when a token holder is throttled and over-limit UDP is dropped before upstream.*
6. **Token hygiene**: Bearer everywhere, hashed at rest, no tokens in HTML/Referer, signed log downloads.
7. **UDP parity**: shared decision function; explicit allow overrides remote block on both transports.
8. **S3/logs**: real pagination or per-day listing, streamed bounded gunzip, batched deletes, dashboard tail.
9. **Rollup**: region-keyed rows or locked additive upsert; two-writer test.
10. **Blocklist sync**: `needsResync` + jitter.

### Phase 2 — correctness hardening
11. Cache: strip OPT, key on DO/CD, preserve question case, SOA-minimum negatives.
12. `ruleSync`: loop-based backoff.
13. Dashboard: timeouts, streaming logs, CSRF token + explicit `SameSite`, security headers (CSP/HSTS/frame-ancestors/Referrer-Policy), `TRUSTED_ORIGINS`/CORS allowlist.
14. Metrics auth; zone `override` counter; cache-hit logging (or fix the docs).

### Phase 3 — ops/CI/docs
15. Non-root container + `HEALTHCHECK`; exec/entrypoint cleanup.
16. CI: real DoH smoke (forward + sinkhole + zone), log download round-trip, reconcile test; merge sentinel into the deploy concurrency group.
17. Update `readme.md` §1/§6 for Cloudflare default, capped TTLs, REFUSED behavior, rate-limit status, and the single-DB reality.

---

## Appendix — verification commands

```bash
cd apps/edge && bun test && bunx tsc --noEmit
cd apps/control && bun test && bunx tsc --noEmit
```

Current result: edge 98/98, control 6/6, both typechecks clean.

*Line references verified against the working tree on 2026-10-19. The v1 report (2026-10-15) remains useful as the source finding list; this revision supersedes its status calls.*
