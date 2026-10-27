import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Activity, Command, Search, ShieldCheck } from 'lucide-react'

import logo from '../assets/logo-square.svg'
import type { SessionUser } from '../server/auth'
import { DnsProbeBadge } from './dns-probe-badge'
import { accountNav, navGroups, SidebarLink } from './shell/nav'
import { ProfileMenu } from './shell/profile-menu'
import { UserMenu } from './shell/user-menu'
import { getOverview } from '../server/dashboard'

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
    : 'Loading…'
  const groups = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.label === 'Devices' && deviceCount > 0 ? { ...item, badge: String(deviceCount) } : item,
    ),
  }))

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 border-b border-[var(--line)] bg-white/95 pl-3 pr-4 shadow-[0_1px_3px_rgba(26,32,24,0.04)] backdrop-blur-xl sm:pr-6">
        <Link to="/" aria-label="ResolveZero home" className="flex shrink-0 items-center">
          <img src={logo} alt="" className="size-9 shrink-0 sm:size-10" />
        </Link>

        <ProfileMenu profiles={data?.profiles ?? []} activeId={data?.profileId ?? ''} label={profileLabel} loading={!data} />

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
