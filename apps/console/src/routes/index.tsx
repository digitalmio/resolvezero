import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { format, getHours, parseISO } from 'date-fns'
import { useEffect, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import {
  ArrowUpRight,
  Ban,
  Clock3,
  FileText,
  Globe2,
  House,
  Monitor,
  Router,
  ShieldCheck,
  Zap,
} from 'lucide-react'

import { PageError } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { getOverview } from '../server/dashboard'

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
  return REGION_NAMES[region] ?? region.toUpperCase()
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

/** Keep the meaningful suffix for long tracker hashes. */
function displayDomain(domain: string): string {
  const [first, ...rest] = domain.split('.')
  if (first && first.length >= 24 && /^[a-f0-9]+$/i.test(first) && rest.length > 2) {
    return `${first.slice(0, 8)}…${rest.slice(-4).join('.')}`
  }
  return domain
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
  if (isError || !data) return <PageError title="Could not load live stats." onRetry={() => void refetch()} />

  const chartData = data.series.map((point) => ({
    time: format(parseISO(point.bucket), 'HH:mm'),
    total: point.total,
    blocked: point.blocked,
  }))
  const maxBlocked = Math.max(...data.topBlocked.map((d) => d.count), 1)
  const topBlocked = data.topBlocked.map((d) => ({
    domain: d.domain,
    label: displayDomain(d.domain),
    count: formatNumber(d.count),
    share: Math.round((d.count / maxBlocked) * 100),
  }))
  const devices = data.topDevices.map((d) => ({
    name: d.device,
    detail: 'DoH device tag',
    queries: formatNumber(d.count),
  }))
  const clients = data.topClients.slice(0, 4).map((c) => ({
    ip: c.clientIp,
    queries: formatNumber(c.count),
  }))
  const totalQueries = data.totalQueries
  const blocked = data.blocked
  const activeSources = Math.max(data.activeDevices, data.topClients.length)
  const qps = totalQueries / 86_400
  const qpsLabel = qps >= 10 ? formatNumber(Math.round(qps)) : qps.toFixed(1)
  const profileLabel = data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1)
  const firstName = data.viewer.name.split(/\s+/)[0] || 'there'
  const region = regionLabel(data.edge.region)
  const updateAge = ageLabel(data.edge.configPollAgeMs)

  return (
    <div className="space-y-7">
      <div className="relative">
        <div aria-hidden="true" className="rz-dot-grid pointer-events-none absolute -inset-x-3 -top-6 h-36 opacity-60" />
        <PageHeader
          eyebrow={`${profileLabel} profile`}
          title="Overview"
          description={`${greeting}, ${firstName}. Here’s how your network is doing over the last 24 hours.`}
          meta={
            <>
              <span className={['rz-pill', data.edge.ok ? 'rz-pill-positive' : 'rz-pill-warning'].join(' ')}>
                <ShieldCheck size={11} />
                {data.edge.ok ? 'Protected' : 'Attention needed'}
              </span>
              <span className="rz-pill">
                <Clock3 size={11} /> Updated {updateAge} ago
              </span>
              <span className="rz-pill">
                <Globe2 size={11} /> {region}
              </span>
            </>
          }
          actions={
            <Link to="/logs" className="rz-button-secondary">
              <FileText size={13} />
              Open query log
            </Link>
          }
        />
      </div>

      <section className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <div className="rz-card flex flex-col p-6 xl:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="rz-section-title">Query volume</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Total vs blocked queries over the last 24 hours</p>
            </div>
            <span className="rz-pill">Last 24 hours</span>
          </div>
          <div className="mt-4 flex items-center gap-5 text-[11px] text-[var(--muted)]">
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[var(--lime)]" /> Queries
            </span>
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-[var(--accent)]" /> Blocked
            </span>
          </div>
          <QueryChart data={chartData} />
        </div>

        <div className="flex flex-col gap-4">
          <LiveTrafficCard qpsLabel={qpsLabel} totalQueries={totalQueries} blocked={blocked} blockRatio={data.blockRatio} />
          <PostureCard
            edge={data.edge}
            updateAge={updateAge}
            region={region}
            ruleCount={data.ruleCount}
            activeSources={activeSources}
          />
        </div>
      </section>

      <section className="rz-card grid grid-cols-2 divide-y divide-[var(--line)] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <PulseMetric icon={<Globe2 size={15} />} label="Queries / 24h" value={formatNumber(totalQueries)} delta="last 24 hours" />
        <PulseMetric
          icon={<Ban size={15} />}
          label="Blocked"
          value={formatNumber(blocked)}
          delta={`${(data.blockRatio * 100).toFixed(1)}% of total`}
        />
        <PulseMetric
          icon={<Clock3 size={15} />}
          label="Avg upstream"
          value={data.avgRttMs != null ? `${data.avgRttMs} ms` : '—'}
          delta="upstream queries"
          positive
        />
        <PulseMetric icon={<Monitor size={15} />} label="Active sources" value={String(activeSources)} delta="client IPs / DoH tags" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <TopBlockedCard items={topBlocked} />
        <DevicesCard devices={devices} clients={clients} />
        <LocalDnsCard count={data.zoneCount} />
      </section>
    </div>
  )
}

function LiveTrafficCard({
  qpsLabel,
  totalQueries,
  blocked,
  blockRatio,
}: {
  qpsLabel: string
  totalQueries: number
  blocked: number
  blockRatio: number
}) {
  return (
    <div className="rz-card flex flex-1 flex-col p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Live traffic</h2>
          <p className="mt-1 text-[12px] text-[var(--muted)]">Rolling 24-hour window</p>
        </div>
        <Zap size={15} className="text-[var(--green)]" />
      </div>
      <p className="mt-4 font-[var(--font-display)] text-[32px] font-semibold tracking-[-0.055em]">
        {qpsLabel}
        <span className="ml-2 font-sans text-[11px] font-medium tracking-normal text-[var(--muted)]">qps avg</span>
      </p>
      <div className="mt-4">
        <div className="flex h-2 overflow-hidden rounded-full bg-[var(--green)]">
          <div
            className="ml-auto h-full bg-[var(--accent)]"
            style={{ width: `${totalQueries > 0 ? (blocked / totalQueries) * 100 : 0}%` }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px]">
          <span className="flex items-center gap-1.5 text-[var(--muted)]">
            <span className="size-1.5 rounded-full bg-[var(--accent)]" /> Blocked
            <span className="rz-mono text-[var(--ink)]">{formatNumber(blocked)}</span>
            <span className="text-[var(--line-strong)]">·</span>
            <span className="rz-mono text-[var(--ink)]">{(blockRatio * 100).toFixed(1)}%</span>
          </span>
          <span className="flex items-center gap-1.5 text-[var(--muted)]">
            Total
            <span className="rz-mono text-[var(--ink)]">{formatNumber(totalQueries)}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

function PostureCard({
  edge,
  updateAge,
  region,
  ruleCount,
  activeSources,
}: {
  edge: {
    ok: boolean
    dns53Bound: boolean
    blocklistsLoaded: boolean
    failedBlocklists: number
  }
  updateAge: string
  region: string
  ruleCount: number
  activeSources: number
}) {
  return (
    <div className="rz-card p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Protection</h2>
          <p className="mt-1 text-[12px] text-[var(--muted)]">Edge and policy status</p>
        </div>
        <span className={['rz-pill', edge.ok ? 'rz-pill-positive' : 'rz-pill-warning'].join(' ')}>
          <span className={['size-1.5 rounded-full', edge.ok ? 'bg-[var(--green)]' : 'bg-[var(--warning)]'].join(' ')} />
          {edge.ok ? 'Active' : 'Degraded'}
        </span>
      </div>
      <div className="mt-4 space-y-2.5">
        <StatusRow label="DNS 53" value={edge.dns53Bound ? 'Healthy' : 'Unavailable'} good={edge.dns53Bound} />
        <StatusRow label="Blocklists" value={edge.blocklistsLoaded ? 'Loaded' : 'Unavailable'} good={edge.blocklistsLoaded} />
        <StatusRow label="Config age" value={updateAge} />
        <StatusRow label="Region" value={region} />
        <StatusRow label="Failed lists" value={String(edge.failedBlocklists)} good={edge.failedBlocklists === 0} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--line)] pt-4">
        <MiniStat label="Custom rules" value={String(ruleCount)} />
        <MiniStat label="Active sources" value={String(activeSources)} />
      </div>
    </div>
  )
}

function TopBlockedCard({ items }: { items: { domain: string; label: string; count: string; share: number }[] }) {
  return (
    <div className="rz-card min-w-0 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Top blocked</h2>
          <p className="mt-1 text-[12px] text-[var(--muted)]">Last 24 hours</p>
        </div>
        <Ban size={15} className="text-[var(--accent)]" />
      </div>
      <div className="mt-5 space-y-3.5">
        {items.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[var(--muted)]">No blocked domains in this window.</p>
        ) : null}
        {items.map((item) => (
          <div key={item.domain}>
            <div className="mb-1.5 flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[11px] text-[var(--ink)]" title={item.domain}>
                {item.label}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-[var(--muted)]">{item.count}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--paper-2)]">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${item.share}%` }} />
            </div>
          </div>
        ))}
      </div>
      <Link
        to="/logs"
        className="mt-5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ink)] hover:text-[var(--green)]"
      >
        Open query log <ArrowUpRight size={12} />
      </Link>
    </div>
  )
}

function DevicesCard({
  devices,
  clients,
}: {
  devices: { name: string; detail: string; queries: string }[]
  clients: { ip: string; queries: string }[]
}) {
  return (
    <div className="rz-card min-w-0 overflow-hidden">
      <div className="flex items-start justify-between p-6 pb-4">
        <div>
          <h2 className="rz-section-title">Devices</h2>
          <p className="mt-1 text-[12px] text-[var(--muted)]">Most active on this profile</p>
        </div>
        <Link to="/devices" className="rz-button-secondary !py-1.5 !text-[11px]">
          Manage
        </Link>
      </div>
      <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
        {devices.length === 0 ? (
          <p className="px-6 py-6 text-center text-[12px] text-[var(--muted)]">No tagged DoH devices in this window.</p>
        ) : null}
        {devices.map((device) => (
          <div key={device.name} className="flex items-center gap-3 px-6 py-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--sage)] text-[var(--muted)]">
              <Monitor size={14} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[12px] font-medium">{device.name}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">{device.detail}</p>
            </div>
            <span className="ml-auto font-mono text-[11px] text-[var(--muted)]">{device.queries}</span>
          </div>
        ))}
        {clients.length > 0 ? (
          <>
            <p className="px-6 pb-1 pt-3 text-[10px] font-medium text-[var(--muted)]">Client IPs</p>
            {clients.map((client) => (
              <div key={client.ip} className="flex items-center gap-3 px-6 py-3">
                <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--paper-2)] text-[var(--muted)]">
                  <Router size={14} />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12px]">{client.ip}</p>
                  <p className="mt-0.5 text-[10px] text-[var(--muted)]">UDP + DoH source</p>
                </div>
                <span className="ml-auto font-mono text-[11px] text-[var(--muted)]">{client.queries}</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  )
}

function LocalDnsCard({ count }: { count: number }) {
  return (
    <div className="rz-card flex min-w-0 flex-col p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Local DNS</h2>
          <p className="mt-1 text-[12px] text-[var(--muted)]">Split-horizon names</p>
        </div>
        <House size={15} className="text-[var(--green)]" />
      </div>
      <p className="mt-5 font-[var(--font-display)] text-[34px] font-semibold tracking-[-0.05em]">
        {count}
        <span className="ml-2 font-sans text-[11px] font-medium tracking-normal text-[var(--muted)]">
          {count === 1 ? 'record' : 'records'}
        </span>
      </p>
      <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">Answer .lan names before blocklists and upstream.</p>
      <Link
        to="/local-dns"
        className="mt-auto inline-flex items-center gap-1 pt-5 text-[11px] font-medium text-[var(--ink)] hover:text-[var(--green)]"
      >
        Manage records <ArrowUpRight size={12} />
      </Link>
    </div>
  )
}

function StatusRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 text-[11px]">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="flex items-center gap-1.5">
        {good !== undefined ? (
          <span className={['size-1.5 rounded-full', good ? 'bg-[var(--green)]' : 'bg-[var(--warning)]'].join(' ')} />
        ) : null}
        <span className="rz-mono text-[var(--ink)]">{value}</span>
      </span>
    </div>
  )
}

function MiniStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-[var(--muted)]">{label}</p>
      <p
        className={[
          'mt-1 font-[var(--font-display)] text-[20px] font-semibold tracking-[-0.04em]',
          accent ? 'text-[var(--accent)]' : 'text-[var(--ink)]',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  )
}

function PulseMetric({
  icon,
  label,
  value,
  delta,
  positive = false,
}: {
  icon: ReactNode
  label: string
  value: string
  delta: string
  positive?: boolean
}) {
  return (
    <div className="px-5 py-5">
      <div className="flex items-center gap-2 text-[var(--muted)]">
        <span className="flex size-7 items-center justify-center rounded-lg bg-[var(--sage)] text-[var(--ink)]">{icon}</span>
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-4 font-[var(--font-display)] text-[26px] font-semibold tracking-[-0.045em]">{value}</p>
      <p className={['mt-1 text-[10px]', positive ? 'text-[var(--green)]' : 'text-[var(--muted)]'].join(' ')}>{delta}</p>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="space-y-7" aria-busy="true" aria-label="Loading dashboard">
      <div className="h-[88px] w-[340px] animate-pulse rounded-xl bg-[var(--paper-2)]" />
      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <div className="rz-card h-[380px] animate-pulse bg-white/60" />
        <div className="flex flex-col gap-4">
          <div className="rz-card h-[180px] animate-pulse bg-white/60" />
          <div className="rz-card h-[180px] animate-pulse bg-white/60" />
        </div>
      </div>
      <div className="rz-card h-[120px] animate-pulse bg-white/60" />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_0.9fr]">
        <div className="rz-card h-[280px] animate-pulse bg-white/60" />
        <div className="rz-card h-[280px] animate-pulse bg-white/60" />
        <div className="rz-card h-[280px] animate-pulse bg-white/60" />
      </div>
    </div>
  )
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n)
}

function QueryChart({ data }: { data: { time: string; total: number; blocked: number }[] }) {
  return (
    <div className="mt-5 min-h-[300px] w-full flex-1" role="img" aria-label="Query volume over the last 24 hours">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rz-query-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--lime)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--lime)" stopOpacity={0} />
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
            itemSorter={(item) => (item.dataKey === 'total' ? 0 : 1)}
            contentStyle={{
              background: '#fff',
              border: '1px solid var(--line)',
              borderRadius: 10,
              boxShadow: '0 8px 24px rgba(26,32,24,0.08)',
              fontSize: 11,
              padding: '4px 6px',
            }}
            labelStyle={{ color: 'var(--muted)', marginBottom: 2, lineHeight: 1.2 }}
            itemStyle={{ padding: 0, lineHeight: 1.3 }}
            formatter={(value, name) => [Number(value).toLocaleString('en-GB'), name === 'total' ? 'Queries' : 'Blocked']}
          />
          <Area
            type="monotone"
            dataKey="total"
            stroke="var(--lime)"
            strokeWidth={1.8}
            fill="url(#rz-query-area)"
            dot={false}
            isAnimationActive
            animationDuration={250}
          />
          <Area
            type="monotone"
            dataKey="blocked"
            stroke="var(--accent)"
            strokeWidth={1.5}
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
