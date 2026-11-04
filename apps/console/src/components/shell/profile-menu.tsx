import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { setActiveProfileCookie } from '../../lib/profile-cookie'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { CreateProfileDialog, DeleteProfileDialog } from './profile-dialogs'

export function ProfileMenu({
  profiles,
  activeId,
  label,
  loading,
}: {
  profiles: { id: string; name: string }[]
  activeId: string
  label: string
  loading: boolean
}) {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'create' | 'delete' | null>(null)

  function choose(id: string) {
    setOpen(false)
    if (id === activeId) return
    setActiveProfileCookie(id)
    window.location.reload()
  }

  const active = profiles.find((profile) => profile.id === activeId) ?? null

  return (
    <div className="relative ml-1 block">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild disabled={loading}>
          <button
            type="button"
            disabled={loading}
            aria-busy={loading}
            className="flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--ink)] transition-colors hover:bg-[var(--paper-2)] disabled:cursor-wait disabled:opacity-60"
          >
            <span className="max-w-[120px] truncate">{label}</span>
            {!loading ? (
              <ChevronDown
                size={14}
                className={`shrink-0 text-[var(--muted)] transition-transform ${open ? 'rotate-180' : ''}`}
              />
            ) : null}
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={12} className="w-[200px]">
          <DropdownMenuLabel>Profiles</DropdownMenuLabel>
          {profiles.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-[var(--muted)]">No profiles</p>
          ) : null}
          <DropdownMenuRadioGroup value={activeId} onValueChange={choose}>
            {profiles.map((profile) => (
              <DropdownMenuRadioItem key={profile.id} value={profile.id}>
                {profile.name.charAt(0).toUpperCase() + profile.name.slice(1)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog('create')}>
            <Plus size={12} /> New profile
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDialog('delete')}
            disabled={profiles.length <= 1}
            className="text-[var(--danger)] data-[disabled]:text-[var(--muted)]"
          >
            <Trash2 size={12} /> Delete profile
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === 'create' ? <CreateProfileDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'delete' && active ? (
        <DeleteProfileDialog profile={active} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  )
}
