import { Link } from '@tanstack/react-router'
import { Check, ChevronDown, Settings } from 'lucide-react'
import { useRef, useState } from 'react'

import { useDismiss } from './use-dismiss'

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
  const containerRef = useRef<HTMLDivElement>(null)

  useDismiss(open, containerRef, setOpen)

  function choose(id: string) {
    setOpen(false)
    if (id === activeId) return
    document.cookie = `rz_profile_id=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`
    window.location.reload()
  }

  return (
    <div ref={containerRef} className="relative ml-1 hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={loading}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={loading}
        className="flex h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3 text-[12px] font-medium text-[var(--ink)] shadow-[0_1px_2px_rgba(26,32,24,0.03)] transition-colors hover:bg-[var(--sage)] disabled:cursor-wait disabled:opacity-60"
      >
        <span className="max-w-[120px] truncate">{label}</span>
        {!loading ? (
          <ChevronDown
            size={14}
            className={`shrink-0 text-[var(--muted)] transition-transform ${open ? 'rotate-180' : ''}`}
          />
        ) : null}
      </button>

      {open && !loading ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-4 w-[172px] overflow-hidden rounded-[10px] border border-[var(--line)] bg-white py-1 shadow-[0_12px_32px_rgba(26,32,24,0.12)]"
        >
          {profiles.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-[var(--muted)]">No profiles</p>
          ) : null}
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              role="menuitemradio"
              aria-checked={profile.id === activeId}
              onClick={() => choose(profile.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--sage)]"
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {profile.id === activeId ? <Check size={12} className="text-[var(--green)]" /> : null}
              </span>
              <span className="truncate">
                {profile.name.charAt(0).toUpperCase() + profile.name.slice(1)}
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-[var(--line)]" />
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--muted)] transition-colors hover:bg-[var(--sage)] hover:text-[var(--ink)]"
          >
            <Settings size={12} /> Profile settings
          </Link>
        </div>
      ) : null}
    </div>
  )
}
