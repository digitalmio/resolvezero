import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { setActiveProfileCookie } from '../../lib/profile-cookie'
import { createProfile, deleteProfile } from '../../server/profiles'
import { Button } from '../ui/button'

function Modal({ title, description, onClose, children }: {
  title: string
  description: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-[var(--radius)] border border-[var(--line)] bg-[var(--card)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1.5 text-[11px] leading-5 text-[var(--muted)]">{description}</p>
        {children}
      </div>
    </div>
  )
}

export function CreateProfileDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => createProfile({ data: { name } }),
    onSuccess: (profile) => {
      setActiveProfileCookie(profile.id)
      window.location.assign('/')
    },
  })

  return (
    <Modal
      title="New profile"
      description="A profile has its own rules, blocklists, logs and DoH/DoT endpoints. You can switch between them from the header."
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!create.isPending && name.trim()) create.mutate()
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="new-profile-name" className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
            Profile name
          </label>
          <input
            id="new-profile-name"
            autoFocus
            required
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Home, Office, Kids…"
            autoComplete="off"
            className="rz-input w-full"
          />
        </div>
        {create.isError ? (
          <p role="alert" className="text-[11px] text-[var(--danger)]">
            {create.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? <LoaderCircle size={14} className="animate-spin" /> : null}
            {create.isPending ? 'Creating…' : 'Create profile'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function DeleteProfileDialog({ profile, onClose }: { profile: { id: string; name: string }; onClose: () => void }) {
  const [confirmation, setConfirmation] = useState('')
  const remove = useMutation({
    mutationFn: () => deleteProfile({ data: { id: profile.id } }),
    onSuccess: (result) => {
      if (result.nextProfileId) setActiveProfileCookie(result.nextProfileId)
      window.location.assign('/')
    },
  })

  const matches = confirmation.trim().toLowerCase() === profile.name.toLowerCase()

  return (
    <Modal
      title={`Delete “${profile.name}”?`}
      description="This removes its rules, blocklists, local records, devices and stats. Linked devices stop resolving immediately. This cannot be undone."
      onClose={onClose}
    >
      <div className="mt-4 flex items-start gap-2 border border-[#e7b4ae] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>Type the profile name to confirm.</span>
      </div>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!remove.isPending && matches) remove.mutate()
        }}
      >
        <input
          autoFocus
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={profile.name}
          aria-label="Type the profile name to confirm"
          className="rz-input w-full"
        />
        {remove.isError ? (
          <p role="alert" className="text-[11px] text-[var(--danger)]">
            {remove.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={remove.isPending || !matches} className="bg-[var(--danger)] border-[var(--danger)] hover:bg-[#b42318] hover:border-[#b42318]">
            {remove.isPending ? 'Deleting…' : 'Delete profile'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
