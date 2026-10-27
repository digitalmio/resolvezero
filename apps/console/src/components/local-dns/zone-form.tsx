import { Plus } from 'lucide-react'
import type { FormEvent } from 'react'

import { ZONE_RECORD_TYPES, type ZoneRecordType } from '../../lib/zone'

export type ZoneFormState = {
  domain: string
  recordType: ZoneRecordType
  values: string
  ttl: string
}

export const emptyZoneForm: ZoneFormState = { domain: '', recordType: 'A', values: '', ttl: '300' }

function valuePlaceholder(type: ZoneRecordType): string {
  if (type === 'A') return '192.168.1.24, 192.168.1.25'
  if (type === 'AAAA') return 'fd00::24'
  if (type === 'CNAME') return 'nas.local'
  return 'v=spf1 -all'
}

export function ZoneForm({
  form,
  editing,
  saving,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: ZoneFormState
  editing: boolean
  saving: boolean
  error: string | null
  onChange: (form: ZoneFormState) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="rz-card h-fit p-5">
      <div className="flex items-center gap-2">
        <Plus size={16} className="text-[var(--muted)]" />
        <div>
          <h2 className="text-[14px] font-semibold">{editing ? 'Edit local record' : 'Add local record'}</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">Changes reach every edge in seconds.</p>
        </div>
      </div>

      <label htmlFor="zone-domain" className="mt-5 block text-[11px] font-medium">
        Name
      </label>
      <input
        id="zone-domain"
        value={form.domain}
        onChange={(event) => onChange({ ...form, domain: event.target.value })}
        placeholder="nas.lan"
        autoComplete="off"
        spellCheck={false}
        className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--green)]"
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
            onChange={(event) => onChange({ ...form, recordType: event.target.value as ZoneRecordType })}
            className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-[11px] outline-none focus:border-[var(--green)]"
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
            onChange={(event) => onChange({ ...form, ttl: event.target.value })}
            className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--green)]"
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
        onChange={(event) => onChange({ ...form, values: event.target.value })}
        placeholder={valuePlaceholder(form.recordType)}
        spellCheck={false}
        className="mt-1.5 w-full resize-y rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--green)]"
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
          disabled={saving || !form.domain.trim() || !form.values.trim()}
          className="rz-button-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : editing ? 'Update record' : 'Add record'}
        </button>
        {editing ? (
          <button type="button" onClick={onCancel} className="rz-button-secondary">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
