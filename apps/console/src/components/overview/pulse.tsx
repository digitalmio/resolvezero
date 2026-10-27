import { type ReactNode } from 'react'

export function PulseMetric({
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

export function OverviewSkeleton() {
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
