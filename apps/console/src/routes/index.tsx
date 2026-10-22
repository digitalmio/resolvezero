import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getOverview } from '../server/dashboard'
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CircleCheck,
  Clock3,
  Globe2,
  Monitor,
  MoreHorizontal,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react'

export const Route = createFileRoute('/')({ component: Overview })

const DEMO_QUERY = [38, 44, 41, 52, 49, 57, 54, 63, 58, 66, 61, 69, 65, 74, 70, 77, 72, 80, 75, 83, 79, 86, 82, 88]
const DEMO_BLOCKED = [10, 12, 9, 15, 13, 17, 14, 19, 16, 20, 18, 22, 19, 24, 21, 26, 22, 27, 24, 29, 26, 30, 27, 32]

const demoTopBlocked = [
  { domain: 'doubleclick.net', count: '2,418', share: 82 },
  { domain: 'googletagmanager.com', count: '1,204', share: 61 },
  { domain: 'facebook.net', count: '978', share: 49 },
  { domain: 'scorecardresearch.com', count: '642', share: 32 },
  { domain: 'adservice.google.com', count: '511', share: 26 },
]

const demoDevices = [
  { name: 'MacBook Pro', detail: 'DoH · macbook', queries: '18.2k', status: 'online' },
  { name: 'iPhone 16 Pro', detail: 'DoH · iphone', queries: '12.6k', status: 'online' },
  { name: 'Living room router', detail: 'UDP · 82.14.22.8', queries: '9.8k', status: 'online' },
  { name: 'Unknown device', detail: 'UDP · 82.14.22.8', queries: '2.2k', status: 'unknown' },
]

const changes = [
  { time: '2 min ago', title: 'Blocklist synced', detail: 'KADhosts · 39,885 entries' },
  { time: '18 min ago', title: 'Rule added', detail: 'allow analytics.resolvezero.com' },
  { time: '1h ago', title: 'Config rolled out', detail: 'fra + lhr · version 59' },
]

function Overview() {
  const { data, isError } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  const isPreview = !data
  const querySeries = data?.series.map((p) => p.total) ?? DEMO_QUERY
  const blockedSeries = data?.series.map((p) => p.blocked) ?? DEMO_BLOCKED
  const topBlocked = data?.topBlocked.length
    ? (() => {
        const max = Math.max(...data.topBlocked.map((d) => d.count), 1)
        return data.topBlocked.map((d) => ({ domain: d.domain, count: formatNumber(d.count), share: Math.round((d.count / max) * 100) }))
      })()
    : demoTopBlocked
  const devices = data?.topDevices.length
    ? data.topDevices.map((d, index) => ({
        name: d.device,
        detail: 'DoH device tag',
        queries: formatNumber(d.count),
        status: index < 4 ? 'online' : 'unknown',
      }))
    : demoDevices
  const totalQueries = data?.totalQueries ?? 42_861
  const blocked = data?.blocked ?? 7_804
  const activeDevices = data?.activeDevices ?? 14

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
            <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="text-[30px] font-semibold tracking-[-0.045em] sm:text-[36px]">Good evening, Maciej.</h1>
          <p className="mt-2 flex items-center gap-2 text-[13px] text-[var(--muted)]">
            {data ? `${data.profileName} · live from Postgres` : 'Your network is quiet. Everything that matters is protected.'}
            {isPreview ? <span className="rounded-md border border-[#e7c6b8] bg-[#fff4ef] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#a64b22]">Preview</span> : null}
          </p>
          {isError ? <p className="mt-2 text-[11px] text-[#a64b22]">No live data source — preview values shown. Set DATABASE_URL to load Postgres rollups.</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <button className="rz-button-secondary">View public status</button>
          <button className="rz-button-primary">
            <Sparkles size={14} />
            Add device
          </button>
        </div>
      </div>

      <section className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card relative overflow-hidden p-6 sm:p-7">
          <div className="pointer-events-none absolute -right-20 -top-28 size-72 rounded-full bg-[radial-gradient(circle,rgba(255,90,31,.14),transparent_68%)]" />
          <div className="relative flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-2xl bg-[#fff0e9] text-[var(--accent)]">
                  <ShieldCheck size={23} strokeWidth={1.8} />
                </span>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Network posture</p>
                  <p className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">Protected</p>
                </div>
              </div>
              <p className="mt-5 max-w-[430px] text-[13px] leading-6 text-[var(--muted)]">
                All resolvers are responding. Your rules are synced across <span className="font-mono text-[var(--ink)]">fra</span> and{' '}
                <span className="font-mono text-[var(--ink)]">lhr</span>. No action is required.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 md:min-w-[210px]">
              <MiniStat label="Uptime" value="99.99%" />
              <MiniStat label="Active rules" value="42" />
              <MiniStat label="Last sync" value="4s" accent />
              <MiniStat label="Region" value="EU" />
            </div>
          </div>
          <div className="relative mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--line)] pt-4 text-[11px] text-[var(--muted)]">
            <span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-[#2e9b55]" /> UDP + TCP 53 healthy</span>
            <span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-[#2e9b55]" /> DoH healthy</span>
            <span className="flex items-center gap-2"><CircleCheck size={12} /> Config v59</span>
          </div>
        </div>

        <div className="rz-card flex flex-col justify-between p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Live traffic</p>
              <p className="mt-2 font-mono text-[34px] font-medium tracking-[-0.06em]">1,284<span className="ml-2 font-sans text-[12px] tracking-normal text-[var(--muted)]">qps</span></p>
            </div>
            <span className="flex items-center gap-1.5 rounded-full bg-[#edf8f0] px-2.5 py-1 text-[11px] font-medium text-[#247440]">
              <ArrowUpRight size={12} /> 8.4%
            </span>
          </div>
          <div className="mt-6 space-y-4">
            <div>
              <div className="mb-2 flex justify-between text-[11px] text-[var(--muted)]"><span>Forwarded</span><span className="font-mono text-[var(--ink)]">1,049</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--paper-2)]"><div className="h-full w-[82%] rounded-full bg-[var(--ink)]" /></div>
            </div>
            <div>
              <div className="mb-2 flex justify-between text-[11px] text-[var(--muted)]"><span>Blocked</span><span className="font-mono text-[var(--ink)]">235</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--paper-2)]"><div className="h-full w-[18%] rounded-full bg-[var(--accent)]" /></div>
            </div>
          </div>
          <div className="mt-6 flex items-center gap-2 border-t border-[var(--line)] pt-4 text-[11px] text-[var(--muted)]">
            <Zap size={12} className="text-[var(--accent)]" />
            Cache hit rate <span className="font-mono text-[var(--ink)]">98.6%</span>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Globe2 size={16} />} label="Queries today" value={formatNumber(totalQueries)} delta={data ? 'last 24h' : '+12.4%'} positive />
        <Kpi icon={<Ban size={16} />} label="Blocked" value={formatNumber(blocked)} delta={`${((data?.blockRatio ?? 0.182) * 100).toFixed(1)}% of total`} />
        <Kpi icon={<Clock3 size={16} />} label="Avg upstream" value={data?.avgRttMs != null ? `${data.avgRttMs} ms` : '21 ms'} delta="forwarded queries" positive />
        <Kpi icon={<Monitor size={16} />} label="Active devices" value={String(activeDevices)} delta={data ? 'DoH tags in window' : '2 new this week'} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Query volume</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Forwarded vs blocked over the last 24 hours</p>
            </div>
            <div className="flex items-center rounded-lg border border-[var(--line)] bg-[var(--paper)] p-0.5 text-[11px]">
              <button className="rounded-md bg-white px-2.5 py-1.5 font-medium shadow-sm">24h</button>
              <button className="px-2.5 py-1.5 text-[var(--muted)]">7d</button>
              <button className="px-2.5 py-1.5 text-[var(--muted)]">30d</button>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-5 text-[11px] text-[var(--muted)]">
            <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--ink)]" /> Forwarded</span>
            <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--accent)]" /> Blocked</span>
          </div>
          <QueryChart querySeries={querySeries} blockedSeries={blockedSeries} />
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
            <button className="text-[var(--muted)]"><MoreHorizontal size={17} /></button>
          </div>
          <div className="mt-5 space-y-4">
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
          <button className="mt-6 flex items-center gap-1 text-[11px] font-medium text-[var(--ink)]">
            Open query log <ArrowUpRight size={12} />
          </button>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex items-start justify-between p-6 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Devices</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Most active on this profile</p>
            </div>
            <button className="rz-button-secondary !py-1.5 !text-[11px]">Manage</button>
          </div>
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {devices.map((device) => (
              <div key={device.name} className="flex items-center gap-3 px-6 py-3.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--paper-2)] text-[var(--muted)]">
                  <Monitor size={14} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium">{device.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">{device.detail}</p>
                </div>
                <span className={['ml-auto font-mono text-[11px]', device.status === 'online' ? 'text-[var(--ink)]' : 'text-[var(--muted)]'].join(' ')}>{device.queries}</span>
                <span className={['size-1.5 rounded-full', device.status === 'online' ? 'bg-[#2e9b55]' : 'bg-[#c8a24a]'].join(' ')} />
              </div>
            ))}
          </div>
        </div>

        <div className="rz-card p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Recent changes</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Config is up to date across all regions</p>
            </div>
            <span className="flex items-center gap-1.5 rounded-full bg-[#edf8f0] px-2.5 py-1 text-[10px] font-medium text-[#247440]">
              <ArrowDownRight size={11} /> 0 pending
            </span>
          </div>
          <div className="mt-5 space-y-0">
            {changes.map((change, index) => (
              <div key={change.title} className="relative flex gap-3 pb-5 last:pb-0">
                {index < changes.length - 1 ? <span className="absolute left-[5px] top-3 h-full w-px bg-[var(--line)]" /> : null}
                <span className="relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-[var(--paper)] bg-[var(--ink)] ring-1 ring-[var(--line)]" />
                <div className="min-w-0">
                  <p className="text-[12px] font-medium">{change.title}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">{change.detail}</p>
                  <p className="mt-1 text-[10px] text-[var(--muted)]">{change.time}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function MiniStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.13em] text-[var(--muted)]">{label}</p>
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

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n)
}

function QueryChart({ querySeries, blockedSeries }: { querySeries: number[]; blockedSeries: number[] }) {
  const width = 760
  const height = 220
  const padX = 4
  const padY = 14
  const max = Math.max(...querySeries, 1)
  const toPoints = (values: number[]) =>
    values.map((value, index) => {
      const x = padX + (index / (values.length - 1)) * (width - padX * 2)
      const y = height - padY - (value / max) * (height - padY * 2)
      return [x, y] as const
    })
  const toPath = (points: readonly (readonly [number, number])[]) =>
    points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const queryPoints = toPoints(querySeries)
  const blockedPoints = toPoints(blockedSeries)
  const area = `${toPath(queryPoints)} L ${width - padX} ${height - padY} L ${padX} ${height - padY} Z`

  return (
    <div className="mt-4 h-[220px] w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full overflow-visible" role="img" aria-label="Query volume over the last 24 hours">
        <defs>
          <linearGradient id="rz-query-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
          <line key={fraction} x1="0" x2={width} y1={height * fraction} y2={height * fraction} stroke="var(--line)" strokeDasharray="2 5" strokeWidth="1" />
        ))}
        <path d={area} fill="url(#rz-query-area)" />
        <path d={toPath(queryPoints)} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d={toPath(blockedPoints)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 4" />
      </svg>
    </div>
  )
}
