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
    <div className="flex flex-1 flex-col border border-[var(--ink)] bg-[var(--ink)] p-5 text-[var(--sidebar-text)]">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--sidebar-text)]">Traffic</h2>
          <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--sidebar-muted)]">
            Rolling 24-hour window
          </p>
        </div>
        <Zap size={16} className="text-[var(--signal)]" />
      </div>
      <p className="mt-5 rz-font-display text-[2.75rem] font-semibold leading-none tracking-[-0.05em]">
        {formatNumber(totalQueries)}
        <span className="ml-2 font-mono text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--sidebar-muted)]">
          queries / 24h
        </span>
      </p>
      <div className="mt-5">
        <div className="flex h-1.5 overflow-hidden bg-white/10">
          <div
            className="ml-auto h-full bg-[var(--signal)]"
            style={{ width: `${totalQueries > 0 ? (blocked / totalQueries) * 100 : 0}%` }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.08em]">
          <span className="flex items-center gap-1.5 text-[var(--sidebar-muted)]">
            Avg
            <span className="text-[var(--sidebar-text)]">{qpsLabel} qps</span>
          </span>
          <span className="flex items-center gap-1.5 text-[var(--sidebar-muted)]">
            <span className="size-1.5 bg-[var(--signal)]" /> Blocked
            <span className="text-[var(--sidebar-text)]">{formatNumber(blocked)}</span>
            <span className="text-white/30">·</span>
            <span className="text-[var(--sidebar-text)]">{(blockRatio * 100).toFixed(1)}%</span>
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
    <div className="rz-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Protection</h2>
          <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted)]">Edge and policy status</p>
        </div>
        <span className={['rz-pill', edge.ok ? 'rz-pill-positive' : 'rz-pill-warning'].join(' ')}>
          <span className={['size-1.5', edge.ok ? 'bg-[var(--green)]' : 'bg-[var(--warning)]'].join(' ')} />
          {edge.ok ? 'Active' : 'Degraded'}
        </span>
      </div>
      <div className="mt-5 space-y-3">
        <StatusRow label="DNS 53" value={edge.dns53Bound ? 'Healthy' : 'Unavailable'} good={edge.dns53Bound} />
        <StatusRow label="Blocklists" value={edge.blocklistsLoaded ? 'Loaded' : 'Unavailable'} good={edge.blocklistsLoaded} />
        <StatusRow label="Config age" value={updateAge} />
        <StatusRow label="Region" value={region} />
        <StatusRow label="Failed lists" value={String(edge.failedBlocklists)} good={edge.failedBlocklists === 0} />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-dashed border-[var(--line)] pt-4">
        <MiniStat label="Custom rules" value={String(ruleCount)} />
        <MiniStat label="Active sources" value={String(activeSources)} />
      </div>
    </div>
  )
}

export function StatusRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted)]">{label}</span>
      <span className="flex items-center gap-1.5">
        {good !== undefined ? (
          <span className={['size-1.5', good ? 'bg-[var(--green)]' : 'bg-[var(--warning)]'].join(' ')} />
        ) : null}
        <span className="rz-mono text-[10px] text-[var(--ink)]">{value}</span>
      </span>
    </div>
  )
}

export function MiniStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--muted)]">{label}</p>
      <p
        className={[
          'mt-1.5 rz-font-display text-[22px] font-semibold tracking-[-0.03em]',
          accent ? 'text-[var(--accent)]' : 'text-[var(--ink)]',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  )
}
