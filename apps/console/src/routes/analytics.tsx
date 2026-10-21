import { createFileRoute } from '@tanstack/react-router'
import { BarChart3 } from 'lucide-react'
import { PagePlaceholder } from '../components/page-placeholder'

export const Route = createFileRoute('/analytics')({ component: Analytics })

function Analytics() {
  return (
    <PagePlaceholder
      eyebrow="Observability"
      title="Analytics"
      description="Long-range trends, categories, and device breakdowns — sourced from Postgres rollups."
      icon={<BarChart3 size={20} />}
    />
  )
}
