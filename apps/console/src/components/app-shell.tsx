import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  ChevronDown,
  CircleHelp,
  Command,
  FileText,
  Layers3,
  ListFilter,
  Monitor,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import type { ReactNode } from 'react'

import logo from '../assets/logo-square.svg'
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
    items: [
      { label: 'Logs', to: '/logs', icon: <FileText size={16} /> },
    ],
  },
]

const accountNav: NavItem[] = [
  { label: 'Settings', to: '/settings', icon: <Settings size={16} /> },
]

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  const deviceCount = data ? Math.max(data.activeDevices, data.topClients.length) : 0
  const queriesLabel = data
    ? new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(data.totalQueries)
    : '—'
  const blockRate = data ? (data.blockRatio * 100).toFixed(1) : '—'
  const edgeHealthy = data?.edge.ok
  const viewerName = data?.viewer.name ?? 'Account'
  const viewerImage = data?.viewer.image ?? null
  const viewerInitials = viewerName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'RZ'
  const groups = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.label === 'Devices' && deviceCount > 0 ? { ...item, badge: String(deviceCount) } : item,
    ),
  }))

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-[var(--line)] bg-[var(--sidebar)] text-[var(--ink)] lg:flex">
        <Link to="/" className="flex items-center gap-3 px-4 pb-6 pt-5">
          <span className="flex size-9 items-center justify-center rounded-lg border border-[var(--line)] bg-white text-[var(--ink)]">
            <img src={logo} alt="" className="size-6" />
          </span>
          <span>
            <span className="block text-[14px] font-semibold tracking-[-0.02em]">ResolveZero</span>
            <span className="block text-[10px] text-[var(--muted)]">Home DNS firewall</span>
          </span>
        </Link>

        <div className="mx-3 mb-4 flex items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3 py-2">
          <span className="text-[12px] font-medium">Home network</span>
          <ChevronDown size={14} className="ml-auto text-[var(--muted)]" />
        </div>

        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2.5 pb-1.5 text-[11px] font-medium text-[var(--muted)]">{group.label}</p>
              {group.items.map((item) => (
                <SidebarLink key={item.label} item={item} active={pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))} />
              ))}
            </div>
          ))}
        </nav>

        <div className="px-3 pb-3">
          <div className="rounded-md border border-[var(--line)] bg-white p-3">
            <div className="flex items-center gap-2 text-[11px] font-medium">
              <ShieldCheck size={14} className="text-[var(--accent)]" />
              {edgeHealthy === false ? 'Edge unavailable' : 'Protection active'}
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-[var(--muted)]">
              {data ? `${queriesLabel} queries in the last 24 hours.` : 'Loading live DNS data…'}
            </p>
            <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--muted)]">
              <span>{deviceCount} devices</span>
              <span className="font-mono text-[var(--ink)]">{blockRate}% blocked</span>
            </div>
          </div>
          <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--muted)]">Account</p>
          {accountNav.map((item) => (
            <SidebarLink key={item.label} item={item} active={pathname === item.to} />
          ))}
        </div>

        <div className="flex items-center gap-2.5 border-t border-[var(--line)] px-4 py-3">
          {viewerImage ? (
            <img src={viewerImage} alt="" className="size-7 rounded-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-[var(--ink)] text-[10px] font-semibold text-white">{viewerInitials}</span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[11px] font-medium">{viewerName}</span>
            <span className="block truncate text-[10px] text-[var(--muted)]">Personal workspace</span>
          </span>
          <CircleHelp size={14} className="ml-auto text-[var(--muted)]" />
        </div>
      </aside>

      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[var(--line)] bg-white/95 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--ink)] text-white">
              <img src={logo} alt="ResolveZero" className="size-5" />
            </span>
            <span className="text-sm font-semibold">ResolveZero</span>
          </div>

          <div className="hidden items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-[12px] text-[var(--muted)] sm:flex">
            <Search size={14} />
            <span>Search domains, rules, devices</span>
            <kbd className="ml-8 flex items-center gap-0.5 rounded border border-[var(--line)] bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
              <Command size={10} /> K
            </kbd>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <DnsProbeBadge />
            <span className="hidden items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3 py-1.5 text-[11px] text-[var(--muted)] md:flex">
              <Activity size={12} className="text-[var(--accent)]" />
              {queriesLabel} queries / 24h
            </span>
            {viewerImage ? (
              <img src={viewerImage} alt={viewerName} className="size-9 rounded-full object-cover ring-1 ring-[var(--line)]" referrerPolicy="no-referrer" />
            ) : (
              <button className="flex size-9 items-center justify-center rounded-full bg-[var(--ink)] text-[11px] font-semibold text-white">
                {viewerInitials}
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-7">
          <Outlet />
        </main>
      </div>
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
          ? 'border-[var(--accent)] bg-transparent text-[var(--ink)]'
          : 'border-transparent text-[var(--muted)] hover:bg-[#f1f0ec] hover:text-[var(--ink)]',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--ink)]' : 'text-[var(--muted)] group-hover:text-[var(--ink)]'}>{item.icon}</span>
      <span>{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)] ring-1 ring-[var(--line)]">{item.badge}</span>
      ) : null}
    </Link>
  )
}
