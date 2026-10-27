import { createFileRoute, redirect } from '@tanstack/react-router'
import { Ban, FileText, House, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import logo from '../assets/logo-square.svg'
import { authClient } from '../lib/auth-client'
import { getSession } from '../server/auth'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const session = await getSession()
    if (session) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** Large brand lockup: the login page is the one place the mark gets room. */
function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-4">
      <span
        className={[
          'flex shrink-0 items-center justify-center border border-[var(--line)] bg-white shadow-[0_10px_30px_rgba(26,32,24,0.09)]',
          compact ? 'size-14 rounded-[16px]' : 'size-20 rounded-[22px]',
        ].join(' ')}
      >
        <img src={logo} alt="" className={compact ? 'size-9' : 'size-14'} />
      </span>
      <span>
        <span
          className={[
            'flex items-center gap-2 font-[var(--font-display)] font-semibold tracking-[-0.055em]',
            compact ? 'text-[26px]' : 'text-[36px]',
          ].join(' ')}
        >
          ResolveZero
          <span className={['rounded-full bg-[var(--lime)]', compact ? 'size-1.5' : 'size-2'].join(' ')} />
        </span>
        <span className={['block text-[var(--muted)]', compact ? 'mt-0.5 text-[11px]' : 'mt-1.5 text-[12px]'].join(' ')}>
          Home DNS firewall
        </span>
      </span>
    </div>
  )
}

function Feature({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-white text-[var(--ink)]">
        {icon}
      </span>
      <div>
        <p className="text-[12px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11px] leading-5 text-[var(--muted)]">{detail}</p>
      </div>
    </div>
  )
}

function LoginPage() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setPending(true)
    setError(null)
    try {
      const result = await authClient.signIn.social({
        provider: 'github',
        callbackURL: '/',
      })
      if (result.error) {
        setError(result.error.message ?? 'GitHub sign-in failed.')
        setPending(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub sign-in failed.')
      setPending(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <div aria-hidden="true" className="rz-dot-grid pointer-events-none absolute inset-x-0 top-0 h-[460px] opacity-60" />

      <header className="relative z-10 flex items-center justify-end px-5 py-5 sm:px-8">
        <span className="rz-pill rz-pill-positive">
          <ShieldCheck size={11} /> Private by default
        </span>
      </header>

      <main className="relative z-10 grid flex-1 items-center gap-12 px-5 pb-16 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:px-16">
        <section className="hidden max-w-[610px] lg:block">
          <BrandLockup />

          <div className="mt-12">
            <p className="rz-eyebrow mb-4">Home DNS firewall</p>
            <h1 className="font-[var(--font-display)] text-[56px] font-semibold leading-[1.02] tracking-[-0.06em]">
              Privacy for every name your home looks up.
            </h1>
            <p className="mt-5 max-w-[470px] text-[14px] leading-7 text-[var(--muted)]">
              ResolveZero filters DNS at the edge, answers your <span className="font-mono">.lan</span> names locally, and
              keeps query history in your own storage.
            </p>
          </div>

          <div className="mt-9 grid max-w-[430px] gap-4">
            <Feature
              icon={<Ban size={15} />}
              title="Block trackers before they connect"
              detail="DNS-level filtering for every device on the network."
            />
            <Feature
              icon={<House size={15} />}
              title="Your names, resolved locally"
              detail="Split-horizon .lan records answered before blocklists or upstream."
            />
            <Feature
              icon={<FileText size={15} />}
              title="A query history you own"
              detail="Compressed raw logs in your bucket, not somebody else's dashboard."
            />
          </div>
        </section>

        <section className="mx-auto w-full max-w-[420px]">
          <div className="mb-7 lg:hidden">
            <BrandLockup compact />
          </div>

          <div className="rz-card p-7 sm:p-8">
            <p className="rz-eyebrow">Welcome back</p>
            <h1 className="mt-2 font-[var(--font-display)] text-[30px] font-semibold tracking-[-0.05em]">Sign in</h1>
            <p className="mt-2 text-[13px] leading-6 text-[var(--muted)]">
              Continue with GitHub to manage your resolver, local DNS, and query history.
            </p>

            <button
              type="button"
              onClick={() => void signIn()}
              disabled={pending}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--ink)] bg-[var(--ink)] px-4 py-2.5 text-[13px] font-medium text-[var(--paper)] transition-colors hover:bg-[#2a3028] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? <LoaderCircle size={16} className="animate-spin" /> : <GitHubMark />}
              {pending ? 'Opening GitHub…' : 'Continue with GitHub'}
            </button>

            {error ? (
              <p role="alert" className="mt-4 rounded-lg border border-[#f0d7c8] bg-[#fff6f1] px-3 py-2 text-[11px] leading-5 text-[#9a3f1b]">
                {error}
              </p>
            ) : null}
          </div>

          <p className="mt-4 text-center text-[11px] leading-5 text-[var(--muted)]">
            Only the account that owns this resolver can access its data.
          </p>
        </section>
      </main>

      <footer className="relative z-10 px-5 pb-6 text-[10px] text-[var(--muted)] sm:px-8">
        Self-hosted friendly · open-source console
      </footer>
    </div>
  )
}
