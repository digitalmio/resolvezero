import { Zap } from 'lucide-react'

import { formatNumber } from './format'

export function LiveTrafficCard({
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

export function PostureCard({
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

export function StatusRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
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

export function MiniStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
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
