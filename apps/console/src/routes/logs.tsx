import { createFileRoute } from '@tanstack/react-router'
import { FileText } from 'lucide-react'
import { PagePlaceholder } from '../components/page-placeholder'

export const Route = createFileRoute('/logs')({ component: Logs })

function Logs() {
  return (
    <PagePlaceholder
      eyebrow="Observability"
      title="Query log"
      description="Search, filter, and export every query. Raw logs are stored in S3 and streamed on demand."
      icon={<FileText size={20} />}
    />
  )
}
