import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ExternalLink, Layers3, Plus, RefreshCw } from 'lucide-react'
import { getBlocklistsData } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'

export const Route = createFileRoute('/blocklists')({ component: Blocklists })

function Blocklists() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['blocklists'],
    queryFn: () => getBlocklistsData(),
  })

  if (isPending) return <PageLoading label="Loading blocklists…" />
  if (isError || !data) return <PageError title="Could not load blocklists." onRetry={() => void refetch()} />

  const totalEntries = data.lists.reduce((sum, list) => sum + list.entries, 0)
  const healthy = data.lists.filter((list) => list.enabled && list.lastStatus === 'ok').length

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Policy</p>
          <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Blocklists</h1>
          <p className="mt-2 text-[13px] text-[var(--muted)]">
            {data.profileName} · public lists and sync health across the edge fleet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="rz-button-secondary" onClick={() => void refetch()}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button className="rz-button-primary"><Plus size={14} /> Add list</button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Subscriptions" value={String(data.lists.length)} detail="Unique source URLs" />
        <Stat label="Compiled entries" value={new Intl.NumberFormat('en-GB').format(totalEntries)} detail="Across all lists" />
        <Stat label="Healthy" value={`${healthy}/${data.lists.length}`} detail="Last sync status" />
      </div>

      <div className="rz-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--line)] p-4 text-[11px] text-[var(--muted)]">
          <Layers3 size={14} /> Parsed once per URL and shared across profiles on each edge.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Format</th>
                <th className="px-4 py-3 font-medium">Entries</th>
                <th className="px-4 py-3 font-medium">Last sync</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {data.lists.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-12 text-center text-[12px] text-[var(--muted)]">No blocklists subscribed.</td></tr>
              ) : null}
              {data.lists.map((list) => (
                <tr key={list.id} className="hover:bg-white/60">
                  <td className="max-w-[430px] px-5 py-4">
                    <a href={list.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 truncate font-mono text-[12px] hover:underline">
                      <span className="truncate">{list.url}</span>
                      <ExternalLink size={11} className="shrink-0 text-[var(--muted)]" />
                    </a>
                  </td>
                  <td className="px-4 py-4 text-[11px] uppercase text-[var(--muted)]">{list.format}</td>
                  <td className="px-4 py-4 font-mono text-[12px]">{new Intl.NumberFormat('en-GB').format(list.entries)}</td>
                  <td className="px-4 py-4 font-mono text-[10px] text-[var(--muted)]">{list.lastSyncedAt ? new Date(list.lastSyncedAt).toLocaleString('en-GB') : 'never'}</td>
                  <td className="px-4 py-4">
                    <span className={['inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium', list.lastStatus === 'ok' ? 'bg-[#edf8f0] text-[#247440]' : 'bg-[#fff4ef] text-[#a64b22]'].join(' ')}>
                      {list.lastStatus === 'ok' ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                      {list.lastStatus ?? (list.enabled ? 'pending' : 'disabled')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rz-card p-5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</p>
      <p className="mt-2 font-mono text-[24px] tracking-[-0.05em]">{value}</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">{detail}</p>
    </div>
  )
}
