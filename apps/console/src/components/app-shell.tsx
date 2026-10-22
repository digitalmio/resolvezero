import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  BookOpen,
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
import { getOverview } from '../server/dashboard'

type NavItem = {
  label: string
  to: string
  icon: ReactNode
  badge?: string
}

const primaryNav: NavItem[] = [
  { label: 'Overview', to: '/', icon: <Activity size={17} /> },
  { label: 'Rules', to: '/rules', icon: <ListFilter size={17} /> },
  { label: 'Blocklists', to: '/blocklists', icon: <Layers3 size={17} /> },
  { label: 'Devices', to: '/devices', icon: <Monitor size={17} /> },
  { label: 'Logs', to: '/logs', icon: <FileText size={17} /> },
  { label: 'Analytics', to: '/analytics', icon: <BarChart3 size={17} /> },
]

const secondaryNav: NavItem[] = [
  { label: 'Settings', to: '/settings', icon: <Settings size={17} /> },
  { label: 'API docs', to: '/settings', icon: <BookOpen size={17} /> },
]

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { data } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  const deviceCount = data?.activeDevices ?? 0
  const nav = primaryNav.map((item) =>
    item.label === 'Devices' && deviceCount > 0 ? { ...item, badge: String(deviceCount) } : item,
  )

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-white/8 bg-[var(--ink)] text-white lg:flex">
        <Link to="/" className="flex items-center gap-3 px-5 pb-7 pt-6">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white text-[#0b0c0e] shadow-[0_0_0_1px_rgba(255,255,255,.08)]">
            <img src={logo} alt="" className="size-7" />
          </span>
          <span>
            <span className="block text-[15px] font-semibold tracking-[-0.02em]">ResolveZero</span>
            <span className="block text-[11px] uppercase tracking-[0.16em] text-white/40">DNS control plane</span>
          </span>
        </Link>

        <div className="mx-3 mb-5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
          <span className="size-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent)]" />
          <span className="text-[12px] font-medium text-white/80">Home network</span>
          <ChevronDown size={14} className="ml-auto text-white/35" />
        </div>

        <nav className="flex flex-1 flex-col px-3">
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">Workspace</p>
          {nav.map((item) => (
            <SidebarLink key={item.label} item={item} active={pathname === item.to || (item.to !== '/' && pathname.startsWith(item.to))} />
          ))}
          <div className="my-5 h-px bg-white/8" />
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/30">Account</p>
          {secondaryNav.map((item) => (
            <SidebarLink key={item.label} item={item} active={pathname === item.to} />
          ))}
        </nav>

        <div className="m-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-white/85">
            <ShieldCheck size={15} className="text-[var(--accent)]" />
            Protection active
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-white/45">
            All resolvers are healthy. Last config sync 4s ago.
          </p>
          <div className="mt-3 flex items-center justify-between text-[11px] text-white/40">
            <span className="font-mono">fra / lhr</span>
            <span className="text-[var(--accent)]">99.99%</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-t border-white/8 px-5 py-4">
          <span className="flex size-8 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold">MK</span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium text-white/85">Maciej K.</span>
            <span className="block truncate text-[11px] text-white/35">Personal workspace</span>
          </span>
          <CircleHelp size={15} className="ml-auto text-white/30" />
        </div>
      </aside>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-[68px] items-center gap-3 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_92%,transparent)] px-5 backdrop-blur-xl sm:px-8">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--ink)] text-white">
              <img src={logo} alt="ResolveZero" className="size-5" />
            </span>
            <span className="text-sm font-semibold">ResolveZero</span>
          </div>

          <div className="hidden items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[12px] text-[var(--muted)] shadow-[0_1px_0_rgba(0,0,0,.02)] sm:flex">
            <Search size={14} />
            <span>Search domains, rules, devices</span>
            <kbd className="ml-8 flex items-center gap-0.5 rounded border border-[var(--line)] bg-[var(--paper)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
              <Command size={10} /> K
            </kbd>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-[#cfe6d7] bg-[#edf8f0] px-3 py-1.5 text-[11px] font-medium text-[#247440] sm:flex">
              <span className="size-1.5 rounded-full bg-[#2e9b55]" />
              Protected
            </span>
            <span className="hidden items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3 py-1.5 text-[11px] text-[var(--muted)] md:flex">
              <Activity size={12} className="text-[var(--accent)]" />
              1,284 qps
            </span>
            <button className="flex size-9 items-center justify-center rounded-full bg-[var(--ink)] text-[11px] font-semibold text-white">
              MK
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-[1480px] px-5 py-7 sm:px-8 sm:py-9">
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
        'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors',
        active ? 'bg-white/[0.09] text-white' : 'text-white/50 hover:bg-white/[0.05] hover:text-white/85',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--accent)]' : 'text-white/35 group-hover:text-white/65'}>{item.icon}</span>
      <span>{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded-md bg-white/8 px-1.5 py-0.5 font-mono text-[10px] text-white/45">{item.badge}</span>
      ) : null}
    </Link>
  )
}
