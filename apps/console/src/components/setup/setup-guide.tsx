import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cable, Check, Copy, Download, Laptop, Router, Smartphone } from 'lucide-react'
import { useState } from 'react'

import { slugifyDevice } from '../../lib/device'
import { ensureDotId, getDeviceSetup } from '../../server/device-setup'
import { Button } from '../ui/button'

type Step = 'router' | 'apple' | 'android' | 'other'

const STEPS: { key: Step; label: string }[] = [
  { key: 'router', label: 'Router' },
  { key: 'apple', label: 'iPhone / iPad' },
  { key: 'android', label: 'Android' },
  { key: 'other', label: 'Mac / other' },
]

const STEP_ICONS = {
  router: Router,
  apple: Smartphone,
  android: Smartphone,
  other: Laptop,
} as const

export function SetupGuide({ profileName }: { profileName: string }) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>('router')
  const [device, setDevice] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const { data, isPending, isError } = useQuery({
    queryKey: ['device-setup'],
    queryFn: () => getDeviceSetup(),
  })

  const dot = useMutation({
    mutationFn: () => ensureDotId(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device-setup'] }),
  })

  const slug = slugifyDevice(device)
  // Untagged form is `<base>/<token>`; the edge resolves that as a bare profile.
  const dohUrl = data ? (slug ? `${data.dohBase}/${slug}/${data.token}` : `${data.dohBase}/${data.token}`) : ''
  const dotHost = dot.data?.hostname ?? data?.dotHostname ?? null

  async function copy(key: string, value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  if (isPending) {
    return <div className="rz-card p-5 text-[12px] text-[var(--muted)]">Loading profile details…</div>
  }
  if (isError || !data) {
    return <div className="rz-card p-5 text-[12px] text-[var(--danger)]">Could not load this profile&apos;s setup details.</div>
  }

  return (
    <div className="rz-card overflow-hidden">
      <div className="border-b border-[var(--line)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="rz-section-title">
              <Cable size={14} className="mr-2 inline text-[var(--brand)]" />
              Connect a device
            </h2>
            <p className="mt-1.5 text-[11px] text-[var(--muted)]">
              {profileName} · pick how the device or router can reach ResolveZero.
            </p>
          </div>
        </div>

        <div className="mt-4 max-w-[420px] space-y-1.5">
          <label
            htmlFor="setup-device"
            className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]"
          >
            Device name
          </label>
          <input
            id="setup-device"
            value={device}
            onChange={(event) => setDevice(event.target.value)}
            placeholder="living room tv"
            autoComplete="off"
            spellCheck={false}
            className="rz-input w-full"
          />
          <p className="text-[10px] leading-5 text-[var(--muted)]">
            Optional. The name becomes the device tag, which is how queries are attributed in the log and stats. Leave it
            empty to use one shared, untagged URL for the whole network.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[var(--line)] px-5 py-3">
        {STEPS.map((option) => {
          const Icon = STEP_ICONS[option.key]
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={step === option.key}
              onClick={() => setStep(option.key)}
              className={[
                'flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11px] transition-colors',
                step === option.key
                  ? 'bg-[var(--brand)] text-white'
                  : 'text-[var(--muted)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]',
              ].join(' ')}
            >
              <Icon size={12} />
              {option.label}
            </button>
          )
        })}
      </div>

      <div className="space-y-4 p-5">
        {step === 'router' ? (
          <>
            <Steps
              items={[
                'Open your router’s DNS settings (usually Internet → DNS, or WAN → DNS).',
                'Select DNS-over-HTTPS (DoH) if offered, otherwise DNS-over-TLS (DoT).',
                'Paste one of the addresses below and save. Reconnect clients if the router asks.',
              ]}
            />
            <CopyRow
              label="DoH URL — per device"
              value={dohUrl}
              copied={copied === 'router-doh'}
              onCopy={() => void copy('router-doh', dohUrl)}
            />
            <CopyRow
              label="DoT hostname — whole profile"
              value={dotHost ?? ''}
              placeholder="Generate a hostname under Android, or below"
              copied={copied === 'router-dot'}
              onCopy={dotHost ? () => void copy('router-dot', dotHost) : undefined}
            />
            {!dotHost ? (
              <Button type="button" onClick={() => dot.mutate()} disabled={dot.isPending}>
                {dot.isPending ? 'Generating…' : 'Enable DoT and generate hostname'}
              </Button>
            ) : null}
            <p className="text-[10px] leading-5 text-[var(--muted)]">
              DoH with a device name gives per-device stats. DoT is one hostname for the whole profile — every device
              using it shares the same attribution.
            </p>
          </>
        ) : null}

        {step === 'apple' ? (
          <>
            <Steps
              items={[
                'Download the profile, then open Settings — “Profile Downloaded” appears at the top.',
                'Tap Install, enter the device passcode, and confirm.',
                'Open a browser and reload this page to confirm the device is using ResolveZero.',
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              {slug ? (
                <Button asChild>
                  <a href={`/api/profile/${slug}`} download>
                    <Download size={13} /> Download .mobileconfig
                  </a>
                </Button>
              ) : (
                <Button type="button" disabled>
                  <Download size={13} /> Download .mobileconfig
                </Button>
              )}
              {!slug ? <span className="text-[10px] text-[var(--muted)]">Name the device first</span> : null}
            </div>
            <p className="text-[10px] leading-5 text-[var(--muted)]">
              iOS marks the profile “Unverified” because it is unsigned. That is expected — the profile only points DNS
              at this profile&apos;s DoH URL.
            </p>
          </>
        ) : null}

        {step === 'android' ? (
          <>
            <Steps
              items={[
                'Open Settings → Network & internet → Private DNS.',
                'Choose “Private DNS provider hostname”.',
                'Paste the hostname below and save.',
              ]}
            />
            {dotHost ? (
              <CopyRow
                label="Private DNS hostname"
                value={dotHost}
                copied={copied === 'android-dot'}
                onCopy={() => void copy('android-dot', dotHost)}
              />
            ) : (
              <Button type="button" onClick={() => dot.mutate()} disabled={dot.isPending}>
                {dot.isPending ? 'Generating…' : 'Enable DoT and generate hostname'}
              </Button>
            )}
            {dot.isError ? (
              <p role="alert" className="text-[11px] text-[var(--danger)]">
                {dot.error.message}
              </p>
            ) : null}
            <p className="text-[10px] leading-5 text-[var(--muted)]">
              Android accepts a hostname, not a URL. DoT attribution is per profile, not per device.
            </p>
          </>
        ) : null}

        {step === 'other' ? (
          <>
            <Steps
              items={[
                'Copy the DoH URL below.',
                'Paste it into any app or OS that accepts a custom DoH resolver.',
                'Firefox: Settings → Privacy & Security → DNS over HTTPS → Custom.',
              ]}
            />
            <CopyRow
              label="DoH URL"
              value={dohUrl}
              copied={copied === 'other-doh'}
              onCopy={() => void copy('other-doh', dohUrl)}
            />
          </>
        ) : null}

        <p className="border-t border-[var(--line)] pt-3 text-[10px] leading-5 text-[var(--muted)]">
          Treat these addresses as credentials — anyone who has the URL or hostname can resolve through this profile.
          Each device can get its own URL by naming it above.
        </p>
      </div>
    </div>
  )
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3 text-[11px] leading-5 text-[var(--muted)]">
          <span className="rz-mono mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--paper-2)] text-[9px] text-[var(--ink)]">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

function CopyRow({
  label,
  value,
  placeholder,
  copied,
  onCopy,
}: {
  label: string
  value: string
  placeholder?: string
  copied: boolean
  onCopy?: () => void
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code
          className={[
            'min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--card)] px-3 py-2 font-mono text-[11px]',
            value ? 'text-[var(--ink)]' : 'text-[var(--muted)]',
          ].join(' ')}
        >
          {value || placeholder}
        </code>
        <Button type="button" variant="secondary" onClick={onCopy} disabled={!value || !onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
