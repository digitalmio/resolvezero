import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { CheckCircle2, Copy, KeyRound, Network, Settings, ShieldCheck } from 'lucide-react'
import { getSettingsData } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettingsData(),
  })

  if (isPending) return <PageLoading label="Loading settings…" />
  if (isError || !data) return <PageError title="Could not load settings." onRetry={() => void refetch()} />

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Account</p>
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white text-[var(--accent)] ring-1 ring-[var(--line)]"><Settings size={20} /></span>
          <div>
            <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Settings</h1>
            <p className="mt-1 text-[13px] text-[var(--muted)]">{data.profileName} · profile and resolver configuration.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Profile" icon={<ShieldCheck size={16} />}>
          <Row label="Name" value={data.profileName} />
          <Row label="Profile ID" value={data.profileId} mono />
          <Row label="Created" value={format(parseISO(data.createdAt), 'dd MMM yyyy')} />
          <Row label="DoH token" value={data.hasDohToken ? 'configured' : 'not set'} />
        </Section>

        <Section title="Upstream" icon={<Network size={16} />}>
          <Row label="Preset" value={data.upstream ?? 'edge default'} />
          <Row label="Custom URL" value={data.upstreamUrl ?? '—'} mono />
          <Row label="Log queries" value={data.logQueries ? 'enabled' : 'disabled'} />
          <Row label="Log retention" value={`${data.logRetentionDays} days`} />
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--line)] p-5">
            <Network size={16} className="text-[var(--muted)]" />
            <div>
              <h2 className="text-[14px] font-semibold">Linked source IPs</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">UDP clients authorized for this profile.</p>
            </div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {data.sourceIps.length === 0 ? <p className="p-6 text-center text-[12px] text-[var(--muted)]">No linked IPs.</p> : null}
            {data.sourceIps.map((ip) => (
              <div key={ip} className="flex items-center gap-3 px-5 py-3.5">
                <CheckCircle2 size={14} className="text-[#2e9b55]" />
                <span className="font-mono text-[12px]">{ip}</span>
                <span className="ml-auto text-[10px] text-[var(--muted)]">linked</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rz-card p-5">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-[var(--muted)]" />
            <h2 className="text-[14px] font-semibold">Capacity</h2>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <Metric label="Rules" value={data.counts.rules} />
            <Metric label="Zones" value={data.counts.zones} />
            <Metric label="Lists" value={data.counts.lists} />
          </div>
          <p className="mt-5 flex items-center gap-2 text-[11px] text-[var(--muted)]">
            <Copy size={12} /> API key management lands with the public API.
          </p>
        </div>
      </div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rz-card p-5">
      <div className="mb-4 flex items-center gap-2"><span className="text-[var(--muted)]">{icon}</span><h2 className="text-[14px] font-semibold">{title}</h2></div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pb-3 last:border-0 last:pb-0">
      <span className="text-[11px] text-[var(--muted)]">{label}</span>
      <span className={['text-right text-[11px]', mono ? 'max-w-[260px] truncate font-mono' : ''].join(' ')}>{value}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-[var(--paper)] p-3">
      <p className="text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</p>
      <p className="mt-1 font-mono text-[20px] tracking-[-0.04em]">{value}</p>
    </div>
  )
}
