import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { format, getHours, parseISO } from 'date-fns'
import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from 'recharts'
import { getOverview } from '../server/dashboard'
import {
  ArrowUpRight,
  Ban,
  Clock3,
  Globe2,
  Monitor,
  ShieldCheck,
  Zap,
} from 'lucide-react'

export const Route = createFileRoute('/')({ component: Overview })

const REGION_NAMES: Record<string, string> = {
  fra: 'Frankfurt',
  lhr: 'London',
  iad: 'Ashburn',
  sjc: 'San José',
  nrt: 'Tokyo',
  syd: 'Sydney',
  gru: 'São Paulo',
}

function regionLabel(region: string | null): string {
  if (!region) return '—'
  return region.toUpperCase()
}

function ageLabel(ms: number | null): string {
  if (ms == null) return '—'
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  if (hour < 22) return 'Good evening'
  return 'Good night'
}

function Overview() {
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  const [greeting, setGreeting] = useState('Hello')

  // Resolve in the browser so the greeting matches the viewer's local time,
  // not the SSR/Fly machine timezone. Starting with "Hello" avoids hydration
  // mismatches when the server and browser are in different zones.
  useEffect(() => {
    setGreeting(greetingForHour(getHours(new Date())))
  }, [])

  if (isPending) return <OverviewSkeleton />
  if (isError || !data) return <OverviewError onRetry={() => void refetch()} />

  const chartData = data.series.map((point) => ({
    time: format(parseISO(point.bucket), 'HH:mm'),
    total: point.total,
    blocked: point.blocked,
  }))
  const maxBlocked = Math.max(...data.topBlocked.map((d) => d.count), 1)
  const topBlocked = data.topBlocked.map((d) => ({
    domain: d.domain,
    count: formatNumber(d.count),
    share: Math.round((d.count / maxBlocked) * 100),
  }))
  const devices = data.topDevices.map((d) => ({
    name: d.device,
    detail: 'DoH device tag',
    queries: formatNumber(d.count),
  }))
  const totalQueries = data.totalQueries
  const blocked = data.blocked
  const activeSources = Math.max(data.activeDevices, data.topClients.length)
  const forwarded = Math.max(totalQueries - blocked, 0)
  const qps = totalQueries / 86_400
  const qpsLabel = qps >= 10 ? formatNumber(Math.round(qps)) : qps.toFixed(1)
  const profileLabel = data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1)
  const region = regionLabel(data.edge.region)
  const updateAge = ageLabel(data.edge.configPollAgeMs)

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-[var(--muted)]">{profileLabel} profile</p>
          <h1 className="text-[24px] font-semibold tracking-[-0.035em]">Overview</h1>
          <p className="mt-1.5 text-[12px] text-[var(--muted)]">
            {greeting}, Maciej · last 24 hours · updated {updateAge} ago
          </p>
        </div>
      </div>

      <section className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-md bg-[#fff1e9] text-[var(--accent)]">
                  <ShieldCheck size={17} strokeWidth={1.8} />
                </span>
                <div>
                  <p className="text-[10px] font-medium text-[var(--muted)]">Network posture</p>
                  <p className="text-[15px] font-semibold tracking-[-0.02em]">{data.edge.ok ? 'Protected' : 'Attention needed'}</p>
                </div>
              </div>
              <p className="mt-4 max-w-[460px] text-[12px] leading-5 text-[var(--muted)]">
                {data.edge.ok
                  ? `DNS is answering${data.edge.region ? ` from ${REGION_NAMES[data.edge.region] ?? region}` : ''}. Your latest rules and blocklists are live.`
                  : 'The DNS edge health check is unavailable. Queries may still be flowing.'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-7 gap-y-3 md:min-w-[220px]">
              <MiniStat label="Custom rules" value={String(data.ruleCount)} />
              <MiniStat label="Active sources" value={String(activeSources)} />
              <MiniStat label="Updated" value={`${updateAge} ago`} accent />
              <MiniStat label="Region" value={region} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] bg-[var(--paper)]/60 px-5 py-2.5 text-[10px] text-[var(--muted)]">
            <span className="flex items-center gap-1.5"><span className={['size-1.5 rounded-full', data.edge.dns53Bound ? 'bg-[#2e9b55]' : 'bg-[#c8a24a]'].join(' ')} /> UDP + TCP 53 {data.edge.dns53Bound ? 'healthy' : 'unavailable'}</span>
            <span className="flex items-center gap-1.5"><span className={['size-1.5 rounded-full', data.edge.blocklistsLoaded ? 'bg-[#2e9b55]' : 'bg-[#c8a24a]'].join(' ')} /> Blocklists {data.edge.blocklistsLoaded ? 'loaded' : 'unavailable'}</span>
            <span className="flex items-center gap-1.5"><span className={['size-1.5 rounded-full', data.edge.ok ? 'bg-[#2e9b55]' : 'bg-[#c8a24a]'].join(' ')} /> Edge {data.edge.ok ? 'healthy' : 'unreachable'}</span>
          </div>
        </div>

        <div className="rz-card flex flex-col justify-between p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-medium text-[var(--muted)]">Live traffic</p>
              <p className="mt-1.5 font-mono text-[28px] font-medium tracking-[-0.05em]">{qpsLabel}<span className="ml-2 font-sans text-[11px] tracking-normal text-[var(--muted)]">qps avg</span></p>
            </div>
            <span className="rounded border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--muted)]">24h window</span>
          </div>
          <div className="mt-4 flex items-center gap-4">
            <BlockedDonut total={totalQueries} blocked={blocked} />
            <div className="space-y-2.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-[var(--ink)]" />
                <span className="text-[var(--muted)]">Forwarded</span>
                <span className="ml-auto font-mono text-[var(--ink)]">{formatNumber(forwarded)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-[var(--accent)]" />
                <span className="text-[var(--muted)]">Blocked</span>
                <span className="ml-auto font-mono text-[var(--ink)]">{formatNumber(blocked)}</span>
              </div>
              <div className="flex items-center gap-2 border-t border-[var(--line)] pt-2.5">
                <span className="text-[var(--muted)]">Total</span>
                <span className="ml-auto font-mono text-[var(--ink)]">{formatNumber(totalQueries)}</span>
              </div>
            </div>
          </div>
          <div className="mt-5 flex items-center gap-1.5 border-t border-[var(--line)] pt-3 text-[10px] text-[var(--muted)]">
            <Zap size={11} className="text-[var(--accent)]" />
            Last 24 hours
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Globe2 size={16} />} label="Queries / 24h" value={formatNumber(totalQueries)} delta="last 24 hours" />
        <Kpi icon={<Ban size={16} />} label="Blocked" value={formatNumber(blocked)} delta={`${(data.blockRatio * 100).toFixed(1)}% of total`} />
        <Kpi icon={<Clock3 size={16} />} label="Avg upstream" value={data.avgRttMs != null ? `${data.avgRttMs} ms` : '—'} delta="forwarded queries" positive />
        <Kpi icon={<Monitor size={16} />} label="Active sources" value={String(activeSources)} delta="client IPs / DoH tags" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Query volume</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Forwarded vs blocked over the last 24 hours</p>
            </div>
            <span className="rounded border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--muted)]">Last 24 hours</span>
          </div>
          <div className="mt-4 flex items-center gap-5 text-[11px] text-[var(--muted)]">
            <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--ink)]" /> Forwarded</span>
            <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--accent)]" /> Blocked</span>
          </div>
          <QueryChart data={chartData} />
          <div className="mt-3 flex justify-between font-mono text-[10px] text-[var(--muted)]">
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
          </div>
        </div>

        <div className="rz-card p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Top blocked</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Last 24 hours</p>
            </div>
          </div>
          <div className="mt-5 space-y-4">
            {topBlocked.length === 0 ? <p className="py-6 text-center text-[12px] text-[var(--muted)]">No blocked domains in this window.</p> : null}
            {topBlocked.map((item) => (
              <div key={item.domain}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-[12px] text-[var(--ink)]">{item.domain}</span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--muted)]">{item.count}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-[var(--paper-2)]">
                  <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${item.share}%` }} />
                </div>
              </div>
            ))}
          </div>
          <Link to="/logs" className="mt-6 flex items-center gap-1 text-[11px] font-medium text-[var(--ink)] hover:text-[var(--accent)]">
            Open query log <ArrowUpRight size={12} />
          </Link>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex items-start justify-between p-6 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Devices</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Most active on this profile</p>
            </div>
            <Link to="/devices" className="rz-button-secondary !py-1.5 !text-[11px]">Manage</Link>
          </div>
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {devices.length === 0 ? <p className="px-6 py-8 text-center text-[12px] text-[var(--muted)]">No tagged DoH devices in this window.</p> : null}
            {devices.map((device) => (
              <div key={device.name} className="flex items-center gap-3 px-6 py-3.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--paper-2)] text-[var(--muted)]">
                  <Monitor size={14} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium">{device.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">{device.detail}</p>
                </div>
                <span className="ml-auto font-mono text-[11px] text-[var(--muted)]">{device.queries}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rz-card p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Edge status</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Live from the resolver</p>
            </div>
            <span className={['flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium', data.edge.ok ? 'bg-[#edf8f0] text-[#247440]' : 'bg-[#fff4e6] text-[#a96500]'].join(' ')}>
              <span className={['size-1.5 rounded-full', data.edge.ok ? 'bg-[#2e9b55]' : 'bg-[#c8a24a]'].join(' ')} />
              {data.edge.ok ? 'Healthy' : 'Degraded'}
            </span>
          </div>
          <div className="mt-5 space-y-3">
            <StatusRow label="Region" value={data.edge.region ? `${region} · ${REGION_NAMES[data.edge.region] ?? 'Unknown'}` : '—'} />
            <StatusRow label="Config age" value={updateAge} />
            <StatusRow label="Blocklists" value={data.edge.blocklistsLoaded ? 'Loaded' : 'Unavailable'} />
            <StatusRow label="Failed lists" value={String(data.edge.failedBlocklists)} />
          </div>
        </div>
      </section>
    </div>
  )
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] pb-3 last:border-0 last:pb-0">
      <span className="text-[11px] text-[var(--muted)]">{label}</span>
      <span className="font-mono text-[11px] text-[var(--ink)]">{value}</span>
    </div>
  )
}

function MiniStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-[var(--muted)]">{label}</p>
      <p className={['mt-1 font-mono text-[17px] tracking-[-0.04em]', accent ? 'text-[var(--accent)]' : 'text-[var(--ink)]'].join(' ')}>{value}</p>
    </div>
  )
}

function Kpi({ icon, label, value, delta, positive = false }: { icon: React.ReactNode; label: string; value: string; delta: string; positive?: boolean }) {
  return (
    <div className="rz-card p-5">
      <div className="flex items-center gap-2 text-[var(--muted)]">
        <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--paper-2)] text-[var(--ink)]">{icon}</span>
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-4 font-mono text-[25px] tracking-[-0.055em]">{value}</p>
      <p className={['mt-1 text-[10px]', positive ? 'text-[#247440]' : 'text-[var(--muted)]'].join(' ')}>{delta}</p>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="h-[72px] w-[320px] animate-pulse rounded-xl bg-[var(--paper-2)]" />
      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card h-[260px] animate-pulse bg-white/60" />
        <div className="rz-card h-[260px] animate-pulse bg-white/60" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="rz-card h-[120px] animate-pulse bg-white/60" />)}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card h-[340px] animate-pulse bg-white/60" />
        <div className="rz-card h-[340px] animate-pulse bg-white/60" />
      </div>
    </div>
  )
}

function OverviewError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rz-card mx-auto mt-16 max-w-[520px] p-8 text-center">
      <p className="text-[11px] font-medium text-[var(--muted)]">Data unavailable</p>
      <h1 className="mt-3 text-[24px] font-semibold tracking-[-0.04em]">Could not load live stats.</h1>
      <p className="mt-2 text-[13px] leading-6 text-[var(--muted)]">
        The dashboard needs a reachable Postgres connection. Check the server logs for the exact error.
      </p>
      <button className="rz-button-primary mt-5" onClick={onRetry}>Try again</button>
    </div>
  )
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n)
}

function BlockedDonut({ total, blocked }: { total: number; blocked: number }) {
  const forwarded = Math.max(total - blocked, 0)
  const pct = total > 0 ? (blocked / total) * 100 : 0
  const data = [
    { name: 'Forwarded', value: forwarded },
    { name: 'Blocked', value: blocked },
  ]

  return (
    <div className="relative size-[124px] shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="68%"
            outerRadius="90%"
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive
            animationDuration={250}
          >
            <Cell fill="var(--ink)" />
            <Cell fill="var(--accent)" />
          </Pie>
          <Tooltip
            contentStyle={{
              background: '#fff',
              border: '1px solid var(--line)',
              borderRadius: 6,
              boxShadow: 'none',
              fontSize: 11,
              padding: '6px 8px',
            }}
            formatter={(value, name) => [Number(value).toLocaleString('en-GB'), String(name)]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[18px] tracking-[-0.04em]">{pct.toFixed(1)}%</span>
        <span className="text-[9px] text-[var(--muted)]">blocked</span>
      </div>
    </div>
  )
}

function QueryChart({ data }: { data: { time: string; total: number; blocked: number }[] }) {
  return (
    <div className="mt-4 h-[220px] w-full" role="img" aria-label="Query volume over the last 24 hours">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rz-query-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ink)" stopOpacity={0.12} />
              <stop offset="100%" stopColor="var(--ink)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="2 5" />
          <XAxis
            dataKey="time"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <Tooltip
            cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
            contentStyle={{
              background: '#fff',
              border: '1px solid var(--line)',
              borderRadius: 6,
              boxShadow: 'none',
              fontSize: 11,
              padding: '6px 8px',
            }}
            labelStyle={{ color: 'var(--muted)', marginBottom: 4 }}
            formatter={(value, name) => [Number(value).toLocaleString('en-GB'), name === 'total' ? 'Forwarded' : 'Blocked']}
          />
          <Area
            type="monotone"
            dataKey="total"
            stroke="var(--ink)"
            strokeWidth={1.5}
            fill="url(#rz-query-area)"
            dot={false}
            isAnimationActive
            animationDuration={250}
          />
          <Area
            type="monotone"
            dataKey="blocked"
            stroke="var(--accent)"
            strokeWidth={1.4}
            fill="transparent"
            dot={false}
            isAnimationActive
            animationDuration={250}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
