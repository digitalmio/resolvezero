import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { format, getHours, parseISO } from 'date-fns'
import { useEffect, useState } from 'react'
import { Ban, Clock3, FileText, Globe2, Monitor, ShieldCheck } from 'lucide-react'

import { PageError } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { DevicesCard, LocalDnsCard, TopBlockedCard } from '../components/overview/breakdown'
import { ageLabel, displayDomain, formatNumber, greetingForHour, regionLabel } from '../components/overview/format'
import { OverviewSkeleton, PulseMetric } from '../components/overview/pulse'
import { QueryChart } from '../components/overview/query-chart'
import { LiveTrafficCard, PostureCard } from '../components/overview/traffic'
import { getOverview } from '../server/dashboard'

export const Route = createFileRoute('/')({ component: Overview })

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
          eyebrow={`01 / Network · ${profileLabel} profile`}
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
        <div className="rz-card flex flex-col border-t-2 border-t-[var(--brand)] p-5 xl:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="rz-section-title">Query volume</h2>
              <p className="mt-1.5 text-[11px] text-[var(--muted)]">Total vs blocked queries over the last 24 hours</p>
            </div>
            <span className="rz-pill">Last 24 hours</span>
          </div>
          <div className="mt-4 flex items-center gap-5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
            <span className="flex items-center gap-2">
              <span className="size-1.5 bg-[var(--ink)]" /> Queries
            </span>
            <span className="flex items-center gap-2">
              <span className="size-1.5 bg-[var(--accent)]" /> Blocked
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

      <section className="grid grid-cols-2 divide-y divide-[var(--line)] border-y border-[var(--line)] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <PulseMetric index="01" icon={<Globe2 size={15} />} label="Queries / 24h" value={formatNumber(totalQueries)} delta="last 24 hours" />
        <PulseMetric
          index="02"
          icon={<Ban size={15} />}
          label="Blocked"
          value={formatNumber(blocked)}
          delta={`${(data.blockRatio * 100).toFixed(1)}% of total`}
        />
        <PulseMetric
          index="03"
          icon={<Clock3 size={15} />}
          label="Avg upstream"
          value={data.avgRttMs != null ? `${data.avgRttMs} ms` : '—'}
          delta="upstream queries"
          positive
        />
        <PulseMetric
          index="04"
          icon={<Monitor size={15} />}
          label="Active sources"
          value={String(activeSources)}
          delta="client IPs / DoH tags"
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <TopBlockedCard items={topBlocked} />
        <DevicesCard devices={devices} clients={clients} />
        <LocalDnsCard count={data.zoneCount} />
      </section>
    </div>
  )
}
