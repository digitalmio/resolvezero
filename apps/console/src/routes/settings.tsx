import { createFileRoute } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { PagePlaceholder } from '../components/page-placeholder'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  return (
    <PagePlaceholder
      eyebrow="Account"
      title="Settings"
      description="Profile, upstream, retention, API keys, and access controls."
      icon={<Settings size={20} />}
    />
  )
}
