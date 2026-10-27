import type { ReactNode } from 'react'

export function PageHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
  meta,
}: {
  eyebrow?: string
  title: string
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0">
        {eyebrow ? <p className="rz-eyebrow mb-2.5">{eyebrow}</p> : null}
        <div className="flex items-center gap-3">
          {icon ? <span className="rz-page-icon">{icon}</span> : null}
          <h1 className="rz-page-title">{title}</h1>
        </div>
        {description ? <p className="mt-2 max-w-2xl text-[13px] leading-6 text-[var(--muted)]">{description}</p> : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
