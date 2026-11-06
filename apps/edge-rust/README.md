# resolvezero-edge (Rust)

A Rust rewrite of the DNS data plane in `apps/edge`. **Work in progress — not
deployed and not wired into CI.** The Node edge remains the production server.

The point is the memory profile: the Node edge carries a ~156 MB baseline and a
100–165 MB parse transient per 500k-rule list. Rust runs the same rule set in
**~52 MB RSS** with no GC headroom, and boots the whole catalog in ~1 second.

## Measured (local, release build, real database)

| | Node edge | Rust edge |
|---|---:|---:|
| Rules loaded | 397k | **406,707** |
| Unique list tables | 4 | 4 |
| RSS after boot | ~156 MB | **51.6 MB** |
| Boot / initial list sync | tens of seconds (deploy grace is 120 s) | **~1 s** |
| Release binary | ~104 MB image | **5.3 MB binary** |

Parser parity was checked against the TypeScript implementation on the four
live lists: both produce **406,707** entries (171,417 Hagezi, 189,625 AdGuard,
44,523 KADhosts, 1,142 Polish Pi-hole).

## What works

- Postgres config snapshot + 5 s `edge_config_state` version polling.
- Shared per-URL blocklist catalog, ABP/hosts/bare-domain parsing, allow-first
  precedence across lists, 5M global entry budget, 64 lists/profile.
- Custom rules with subtree semantics, local zones (exact + `*.` wildcard,
  A/AAAA/CNAME/TXT), block modes (`null` / `nxdomain` / `refused` / custom IP).
- DNS cache keyed by name/type/class/DNSSEC intent/upstream, with the Node
  edge's TTL caps (positive 300 s, negative 60 s).
- DoH GET (`?dns=`) and POST, path shapes `/v1/:id`, `/v1/:id/:token`,
  `/v1/:id/:device`, `/v1/:id/:device/:token`, constant-time token compare.
- UDP 53 with source-IP auth and `UDP_UNKNOWN_SOURCE=refused|silent`.
- TCP 53 with PROXY protocol v1/v2 (Fly's `proxy_proto` ingress).
- Upstream presets (Cloudflare/Google/Quad9) and custom DoH URLs.
- `/healthz`, `/readyz` (rules, tables, RSS), `/metrics` on a private port.
- Privilege drop after binding 53 (UID/GID 1000 by default).
- xxhash64 fingerprints identical to the TS runtime (seed 0).

## Not ported yet (required before cutover)

- Query-log batching + S3 archive, stats/rollups to Postgres, per-device
  rollups, the logs/stats/admin APIs. A Rust machine currently serves DNS but
  writes no analytics.
- DoT on 853 (SNI/authority TLV mapping to a profile). Fly's TLS proxy is in
  place; the listener is not.
- Blocked services catalog, SafeSearch, DNS-presence probe.
- Rate limiting / semaphores, per-device write-behind, exact TTL rewriting on
  forwarded answers (the cache is capped, the returned TTL is untouched).
- Content-addressed artifacts (same format is planned for both runtimes).

## Run locally

```sh
cd apps/edge-rust
DATABASE_URL='postgresql://…' \
PORT=8088 DNS_PORT=5354 METRICS_PORT=9191 \
DROP_PRIVILEGES=0 LOG_LEVEL=info \
cargo run --release
```

Then:

```sh
curl -s localhost:8088/readyz
# DoH POST with a wire query against /v1/<profile>/<token>
```

Tests: `cargo test` (25 tests). Lint: `cargo clippy --all-targets`.

## Environment

Same names as the Node edge where possible: `DATABASE_URL`, `PORT` (DoH),
`DNS_PORT`, `METRICS_PORT`, `FLY_REGION`, `UPSTREAM_DOH_URL`,
`UPSTREAM_PRESET`, `UDP_UNKNOWN_SOURCE`, `BLOCKLIST_MAX_TOTAL_ENTRIES`,
`BLOCKLIST_MAX_LISTS_PER_PROFILE`, `LIST_SYNC_INTERVAL_SECONDS`,
`CONFIG_POLL_MS`, `DROP_PRIVILEGES`, `DROP_UID`, `DROP_GID`, `LOG_LEVEL`.

`sslrootcert=system` in the PlanetScale URL is stripped because sqlx treats it
as a file path; rustls then uses its bundled roots.
