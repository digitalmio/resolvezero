import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Command,
  FileText,
  House,
  Layers3,
  ListFilter,
  LogOut,
  Monitor,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import logo from '../assets/logo-square.svg'
import { authClient } from '../lib/auth-client'
import type { SessionUser } from '../server/auth'
import { DnsProbeBadge } from './dns-probe-badge'
import { getOverview } from '../server/dashboard'

type NavItem = {
  label: string
  to: string
  icon: ReactNode
  badge?: string
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: 'Network',
    items: [
      { label: 'Overview', to: '/', icon: <Activity size={16} /> },
      { label: 'Devices', to: '/devices', icon: <Monitor size={16} /> },
      { label: 'Local DNS', to: '/local-dns', icon: <House size={16} /> },
    ],
  },
  {
    label: 'Protection',
    items: [
      { label: 'Rules', to: '/rules', icon: <ListFilter size={16} /> },
      { label: 'Blocklists', to: '/blocklists', icon: <Layers3 size={16} /> },
    ],
  },
  {
    label: 'Observe',
    items: [{ label: 'Logs', to: '/logs', icon: <FileText size={16} /> }],
  },
]

const accountNav: NavItem[] = [{ label: 'Settings', to: '/settings', icon: <Settings size={16} /> }]

export function AppShell({ session }: { session: SessionUser | null }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  const deviceCount = data ? Math.max(data.activeDevices, data.topClients.length) : 0
  const queriesLabel = data
    ? new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(data.totalQueries)
    : '—'
  const blockRate = data ? (data.blockRatio * 100).toFixed(1) : '—'
  const edgeHealthy = data?.edge.ok
  const viewerName = session?.name ?? ''
  const viewerImage = session?.image ?? null
  const viewerEmail = session?.email ?? null
  const profileLabel = data?.profileName
    ? data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1)
    : 'Home network'
  const groups = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.label === 'Devices' && deviceCount > 0 ? { ...item, badge: String(deviceCount) } : item,
    ),
  }))

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 border-b border-[var(--line)] bg-white/95 px-4 shadow-[0_1px_3px_rgba(26,32,24,0.04)] backdrop-blur-xl sm:px-6">
        <Link to="/" aria-label="ResolveZero home" className="flex shrink-0 items-center">
          <img src={logo} alt="" className="size-9 shrink-0 sm:size-10" />
        </Link>

        <div className="ml-1 hidden h-8 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3 text-[12px] font-medium text-[var(--ink)] shadow-[0_1px_2px_rgba(26,32,24,0.03)] transition-colors hover:bg-[var(--sage)] md:flex">
          <span className="max-w-[120px] truncate">{profileLabel}</span>
          <ChevronDown size={14} className="shrink-0 text-[var(--muted)]" />
        </div>

        <div className="absolute left-1/2 top-1/2 hidden w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--muted)] shadow-[0_1px_2px_rgba(26,32,24,0.03)] lg:flex">
          <Search size={14} />
          <span>Search domains, rules, devices</span>
          <kbd className="ml-auto flex items-center gap-0.5 rounded border border-[var(--line)] bg-[var(--sage)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
            <Command size={10} /> K
          </kbd>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {data ? <DnsProbeBadge profileId={data.profileId} /> : null}
          <span className="hidden h-8 items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3 text-[11px] font-medium text-[var(--muted)] md:inline-flex">
            <Activity size={12} className="text-[var(--green)]" />
            {queriesLabel} queries / 24h
          </span>
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-16 z-30 hidden w-[240px] flex-col border-r border-[var(--line)] bg-white text-[var(--ink)] lg:flex">
        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4 pt-5">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2.5 pb-1.5 text-[11px] font-medium text-[var(--muted)]">{group.label}</p>
              {group.items.map((item) => (
                <SidebarLink
                  key={item.label}
                  item={item}
                  active={pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))}
                />
              ))}
            </div>
          ))}
        </nav>

        <div className="px-3 pb-3">
          <div className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--sage)] p-3.5 shadow-[0_1px_2px_rgba(26,32,24,0.03)]">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[11px] font-medium">
                <span
                  className={[
                    'size-1.5 rounded-full',
                    edgeHealthy === false ? 'bg-[var(--warning)]' : 'bg-[var(--green)]',
                  ].join(' ')}
                />
                {edgeHealthy === false ? 'Edge unavailable' : 'Protection active'}
              </span>
              <ShieldCheck size={14} className="text-[var(--green)]" />
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
              {data ? `${queriesLabel} queries in the last 24 hours.` : 'Loading live DNS data…'}
            </p>
            <div className="mt-2.5 flex items-center justify-between border-t border-[var(--line)] pt-2.5 text-[10px] text-[var(--muted)]">
              <span>
                {deviceCount} {deviceCount === 1 ? 'device' : 'devices'}
              </span>
              <span className="rz-mono text-[var(--ink)]">{blockRate}% blocked</span>
            </div>
          </div>

          <p className="px-2.5 pb-1 pt-4 text-[11px] font-medium text-[var(--muted)]">Account</p>
          {accountNav.map((item) => (
            <SidebarLink key={item.label} item={item} active={pathname === item.to} />
          ))}
        </div>

        {session ? <UserMenu name={viewerName} image={viewerImage} email={viewerEmail} /> : null}
      </aside>

      <div className="pt-16 lg:pl-[240px]">
        <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-8 sm:py-9">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function UserMenu({ name, image, email }: { name: string; image: string | null; email: string | null }) {
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

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

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

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={[
        'group flex items-center gap-2.5 border-l-2 px-2.5 py-2 text-[12px] font-medium transition-colors',
        active
          ? 'border-[var(--green)] bg-[var(--sage)] text-[var(--ink)]'
          : 'border-transparent text-[var(--muted)] hover:bg-[var(--sage)]/60 hover:text-[var(--ink)]',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--green)]' : 'text-[var(--muted)] group-hover:text-[var(--ink)]'}>{item.icon}</span>
      <span>{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)] ring-1 ring-[var(--line)]">{item.badge}</span>
      ) : null}
    </Link>
  )
}
