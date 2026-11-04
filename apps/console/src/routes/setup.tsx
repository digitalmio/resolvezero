import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { DnsProbeBadge } from '../components/dns-probe-badge'
import { PageHeader } from '../components/page-header'
import { SetupGuide } from '../components/setup/setup-guide'
import { Button } from '../components/ui/button'
import { getDeviceSetup } from '../server/device-setup'

export const Route = createFileRoute('/setup')({ component: SetupPage })

function SetupPage() {
  const [probeKey, setProbeKey] = useState(0)
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['device-setup'],
    queryFn: () => getDeviceSetup(),
  })

  const header = (
    <PageHeader
      eyebrow="Network"
      title="Setup"
      description="Point a router, phone, or computer at ResolveZero. Start with the device name, then copy the address for the way that device connects."
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading setup details…" /></div>
  if (isError || !data) {
    return (
      <div className="space-y-6">
        {header}
        <PageError title="Could not load setup details." onRetry={() => void refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}

      <SetupGuide profileName={data.profileName} />

      <div className="rz-card p-5">
        <h2 className="rz-section-title">Verify</h2>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          After saving the new DNS settings, reload this page. The check below only tests the device you are on.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <DnsProbeBadge key={probeKey} profileId={data.profileId} />
          <Button type="button" variant="secondary" size="sm" onClick={() => setProbeKey((value) => value + 1)}>
            <RefreshCw size={12} /> Check again
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to="/logs">
              <FileText size={12} /> Open query log
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
