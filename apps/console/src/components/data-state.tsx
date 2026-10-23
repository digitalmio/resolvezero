export function PageLoading({ label = "Loading live data…" }: { label?: string }) {
  return (
    <div className="rz-card flex min-h-[280px] items-center justify-center p-8" aria-busy="true">
      <div className="text-center">
        <span className="mx-auto block size-5 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--accent)]" />
        <p className="mt-3 text-[12px] text-[var(--muted)]">{label}</p>
      </div>
    </div>
  )
}

export function PageError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="rz-card mx-auto mt-16 max-w-[520px] p-8 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Data unavailable</p>
      <h1 className="mt-3 text-[22px] font-semibold tracking-[-0.04em]">{title}</h1>
      <p className="mt-2 text-[13px] leading-6 text-[var(--muted)]">
        Check the console server logs for the Postgres or edge error.
      </p>
      <button className="rz-button-primary mt-5" onClick={onRetry}>Try again</button>
    </div>
  )
}
