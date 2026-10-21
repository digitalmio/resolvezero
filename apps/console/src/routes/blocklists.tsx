import { createFileRoute } from '@tanstack/react-router'
import { Layers3 } from 'lucide-react'
import { PagePlaceholder } from '../components/page-placeholder'

export const Route = createFileRoute('/blocklists')({ component: Blocklists })

function Blocklists() {
  return (
    <PagePlaceholder
      eyebrow="Policy"
      title="Blocklists"
      description="Subscribe to public lists, track sync health, and see exactly what each source contributes."
      icon={<Layers3 size={20} />}
    />
  )
}
