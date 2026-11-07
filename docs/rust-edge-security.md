# Rust Edge — Security Review Follow-up

**Scope:** the 2026-11-07 review of `apps/edge-rust`
**Status:** fixes are on `feat/rust-edge`; not merged, not deployed
**Last updated:** 2026-11-07

The Rust edge started as a behavior port of the Node edge, not a security
parity port. This pass closes the cutover blockers from the review. The canary
app was destroyed before this work, so none of the findings were ever
production-exposed.

## Fixed

### 1. SSRF guard for tenant-controlled URLs — fixed

`apps/edge-rust/src/netguard.rs` is a port of `apps/edge/src/netGuard.ts`:

- https-only by default (lists **and** custom upstreams); `ALLOW_HTTP_TARGETS=1`
  is the explicit self-host escape hatch (requires `ALLOW_PRIVATE_TARGETS=1`).
- rejects embedded credentials and metadata hosts.
- resolves the host and rejects loopback/private/link-local/CGNAT/multicast/
  reserved/documentation ranges (including IPv4-mapped and NAT64 forms).
- **pins the validated address** for the connection (DNS-rebinding window
  closed).
- re-validates every redirect hop, max 3.
- response bodies are streamed with a hard cap (no post-hoc size check).
- used by `lists.rs`, `upstream.rs` (custom URLs), `rz-compile`, and the
  artifact/log fetchers.
- `ALLOW_PRIVATE_TARGETS=1` remains for self-hosted Unbound/internal lists.

### 2. Upstream response validation — fixed

- Hard 65,535-byte cap while streaming; oversized bodies are rejected.
- `dns::validate_upstream` checks QR, response ID, question name/type/class.
- Upstream HTTP redirects are not followed.
- Only **NOERROR / NXDOMAIN** produce a cache TTL; SERVFAIL/REFUSED/FORMERR/
  BADVERS are never cached.
- TCP responses over 65,535 bytes are replaced with SERVFAIL instead of being
  length-truncated.
- Upstream errors are logged with `reqwest::Error::without_url()` so custom
  upstream URLs (which may carry tokens) do not reach logs.

### 3. Resource limits — largely fixed

| Ingress | Control |
|---|---|
| DoH | 600/min per client IP, 256 in-flight, 5 s timeout, 65,535-byte POST cap, 4,096-byte GET cap, content-type check, `Cache-Control: no-store` |
| UDP 53 | 600/min per source, 1,024 in-flight, TC response when the answer exceeds the client's EDNS payload |
| TCP 53 | 512 concurrent connections, 30 s idle timeout, 300 s lifetime, 5 s PROXY-header timeout |
| Fetches | streamed caps for lists, upstreams, artifacts, logs |
| List sync | 256 unique lists, 180 s cycle deadline, 30 s retry after a failed cycle |

UDP now binds `fly-global-services` when `FLY_REGION` is set (the Node edge's
requirement; `0.0.0.0` does not receive Fly UDP traffic). DoH-only deployments
set `UDP_BIND=0.0.0.0`.

**Still open:** single-flight coalescing for identical cache misses; per-source
TCP connection caps (only a global cap exists); DoH limiting is per client IP,
not per profile.

### 4. hickory-proto advisory — fixed

- Upgraded `hickory-proto` **0.24.4 → 0.26.3** (patched line).
- Inbound queries are rejected unless they are a standard QUERY with exactly
  one question (no QR=1, no other opcodes, no multi-question packets).
- Responses echo exactly **one** question, never the attacker-supplied section.
- UDP/DoH/TCP message sizes are bounded in addition to the crate fix.

### 5. Privilege drop — fixed

- `setgroups(0, NULL)`, `setgid`, `setuid` return values are checked; any
  failure aborts startup.
- `PR_SET_NO_NEW_PRIVS` on Linux.
- Drops whenever euid is 0 by default (`DROP_PRIVILEGES=0` is an explicit
  opt-out); the old FLY_REGION-only default is gone.
- The container still starts as root to bind 53, then drops. A non-root +
  `CAP_NET_BIND_SERVICE` image is **not** done.

### 6. DNS cache normalization — fixed

`dns.rs` / `cache.rs` now:

- key the cache on name, type, class, CD, **a hash of the full EDNS OPT**
  (covers ECS/cookies/EDNS version), and upstream URL;
- strip OPT before storing **and** serving, so one client's ECS/cookie/padding
  is never replayed to another;
- rewrite the question name to the requesting query's exact case (0x20-safe);
- count TTLs down while cached;
- cache only NOERROR/NXDOMAIN.

Cache hits are parsed and re-encoded (hickory 0.26 fixed the O(n²) encoder);
the hot-path cost is accepted for correctness.

### 7. Filter freshness and readiness — fixed

- The periodic list sync now actually uses `list_interval` (default 6 h), in
  addition to `blocklist_version` changes.
- The version is advanced only after a successful sync; failures retry after
  30 s.
- `/readyz` now reports `blocklistOk`, `blocklistError`, `failedBlocklists`,
  `blocklistLastSyncAgeMs`, and returns **503** when the initial/last sync is
  unhealthy. This is deliberately strict: an unfiltered resolver is worse than
  an unready one. Partial failures are visible to monitoring.
- Tokenless profiles are re-checked on every snapshot apply and rejected at
  request time in hosted mode (DoH/UDP/TCP), not only at boot.

### 8. Cross-tenant zone scan — fixed

`has_zone_name` no longer scans every zone of every profile per query. Zone
names are indexed per profile (`zone_names`, `wildcard_names`), so NODATA
checks cost O(label count).

### 9. Smaller hardening

- profile IDs are charset/length validated (`[a-zA-Z0-9-]{1,64}`), matching the
  schema's 8-char ids with defense in depth.
- token comparison hashes both values with SHA-256 and compares them with
  `subtle::ConstantTimeEq`, removing both content and length oracles.
- `Config`, `S3Config`, `ProfileMeta`, and `RuleStore` no longer derive `Debug`
  (they hold DB URLs, S3 secrets, or profile tokens).
- list URLs logged to the edge are redacted (query/userinfo stripped).
- `DATABASE_URL` is forced to `sslmode=verify-full` (self-host local Postgres
  opts out with `DATABASE_SSL=disable`).
- S3 endpoints must be https (localhost/`ALLOW_HTTP_S3=1` are the only
  exceptions); one shared client is reused; canonical URIs are percent-encoded;
  artifact downloads are streamed capped at 64 MiB; the decoder uses checked
  arithmetic and validates the header's total; sidecar JSON escapes control
  characters.
- the query logger has an explicit shutdown channel; SIGTERM flushes pending
  stats and archive rows instead of dropping them with the runtime.
- CI: `.github/workflows/edge-rust.yml` runs `cargo fmt --check`,
  `clippy --all-targets -- -D warnings`, `cargo test`, and `cargo audit`.
  Dependabot tracks Cargo for `apps/edge-rust`.

## Not fixed / partial

| Item | Status |
|---|---|
| DoT 853 (SNI/authority TLV) | **Not ported** — Apple/Android private DNS still breaks |
| SafeSearch | **Not ported** |
| Blocked-services catalog | **Not ported** |
| DNS-presence probe | **Not ported** |
| Edge read APIs (`/logs`, `/stats`, cache purge, admin, whoami) | **Not ported** — console Logs/purge still call the Node edge |
| Blocklist `last_status` / `entry_count` write-back | **Not ported** — Blocklists page shows stale status |
| Per-device write-behind (`profile_devices`) | **Not ported** |
| Single-flight for identical misses | **Not implemented** |
| Per-source TCP caps | **Not implemented** (global cap only) |
| DoH metrics/readyz authentication | **Not added** (Fly keeps `/metrics` private; `/readyz` stays public) |
| Non-root container / capability-only bind | **Not changed** — root then checked drop |
| S3 PUT retry | **Not implemented** — failed log uploads are logged/dropped |
| PROXY header trust | **Unchanged** — safe only if port 53 is reachable exclusively through Fly's `proxy_proto`; UDP now binds `fly-global-services` |
| Query-log timestamps | Second precision (Node uses ms) |

## Verification

- `cargo test`: **36 passed**.
- `cargo clippy --all-targets -- -D warnings`: clean.
- Local release boot with the published artifacts: 4/4 lists from artifacts,
  **0 raw**, 435,691 rules, ~20 MB RSS.
- DoH smoke after hardening: `doubleclick.net` → `0.0.0.0`; `example.com` →
  forwarded answer.
- The temporary Fly canary used for the earlier comparison was destroyed; this
  security pass was verified locally only. A fresh canary is required before
  any cutover.

## Recommended next steps

1. Port the edge read APIs + DoT + SafeSearch/blocked services (feature parity).
2. Add single-flight and per-source TCP caps.
3. Deploy a fresh canary with its own IP; replay stored query logs against Node
   and diff answers.
4. Only then consider a regional cutover, with Node still as rollback.
