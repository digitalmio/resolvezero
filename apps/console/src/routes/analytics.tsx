import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { getAnalyticsData } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'

export const Route = createFileRoute('/analytics')({ component: Analytics })

type Range = '24h' | '7d' | '30d'

function Analytics() {
  const [range, setRange] = useState<Range>('7d')
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => getAnalyticsData(),
  })

  if (isPending) return <PageLoading label="Loading analytics…" />
  if (isError || !data) return <PageError title="Could not load analytics." onRetry={() => void refetch()} />

  const series = data.series[range]
  const total = series.reduce((sum, point) => sum + point.total, 0)
  const blocked = series.reduce((sum, point) => sum + point.blocked, 0)
  const ratio = total > 0 ? (blocked / total) * 100 : 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Observability</p>
          <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Analytics</h1>
          <p className="mt-2 text-[13px] text-[var(--muted)]">{data.profileName} · long-range rollups from Postgres.</p>
        </div>
        <div className="flex items-center rounded-lg border border-[var(--line)] bg-[var(--paper)] p-0.5 text-[11px]">
          {(['24h', '7d', '30d'] as Range[]).map((value) => (
            <button
              key={value}
              onClick={() => setRange(value)}
              className={['rounded-md px-2.5 py-1.5', range === value ? 'bg-white font-medium shadow-sm' : 'text-[var(--muted)]'].join(' ')}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={`Queries · ${range}`} value={new Intl.NumberFormat('en-GB').format(total)} detail="Rollup total" />
        <Stat label={`Blocked · ${range}`} value={new Intl.NumberFormat('en-GB').format(blocked)} detail={`${ratio.toFixed(1)}% of queries`} />
        <Stat label="30 day total" value={new Intl.NumberFormat('en-GB').format(data.total30d)} detail={`${new Intl.NumberFormat('en-GB').format(data.blocked30d)} blocked`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Query volume</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Forwarded vs blocked · {range}</p>
            </div>
            <BarChart3 size={18} className="text-[var(--muted)]" />
          </div>
          <AnalyticsChart series={series} />
        </div>

        <div className="rz-card p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Top blocked</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Last 30 days</p>
            </div>
            <TrendingUp size={17} className="text-[var(--muted)]" />
          </div>
          <div className="mt-5 space-y-4">
            {data.topBlocked.length === 0 ? <p className="py-8 text-center text-[12px] text-[var(--muted)]">No blocked domains yet.</p> : null}
            {data.topBlocked.map((item) => {
              const max = Math.max(...data.topBlocked.map((d) => d.count), 1)
              return (
                <div key={item.domain}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[12px]">{item.domain}</span>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--muted)]">{new Intl.NumberFormat('en-GB').format(item.count)}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--paper-2)]">
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${(item.count / max) * 100}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function AnalyticsChart({ series }: { series: { label: string; total: number; blocked: number }[] }) {
  const width = 760
  const height = 240
  const padX = 4
  const padY = 16
  const max = Math.max(...series.map((p) => p.total), 1)
  const points = (key: 'total' | 'blocked') =>
    series.map((point, index) => {
      const x = padX + (index / Math.max(series.length - 1, 1)) * (width - padX * 2)
      const y = height - padY - (point[key] / max) * (height - padY * 2)
      return [x, y] as const
    })
  const path = (key: 'total' | 'blocked') =>
    points(key).map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const area = `${path('total')} L ${width - padX} ${height - padY} L ${padX} ${height - padY} Z`

  return (
    <div className="mt-5 h-[240px]">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Query analytics">
        <defs>
          <linearGradient id="rz-analytics-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.2, 0.4, 0.6, 0.8].map((f) => <line key={f} x1="0" x2={width} y1={height * f} y2={height * f} stroke="var(--line)" strokeDasharray="2 5" />)}
        <path d={area} fill="url(#rz-analytics-area)" />
        <path d={path('total')} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path('blocked')} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rz-card p-5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</p>
      <p className="mt-2 font-mono text-[24px] tracking-[-0.05em]">{value}</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">{detail}</p>
    </div>
  )
}
