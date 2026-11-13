import { Link } from '@tanstack/react-router'
import { Activity, Cable, FileText, House, KeyRound, Layers3, ListFilter, Monitor, Settings } from 'lucide-react'
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
      { label: 'Setup', to: '/setup', icon: <Cable size={16} /> },
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

export const accountNav: NavItem[] = [
  { label: 'API keys', to: '/api-keys', icon: <KeyRound size={16} /> },
  { label: 'Settings', to: '/settings', icon: <Settings size={16} /> },
]

export function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={[
        'group flex items-center gap-2.5 px-2.5 py-[7px] font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors',
        active
          ? 'bg-[var(--signal)] text-[var(--ink)]'
          : 'text-[var(--sidebar-muted)] hover:bg-white/[0.06] hover:text-[var(--sidebar-text)]',
      ].join(' ')}
    >
      <span className={active ? 'text-[var(--ink)]' : 'text-[var(--sidebar-muted)] group-hover:text-[var(--sidebar-text)]'}>
        {item.icon}
      </span>
      <span>{item.label}</span>
      {item.badge ? (
        <span
          className={[
            'ml-auto px-1.5 py-0.5 font-mono text-[9px]',
            active ? 'bg-[var(--ink)] text-[var(--signal)]' : 'bg-white/10 text-[var(--sidebar-text)]',
          ].join(' ')}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  )
}
