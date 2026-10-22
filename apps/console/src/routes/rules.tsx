import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getRulesData } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'
import { Ban, Check, Filter, MoreHorizontal, Network, Plus, Search } from 'lucide-react'

export const Route = createFileRoute('/rules')({ component: Rules })

function Rules() {
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['rules'], queryFn: () => getRulesData() })
  if (isPending) return <PageLoading label="Loading rules…" />
  if (isError || !data) return <PageError title="Could not load rules." onRetry={() => void refetch()} />

  const rules = data.rules
  const tabs = [
    { label: 'Block', count: data.counts.block },
    { label: 'Allow', count: data.counts.allow },
    { label: 'Zones', count: data.counts.zones },
    { label: 'Blocklists', count: data.counts.lists },
  ]
  const blockCount = data.counts.block
  const allowCount = data.counts.allow
  const zoneCount = data.counts.zones

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Policy</p>
          <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Rules</h1>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Block, allow, and override names. Changes reach every edge in seconds.</p>
        </div>
        <button className="rz-button-primary">
          <Plus size={14} />
          Add rule
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)]">
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            className={[
              'relative flex items-center gap-2 px-3 py-3 text-[12px] font-medium transition-colors',
              index === 0 ? 'text-[var(--ink)]' : 'text-[var(--muted)] hover:text-[var(--ink)]',
            ].join(' ')}
          >
            {tab.label}
            <span className="rounded-md bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">{tab.count}</span>
            {index === 0 ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--accent)]" /> : null}
          </button>
        ))}
      </div>

      <div className="rz-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--line)] p-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--muted)]">
            <Search size={14} />
            <span>Search rules and domains</span>
          </div>
          <button className="rz-button-secondary !py-2">
            <Filter size={13} />
            Filter
          </button>
          <button className="rz-button-secondary !py-2">
            <Network size={13} />
            Import
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Scope</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Updated</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {rules.length === 0 ? <tr><td colSpan={6} className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">No rules yet.</td></tr> : null}
              {rules.map((rule) => (
                <tr key={`${rule.domain}-${rule.action}`} className="group hover:bg-white/60">
                  <td className="px-5 py-3.5 font-mono text-[12px]">{rule.domain}</td>
                  <td className="px-4 py-3.5"><ActionPill action={rule.action} /></td>
                  <td className="px-4 py-3.5 text-[11px] text-[var(--muted)]">{rule.scope}</td>
                  <td className="px-4 py-3.5 text-[11px] text-[var(--muted)]">{rule.source}</td>
                  <td className="px-4 py-3.5 font-mono text-[10px] text-[var(--muted)]">{rule.updated}</td>
                  <td className="px-4 py-3.5 text-right text-[var(--muted)]"><MoreHorizontal size={16} className="ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)]">
          <span>{rules.length} rules</span>
          <span className="font-mono">synced · v59</span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Summary icon={<Ban size={15} />} label="Block rules" value={String(blockCount)} detail="explicit + list-driven" />
        <Summary icon={<Check size={15} />} label="Allow rules" value={String(allowCount)} detail="Allow wins over blocklists" />
        <Summary icon={<Network size={15} />} label="Zone records" value={String(zoneCount)} detail="Local overrides" />
      </div>
    </div>
  )
}

function ActionPill({ action }: { action: string }) {
  const style =
    action === 'block'
      ? 'bg-[#fff0e9] text-[#c64012] ring-[#ffd9ca]'
      : action === 'allow'
        ? 'bg-[#edf8f0] text-[#247440] ring-[#cfe6d7]'
        : 'bg-[#eef2ff] text-[#3552a5] ring-[#dbe3ff]'
  return <span className={`inline-flex items-center rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1 ${style}`}>{action}</span>
}

function Summary({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="rz-card flex items-center gap-3 p-4">
      <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--paper-2)] text-[var(--ink)]">{icon}</span>
      <div>
        <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</p>
        <p className="mt-0.5 text-[16px] font-semibold">{value}</p>
        <p className="mt-0.5 text-[10px] text-[var(--muted)]">{detail}</p>
      </div>
    </div>
  )
}
