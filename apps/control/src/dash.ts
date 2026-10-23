/**
 * Server-rendered dashboard (readme §4a, "dashboard MVP").
 * Session-gated HTML pages under / — login (better-auth), Setup, Rules,
 * Analytics, Logs, Settings. The Edge stays the data plane: /stats + /logs
 * are proxied read-only; rules/zones/lists are written through drizzle and
 * propagate to the edge via the existing NOTIFY triggers.
 */
import { Hono } from "hono";
import { isIP } from "node:net";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  profileBlocklists,
  profileDevices,
  profileRules,
  profileSourceIps,
  profileZones,
  profiles,
  type StatsTopEntry,
} from "@resolvezero/db/schema";
type SessionUser = { id: string; name: string; email: string; image?: string | null };
type SessionData = { user: SessionUser; session: unknown } | null;
type AuthLike = {
  api: { getSession(args: { headers: Headers }): Promise<SessionData> };
};

const EDGE_URL = process.env.EDGE_URL ?? "https://resolvezero-edge.fly.dev";
const APP_HOST = process.env.DASH_HOST ?? "https://resolvezero-control.fly.dev";

/** Control → edge call with Bearer auth (never put the token in a URL). */
function edgeFetch(path: string, token: string | null | undefined, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${EDGE_URL}${path}`, { ...init, headers });
}

type SessionView = { user: SessionUser; session: unknown } | null;

type AppEnv = {
  Variables: { session: SessionView };
};

type Profile = {
  id: string;
  name: string;
  dohToken: string | null;
  logQueries: boolean;
  logRetentionDays: number;
  upstream: string | null;
  upstreamUrl?: string | null;
  ownerUserId: string | null;
};

// ---- utilities ----

/** Mirror of the edge SSRF guard (https-only, no private/metadata hosts). */
function isSafeListUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  return !(
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^\[?(fc|fd|fe[89ab])[0-9a-f]{2}:/i.test(host)
  );
}

/** Custom upstream: syntax only — the edge performs the authoritative
 *  redirect-aware SSRF check (and allows private targets for self-hosters). */
function isValidUpstreamUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !!u.hostname;
}

function isValidZoneValue(recordType: string, value: string): boolean {
  if (recordType === "A") return isIP(value) === 4;
  if (recordType === "AAAA") return isIP(value) === 6;
  if (recordType === "CNAME") return value.length <= 253 && /^[a-z0-9._-]+$/i.test(value);
  return true; // TXT
}

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const DAY = 24 * 3600_000;

function fmt(n: number | undefined | null): string {
  if (n == null) return "-";
  return n.toLocaleString("en-US");
}

function layout(
  opts: { session: SessionView; title: string; profiles: Profile[]; current?: Profile; active?: string },
  body: string,
): string {
  const tabs = ["setup", "rules", "analytics", "logs", "settings"];
  const me = opts.session?.user ? opts.session.user : null;
  const profileChips = opts.profiles.length
    ? opts.profiles
    : (opts.current ? [opts.current] : []);
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · ResolveZero</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><span class="shield">0</span> ResolveZero</a>
  ${profileChips.length > 1 ? `<span class="switcher">${profileChips.map((p) => `<a href="/?p=${esc(p.id)}" class="${opts.current?.id === p.id ? "chip active" : "chip"}">${esc(p.name)}</a>`).join("")}</span>` : profileChips.length === 1 ? `<span class="chip active">${esc(profileChips[0]!.name)}</span>` : ""}
  <span class="spacer"></span>
  ${me ? `<span class="me">${esc(me.email ?? me.name ?? "")}</span>
  <form method="post" action="/api/auth/sign-out" id="logout" class="inline"><input type="hidden" name="csrf"> <button class="btn ghost" form="logout" onclick="fetch('/api/auth/sign-out',{method:'POST'}).then(()=>location.reload())">Sign out</button></form>` : ""}
</header>
${opts.active
    ? `<nav class="tabs"><a class="${opts.active === "setup" ? "on" : ""}" href="/setup?p=${esc(opts.current?.id ?? "")}">Setup</a>
    <a class="${opts.active === "rules" ? "on" : ""}" href="/rules?p=${esc(opts.current?.id ?? "")}">Rules</a>
    <a class="${opts.active === "analytics" ? "on" : ""}" href="/analytics?p=${esc(opts.current?.id ?? "")}">Analytics</a>
    <a class="${opts.active === "logs" ? "on" : ""}" href="/logs?p=${esc(opts.current?.id ?? "")}">Logs</a>
    <a class="${opts.active === "settings" ? "on" : ""}" href="/settings?p=${esc(opts.current?.id ?? "")}">Settings</a></nav>`
    : ""}
<main class="wrap">
${body}
</main>
</body></html>`;
}

function loginPage(session: SessionView): string {
  if (session?.user) return "";
  return layout({ session: null, title: "Sign in", profiles: [] }, `
<div class="center">
  <div class="card login">
    <h1>ResolveZero</h1>
    <p class="muted">API-first DNS filtering, EU-resident. Sign in to your resolver fleet.</p>
    <button class="btn primary big" id="gh-signin" type="button">Sign in with GitHub</button>
    <p class="muted small" id="gh-err" hidden></p>
  </div>
</div>
${SOCIAL_SIGNIN_SCRIPT}`);
}

/** better-auth's social sign-in is POST + JSON; the button does the round-trip. */
const SOCIAL_SIGNIN_SCRIPT = `<script>
document.getElementById("gh-signin")?.addEventListener("click", async () => {
  const btn = document.getElementById("gh-signin");
  const err = document.getElementById("gh-err");
  try {
    btn.disabled = true;
    const res = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    });
    if (!res.ok) throw new Error("sign-in failed (" + res.status + ")");
    const data = await res.json();
    if (data?.url) {
      location.href = data.url;
      return;
    }
    location.href = "/";
  } catch (e) {
    if (err) { err.textContent = "GitHub sign-in unavailable: " + (e instanceof Error ? e.message : e); err.hidden = false; }
    btn.disabled = false;
  }
});
</script>`;

function kpiTiles(stats: StatsSummary): string {
  return `<div class="kpis">
  <div class="tile"><div class="big">${fmt(stats.totalQueries)}</div><div class="muted small">queries ${stats.range}</div></div>
  <div class="tile"><div class="big red">${fmt(stats.blocked)}</div><div class="muted small">blocked</div></div>
  <div class="tile"><div class="big">${stats.blockRatio != null ? (stats.blockRatio * 100).toFixed(2) : "-"}%</div><div class="muted small">block ratio</div></div>
  <div class="tile"><div class="big">${stats.avgRttMs ?? "-"}</div><div class="muted small">avg upstream RTT ms</div></div>
</div>`;
}

function topList(title: string, entries: StatsTopEntry[] | undefined, key: "domain" | "device" | "clientIp"): string {
  const rows = (entries ?? []).slice(0, 10).map((e) => {
    const label = key === "domain" ? e.domain : key === "device" ? e.device : e.clientIp;
    return `<li><span class="mono">${esc(label ?? "-")}</span><span class="count">${fmt(e.count)}</span></li>`;
  }).join("");
  return `<div class="card"><h3>${esc(title)}</h3><ul class="toplist">${rows || '<li class="muted">nothing yet</li>'}</ul></div>`;
}

function logUrl(profileId: string, format: string, date: string): string {
  const q = new URLSearchParams({ p: profileId, format, date });
  return `/dash/logs/download?${q}`;
}

interface StatsSummary {
  range: string;
  totalQueries: number;
  blocked: number;
  blockRatio: number;
  avgRttMs?: number;
  topDomains?: StatsTopEntry[];
  topBlocked?: StatsTopEntry[];
  queriesPerDevice?: StatsTopEntry[];
  queriesPerClient?: StatsTopEntry[];
  series?: { bucket: string; total: number; blocked: number }[];
}

/** Minimal inline SVG chart: total (blue) + blocked (red) polylines. */
function chart(series: { bucket: string; total: number; blocked: number }[]): string {
  if (!series?.length) return `<div class="card"><h3>Queries over time</h3><p class="muted">no data yet</p></div>`;
  const W = 900, H = 180, PAD = 8;
  const max = Math.max(...series.map((s) => s.total), 1);
  const px = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(series.length - 1, 1);
  const py = (v: number) => H - PAD - (v * (H - 2 * PAD)) / max;
  const line = (key: "total" | "blocked") =>
    series.map((s, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(s[key] ?? 0).toFixed(1)}`).join(" ");
  const area = `${line("total")} L${px(series.length - 1).toFixed(1)},${H - PAD} L${px(0).toFixed(1)},${H - PAD} Z`;
  const labels: string[] = series.map((s) => `t:${esc(s.bucket)}`);
  return `<div class="card"><h3>Queries over time</h3>
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="queries">
  <path d="${area}" fill="rgba(59,130,246,0.15)"/>
  <path d="${line("total")}" stroke="#3b82f6" fill="none" stroke-width="2"/>
  <path d="${line("blocked")}" stroke="#ef4444" fill="none" stroke-width="2"/>
</svg>
<div class="legend"><span class="dot blue"></span> total <span class="dot red"></span> blocked</div>
<span hidden>${labels.join(",")}</span></div>`;
}

// ---- data helpers ----

async function fetchStats(profileId: string, range: string, token: string | null): Promise<StatsSummary | null> {
  const q = encodeURIComponent(profileId);
  try {
    const res = await edgeFetch(
      `/v1/${q}/stats?range=${encodeURIComponent(range)}`,
      token,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    return (await res.json()) as StatsSummary;
  } catch {
    return null;
  }
}

async function listProfiles(ownerUserId: string): Promise<Profile[]> {
  return (await db
    .select({
      id: profiles.id,
      name: profiles.name,
      dohToken: profiles.dohToken,
      logQueries: profiles.logQueries,
      logRetentionDays: profiles.logRetentionDays,
      upstream: profiles.upstream,
      upstreamUrl: profiles.upstreamUrl,
      ownerUserId: profiles.ownerUserId,
    })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(asc(profiles.createdAt))) as Profile[];
}

function tokenOr(url: string, token?: string | null): string {
  return token ? url : url;
}

// ---- the app ----

export function createDashApp(auth: AuthLike): Hono<AppEnv> { const app = new Hono<AppEnv>();

  // session middleware (HTML side)
  app.use("*", async (c, next) => {
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("session", s);
    await next();
  });

  // CSRF guard for dashboard mutations: same-origin POSTs only.
  // Session cookies alone would allow cross-site POSTs; require Origin/Referer
  // matching the dashboard host (or TRUSTED_ORIGINS).
  app.use("/dash/*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin") ?? c.req.header("referer");
      if (origin) {
        let ok = false;
        try {
          const oHost = new URL(origin).host.toLowerCase();
          const reqHost = new URL(c.req.url).host.toLowerCase();
          const allowed = new Set(
            (process.env.TRUSTED_ORIGINS ?? "").split(",").map((s) => {
              try {
                return new URL(s.trim()).host.toLowerCase();
              } catch {
                return s.trim().toLowerCase();
              }
            }).filter(Boolean),
          );
          allowed.add(reqHost);
          ok = allowed.has(oHost);
        } catch {
          ok = false;
        }
        if (!ok) return c.body(null, 403);
      }
      // No Origin/Referer (curl, non-browser): allow — session auth still applies.
    }
    await next();
  });

  app.get("/style.css", (c) =>
    c.body(CSS, 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=3600",
    }),
  );

  app.get("/", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    const stats = current ? await fetchStats(current.id, "24h", current.dohToken) : null;
    const body = current && stats
      ? `
<div class="headbox"><h1>${esc(current.name)}</h1><span class="muted">last 24h · <a class="muted" href="/analytics?p=${esc(current.id)}">all ranges →</a></span></div>
${kpiTiles(stats)}
${chart(stats.series ?? [])}
<div class="grid2">
  ${topList("Top domains", stats.topDomains, "domain")}
  ${topList("Blocked", stats.topBlocked, "domain")}
  ${topList("Devices", stats.queriesPerDevice, "device")}
  ${topList("Clients", stats.queriesPerClient, "clientIp")}
</div>`
      : onboarding();
    return c.html(layout({ session, title: "Home", profiles: owned, current, active: "home" }, body));
  });

  app.get("/setup", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.html(layout({ session, title: "Setup", profiles: [] }, onboarding()));
    const dohBase = `${APP_HOST.replace("resolvezero-control", "dns")}/v1`;
    const base = new URL(dohBase).host ? `${dohBase.replace("/v1", "")}/v1` : dohBase;
    const dohUrl = `${process.env.DOH_HOST ?? "https://dns.resolvezero.com"}/v1/${current.id}`;
    const dohDeviceUrl = `${dohUrl}/<device>`;
    const deviceRows = (await db
      .select({ slug: profileDevices.slug, firstSeenAt: profileDevices.firstSeenAt, lastSeenAt: profileDevices.lastSeenAt })
      .from(profileDevices)
      .where(eq(profileDevices.profileId, current.id))
      .orderBy(asc(profileDevices.firstSeenAt)));
    const deviceTags = deviceRows.length
      ? `<ul class="toplist">${deviceRows
          .map(
            (d) =>
              `<li><span class="mono">${esc(d.slug)}</span><span class="count muted small">${esc(d.firstSeenAt.toISOString().slice(0, 10))}</span> <a class="btn ghost small" href="/setup/device?p=${esc(current.id)}&name=${esc(d.slug)}">Config</a></li>`,
          )
          .join("")}</ul>`
      : `<p class="muted">No devices tagged yet. Name them via <span class="mono">${esc(dohDeviceUrl)}</span> when you set a device up.</p>`;

    const sourceIps = await db
      .select({ ip: profileSourceIps.ipAddress })
      .from(profileSourceIps)
      .where(eq(profileSourceIps.profileId, current.id));

    const body = `
<div class="headbox"><h1>Setup · ${esc(current.name)}</h1></div>
<div class="card"><h3>DoH URLs</h3>
  <div class="row"><span class="k">Profile</span><span class="mono" id="doh-bare">${esc(dohUrl)}</span><button class="btn ghost small" data-copy="doh-bare">Copy</button></div>
  <div class="row"><span class="k">Per-device</span><span class="mono">${esc(dohDeviceUrl)}</span></div>
  <div class="row"><span class="k">DoT (Android)</span><span class="mono">coming soon (see readme §4b)</span></div>
  <p class="muted small">IPs (UDP legacy / Deco): <span class="mono">37.16.24.24</span> · <span class="mono">37.16.24.46</span></p>
</div>
<div class="grid2">
  <div class="card"><h3>Devices</h3>${deviceTags}</div>
  <div class="card"><h3>Linked IPs (UDP)</h3>
    ${sourceIps.length ? `<ul class="toplist">${sourceIps.map((s) => `<li><span class="mono">${esc(s.ip)}</span></li>`).join("")}</ul>` : '<p class="muted">None yet.</p>'}
    <form method="post" action="/dash/link-ip?p=${esc(current.id)}" class="rowWrap">
      <input class="inp" name="ip" placeholder="Leave blank to link your current IP">
      <button class="btn primary small">Link IP</button>
    </form>
    <p class="muted small">Server-side: your edge already whitelists these IPs; the edge keeps <span class="mono">rx_drop_refused</span> counts if you mess with routes.</p>
  </div>
</div>
${copyScript}
`;
    return c.html(layout({ session, title: "Setup", profiles: owned, current, active: "setup" }, body));
  });

  app.post("/dash/link-ip", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody().catch(() => ({}));
    const explicitIp = String((form as Record<string, unknown>).ip ?? "").trim();
    // Prefer the user's browser IP (they're on the network being linked),
    // not the control server's egress IP.
    const callerIp =
      explicitIp ||
      c.req.header("fly-client-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "";
    const ip = callerIp.replace(/^\[|\]$/g, "").split("%")[0]!.trim();
    if (!ip || isIP(ip) === 0) return c.html("IP link failed: invalid IP.", 400);

    // The control plane owns the session and profile ownership check, so it
    // can write the link directly. This avoids passing a browser-controlled
    // ?ip= value through the public edge admin endpoint.
    const inserted = await db
      .insert(profileSourceIps)
      .values({ ipAddress: ip, profileId: current.id })
      .onConflictDoNothing({ target: profileSourceIps.ipAddress })
      .returning({ profileId: profileSourceIps.profileId });
    if (inserted.length === 0) {
      const existing = await db
        .select({ profileId: profileSourceIps.profileId })
        .from(profileSourceIps)
        .where(eq(profileSourceIps.ipAddress, ip))
        .limit(1);
      if (existing[0] && existing[0].profileId !== current.id) {
        return c.html("IP link failed: that IP is linked to another profile.", 409);
      }
    }
    return c.redirect(`/setup?p=${current.id}`);
  });

  app.get("/rules", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.html(layout({ session, title: "Rules", profiles: [] }, onboarding()));

    const [rules, lists, zones] = await Promise.all([
      db
        .select({ domain: profileRules.domain, action: profileRules.action })
        .from(profileRules)
        .where(eq(profileRules.profileId, current.id))
        .orderBy(asc(profileRules.domain)),
      db
        .select({
          id: profileBlocklists.id,
          url: profileBlocklists.url,
          enabled: profileBlocklists.enabled,
          entryCount: profileBlocklists.entryCount,
          lastStatus: profileBlocklists.lastStatus,
          lastSyncedAt: profileBlocklists.lastSyncedAt,
          format: profileBlocklists.format,
        })
        .from(profileBlocklists)
        .where(eq(profileBlocklists.profileId, current.id))
        .orderBy(asc(profileBlocklists.createdAt)),
      db
        .select({ domain: profileZones.domain, recordType: profileZones.recordType, values: profileZones.values })
        .from(profileZones)
        .where(eq(profileZones.profileId, current.id))
        .orderBy(asc(profileZones.domain)),
    ]);

    const ruleRows = rules
      .map(
        (r) =>
          `<tr><td class="mono">${esc(r.domain)}</td><td><span class="chip ${r.action === "block" ? "" : "ok"}">${esc(r.action)}</span></td>
<td><form method="post" action="/dash/rules/delete?p=${esc(current.id)}" class="inline"><input type="hidden" name="domain" value="${esc(r.domain)}"><input type="hidden" name="action" value="${esc(r.action)}"><button class="btn ghost small">Remove</button></form></td></tr>`,
      )
      .join("");
    const listRows = lists
      .map(
        (l) =>
          `<div class="row"><span class="chip ${l.enabled ? "ok" : "muted"}">${l.enabled ? "on" : "off"}</span>
<span class="mono grow">${esc(l.url)}</span>
<span class="count">${fmt(l.entryCount)}</span>
<span class="muted small">${esc(l.lastStatus ?? "")}</span>
<form method="post" action="/dash/lists/toggle?p=${esc(current.id)}" class="inline"><input type="hidden" name="id" value="${esc(l.id)}"><input type="hidden" name="enabled" value="${l.enabled ? "0" : "1"}"><button class="btn ghost small">${l.enabled ? "Disable" : "Enable"}</button></form>
<form method="post" action="/dash/lists/sync?p=${esc(current.id)}" class="inline"><input type="hidden" name="id" value="${esc(l.id)}"><button class="btn ghost small">Force sync</button></form>
</div>`,
      )
      .join("");
    const zoneRows = zones
      .map(
        (z) =>
          `<div class="row"><span class="mono grow">${esc(z.domain)}</span><span>${esc(z.recordType)}</span><span class="mono">${esc(z.values.join(", "))}</span><form method="post" action="/dash/zones/delete?p=${esc(current.id)}" class="inline"><input type="hidden" name="domain" value="${esc(z.domain)}"><input type="hidden" name="recordType" value="${esc(z.recordType)}"><button class="btn ghost small">Delete</button></form></div>`,
      )
      .join("");

    const body = `
<div class="headbox"><h1>Rules · ${esc(current.name)}</h1></div>
<div class="grid2">
<div class="card"><h3>Manual rules</h3>
<table class="tbl"><thead><tr><th>Domain</th><th>Action</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table>
<form method="post" action="/dash/rules/add?p=${esc(current.id)}" class="rowWrap">
  <input class="inp" name="domain" placeholder="doubleclick.net" required pattern="[a-zA-Z0-9._*-]+" >
  <select name="action" class="inp"><option>block</option><option>allow</option></select>
  <button class="btn primary small">Add</button>
</form></div>
<div class="card"><h3>Remote blocklists</h3>${listRows || '<p class="muted">None subscribed.</p>'}
<form method="post" action="/dash/lists/add?p=${esc(current.id)}" class="rowWrap">
  <input class="inp" name="url" placeholder="https://…/hostfile.txt" required>
  <select name="format" class="inp"><option>hosts</option><option>abp</option><option>domains</option></select>
  <button class="btn primary small">Subscribe</button>
</form></div>
</div>
<div class="card"><h3>Zones (split-horizon, TXT/A/AAAA/CNAME)</h3>
${zoneRows || '<p class="muted">None configured.</p>'}
<form method="post" action="/dash/zones/add?p=${esc(current.id)}" class="rowWrap">
  <input class="inp" name="domain" placeholder="nas.lan or *.home.example.com" required>
  <input class="inp" name="recordType" placeholder="A" value="A" size="4">
  <input class="inp" name="values" placeholder="192.168.1.24[,192.168.1.25]" required>
  <input class="inp" name="ttl" type="number" placeholder="ttl" value="120" size="5">
  <button class="btn primary small">Add</button>
</form></div>`;
    return c.html(layout({ session, title: "Rules", profiles: owned, current, active: "rules" }, body));
  });

  app.post("/dash/rules/add", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    const domain = String(form.domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
    const action = form.action === "allow" ? "allow" : "block";
    if (!VALID_DOMAIN.test(domain)) return c.body(null, 400);
    await db
      .insert(profileRules)
      .values({ profileId: current.id, domain, action })
      .onConflictDoUpdate({ target: [profileRules.profileId, profileRules.domain], set: { action } });
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.post("/dash/rules/delete", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    const domain = String(form.domain ?? "");
    const action = String(form.action ?? "");
    await db
      .delete(profileRules)
      .where(and(eq(profileRules.profileId, current.id), eq(profileRules.domain, domain), eq(profileRules.action, action)));
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.post("/dash/lists/add", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    const url = String(form.url ?? "").trim();
    const format = ["hosts", "abp", "domains"].includes(String(form.format))
      ? String(form.format)
      : "hosts";
    if (!isSafeListUrl(url)) return c.json({ error: "list URL must be https (no private/metadata hosts)" }, 400);
    const existing = await db
      .select({ id: profileBlocklists.id })
      .from(profileBlocklists)
      .where(and(eq(profileBlocklists.profileId, current.id), eq(profileBlocklists.url, url)))
      .limit(1);
    if (existing.length > 0) return c.json({ error: "already subscribed" }, 409);
    const count = await db
      .select({ id: profileBlocklists.id })
      .from(profileBlocklists)
      .where(eq(profileBlocklists.profileId, current.id));
    if (count.length >= 20) return c.json({ error: "subscription limit (20) reached" }, 400);
    await db.insert(profileBlocklists).values({ profileId: current.id, url, format, enabled: true });
    void edgeFetch(`/v1/${current.id}/blocklists/sync`, current.dohToken, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.post("/dash/lists/toggle", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    const id = String(form.id ?? "");
    const enabled = String(form.enabled ?? "1") === "1";
    await db
      .update(profileBlocklists)
      .set({ enabled })
      .where(and(eq(profileBlocklists.profileId, current.id), eq(profileBlocklists.id, id)));
    void edgeFetch(`/v1/${current.id}/blocklists/sync`, current.dohToken, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.post("/dash/lists/sync", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    try {
      await edgeFetch(`/v1/${current.id}/blocklists/sync`, current.dohToken, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // edge unreachable — redirect anyway, status visible on next load
    }
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.post("/dash/zones/add", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    const domain = String(form.domain ?? "").trim().toLowerCase();
    const recordType = String(form.recordType || "A").toUpperCase();
    const values = String(form.values ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ttl = Math.min(86400, Math.max(1, Number(form.ttl ?? 300) || 300));
    if (!VALID_DOMAIN.test(domain.replace(/^\*\./, ""))) return c.body(null, 400);
    if (!["A", "AAAA", "CNAME", "TXT"].includes(recordType)) return c.body(null, 400);
    if (values.length === 0 || values.length > 8 || values.some((v) => v.length > 255)) return c.body(null, 400);
    if (!values.every((v) => isValidZoneValue(recordType, v))) return c.body(null, 400);
    await db
      .insert(profileZones)
      .values({ profileId: current.id, domain, recordType, values, ttl })
      .onConflictDoUpdate({
        target: [profileZones.profileId, profileZones.domain, profileZones.recordType],
        set: { values, ttl },
      });
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.post("/dash/zones/delete", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    await db
      .delete(profileZones)
      .where(
        and(
          eq(profileZones.profileId, current.id),
          eq(profileZones.domain, String(form.domain ?? "")),
          eq(profileZones.recordType, String(form.recordType ?? "A")),
        ),
      );
    return c.redirect(`/rules?p=${current.id}`);
  });

  app.get("/analytics", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.html(layout({ session, title: "Analytics", profiles: [] }, onboarding()));
    const range = (c.req.query("range") ?? "24h").match(/^(30m|6h|24h|7d|30d|90d)$/)?.[0] ?? "24h";
    const stats = (await fetchStats(current.id, range, current.dohToken)) ?? EMPTY_STATS;
    const body = `
<div class="headbox"><h1>Analytics · ${esc(current.name)}</h1>
<span class="muted">range</span>
${["30m", "6h", "24h", "7d", "30d", "90d"]
    .map((r) => `<a class="chip ${r === range ? "active" : ""}" href="/analytics?p=${esc(current.id)}&range=${r}">${r}</a>`)
    .join("")}</div>
${kpiTiles(stats)}
${chart(stats.series ?? [])}
<div class="grid2">
  ${topList("Resolved domains", stats.topDomains, "domain")}
  ${topList("Blocked domains", stats.topBlocked, "domain")}
  ${topList("Devices", stats.queriesPerDevice, "device")}
</div>
<p class="muted small">Raw events: <a class="mono" href="${logUrl(current.id, "jsonl", new Date().toISOString().slice(0, 10))}">download JSONL</a> · <a class="mono" href="${logUrl(current.id, "csv", new Date().toISOString().slice(0, 10))}">CSV</a></p>`;
    return c.html(layout({ session, title: "Analytics", profiles: owned, current, active: "analytics" }, body));
  });

  // Server-side log download: the browser never receives a DoH token in a
  // URL. Control authenticates the session/ownership, then streams from the
  // edge with a Bearer header.
  app.get("/dash/logs/download", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);

    const format = c.req.query("format") === "csv" ? "csv" : "jsonl";
    const date = c.req.query("date") ?? "";
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.body(null, 400);

    const params = new URLSearchParams({ format });
    if (date) params.set("date", date);
    let res: Response;
    try {
      res = await edgeFetch(`/v1/${current.id}/logs?${params}`, current.dohToken);
    } catch {
      return c.text("edge unreachable", 502);
    }
    if (!res.ok || !res.body) return c.text(`edge returned ${res.status}`, 502);

    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": format === "csv" ? "text/csv" : "application/x-ndjson",
        "content-disposition": `attachment; filename="rz-logs-${current.id}${date ? "-" + date : ""}.${format}"`,
        "cache-control": "no-store",
      },
    });
  });

  app.get("/logs", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.html(layout({ session, title: "Logs", profiles: [] }, onboarding()));
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    let rows: { time: string; domain: string; action: string; clientIp: string; rttMs: number | null; device?: string }[] = [];
    let err = "";
    try {
      const res = await edgeFetch(
        `/v1/${current.id}/logs?format=jsonl&date=${encodeURIComponent(date)}&limit=400&order=desc`,
        current.dohToken,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (res.ok) {
        const text = await res.text();
        rows = text
          .split("\n")
          .filter(Boolean)
          .map((l): Record<string, unknown> | null => {
            try {
              return JSON.parse(l) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((e): e is Record<string, unknown> => e !== null && typeof e["time"] === "string")
          .map((e) => ({
            time: String(e["time"]),
            domain: String(e.domain),
            action: String(e["action"]),
            clientIp: String(e["clientIp"] ?? ""),
            rttMs: (e["rttMs"] as number | null) ?? null,
            device: e["device"] as string | undefined,
          }));
      } else {
        err = `edge returned ${res.status}`;
      }
    } catch (e) {
      err = String(e);
    }
    const body = `
<div class="headbox"><h1>Logs · ${esc(current.name)}</h1>
<form method="get" action="/logs" class="rowWrap"><input type="hidden" name="p" value="${esc(current.id)}">
<input class="inp" type="date" name="date" value="${esc(date)}"><button class="btn primary small">Load</button></form>
</div>
${err ? `<p class="muted">${esc(err)}</p>` : ""}
<div class="card"><table class="tbl"><thead><tr><th>time</th><th>domain</th><th>action</th><th>device</th><th>client</th><th>rtt</th></tr></thead>
<tbody>${rows
      .map(
        (r) =>
          `<tr><td class="muted small">${esc(r.time.slice(11, 19))}</td><td class="mono">${esc(r.domain)}</td><td>${esc(r.action)}</td><td class="mono">${esc(r.device ?? "-")}</td><td class="mono small">${esc(r.clientIp)}</td><td class="muted small">${r.rttMs ?? "-"}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
    return c.html(layout({ session, title: "Logs", profiles: owned, current, active: "logs" }, body));
  });

  app.get("/settings", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.html(layout({ session, title: "Settings", profiles: [] }, onboarding()));
    const body = `
<div class="headbox"><h1>Settings · ${esc(current.name)}</h1></div>
<div class="card"><h3>Basics</h3>
<form method="post" action="/dash/settings/save?p=${esc(current.id)}" class="col">
  <label>Name <input class="inp" name="name" value="${esc(current.name)}" required></label>
  <label><input type="checkbox" name="logQueries" value="1" ${current.logQueries ? "checked" : ""}> Log queries (raw events to your archive)</label>
  <label>Retention days <input class="inp" type="number" name="logRetentionDays" value="${current.logRetentionDays}"></label>
  <label>Upstream
    <select name="upstream" class="inp">
      ${["", "cloudflare", "google", "quad9"].map((u) => `<option value="${u}" ${current.upstream === u ? "selected" : ""}>${u || "edge default (Cloudflare)"}</option>`).join("")}
    </select>
  </label>
  <label>Custom upstream DoH URL (wins over preset)
    <input class="inp" name="upstreamUrl" value="${esc(current.upstreamUrl ?? "")}" placeholder="https://…/dns-query" inputmode="url">
  </label>
  <button class="btn primary">Save</button>
</form></div>
<div class="card danger"><h3>Danger zone</h3>
<form method="post" action="/dash/settings/delete?p=${esc(current.id)}" onSubmit="return confirm('Delete profile ${esc(current.name)}? This is permanent.')">
  <button class="btn danger">Delete profile entirely</button>
  <span class="muted small">cascades rules/zones/lists, de-links devices</span>
</form></div>`;
    return c.html(layout({ session, title: "Settings", profiles: owned, current, active: "settings" }, body));
  });

  app.post("/dash/settings/save", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim().slice(0, 64) || current.name;
    const logQueries = form.logQueries === "1";
    const logRetentionDays = Math.min(365, Math.max(1, Number(form.logRetentionDays ?? 30) || 30));
    const upstream = form.upstream && String(form.upstream) ? String(form.upstream) : null;
    const rawUpstreamUrl = String(form.upstreamUrl ?? "").trim();
    const upstreamUrl = rawUpstreamUrl ? rawUpstreamUrl.slice(0, 255) : null;
    if (upstreamUrl && !isValidUpstreamUrl(upstreamUrl)) {
      return c.json({ error: "upstream URL must be http(s)" }, 400);
    }
    await db
      .update(profiles)
      .set({ name, logQueries, logRetentionDays, upstream, upstreamUrl })
      .where(and(eq(profiles.id, current.id), eq(profiles.ownerUserId, session.user.id)));
    return c.redirect(`/settings?p=${current.id}`);
  });

  app.post("/dash/settings/delete", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p"));
    if (!current) return c.body(null, 403);
    await db.delete(profiles).where(and(eq(profiles.id, current.id), eq(profiles.ownerUserId, session.user.id)));
    return c.redirect("/");
  });

  // Onboarding: adopt existing profile (id + token) or create a fresh one.
  app.post("/dash/adopt", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const form = await c.req.parseBody();
    const id = String(form.profileId ?? "").trim();
    const token = String(form.dohToken ?? "").trim();
    const row = (await db.select({ id: profiles.id, dohToken: profiles.dohToken, ownerUserId: profiles.ownerUserId }).from(profiles).where(eq(profiles.id, id)).limit(1))[0];
    if (!row) return c.body(null, 404);
    if (row.dohToken !== token) return c.body(null, 403);
    if (row.ownerUserId && row.ownerUserId !== session.user.id) return c.body(null, 403);
    await db.update(profiles).set({ ownerUserId: session.user.id }).where(eq(profiles.id, id));
    return c.redirect(`/setup?p=${id}`);
  });

  app.post("/dash/profiles/create", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim().slice(0, 64) || "profile";
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const created = (
      await db
        .insert(profiles)
        .values({ name, dohToken: token, ownerUserId: session.user.id, logQueries: true, logRetentionDays: 30 })
        .returning({ id: profiles.id })
    )[0];
    if (!created) return c.body(null, 500);
    // Seed minimal starter rules: a blocklist (Polish Pi-hole list) + KADhosts.
    await db.insert(profileBlocklists).values([
      {
        profileId: created.id,
        url: "https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/polish-pihole-filters/hostfile.txt",
        format: "hosts",
        enabled: true,
      },
      { profileId: created.id, url: "https://raw.githubusercontent.com/FiltersHeroes/KADhosts/master/KADhosts.txt", format: "hosts", enabled: true },
    ]);
    return c.redirect(`/setup?p=${created.id}`);
  });

  app.get("/setup/device", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.html(loginPage(session));
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.body(null, 403);
    const slug = (c.req.query("name") ?? "device").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "device";
    const url = `${process.env.DOH_HOST ?? "https://dns.resolvezero.com"}/v1/${current.id}/${slug}`;
    const mobileconfig = MOBILECONFIG(current.name, slug, url);
    const body = `
<div class="headbox"><h1>Device setup · ${esc(current.name)} / ${esc(slug)}</h1></div>
<div class="card"><h3>DoH (Apple, macOS/iOS)</h3>
  <div class="row"><span class="mono grow">${esc(url)}</span><button class="btn ghost small" data-copy="doh-device">Copy</button></div>
  <a class="btn primary" href="/setup/download-profile?p=${esc(current.id)}&name=${esc(slug)}">Download .mobileconfig</a>
  <p class="muted small">Settings → General → VPN & Device Management → install profile. Safari uses system DNS; Chrome/Firefox with "secure DNS" bundled bypass it.</p>
</div>
<div class="card"><h3>Android (DoT, later)</h3><p class="muted small">DoT listener is on the roadmap (§4b). For now use DoH-based apps or the UDP IPs + linked IP.</p></div>
<div class="card"><h3>Deco / router (UDP legacy)</h3>
  <p>DNS server IPs: <span class="mono">37.16.24.24</span>, <span class="mono">37.16.24.46</span> then click Link IP above (or from the live network: <span class="mono">curl "https://resolvezero-edge.fly.dev/v1/${esc(current.id)}/update-ip"</span>).</p></div>
${copyScript}`;
    return c.html(layout({ session, title: "Device setup", profiles: owned, current, active: "setup" }, body));
  });

  app.get("/setup/download-profile", async (c) => {
    const session = c.get("session");
    if (!session?.user) return c.body(null, 401);
    const owned = await listProfiles(session.user.id);
    const current = owned.find((p) => p.id === c.req.query("p")) ?? owned[0];
    if (!current) return c.body(null, 403);
    const slug = (c.req.query("name") ?? "device").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "device";
    const url = `${process.env.DOH_HOST ?? "https://dns.resolvezero.com"}/v1/${current.id}/${slug}`;
    const xml = MOBILECONFIG(current.name, slug, url);
    return c.body(xml, 200, {
      "content-type": "application/x-apple-aspen-config; charset=utf-8",
      "content-disposition": `attachment; filename="resolvezero-${slug}.mobileconfig"`,
    });
  });

  return app;
}

const VALID_DOMAIN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const EMPTY_STATS: StatsSummary = { range: "-", totalQueries: 0, blocked: 0, blockRatio: 0 };

const copyScript = `<script>
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-copy]");
  if (!t) return;
  const node = document.getElementById(t.dataset.copy);
  if (node?.textContent) navigator.clipboard.writeText(node.textContent.trim());
  t.textContent = "Copied";
  setTimeout(() => (t.textContent = "Copy"), 1400);
});
</script>`;
const scriptCopy = copyScript;
const snippets = "";

function MOBILECONFIG(profileName: string, slug: string, url: string): string {
  const uuid = crypto.randomUUID();
  const uuid2 = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key><array><dict>
    <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
    <key>PayloadIdentifier</key><string>com.resolvezero.doh.${esc(slug)}</string>
    <key>PayloadUUID</key><string>${uuid2}</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>PayloadDisplayName</key><string>ResolveZero DoH (${esc(profileName)})</string>
    <key>DNSSettings</key><dict>
      <key>DNSProtocol</key><string>HTTPS</string>
      <key>ServerURL</key><string>${esc(url)}</string>
    </dict>
  </dict></array>
  <key>PayloadDisplayName</key><string>ResolveZero (${esc(profileName)})</string>
  <key>PayloadIdentifier</key><string>com.resolvezero.profile.${esc(slug)}</string>
  <key>PayloadOrganization</key><string>ResolveZero</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict></plist>
</html>`;
}

function onboarding(): string {
  return `
<div class="center"><div class="card onb">
<h2>Welcome aboard</h2>
<p class="muted">Adopt an existing profile (from your self-host or staging setup) or create a fresh one.</p>
<div class="grid2">
<div class="card"><h3>Create a profile</h3>
<form method="post" action="/dash/profiles/create" class="col">
  <input class="inp" name="name" placeholder="home" required>
  <button class="btn primary">Create (+ starter blocklists)</button>
</form></div>
<div class="card"><h3>Adopt an existing profile</h3>
<form method="post" action="/dash/adopt" class="col">
  <input class="inp" name="profileId" placeholder="profile id (uuid)" required>
  <input class="inp" name="dohToken" placeholder="doh token" required>
  <button class="btn">Claim</button>
</form></div>
</div></div></div>`;
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:#0b0f17; color:#e2e8f0; font:14px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto; }
a { color: inherit; text-decoration: none; }
.topbar { display:flex; gap:1rem; align-items:center; padding:0.8rem 1.2rem; border-bottom:1px solid #1e293b; position:sticky; top:0; background:#0b0f17ea; backdrop-filter: blur(8px); z-index:10; }
.brand { font-weight:700; display:flex; gap:.5rem; align-items:center; }
.brand .shield { background:#3b82f6; color:#fff; border-radius:8px; width:1.6rem; height:1.6rem; display:inline-flex; align-items:center; justify-content:center; }
.switcher { display:flex; gap:.5rem; }
.chip { border:1px solid #334155; border-radius:999px; padding:.15rem .7rem; font-size:.85rem; color:#94a3b8; }
.chip.active, .chip.ok { border-color:#3b82f6; color:#e2e8f0; background:#1d4ed822; }
.chip.ok { color:#4ade80; border-color:#4ade80; }
.spacer { flex:1; }
.me { color:#94a3b8; font-size:.85rem; }
.btn { border:1px solid #334155; background:#1e293b; color:#e2e8f0; padding:.35rem .7rem; border-radius:8px; cursor:pointer; font-size:.85rem; }
.btn.primary { background:#3b82f6; border-color:#3b82f6; color:white; }
.btn.primary:hover { background:#2563eb; }
.btn.ghost { background:transparent; }
.btn.danger { background:#7f1d1d; border-color:#b91c1c; color:#fecaca; }
.btn.big { padding:.7rem 1.2rem; font-size:1rem; }
.btn.small { padding:.2rem .5rem; }
.regex, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.tabs { display:flex; gap:.25rem; padding:.5rem 1.2rem 0; border-bottom:1px solid #1e293b; }
.tabs a { padding:.45rem .9rem; border-radius:8px 8px 0 0; color:#94a3b8; }
.tabs a.on { color:#e2e8f0; background:#1e293b; border:1px solid #334155; border-bottom:transparent; }
.wrap { padding:1.4rem 1.2rem; max-width:1080px; margin:0 auto; }
.headbox { display:flex; align-items:baseline; gap:1rem; margin-bottom:1rem; }
.muted { color:#94a3b8; }
.small { font-size:.8rem; }
.red { color:#f87171; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:1rem; margin-top:1rem; }
.card { background:#111827; border:1px solid #1e293b; border-radius:12px; padding:1rem 1.1rem; }
.card h3 { margin:.1rem 0 .8rem; font-size:.95rem; color:#cbd5e1; }
.card.danger { border-color:#7f1d1d; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1rem; }
.tile { background:#111827; border:1px solid #1e293b; border-radius:12px; padding:1rem; }
.tile .big { font-size:1.7rem; font-weight:700; }
.toplist { list-style:none; margin:0; padding:0; }
.toplist li { display:flex; gap:.6rem; padding:.3rem 0; border-bottom:1px dashed #1e293b; align-items:center; }
.toplist li .count { margin-left:auto; color:#64748b; }
.tbl { width:100%; border-collapse:collapse; }
.tbl th { text-align:left; color:#94a3b8; font-weight:500; font-size:.8rem; border-bottom:1px solid #334155; padding:.35rem .5rem; }
.tbl td { padding:.35rem .5rem; border-bottom:1px solid #1e293b; }
.row { display:flex; gap:.6rem; align-items:center; padding:.35rem 0; }
.rowWrap { display:flex; gap:.5rem; margin-top:.6rem; flex-wrap:wrap; }
.inp { background:#0b0f17; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:.38rem .6rem; }
.col { display:flex; flex-direction:column; gap:.7rem; }
.center { display:grid; place-items:center; min-height:80vh; }
.login { max-width:420px; text-align:center; padding:2rem; }
.login h1 { margin:.2rem 0 .4rem; }
.chart { width:100%; height:auto; }
.legend { display:flex; gap:1rem; align-items:center; font-size:.8rem; color:#94a3b8; }
.dot { width:.7rem; height:.7rem; border-radius:50%; display:inline-block; margin-right:.3rem; }
.dot.blue { background:#3b82f6; }
.dot.red { background:#ef4444; }
.grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.onb { max-width:640px; }
`;

const { snippets: _} = { snippets: "" };
