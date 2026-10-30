import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { UPSTREAM_PRESETS } from '../../lib/settings'
import { updateSettings } from '../../server/dashboard'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'

const PRESET_LABELS: Record<string, string> = {
  default: 'Edge default',
  cloudflare: 'Cloudflare',
  google: 'Google',
  quad9: 'Quad9',
}

export interface ResolverFormValues {
  upstream: string | null
  upstreamUrl: string | null
  logQueries: boolean
  logRetentionDays: number
}

export function ResolverForm({ initial }: { initial: ResolverFormValues }) {
  const queryClient = useQueryClient()
  const [upstream, setUpstream] = useState(initial.upstream ?? 'default')
  const [upstreamUrl, setUpstreamUrl] = useState(initial.upstreamUrl ?? '')
  const [logQueries, setLogQueries] = useState(initial.logQueries)
  const [retention, setRetention] = useState(String(initial.logRetentionDays))

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        data: {
          upstream: upstream === 'default' ? null : (upstream as 'cloudflare' | 'google' | 'quad9'),
          upstreamUrl: upstreamUrl.trim() || null,
          logQueries,
          logRetentionDays: Number(retention),
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  return (
    <form
      className="space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <div className="space-y-1.5">
        <label className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
          Upstream preset
        </label>
        <Select value={upstream} onValueChange={setUpstream}>
          <SelectTrigger className="w-full" aria-label="Upstream preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['default', ...UPSTREAM_PRESETS].map((preset) => (
              <SelectItem key={preset} value={preset}>
                {PRESET_LABELS[preset] ?? preset}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
          Custom upstream URL
        </label>
        <input
          value={upstreamUrl}
          onChange={(event) => setUpstreamUrl(event.target.value)}
          placeholder="https://dns.example.com/dns-query"
          aria-label="Custom upstream URL"
          spellCheck={false}
          className="rz-input w-full font-mono"
        />
        <p className="text-[10px] text-[var(--muted)]">Overrides the preset. Leave empty to use the preset.</p>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-[var(--line)] pt-4">
        <div>
          <p className="text-[11px] font-medium">Log queries</p>
          <p className="mt-0.5 text-[10px] text-[var(--muted)]">Off means stats still aggregate, but no per-query rows.</p>
        </div>
        <Switch checked={logQueries} onCheckedChange={setLogQueries} aria-label="Log queries" />
      </div>

      <div className="flex items-end gap-3">
        <div className="space-y-1.5">
          <label className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            Retention (days)
          </label>
          <input
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            inputMode="numeric"
            aria-label="Log retention days"
            className="rz-input w-[110px] font-mono"
          />
        </div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {save.isSuccess ? <span className="pb-2 text-[10px] text-[var(--green)]">Saved</span> : null}
      </div>

      {save.isError ? (
        <p role="alert" className="text-[11px] text-[var(--danger)]">
          {save.error.message}
        </p>
      ) : null}
    </form>
  )
}
