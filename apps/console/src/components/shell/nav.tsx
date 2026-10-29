import { Link } from '@tanstack/react-router'
import { Activity, FileText, House, Layers3, ListFilter, Monitor, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

export type NavItem = {
  label: string
  to: string
  icon: ReactNode
  badge?: string
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
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

export const accountNav: NavItem[] = [{ label: 'Settings', to: '/settings', icon: <Settings size={16} /> }]

export function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={[
        'group flex items-center gap-2.5 border-l-2 px-2.5 py-2 text-[11px] font-medium transition-colors',
        active
          ? 'border-[var(--brand)] bg-white/[0.06] text-[var(--sidebar-text)]'
          : 'border-transparent text-[var(--sidebar-muted)] hover:bg-white/[0.04] hover:text-[var(--sidebar-text)]',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--brand)]' : 'text-[var(--sidebar-muted)] group-hover:text-[var(--sidebar-text)]'}>
        {item.icon}
      </span>
      <span>{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded-[2px] bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-[var(--sidebar-text)] ring-1 ring-white/10">
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}
