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
        'group flex items-center gap-2.5 border-l-2 px-2.5 py-2 text-[12px] font-medium transition-colors',
        active
          ? 'border-[var(--green)] bg-[var(--sage)] text-[var(--ink)]'
          : 'border-transparent text-[var(--muted)] hover:bg-[var(--sage)]/60 hover:text-[var(--ink)]',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--green)]' : 'text-[var(--muted)] group-hover:text-[var(--ink)]'}>{item.icon}</span>
      <span>{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)] ring-1 ring-[var(--line)]">
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}
