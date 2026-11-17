import { type ReactNode } from 'react'

export function PulseMetric({
  index,
  icon,
  label,
  value,
  delta,
  positive = false,
}: {
  index: string
  icon: ReactNode
  label: string
  value: string
  delta: string
  positive?: boolean
}) {
  return (
    <div className="px-5 py-6">
      <div className="flex items-center justify-between">
        <span className="bg-[var(--ink)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--signal)]">{index}</span>
        <span className="text-[var(--brand)]">{icon}</span>
      </div>
      <p className="mt-5 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</p>
      <p className="mt-2 rz-font-display text-[2rem] font-semibold leading-none tracking-[-0.04em]">{value}</p>
      <p className={['mt-2 font-mono text-[9px] uppercase tracking-[0.08em]', positive ? 'text-[var(--green)]' : 'text-[var(--muted)]'].join(' ')}>
        {delta}
      </p>
    </div>
  )
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-7" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <div className="rz-card h-[380px] animate-pulse bg-[var(--card)]/60" />
        <div className="flex flex-col gap-4">
          <div className="rz-card h-[180px] animate-pulse bg-[var(--card)]/60" />
          <div className="rz-card h-[180px] animate-pulse bg-[var(--card)]/60" />
        </div>
      </div>
      <div className="h-[128px] animate-pulse border-y border-[var(--line)] bg-[var(--paper-2)]" />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr_0.9fr]">
        <div className="rz-card h-[280px] animate-pulse bg-[var(--card)]/60" />
        <div className="rz-card h-[280px] animate-pulse bg-[var(--card)]/60" />
        <div className="rz-card h-[280px] animate-pulse bg-[var(--card)]/60" />
      </div>
    </div>
  )
}
