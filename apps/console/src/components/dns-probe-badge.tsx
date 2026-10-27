import { useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react'

import { checkDnsProbe } from '../server/dashboard'

/**
 * The probe hostname has no public DNS record. Only a browser using our
 * resolver sends the lookup to the edge; the edge records the random nonce.
 * The fetch itself is expected to fail TLS, so we only care that DNS ran.
 */
const PROBE_DOMAIN = 'probe.resolvezero.com'
const ATTEMPTS = 8
const POLL_MS = 350

type Phase = 'checking' | 'active' | 'inactive'

const phaseMeta: Record<
  Phase,
  { label: string; icon: typeof ShieldCheck; className: string; dot: string }
> = {
  checking: {
    label: 'Checking DNS',
    icon: LoaderCircle,
    className: 'border-[var(--line)] bg-white text-[var(--muted)]',
    dot: 'bg-[var(--warning)]',
  },
  active: {
    label: 'Using ResolveZero',
    icon: ShieldCheck,
    className: 'border-[var(--line)] bg-[var(--green-soft)] text-[var(--green)]',
    dot: 'bg-[var(--green)]',
  },
  inactive: {
    label: 'Not using ResolveZero',
    icon: WifiOff,
    className: 'border-[#eadfc4] bg-[#fbf6e9] text-[var(--warning)]',
    dot: 'bg-[var(--warning)]',
  },
}

function randomNonce(profileId: string): string {
  const prefix = profileId.replace(/-/g, '')
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}${suffix}`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function DnsProbeBadge({ profileId }: { profileId: string }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPhase('checking')

    const nonce = randomNonce(profileId)
    const controller = new AbortController()
    const fetchTimeout = setTimeout(() => controller.abort(), 2500)

    // Deliberately no-cors: the lookup is the signal. A certificate for the
    // random hostname is not required (and the request is expected to fail).
    void fetch(`https://${nonce}.${PROBE_DOMAIN}/probe`, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'no-cors',
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(fetchTimeout))

    void (async () => {
      for (let i = 0; i < ATTEMPTS && !cancelled; i += 1) {
        try {
          const status = await checkDnsProbe({ data: nonce })
          if (status.seen) {
            if (!cancelled) setPhase('active')
            return
          }
        } catch {
          // Keep polling; the edge insert may still be in flight.
        }
        await wait(POLL_MS)
      }
      if (!cancelled) setPhase('inactive')
    })()

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(fetchTimeout)
    }
  }, [attempt, profileId])

  const meta = phaseMeta[phase]
  const Icon = meta.icon

  return (
    <span
      role="status"
      aria-live="polite"
      className={[
        'flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium',
        meta.className,
      ].join(' ')}
      title={
        phase === 'active'
          ? 'This browser resolved the ResolveZero canary through our DNS.'
          : phase === 'inactive'
            ? 'This browser did not reach our DNS. If you use another DoH provider, this is expected.'
            : 'Checking which resolver this browser is using.'
      }
    >
      {phase === 'checking' ? (
        <Icon size={12} className="animate-spin" />
      ) : (
        <span className={['size-1.5 rounded-full', meta.dot].join(' ')} />
      )}
      <span className="hidden sm:inline">{meta.label}</span>
      {phase !== 'checking' ? (
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="-mr-1 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
          aria-label="Check DNS again"
          title="Check DNS again"
        >
          <RefreshCw size={11} />
        </button>
      ) : null}
    </span>
  )
}
