import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { BLOCKLIST_FORMATS, type BlocklistFormat } from '../../lib/policy'
import { createBlocklist } from '../../server/policy'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function AddListForm({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<BlocklistFormat>('auto')

  const mutation = useMutation({
    mutationFn: () => createBlocklist({ data: { url: url.trim(), format, profileId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['blocklists'] })
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      setUrl('')
      onDone()
    },
  })

  return (
    <form
      className="border-b border-[var(--line)] bg-[var(--paper)]/40 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (url.trim()) mutation.mutate()
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          autoFocus
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/hosts.txt"
          aria-label="Blocklist URL"
          spellCheck={false}
          autoCapitalize="none"
          className="rz-input min-w-0 flex-1 font-mono"
        />
        <Select value={format} onValueChange={(value) => setFormat(value as BlocklistFormat)}>
          <SelectTrigger className="w-full sm:w-[210px]" aria-label="List format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BLOCKLIST_FORMATS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={!url.trim() || mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save list'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
        https only. Auto-detect sniffs hosts, domains, and adblock syntax from the file; override it only if a list
        mixes formats. The edge fetches it on its next sync — usually within seconds.
      </p>
      {mutation.isError ? (
        <p role="alert" className="mt-2 text-[11px] text-[var(--danger)]">
          {mutation.error.message}
        </p>
      ) : null}
    </form>
  )
}
