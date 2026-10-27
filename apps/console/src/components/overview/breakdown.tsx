import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Ban, House, Monitor, Router } from 'lucide-react'

export function TopBlockedCard({ items }: { items: { domain: string; label: string; count: string; share: number }[] }) {
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

export function DevicesCard({
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

export function LocalDnsCard({ count }: { count: number }) {
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
