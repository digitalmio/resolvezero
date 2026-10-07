# ResolveZero

**Your NextDNS replacement, in the cloud — API-first from ground up.** Open source, self-hostable, with a hosted option.

## 1. Product Overview

ResolveZero is a personal DNS & DoH (DNS-over-HTTPS) resolver you fully control. Think NextDNS or Pi-hole, but running in the cloud (no DHCP, no local box to babysit) and **programmatic at its core**: every config knob, rule, and log is an API, not a web form.

* **Profiles** instead of enterprise tenants: small, isolated configs (`home`, `laptop`, `phone`), each with its own rules, blocklists, and DoH URL — the NextDNS model.
* **Open source first**: the edge is a single Bun binary you can run anywhere with Postgres. The hosted option runs the same code on Fly.io.
* **Privacy-respecting logs**: all queries are logged for the dashboard unless a profile opts out.
* **Encrypted upstream**: edge → resolver traffic goes over DoH (Quad9 by default), not plain UDP.

## 2. Core Tech Stack

* **Edge Runtime:** Bun (v1.4+, Rust-backed). Extreme low latency, low RAM footprint, and native `Bun.udpSocket()` for legacy device support.
* **Infrastructure (hosted option):** Fly.io. Edge compute + BGP Anycast + one shared dedicated IPv4 (UDP requires it; all profiles share it).
* **Database:** PlanetScale Postgres (Metal) — profiles, rules, query logs, and the central source of truth.
    * ⚠️ Managed PgBouncer runs in transaction-pooling mode, which does NOT support `LISTEN`/`NOTIFY`. Runtime queries use the pool; the edge's `pg-listen` socket uses a **direct connection**.
* **ORM / Migrations:** Drizzle (package `packages/db`).
* **Pub/Sub (Invalidation):** Native PostgreSQL `LISTEN`/`NOTIFY` via `pg-listen`.
* **Policy Cache:** A plain in-memory `Map` of ALL profiles' policies. Bounded set — NEVER evict (LRU is reserved for the resolver cache only).
* **DNS Response Cache:** `lru-cache`, the only unbounded-by-nature data — safe to evict.
* **DNS Parsing:** `dns2` or `dns-packet` (npm).
* **Upstream Resolver:** DoH to Quad9 (`https://dns.quad9.net/dns-query`) for MVP; self-hosters can point it anywhere (e.g. local `Unbound` via plain DNS `127.0.0.1:5353`) with a 1-line config change.

## 3. System Architecture

Strictly decoupled: **Control Plane** (slow, persistent, Postgres) and **Data Plane** (fast, in-memory, edge).

### A. The Control Plane (Postgres)

Stores profiles, rules, blocklist picks, source-IP whitelists, log opt-outs, and the query log.
When a rule changes, a Postgres trigger fires a `NOTIFY profile_updates` event with an `op` field (`INSERT`/`UPDATE`/`DELETE`) and the affected row's JSON (see trigger SQL — `TG_OP` selects `NEW`/`OLD`, so DELETEs propagate correctly).

### B. The Edge Data Plane (Bun on Fly.io)

1. **Boot Phase (race-free sync):** subscribe (`LISTEN profile_updates`) → buffer events → `SELECT` snapshot into the policy `Map` → replay the buffer (reconcile). Re-snapshot on `pg-listen` reconnect.
2. **Resolution Phase:** authenticate (`profile id` from DoH path, or `senderAddress`→profile for UDP), then check the domain (`O(1)` exact + longest-suffix wildcard, `O(domain depth)`) against the profile's rules.
    * **Blocked** → sinkhole (`0.0.0.0`) — answerable locally, log, return.
    * **Allowed** → DNS response LRU cache; on miss, forward upstream **over DoH**, log, cache per upstream TTL (including negative/NXDOMAIN answers).
3. **Geo behavior:** upstream is Anycast DoH, so requests from the Tokyo node resolve via Quad9's Tokyo PoP — end-device geo stays natural.

### C. Query Logging & Analytics (the differentiator)

Every decidable query (domain, profile, action, client IP, timestamp, response RTT) is logged to Postgres — **unless the profile opts out**. The edge batches writes asynchronously (non-blocking on the hot path). `query_log` rows carry a `log_until` retention timestamp; a periodic job prunes expired data.

## 4. Authentication (Profiles)

Every query must be authenticated before processing. Without DoH TLS, packets are cheap to spoof — **unauthenticated/unknown UDP packets are dropped silently** (`return;`, no response).

1. **DoH Token Auth (primary):**
    * *Path:* `https://dns.resolvezero.com/v1/{profile_id}/{optional_profile_token}`
    * For self-hosted single-user the profile id is enough; hosted profiles can require a token. Never log the raw token/path (hash comparison).
2. **Source IP Whitelisting (UDP ingress, for routers/legacy devices):**
    * Optional per profile; checked against `senderAddress` (Fly preserves the real client IP). Since UDP source IPs are spoofable, apply a per-source rate limit / penalty box in front of policy checks.
3. **What's deliberately NOT here:** per-tenant dedicated Anycast IPs. (Fly rewrites all of an app's UDP destinations to `fly-global-services`, so destination-based identity is impossible; per-tenant infra would mean one app per profile — pointless for a personal product.)

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

-- Full query log (NextDNS-style analytics). Retention per profile.
CREATE TABLE query_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id),
    domain VARCHAR(255) NOT NULL,
    action VARCHAR(20) NOT NULL,         -- 'block' | 'forward'
    client_ip INET,
    rtt_ms INT,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX query_log_logged_at_idx ON query_log (logged_at);

-- Trigger function for pub/sub (renamed for profiles)
CREATE OR REPLACE FUNCTION notify_rule_change()
RETURNS TRIGGER AS $$
DECLARE payload JSONB;
BEGIN
    payload := JSONB_BUILD_OBJECT(
        'op', TG_OP,
        'profile_id', COALESCE(NEW.profile_id, OLD.profile_id),
        'domain',     COALESCE(NEW.domain,     OLD.domain),
        'action',     NEW.action               -- NULL on DELETE
    );
    PERFORM pg_notify('profile_updates', payload::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rule_update_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_rules
FOR EACH ROW EXECUTE FUNCTION notify_rule_change();
```

## 6. Phase 1 Build Order

1. **Database layer** (`packages/db`) ✅ — drizzle schema + migrations + `ensureRuleNotifyTrigger()` at edge boot.
2. **Policy sync** ✅ — race-free boot (subscribe → buffer → snapshot → reconcile) into the policy `Map`; unit-tested.
3. **DoH endpoint + DoH upstream:**
    * Bun HTTP server: `POST/GET /v1/{profile_id}[/{token}]` (RFC 8484 style), auth profile, parse wire format, resolve, answer.
    * Allowed/uncached queries → **DoH upstream** (Quad9); LRU-cache by upstream TTL incl. NXDOMAIN.
4. **UDP ingress (legacy devices):**
    * Single `Bun.udpSocket()` bound to `fly-global-services:53` (mandatory on Fly; same port in/out).
    * Silent-drop unauthenticated; rate-limit permitted sources; TC flag fallback for oversized responses.
5. **Query log batcher:** async buffered inserts (`INSERT ... ON CONFLICT DO NOTHING`-safe), respects `log_queries = false`; prune job for `log_retention_days`.
6. **Profile config API + dashboard data endpoints** (CRUD rules, fetch stats) — the "API-based from ground up" surface.

## 7. Deployment Notes (hosted)

* One Fly app = one edge binary; deploy per region (anycast handles routing).
* `fly.toml`: dedicated IPv4 allocated (`fly ips allocate-v4`), HTTP/TLS handled by Fly for DoH.
* Postgres keeps the app-shaped `DATABASE_URL`; edge holds two configs: pooled (queries) + direct (LISTEN).
