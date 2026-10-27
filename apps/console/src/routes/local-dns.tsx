import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { House, Info, Pencil, Plus, Router, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { ZONE_RECORD_TYPES, zoneKey, type LocalDnsZone, type ZoneRecordType } from '../lib/zone'
import { deleteLocalDnsZone, getLocalDnsData, saveLocalDnsZone } from '../server/dashboard'

export const Route = createFileRoute('/local-dns')({ component: LocalDnsPage })

type FormState = {
  domain: string
  recordType: ZoneRecordType
  values: string
  ttl: string
}

const emptyForm: FormState = { domain: '', recordType: 'A', values: '', ttl: '300' }

function valuePlaceholder(type: ZoneRecordType): string {
  if (type === 'A') return '192.168.1.24, 192.168.1.25'
  if (type === 'AAAA') return 'fd00::24'
  if (type === 'CNAME') return 'nas.local'
  return 'v=spf1 -all'
}

function LocalDnsPage() {
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['local-dns'],
    queryFn: () => getLocalDnsData(),
  })
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editingKey, setEditingKey] = useState<string | null>(null)

  function invalidate() {
    for (const key of ['local-dns', 'rules', 'overview', 'settings']) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  const save = useMutation({
    mutationFn: () =>
      saveLocalDnsZone({
        data: {
          domain: form.domain,
          recordType: form.recordType,
          values: form.values,
          ttl: Number(form.ttl),
        },
      }),
    onSuccess: () => {
      setForm(emptyForm)
      setEditingKey(null)
      invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: (zone: LocalDnsZone) =>
      deleteLocalDnsZone({ data: { domain: zone.domain, recordType: zone.recordType } }),
    onSuccess: invalidate,
  })

  if (isPending) return <PageLoading label="Loading local DNS records…" />
  if (isError || !data) return <PageError title="Could not load local DNS records." onRetry={() => void refetch()} />

  const profileLabel = data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1)
  const error = save.isError ? save.error.message : remove.isError ? remove.error.message : null

  function startEdit(zone: LocalDnsZone) {
    setEditingKey(zoneKey(zone))
    setForm({
      domain: zone.domain,
      recordType: zone.recordType,
      values: zone.values.join(', '),
      ttl: String(zone.ttl),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelEdit() {
    setEditingKey(null)
    setForm(emptyForm)
    save.reset()
    remove.reset()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!save.isPending) save.mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Network</p>
        <div className="flex items-start gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white text-[var(--accent)] ring-1 ring-[var(--line)]">
            <House size={20} />
          </span>
          <div>
            <h1 className="text-[30px] font-semibold tracking-[-0.045em]">Local DNS</h1>
            <p className="mt-1 text-[13px] text-[var(--muted)]">
              {profileLabel} profile · answer <span className="font-mono">.lan</span> names before blocklists and upstream.
            </p>
          </div>
        </div>
      </div>

      <div className="rz-card flex items-start gap-3 border-[#dbe3ff] bg-[#f5f7ff] p-4">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#e6ecff] text-[#3552a5]">
          <Info size={14} />
        </span>
        <div className="text-[12px] leading-5 text-[#3f4f75]">
          <p>
            Only names ending in <span className="font-mono">.lan</span> are accepted. Exact names match only themselves.
            Use <span className="font-mono">*.home.lan</span> for wildcard subdomains — the apex{' '}
            <span className="font-mono">home.lan</span> is not included.
          </p>
          <p className="mt-1">
            A/AAAA/CNAME answers can be comma-separated. Use new lines for multiple TXT values. Local records win before
            blocklists, cache, and upstream.
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <form onSubmit={submit} className="rz-card h-fit p-5">
          <div className="flex items-center gap-2">
            <Plus size={16} className="text-[var(--muted)]" />
            <div>
              <h2 className="text-[14px] font-semibold">{editingKey ? 'Edit local record' : 'Add local record'}</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">Changes reach every edge in seconds.</p>
            </div>
          </div>

          <label htmlFor="zone-domain" className="mt-5 block text-[11px] font-medium">
            Name
          </label>
          <input
            id="zone-domain"
            value={form.domain}
            onChange={(event) => setForm({ ...form, domain: event.target.value })}
            placeholder="nas.lan"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--accent)]"
          />
          <p className="mt-1.5 text-[10px] text-[var(--muted)]">Must end in .lan.</p>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="zone-type" className="block text-[11px] font-medium">
                Type
              </label>
              <select
                id="zone-type"
                value={form.recordType}
                onChange={(event) => setForm({ ...form, recordType: event.target.value as ZoneRecordType })}
                className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-[11px] outline-none focus:border-[var(--accent)]"
              >
                {ZONE_RECORD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="zone-ttl" className="block text-[11px] font-medium">
                TTL (seconds)
              </label>
              <input
                id="zone-ttl"
                type="number"
                min={1}
                max={86400}
                value={form.ttl}
                onChange={(event) => setForm({ ...form, ttl: event.target.value })}
                className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>

          <label htmlFor="zone-values" className="mt-3 block text-[11px] font-medium">
            Answer
          </label>
          <textarea
            id="zone-values"
            rows={2}
            value={form.values}
            onChange={(event) => setForm({ ...form, values: event.target.value })}
            placeholder={valuePlaceholder(form.recordType)}
            spellCheck={false}
            className="mt-1.5 w-full resize-y rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--accent)]"
          />
          <p className="mt-1.5 text-[10px] leading-4 text-[var(--muted)]">
            Up to 8 values. Separate A/AAAA/CNAME values with commas; TXT values can be one per line.
          </p>

          {error ? (
            <p role="alert" className="mt-3 rounded-md border border-[#f0d7c8] bg-[#fff6f1] px-3 py-2 text-[11px] leading-5 text-[#9a3f1b]">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={save.isPending || !form.domain.trim() || !form.values.trim()}
              className="rz-button-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : editingKey ? 'Update record' : 'Add record'}
            </button>
            {editingKey ? (
              <button type="button" onClick={cancelEdit} className="rz-button-secondary">
                Cancel
              </button>
            ) : null}
          </div>
        </form>

        <div className="rz-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--line)] p-5">
            <div>
              <h2 className="text-[14px] font-semibold">Local records</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                {data.zones.length} {data.zones.length === 1 ? 'record' : 'records'} · answered by ResolveZero
              </p>
            </div>
            <Router size={17} className="text-[var(--muted)]" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Answer</th>
                  <th className="px-4 py-3 font-medium">TTL</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {data.zones.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">
                      No local records yet. Add <span className="font-mono">nas.lan</span> →{' '}
                      <span className="font-mono">192.168.1.24</span>.
                    </td>
                  </tr>
                ) : null}
                {data.zones.map((zone) => {
                  const key = zoneKey(zone)
                  return (
                    <tr key={key} className="group hover:bg-white/60">
                      <td className="px-5 py-3.5 font-mono text-[12px]">{zone.domain}</td>
                      <td className="px-4 py-3.5">
                        <span className="inline-flex items-center rounded-md bg-[#eef2ff] px-2 py-1 text-[10px] font-semibold text-[#3552a5] ring-1 ring-[#dbe3ff]">
                          {zone.recordType}
                        </span>
                      </td>
                      <td className="max-w-[320px] px-4 py-3.5">
                        <p className="truncate font-mono text-[11px] text-[var(--muted)]" title={zone.values.join(', ')}>
                          {zone.values.join(', ')}
                        </p>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-[11px] text-[var(--muted)]">{zone.ttl}s</td>
                      <td className="px-4 py-3.5">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => startEdit(zone)}
                            className="rounded-md p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                            aria-label={`Edit ${zone.domain} ${zone.recordType}`}
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`Delete ${zone.domain} (${zone.recordType})?`)) remove.mutate(zone)
                            }}
                            className="rounded-md p-1.5 text-[var(--muted)] transition-colors hover:bg-[#fff0e9] hover:text-[#c64012]"
                            aria-label={`Delete ${zone.domain} ${zone.recordType}`}
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)]">
            Local answers take precedence over blocklists, cache, and upstream.
          </div>
        </div>
      </div>
    </div>
  )
}
