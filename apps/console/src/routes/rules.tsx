import { createFileRoute } from '@tanstack/react-router'
import { ListFilter } from 'lucide-react'
import { PagePlaceholder } from '../components/page-placeholder'

export const Route = createFileRoute('/rules')({ component: Rules })

function Rules() {
  return (
    <PagePlaceholder
      eyebrow="Policy"
      title="Rules"
      description="Block, allow, and zone overrides. Changes propagate to every edge in seconds."
      icon={<ListFilter size={20} />}
    />
  )
}
