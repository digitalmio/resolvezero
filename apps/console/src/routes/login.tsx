import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { Ban, FileText, House, LoaderCircle } from 'lucide-react'
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

/** Brand mark: the signet stands alone on the white panel. */
function BrandLockup() {
  return <img src={logo} alt="ResolveZero" className="size-11 shrink-0 lg:size-14" />
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
    <div className="flex min-h-screen flex-col bg-[var(--paper)] text-[var(--ink)] lg:grid lg:grid-cols-2">
      <section className="relative flex flex-col border-b border-[var(--line)] bg-white px-5 py-5 sm:px-8 lg:min-h-screen lg:border-b-0 lg:border-r lg:px-14 lg:py-12 xl:px-20">
        <BrandLockup />

        <div className="hidden max-w-[540px] flex-1 flex-col justify-center py-16 lg:flex">
          <h1 className="font-[var(--font-display)] text-[46px] font-semibold leading-[1.03] tracking-[-0.06em]">
            Privacy for every name your home looks up.
          </h1>
          <p className="mt-5 max-w-[470px] text-[14px] leading-7 text-[var(--muted)]">
            ResolveZero filters DNS at the edge, answers your <span className="font-mono">.lan</span> names locally, and
            keeps query history in your own storage.
          </p>
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
        </div>

        <p className="hidden text-[10px] text-[var(--muted)] lg:block">Self-hosted friendly · open-source console</p>
      </section>

      <section className="relative flex flex-1 flex-col overflow-hidden px-5 pb-8 pt-4 sm:px-8 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <div aria-hidden="true" className="rz-dot-grid pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-50" />

        <main className="relative z-10 flex flex-1 items-center justify-center py-8 lg:py-12">
          <div className="w-full max-w-[420px]">
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
              Don’t have an account yet?{' '}
              <Link
                to="/waitlist"
                className="font-medium text-[var(--ink)] underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--green)]"
              >
                Click here
              </Link>
            </p>
          </div>
        </main>

        <footer className="relative z-10 text-center text-[10px] text-[var(--muted)] lg:hidden">
          Self-hosted friendly · open-source console
        </footer>
      </section>
    </div>
  )
}
