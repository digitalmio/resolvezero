import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getOverview } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'
import { Info, Monitor, Plus, Router, Search, Smartphone } from 'lucide-react'

export const Route = createFileRoute('/devices')({ component: Devices })

function Devices() {
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  if (isPending) return <PageLoading label="Loading devices…" />
  if (isError || !data) return <PageError title="Could not load devices." onRetry={() => void refetch()} />

  const dohDevices = data.topDevices.map((d, index) => ({ name: d.device, tag: d.device, queries: String(d.count), lastSeen: 'last 24h', kind: 'DoH', status: index < 4 ? 'online' : 'unknown' }))
  const udpSources = data.topClients.map((c, index) => ({ name: index === 0 ? 'Primary source' : 'Source IP', ip: c.clientIp, queries: String(c.count), lastSeen: 'last 24h', kind: 'UDP' }))

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Network</p>
          <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Devices</h1>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Know what is talking to your resolver, and how much.</p>
        </div>
        <button className="rz-button-primary">
          <Plus size={14} />
          Tag a device
        </button>
      </div>

      <div className="rz-card flex items-start gap-3 border-[#f0dfb8] bg-[#fffaf0] p-4">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#f7e9ca] text-[#8a691d]"><Info size={14} /></span>
        <p className="text-[12px] leading-5 text-[#6e5a2c]">
          UDP DNS carries no device identity. Queries from the same public IP are shown as one source. Use the device-tagged DoH URL for per-device attribution.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">DoH devices</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Identified by device tag in the DoH URL</p>
            </div>
            <span className="rounded-full bg-[#edf8f0] px-2.5 py-1 text-[10px] font-medium text-[#247440]">{dohDevices.length} active</span>
          </div>
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {dohDevices.length === 0 ? <p className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">No DoH device tags in the last 24h.</p> : null}
            {dohDevices.map((device) => (
              <div key={device.tag} className="flex items-center gap-3 px-5 py-4">
                <span className="flex size-9 items-center justify-center rounded-xl bg-[var(--paper-2)] text-[var(--muted)]">
                  {device.tag === 'iphone' ? <Smartphone size={16} /> : <Monitor size={16} />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium">{device.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">/v1/.../{device.tag}/••••</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="font-mono text-[11px]">{device.queries}</p>
                  <p className="text-[10px] text-[var(--muted)]">{device.lastSeen}</p>
                </div>
                <span className="size-1.5 rounded-full bg-[#2e9b55]" />
              </div>
            ))}
          </div>
        </div>

        <div className="rz-card overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">UDP sources</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Public IP only — downstream devices are opaque</p>
            </div>
            <Router size={17} className="text-[var(--muted)]" />
          </div>
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {udpSources.length === 0 ? <p className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">No UDP sources in the last 24h.</p> : null}
            {udpSources.map((source) => (
              <div key={source.name} className="flex items-center gap-3 px-5 py-4">
                <span className="flex size-9 items-center justify-center rounded-xl bg-[var(--paper-2)] text-[var(--muted)]"><Router size={16} /></span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium">{source.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">{source.ip}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="font-mono text-[11px]">{source.queries}</p>
                  <p className="text-[10px] text-[var(--muted)]">{source.lastSeen}</p>
                </div>
                <span className={['size-1.5 rounded-full', source.name === 'Unknown device' ? 'bg-[#c8a24a]' : 'bg-[#2e9b55]'].join(' ')} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rz-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--line)] p-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--muted)]">
            <Search size={14} />
            <span>Search devices or source IPs</span>
          </div>
          <span className="text-[11px] text-[var(--muted)]">{dohDevices.length + udpSources.length} devices/sources · last 24h</span>
        </div>
        <div className="grid gap-px bg-[var(--line)] sm:grid-cols-3">
          <DeviceStat label="DoH devices" value={String(dohDevices.length)} detail="Attributed" />
          <DeviceStat label="UDP sources" value={String(udpSources.length)} detail="IP-only" />
          <DeviceStat label="Queries today" value={new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(data.totalQueries)} detail="Across all devices" />
        </div>
      </div>
    </div>
  )
}

function DeviceStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-white p-5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</p>
      <p className="mt-2 font-mono text-[24px] tracking-[-0.05em]">{value}</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">{detail}</p>
    </div>
  )
}
