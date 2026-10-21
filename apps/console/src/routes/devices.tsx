import { createFileRoute } from '@tanstack/react-router'
import { Monitor } from 'lucide-react'
import { PagePlaceholder } from '../components/page-placeholder'

export const Route = createFileRoute('/devices')({ component: Devices })

function Devices() {
  return (
    <PagePlaceholder
      eyebrow="Network"
      title="Devices"
      description="DoH devices are identified by their device tag. UDP sources are identified by public IP only."
      icon={<Monitor size={20} />}
    />
  )
}
