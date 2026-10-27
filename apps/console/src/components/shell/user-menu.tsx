import { ChevronUp, LogOut } from 'lucide-react'
import { useRef, useState } from 'react'

import { authClient } from '../../lib/auth-client'
import { useDismiss } from './use-dismiss'

export function UserMenu({ name, image, email }: { name: string; image: string | null; email: string | null }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'RZ'

  useDismiss(open, containerRef, setOpen)

  async function signOut() {
    setPending(true)
    try {
      await authClient.signOut()
    } finally {
      window.location.assign('/login')
    }
  }

  return (
    <div ref={containerRef} className="relative border-t border-[var(--line)]">
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-[12px] border border-[var(--line)] bg-white shadow-[0_12px_32px_rgba(26,32,24,0.12)]"
        >
          <div className="border-b border-[var(--line)] px-3 py-2.5">
            <p className="truncate text-[11px] font-medium">{name}</p>
            {email ? <p className="mt-0.5 truncate text-[10px] text-[var(--muted)]">{email}</p> : null}
          </div>
          <button
            role="menuitem"
            type="button"
            onClick={() => void signOut()}
            disabled={pending}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--ink)] transition-colors hover:bg-[var(--sage)] disabled:opacity-60"
          >
            <LogOut size={14} className="text-[var(--muted)]" />
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-[var(--sage)]"
      >
        {image ? (
          <img src={image} alt="" className="size-8 rounded-full object-cover ring-1 ring-[var(--line)]" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-[var(--ink)] text-[10px] font-semibold text-white">
            {initials}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-medium">{name}</span>
          <span className="block truncate text-[10px] text-[var(--muted)]">Personal workspace</span>
        </span>
        <ChevronUp size={14} className={`ml-auto text-[var(--muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  )
}
