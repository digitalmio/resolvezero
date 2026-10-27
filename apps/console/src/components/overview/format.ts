const REGION_NAMES: Record<string, string> = {
  fra: 'Frankfurt',
  lhr: 'London',
  iad: 'Ashburn',
  sjc: 'San José',
  nrt: 'Tokyo',
  syd: 'Sydney',
  gru: 'São Paulo',
}

export function regionLabel(region: string | null): string {
  if (!region) return '—'
  return REGION_NAMES[region] ?? region.toUpperCase()
}

export function ageLabel(ms: number | null): string {
  if (ms == null) return '—'
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  if (hour < 22) return 'Good evening'
  return 'Good night'
}

/** Keep the meaningful suffix for long tracker hashes. */
export function displayDomain(domain: string): string {
  const [first, ...rest] = domain.split('.')
  if (first && first.length >= 24 && /^[a-f0-9]+$/i.test(first) && rest.length > 2) {
    return `${first.slice(0, 8)}…${rest.slice(-4).join('.')}`
  }
  return domain
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n)
}
