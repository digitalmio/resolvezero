# Code Review — Edge & Console (2026-10-28)

## Remediation status (updated 2026-10-28)

- **E1 (P0):** Done. The exposed `home` DoH token was rotated and the old token no longer authenticates. The credential was removed from current source on both `design/logo-refine` and `main`; probe credentials now come from `PROBE_PROFILE_ID` / `PROBE_DOH_TOKEN`. The old token remains in git history but is revoked; history was not rewritten.
- **Item 4 (console body limit/auth order):** Done. Added a 64 KiB global request-body cap in `apps/console/src/start.ts`. Local DNS validators now do structural length checks only; full normalization runs after `requireSessionUser`.
- **Item 5 (ingress/aggregate budgets):** Done. Added per-PoP rate limits and in-flight semaphores for DoH/UDP/TCP, TCP per-source connection caps and absolute lifetime, a global force-sync budget, blocklist list/entry/deadline budgets, S3 staging/pending byte budgets with async gzip, and log-export aggregate caps with backpressure/abort handling.
- **Item 6 (token at rest):** Decision documented in `docs/token-at-rest.md`: HMAC-hashed DoH tokens plus short-lived edge-admin JWTs. **Not implemented yet**; it needs a schema migration and edge/console coordination.
- **Item 7 (DNS correctness):** Done. ECS is now part of cache and single-flight keys; local zones return CNAMEs for A/AAAA/TXT misses and NODATA for existing names with no matching type; short-window stats totals now come from minute rows.
- **M3 (docs drift):** Fixed for the root token claim and `apps/console/README.md`.
- **Item 8 (profile targeting):** Done. Profile fallback now breaks equal-hour ties by profile id, the selected fallback is persisted in `rz_profile_id` from the console shell, and Local DNS save/delete plus cache purge pass the currently viewed `profileId` through to an owner-checked `findProfile`. Verified a Test-profile record does not appear under Home and is deleted from Test.
- **Item 9 (auth-layer registration gate):** Not started.
- **M1/M2:** Not started (edge module splits; console regression tests).

## Scope and method

- **Reviewed:** current working tree of `apps/edge` and `apps/console`, including authored source, scripts, and package/build configuration. Shared DB code and deployment files were consulted only where needed to verify a finding.
- **Excluded:** `node_modules`, `dist`, `.tanstack`, and generated route code, except where necessary to understand wiring.
- **Threat model:** internet-facing, multi-tenant services; untrusted clients and tenant-controlled input; strict tenant isolation required.
- **Usability meaning:** code maintainability, readability, and ease of safe modification—not UI/UX.
- **Method:** static manual review. No credentials were tested, no services were probed, no dependency audit was run, and no tests/builds were executed.
- Existing review reports and `progress.md` were used as historical context only. Findings below were checked against current source; intentionally deferred risks are identified as such.

Severity reflects the stated public multi-tenant threat model. Conditions that could materially change severity are called out explicitly.

## Executive summary

The console’s core tenant-authorization pattern is generally sound: private handlers re-check the session, profile selection is owner-scoped, Drizzle parameterizes database input, and no direct IDOR, SQL injection, dangerous-HTML XSS, or user-controlled SSRF sink was confirmed.

The highest residual risk is **availability and credential management**, rather than a straightforward tenant-data authorization bypass:

1. A plaintext DoH credential is committed in an edge probe script; its current validity was not tested.
2. Several endpoints permit unauthenticated or tenant-initiated work without an aggregate memory, time, or concurrency budget.
3. Raw-log staging/export and blocklist synchronization can affect the entire edge process or every PoP.
4. The global DNS cache has cross-tenant availability effects and omits response-varying EDNS Client Subnet from its keys.
5. Sensitive URL/token handling remains weaker than the rest of the security architecture.

## Priority findings

| ID | Severity | Area | Finding |
|---|---|---|---|
| E1 | **High if valid** | Edge / credentials | Plaintext profile ID and DoH token committed in a production-targeting probe |
| E2 | **High** | Edge / availability | Global blocklist loading has no aggregate time, rule, or memory budget |
| E3 | **High** | Edge / availability | Raw-log staging and export permit shared-process memory/CPU exhaustion |
| E4 | **High** | Edge / availability | TCP clients can starve global slots and create unbounded in-flight DNS work |
| C1 | **High** | Console / availability | Large server-function input is parsed and normalized before authentication |
| E5 | Medium | Edge / cross-tenant | Any profile token can trigger synchronization of every tenant’s blocklists |
| E6 | Medium | Edge / DNS correctness | Cache and single-flight keys omit EDNS Client Subnet |
| E7 | Medium | Edge + Console / isolation | Tenant cache purges evict other tenants’ entries on every PoP |
| E8 | Medium | Edge / confidentiality | Secret-bearing blocklist URLs are logged verbatim |
| E9 | Medium | Edge / credentials | DoH tokens remain plaintext at rest |
| E10 | Medium | Edge / privacy/correctness | Exact-type zone lookup can leak local names upstream and misses CNAME semantics |
| E11 | Medium | Edge / availability | UDP source-IP authorization remains spoofable and can enable reflection |
| C2 | Medium | Console + Edge / availability | Unquota’d Local DNS writes can repeatedly trigger global edge snapshots |
| C3 | Medium | Console / correctness | Implicit profile selection is nondeterministic across calls |
| E12 | Low | Edge / resource lifecycle | Device caps reset across restarts/PoPs and deleted-profile state is retained |
| E13 | Low | Edge / resource lifecycle | SSRF DNS-cache entries are never removed |
| C4 | Low | Console / access policy | “Closed registration” is not enforced by OAuth configuration |
| C5 | Low | Console / session | Failed sign-out is presented as successful |
| E14 | Medium | Edge / correctness | Short-range stats can use totals/top lists from the wrong interval |
| E15 | Low | Edge / reliability | Raw logging and shutdown drain have data-loss paths |

---

## Edge findings

### E1 — High if the credential is still valid: plaintext DoH credential in a probe script

**Evidence:** `apps/edge/scripts/probe-blocks.ts:2-7` contains a profile ID and plaintext token and sends them to the public edge hostname. The token is intentionally not reproduced in this report.

Anyone who obtains the repository and a still-valid credential can act as that profile on token-gated DNS, log, statistics, and management endpoints. This can expose query history and permit destructive log operations, depending on the routes enabled for that profile.

**Verification limit:** validity was not tested. If revoked, this remains a credential-handling and repository-hygiene issue rather than an active account compromise.

**Direction:** rotate the credential, remove it from source and history, and inject future probe credentials through a secret environment variable. The current `.dockerignore:13-14` does exclude `apps/edge/scripts` from the image; the earlier concern that these scripts are shipped in the production image was **not** confirmed.

### E2 — High: blocklist synchronization lacks an aggregate resource budget

**Evidence:**

- `apps/edge/src/blocklists.ts:75-109` selects every enabled subscription globally, fetches each unique URL sequentially, and materializes response text, string sets, and fingerprint tables.
- `apps/edge/src/blocklists.ts:225-236` applies per-fetch timeout/byte limits, but there is no cycle-wide time, rule-count, or memory limit.
- `apps/edge/src/index.ts:183-188,255-269` awaits initial synchronization before DNS listeners bind.
- Parsed tables are retained in the shared catalog (`apps/edge/src/ruleStore.ts:91-104`).

Sequential parsing reduces simultaneous transient allocations, but does not bound total work or retained memory. Slow lists can delay startup by approximately `N × per-fetch timeout`; enough large lists can still exhaust a PoP. One tenant’s subscriptions therefore contribute to startup latency and memory pressure for all tenants.

**Direction:** enforce global and per-tenant list/rule/byte quotas and a cycle deadline; make startup behavior explicit when the budget is exceeded.

### E3 — High: raw-log staging and export have independent exhaustion paths

**Evidence:**

- `apps/edge/src/sinks/s3.ts:198-232` appends log lines to staging arrays without a line or byte budget. The batcher’s queue cap does not bound sustained throughput into this separate map.
- `apps/edge/src/sinks/s3.ts:290-293,355-356` joins and compresses completed windows synchronously, creating large contiguous buffers and blocking the event loop. The pending-object cap counts objects, not bytes.
- `apps/edge/src/logs.ts:122-138` reads each complete compressed S3 object before checking its size.
- `apps/edge/src/logs.ts:112-170` performs export work in `ReadableStream.start()` and repeatedly calls `enqueue()` without honoring backpressure or explicitly stopping on client disconnect.

A token holder can generate blocked queries cheaply, retain large staged windows, and then request exports or consume them slowly. Per-object inflate limits and request rate limits do not bound aggregate compressed input, retained output, or synchronous compression work.

**Direction:** budget staged bytes and export work, stream with backpressure/cancellation, and avoid whole-object reads before enforcing limits.

### E4 — High: TCP connection starvation and unbounded asynchronous DNS work

**Evidence:**

- `apps/edge/src/dns53.ts:25-27,147-156` provides a global connection cap and idle timeout, but no unauthenticated/per-source connection quota or absolute connection deadline.
- `apps/edge/src/dns53.ts:237-267` launches `handlePacket()` for complete frames without an in-flight work limit.

Unauthorized clients can occupy global TCP slots before source authorization and keep them alive with occasional traffic. Authorized clients can also pipeline unique queries and create large numbers of concurrent upstream operations. Receive-buffer and write-backpressure limits do not bound these promises.

**Direction:** add per-source and pre-auth connection controls, absolute deadlines, and a bounded in-flight query budget.

### E5 — Medium: profile force-sync initiates global blocklist work

**Evidence:** `apps/edge/src/admin.ts:174-183` permits a profile-token caller to request synchronization, while `apps/edge/src/blocklists.ts:75-100` refreshes all enabled subscriptions globally. The debounce at `blocklists.ts:173-184` coalesces overlapping calls but does not impose a global rate or cost budget.

A single tenant can repeatedly cause downloads, parsing, CPU use, and status writes for unrelated tenants; multiple profiles multiply the effective allowance.

**Direction:** separate tenant configuration refresh from global catalog refresh and apply a global work budget/rate limit.

### E6 — Medium: EDNS Client Subnet is absent from cache and single-flight keys

**Evidence:**

- `apps/edge/src/dnsCache.ts:161-175` keys entries by question, class, DO/CD, and upstream, but not ECS.
- `apps/edge/src/upstream.ts:139-153` uses the same incomplete dimensions for request coalescing.

ECS options can be forwarded upstream while answers for different client subnets share a cache entry or in-flight request. For ECS-aware domains, one network’s answer can be returned to another network for the cache lifetime. Transaction-ID/question validation does not detect this because the visible question still matches.

**Impact:** cross-request answer contamination, incorrect geo-specific answers, and avoidable privacy/availability surprises. This is not a demonstrated arbitrary DNS-poisoning primitive.

**Direction:** either strip/normalize ECS deliberately or include every response-varying EDNS dimension in cache and coalescing keys.

### E7 — Medium: tenant cache purge has cross-tenant availability effects

**Evidence:**

- The console authorizes a purge for an owned profile at `apps/console/src/server/dashboard/settings.server.ts:52-74`.
- The purge poller discards `profileId` and invokes a global purge at `apps/edge/src/index.ts:90-107`.
- `apps/edge/src/dnsCache.ts:133-150` scans and deletes matching keys regardless of tenant.

No policy or answer-data crossover was found because zones/rules run before cache lookup. However, a tenant can repeatedly purge a popular name, keep shared entries cold, increase upstream traffic, and cause an `O(cache-size)` scan on every PoP.

**Direction:** make purge scope and pricing consistent with the global cache design; add fleet-wide work controls or partition cache entries appropriately.

### E8 — Medium: blocklist URLs are written verbatim to logs

**Evidence:** `apps/edge/src/blocklists.ts:111-130` includes the full URL in success, failure, and status-write log events. `apps/edge/src/logger.ts:9-14` configures no corresponding redaction.

Private blocklist URLs commonly contain path or query credentials. Syncing therefore copies those credentials into stdout/platform log retention, expanding access beyond the original secret store.

**Direction:** log subscription IDs or a deliberately sanitized origin, never URL paths/queries.

### E9 — Medium: DoH tokens remain plaintext at rest

**Evidence:** `apps/edge/src/ruleStore.ts:221-232` loads and compares raw profile tokens; `packages/db/src/schema.ts:91-95` stores the raw token column.

A database, replica, or backup disclosure immediately yields credentials for DNS resolution, logs, and token-gated management. Timing-safe online comparison does not protect stored credentials.

**Direction:** store only keyed/cryptographic hashes and migrate existing tokens through a rotation plan.

### E10 — Medium: exact-type zone lookup leaks some local queries and breaks CNAME behavior

**Evidence:** `apps/edge/src/ruleStore.ts:384-399` looks up a zone only for the requested record type. A miss continues through normal resolution in `apps/edge/src/doh.ts:259-289` and `apps/edge/src/dns53.ts:384-410`.

If `nas.lan A` exists, an `AAAA` query does not match the local name and may be sent upstream instead of receiving local NODATA. An ordinary `A`/`AAAA` query also misses a configured CNAME, contrary to normal resolver behavior. This can disclose private names and produce inconsistent answers.

**Direction:** distinguish “name exists locally” from “this exact type exists” and implement explicit local negative/CNAME handling.

### E11 — Medium, documented residual risk: UDP source spoofing and reflection

**Evidence:** `apps/edge/src/dns53.ts:276-289` authorizes UDP solely by packet source IP, and `dns53.ts:122-132` sends the answer to that source.

An attacker capable of spoofing a linked victim IP can make the edge send responses to the victim. Unknown-source REFUSED handling does not mitigate spoofed packets that name an *authorized* source. This is partly inherent to UDP and is already acknowledged in project documentation, but remains relevant to the public-service threat model.

**Direction:** retain the documented warning; use ingress anti-spoofing/DDoS controls and response-size/rate policies rather than treating the allowlist as proof of packet origin.

### E12 — Low: device quotas are process-local and stale profile state survives

**Evidence:** `apps/edge/src/ruleStore.ts:428-440` caps only the in-memory `seenDevices` set. The registry is neither restored from nor enforced against persistent device counts, and `replaceAll()` does not prune this map (`ruleStore.ts:172-218`).

Restarts and additional PoPs each permit another set of new device slugs. Deleted profiles can also leave their sets resident. The cap stops one simple loop but is not a durable tenant quota.

### E13 — Low: SSRF DNS-cache entries grow by unique hostname

**Evidence:** `apps/edge/src/netGuard.ts:48,263-279` stores successful hostname resolutions in a map. Expiry prevents reuse after 60 seconds but expired entries are not deleted.

Tenant-controlled URLs with many unique resolvable hostnames can cause permanent process-lifetime growth.

### E14 — Medium correctness: short-window stats mix minute and hourly intervals

**Evidence:** `apps/edge/src/stats.ts:133-147` builds short-range series from minute rows but obtains totals/top lists from hourly rows filtered by hour-start time.

At some offsets the current hourly row is excluded and totals become zero despite minute data; at others a partial hour is overcounted. The requested interval and displayed totals therefore disagree.

### E15 — Low reliability: raw-log output and shutdown can lose data

- DoH uses the stdout-aware wrapper at `apps/edge/src/index.ts:127-143`, while UDP/TCP call only the batcher at `index.ts:256-262`. With stdout logging enabled and no S3 sink, port-53 raw logs can disappear.
- `apps/edge/src/batcher.ts:82-99` does not clearly await an already-running flush during `stop()`, leaving a shutdown race with rollup persistence.

---

## Console findings

### C1 — High: unbounded input work occurs before session authentication

**Evidence:**

- `apps/console/src/server/dashboard.ts:34-42` runs `normalizeZoneInput` in the server-function validator before `requireSessionUser` in the handler.
- `apps/console/src/lib/zone.ts:78-82` maps, trims, filters, and deduplicates the complete supplied values collection before checking the eight-value limit.
- No application-level request-body limit was found in `apps/console/vite.config.ts` or the surrounding console configuration.

A direct RPC caller does not need a valid browser session to submit a large JSON body or values array. Parsing and normalization consume memory/CPU before the handler rejects the request as unauthorized. Concurrent requests can amplify this into process exhaustion.

**Qualification:** an external reverse proxy/WAF body limit may reduce exposure, but none is established by the reviewed application. This was not load-tested.

**Direction:** enforce small transport-level body limits and structural input limits before expensive normalization; authenticate as early as the server-function model safely permits.

### C2 — Medium: Local DNS writes can create repeated fleet-wide work

**Evidence:**

- `apps/console/src/server/dashboard/rules.server.ts:99-123` performs owner-scoped inserts/deletes but has no per-profile zone quota or mutation throttle.
- `apps/console/src/server/dashboard.ts:34-57` exposes the mutations to every authenticated account.
- Configuration triggers and polling cause every edge to rebuild profile/rule/source-IP/zone state (`apps/edge/src/ruleSync.ts:85-135`).

Ownership checks prevent cross-tenant writes but do not contain the resulting global load. Repeated updates can keep every PoP taking full snapshots; unlimited distinct records can grow DB and edge memory.

**Direction:** add tenant quotas, mutation rate controls, and coalescing/cost limits for global configuration propagation.

### C3 — Medium correctness: implicit profile selection is nondeterministic

**Evidence:** `apps/console/src/server/dashboard/profile.server.ts:21-47` selects the latest owned rollup using only `ORDER BY hour DESC LIMIT 1`, without a secondary profile ordering. `findProfile` is called independently by reads and mutations, including `rules.server.ts:99-123`.

Profiles commonly share the same latest hour. Without an explicit preference cookie, different calls can select different owned profiles, causing a mutation to target a profile other than the one the user just viewed. The owner predicate prevents cross-tenant access; the issue is stable operation targeting within one account.

**Direction:** use deterministic fallback selection and pass an explicitly authorized profile ID through each operation.

### C4 — Low: closed registration is only represented in the UI

**Evidence:** `apps/console/src/server/auth.server.ts:34-39` configures GitHub OAuth without an implicit-signup disable/allowlist hook, while `apps/console/src/routes/login.tsx:52-55` and `routes/waitlist.tsx:27-30` describe registration as closed.

Previously unseen GitHub accounts can therefore follow the normal OAuth account-creation path unless an external control prevents it. New accounts currently receive no profile automatically, which limits immediate tenant-data impact.

**Direction:** enforce hosted-access policy in the auth layer rather than relying on UI copy.

### C5 — Low: sign-out navigation hides failure

**Evidence:** `apps/console/src/components/shell/user-menu.tsx:21-27` ignores the sign-out result and navigates in `finally` for both success and failure.

If revocation or cookie clearing fails, the user sees the login page while a valid session may remain. This is most relevant on shared browsers.

**Direction:** surface failures and verify that the session is actually cleared before presenting sign-out as complete.

### C6 — Conditional low: raw server-function errors may disclose internals

**Evidence:** `apps/console/src/server/auth.server.ts:62-65`, `dashboard/rules.server.ts:101-113`, and `dashboard/settings.server.ts:58-76` do not map unexpected failures to stable public errors.

Database/driver/fetch errors can contain implementation and infrastructure details. Actual production serialization depends on the installed TanStack deployment path; no live error responses were captured, so stack/path disclosure is treated as a risk rather than a confirmed leak.

### C7 — Conditional low: sensitive GET RPC responses lack explicit shared-cache protection

**Evidence:** private read functions use GET in `apps/console/src/server/dashboard.ts:7-31,59-93`, including query-log loading at `dashboard.ts:86-93`. No application-level `Cache-Control: private/no-store` or `Vary: Cookie` policy was found for these responses.

No shared/CDN cache is configured in the reviewed repository, so no current cross-tenant cache leak is asserted. If such a cache is introduced and caches dynamic GETs, responses could cross sessions.

---

## Maintainability and safe-change findings

### M1 — Security-critical edge modules exceed the repository’s file-size guardrail

Current authored source sizes include:

- `apps/edge/src/ruleStore.ts` — **456 lines**
- `apps/edge/src/dns53.ts` — **442 lines**
- `apps/edge/src/sinks/s3.ts` — **374 lines**
- `apps/edge/src/index.ts` — **352 lines**
- `apps/edge/src/doh.ts` — **346 lines**

These exceed the root `AGENTS.md` 300-line ceiling. More importantly, each combines multiple security-sensitive responsibilities: transport/framing/auth, profile/rule/zone state, archive staging/upload/export support, or startup/lifecycle wiring. The duplication between DoH and port-53 resolution paths makes parity bugs—such as zone and logging differences—more likely.

**Direction:** split along existing responsibilities and share resolver-policy/logging paths rather than adding further conditional behavior to these files.

### M2 — Console tenant-safety behavior lacks local regression tests

`apps/console/package.json:8-13` has no test script, and no authored console `*.test.*`/`*.spec.*` files were found. Session guards, owner scoping, probe isolation, validators, and profile selection therefore depend heavily on manual verification.

The edge has substantial tests, but the highest-risk console invariants need executable regression coverage as the code evolves.

### M3 — Security/setup documentation has drifted from implementation

- `apps/console/README.md:39-44,77-83` still says Better Auth/login is not implemented and instructs developers to add authentication, despite the current auth route and guarded handlers.
- The root `readme.md:177` says DoH tokens are compared as hashes, while the current DB/rule-store path retains raw tokens.

Stale security documentation can lead to unsafe deployment assumptions and makes future reviews less reliable.

---

## Additional conditional risk

### Runtime tokenless-profile transition bypasses the boot-only hosted guard

**Evidence:** the hosted tokenless-profile check runs at startup (`apps/edge/src/index.ts:168-180`), while later snapshots can replace tokens from the nullable DB column (`apps/edge/src/ruleSync.ts:85-145`). `apps/edge/src/ruleStore.ts:226-232` treats a null token as ID-only authentication.

If a profile becomes tokenless after startup, the boot guard is not rerun and token-gated routes can become ID-only until restart. Normal current profile creation supplies a token, so a direct tenant-reachable transition was not established. **Severity is high if such a transition is possible through any administrative/import path; otherwise this is defense-in-depth.**

## Positive controls verified

- Every reviewed private console data handler re-checks the session; profile IDs are resolved through `owner_user_id`, including cookie-selected profiles.
- DoH tokens are kept server-side by the console and sent to the edge in authorization headers rather than browser URLs; settings exposes only token presence.
- Drizzle parameterization and React escaping are used consistently in reviewed paths; no confirmed SQL injection or dangerous-HTML XSS was found.
- Edge profile IDs are constrained before S3 prefix construction; no cross-profile S3-key traversal was found.
- The SSRF guard validates redirects and pins validated connection addresses; request-body and inflate helpers provide important per-operation limits.
- Upstream DNS responses receive QR/ID/question validation; cache entries strip OPT records and partition by upstream/class/DO/CD.
- TCP receive buffers, zero-length-frame handling, idle timeouts, global connection caps, and write-backpressure controls are present, despite the remaining starvation/work-budget gaps.
- Metrics are privately bound, runtime privileges are dropped after binding, and `.dockerignore` excludes edge development scripts.
- CSV formula-injection defenses and bounded gzip inflation are present.

## Suggested review/remediation order

1. **Rotate and remove the committed DoH credential**, then assess any use of the exposed profile token.
2. **Put strict ingress/body/connection limits in front of public services** and add application-level aggregate work budgets.
3. **Bound raw-log staging/export and blocklist synchronization** by bytes, time, concurrency, and tenant/global quota.
4. **Remove cross-tenant availability levers** from force-sync/cache-purge/config-refresh paths.
5. **Correct DNS cache/zone semantics**, especially ECS keying and local-name negative/CNAME behavior.
6. **Reduce credential exposure** through URL log redaction and hashed token storage.
7. **Add console security regression tests**, deterministic profile targeting, and maintainability splits before further feature growth.

## Review limitations

This was a static review, not a penetration test or load test. No claim is made that the listed denial-of-service paths were exercised, that the committed credential remains valid, that production infrastructure lacks external limits, or that the dependency tree is vulnerability-free. Conversely, absence of a finding does not prove absence of a vulnerability in excluded generated/vendor code or unreviewed deployment infrastructure.
