import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Download, FileText, Search } from 'lucide-react'
import { useState } from 'react'
import { getLogsData } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'

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

  const filtered = data.entries.filter((entry) =>
    search.trim() ? entry.domain.toLowerCase().includes(search.toLowerCase()) : true,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Observability</p>
          <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Query log</h1>
          <p className="mt-2 text-[13px] text-[var(--muted)]">{data.profileName} · latest 100 entries streamed from the edge archive.</p>
        </div>
        <button className="rz-button-secondary"><Download size={13} /> Export</button>
      </div>

      <div className="rz-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--line)] p-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--muted)]">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by domain"
              className="w-full bg-transparent text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
          </div>
          <span className="text-[11px] text-[var(--muted)]">{filtered.length} entries</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">POP</th>
                <th className="px-4 py-3 font-medium">Client IP</th>
                <th className="px-4 py-3 font-medium">RTT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {filtered.length === 0 ? <tr><td colSpan={7} className="px-5 py-12 text-center text-[12px] text-[var(--muted)]">No log entries found.</td></tr> : null}
              {filtered.map((entry, index) => (
                <tr key={`${entry.time}-${entry.domain}-${index}`} className="hover:bg-white/60">
                  <td className="px-5 py-3.5 font-mono text-[10px] text-[var(--muted)]" title={entry.time ? new Date(entry.time).toISOString() : undefined}>
                    {entry.time
                      ? new Date(entry.time).toLocaleString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })
                      : '—'}
                  </td>
                  <td className="max-w-[360px] truncate px-4 py-3.5 font-mono text-[12px]">{entry.domain}</td>
                  <td className="px-4 py-3.5">
                    <span className={['rounded-md px-2 py-1 text-[10px] font-semibold uppercase', entry.action === 'block' ? 'bg-[#fff0e9] text-[#c64012]' : 'bg-[#edf8f0] text-[#247440]'].join(' ')}>{entry.action}</span>
                  </td>
                  <td className="max-w-[260px] truncate px-4 py-3.5 text-[11px] text-[var(--muted)]" title={entry.listLabel ?? undefined}>
                    {reasonLabel(entry)}
                  </td>
                  <td
                    className="px-4 py-3.5 font-mono text-[10px] uppercase text-[var(--muted)]"
                    title={popDetail(entry)}
                  >
                    {entry.region ?? '—'}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-[10px] text-[var(--muted)]">{entry.clientIp ?? '—'}</td>
                  <td className="px-4 py-3.5 font-mono text-[10px] text-[var(--muted)]">{entry.rttMs != null ? `${entry.rttMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--line)] px-5 py-3 text-[10px] text-[var(--muted)]">
          <FileText size={12} /> Archive objects are streamed on demand; older data remains in S3.
        </div>
      </div>
    </div>
  )
}
