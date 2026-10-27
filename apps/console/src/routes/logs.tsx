import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { format, formatISO, parseISO } from 'date-fns'
import { FileText, Search } from 'lucide-react'
import { useState } from 'react'
import { getLogsData } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'

export const Route = createFileRoute('/logs')({ component: Logs })

const REGION_NAMES: Record<string, string> = {
  fra: 'Frankfurt',
  lhr: 'London',
  iad: 'Ashburn',
  sjc: 'San José',
  nrt: 'Tokyo',
  syd: 'Sydney',
  gru: 'São Paulo',
}

function reasonLabel(entry: { reason: string | null; listLabel: string | null }): string {
  if (entry.reason === 'manual') return 'Manual rule'
  if (entry.reason === 'blocklist') return entry.listLabel ?? 'Blocklist'
  if (entry.reason === 'zone') return 'Local zone'
  return '—'
}

function popDetail(entry: { region: string | null; transport: string | null; upstream: string | null }): string {
  const parts = [
    entry.region ? (REGION_NAMES[entry.region] ?? entry.region) : 'Unknown POP',
    entry.transport ? entry.transport.toUpperCase() : null,
    entry.upstream ? `upstream: ${entry.upstream}` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

function Logs() {
  const [search, setSearch] = useState('')
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['logs'],
    queryFn: () => getLogsData(),
  })

  if (isPending) return <PageLoading label="Loading recent queries…" />
  if (isError || !data) return <PageError title="Could not load query logs." onRetry={() => void refetch()} />

  const profileLabel = data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1)
  const filtered = data.entries.filter((entry) =>
    search.trim() ? entry.domain.toLowerCase().includes(search.toLowerCase()) : true,
  )

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Network activity"
        title="Query log"
        description={`${profileLabel} · latest 100 archived queries · 1-minute flush`}
      />

      <div className="rz-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--line)] bg-[var(--paper)]/50 px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-[11px] text-[var(--muted)]">
            <Search size={13} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by domain"
              className="w-full bg-transparent text-[11px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
          </div>
          <span className="text-[10px] text-[var(--muted)]">{filtered.length} entries</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] text-[10px] font-medium text-[var(--muted)]">
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Domain</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Reason</th>
                <th className="px-4 py-2.5 font-medium">POP</th>
                <th className="px-4 py-2.5 font-medium">Client IP</th>
                <th className="px-4 py-2.5 font-medium">RTT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {filtered.length === 0 ? <tr><td colSpan={7} className="px-5 py-12 text-center text-[12px] text-[var(--muted)]">No log entries found.</td></tr> : null}
              {filtered.map((entry, index) => (
                <tr key={`${entry.time}-${entry.domain}-${index}`} className="hover:bg-[var(--paper)]/60">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]" title={entry.time ? formatISO(parseISO(entry.time)) : undefined}>
                    {entry.time ? format(parseISO(entry.time), 'dd MMM, HH:mm:ss') : '—'}
                  </td>
                  <td className="max-w-[360px] truncate px-4 py-2.5 font-mono text-[11px]">{entry.domain}</td>
                  <td className="px-4 py-2.5">
                    <span className={['inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]', entry.action === 'block' ? 'text-[var(--danger)]' : 'text-[var(--green)]'].join(' ')}>
                      <span className={['size-1.5 rounded-full', entry.action === 'block' ? 'bg-[var(--accent)]' : 'bg-[var(--green)]'].join(' ')} />
                      {entry.action}
                    </span>
                  </td>
                  <td className="max-w-[260px] truncate px-4 py-2.5 text-[11px] text-[var(--muted)]" title={entry.listLabel ?? undefined}>
                    {reasonLabel(entry)}
                  </td>
                  <td
                    className="px-4 py-2.5 font-mono text-[10px] uppercase text-[var(--muted)]"
                    title={popDetail(entry)}
                  >
                    {entry.region ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]">{entry.clientIp ?? '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]">{entry.rttMs != null ? `${entry.rttMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-2.5 text-[10px] text-[var(--muted)]">
          <FileText size={12} /> Archived on the edge; older objects remain in S3.
        </div>
      </div>
    </div>
  )
}
