import { createFileRoute, Link, redirect } from '@tanstack/react-router'
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

function Proof({ index, icon, title, detail }: { index: string; icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="grid grid-cols-[2.25rem_1fr] gap-3 border-t border-white/15 py-4">
      <span className="rz-mono pt-0.5 text-[9px] text-[var(--brand)]">{index}</span>
      <div>
        <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--sidebar-text)]">
          <span className="text-[var(--sidebar-muted)]">{icon}</span>
          {title}
        </p>
        <p className="mt-1 text-[11px] leading-5 text-[var(--sidebar-muted)]">{detail}</p>
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
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)] lg:grid lg:grid-cols-2">
      <section className="relative flex flex-col overflow-hidden bg-[var(--sidebar)] px-5 py-5 text-[var(--sidebar-text)] lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-16 -right-10 select-none rz-font-display text-[18rem] font-extrabold leading-none tracking-[-0.09em] text-white/[0.035] lg:text-[24rem]"
        >
          RØ
        </div>

        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="ResolveZero" className="size-10 shrink-0 invert" />
            <span className="rz-font-display text-[17px] font-bold uppercase tracking-[-0.03em] lg:hidden">
              ResolveZero
            </span>
          </div>
          <span className="text-[8px] font-semibold uppercase tracking-[0.2em] text-[var(--sidebar-muted)]">
            DNS / Privacy
          </span>
        </div>

        <div className="relative z-10 hidden flex-1 flex-col justify-center py-16 lg:flex">
          <p className="mb-5 text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--sidebar-muted)]">
            Open-source DNS firewall
          </p>
          <h1 className="rz-display max-w-[700px] text-[clamp(2.8rem,4.8vw,5.2rem)]">ResolveZero</h1>
          <p className="mt-6 max-w-[430px] text-[16px] leading-7 text-[var(--sidebar-muted)]">
            Your DNS. Your rules. Filter at the edge, resolve local names, and keep the logs in storage you own.
          </p>

          <div className="mt-10 max-w-[430px]">
            <Proof
              index="01"
              icon={<Ban size={12} />}
              title="Filter"
              detail="Block trackers before they connect."
            />
            <Proof
              index="02"
              icon={<House size={12} />}
              title="Resolve"
              detail="Answer .lan names locally, before blocklists or upstream."
            />
            <Proof
              index="03"
              icon={<FileText size={12} />}
              title="Own"
              detail="Compressed query history in your bucket, not someone else's dashboard."
            />
          </div>
        </div>

        <p className="relative z-10 hidden border-t border-white/15 pt-4 text-[8px] font-semibold uppercase tracking-[0.2em] text-[var(--sidebar-muted)] lg:block">
          Private by default · No third-party DNS · Self-hosted friendly
        </p>
      </section>

      <section className="relative flex min-h-[calc(100vh-5rem)] flex-col bg-[var(--paper)] px-5 pb-6 pt-5 sm:px-8 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <div className="flex items-center justify-between">
          <span className="rz-eyebrow">Access / 001</span>
          <span className="rz-pill rz-pill-positive">
            <ShieldCheck size={11} /> Private by default
          </span>
        </div>

        <main className="flex flex-1 items-center justify-center py-10 lg:py-14">
          <div className="w-full max-w-[420px]">
            <div className="border border-[var(--line-strong)] border-t-4 border-t-[var(--brand)] bg-[var(--card)] p-7 sm:p-8">
              <p className="rz-eyebrow">Welcome back</p>
              <h2 className="rz-display mt-3 text-[2.6rem]">Sign in</h2>
              <p className="mt-3 text-[12px] leading-6 text-[var(--muted)]">
                Continue with GitHub to manage your resolver, local DNS, and query history.
              </p>

              <button
                type="button"
                onClick={() => void signIn()}
                disabled={pending}
                className="rz-button-primary mt-7 w-full !py-3 !text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? <LoaderCircle size={16} className="animate-spin" /> : <GitHubMark />}
                {pending ? 'Opening GitHub…' : 'Continue with GitHub'}
              </button>

              {error ? (
                <p role="alert" className="mt-4 border border-[#e7b4ae] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]">
                  {error}
                </p>
              ) : null}
            </div>

            <p className="mt-4 text-center text-[11px] leading-5 text-[var(--muted)]">
              Don’t have an account yet?{' '}
              <Link
                to="/waitlist"
                className="font-semibold text-[var(--ink)] underline decoration-[var(--brand)] decoration-2 underline-offset-4 hover:text-[var(--brand)]"
              >
                Click here
              </Link>
            </p>
          </div>
        </main>

        <footer className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
          Self-hosted friendly · open-source console
        </footer>
      </section>
    </div>
  )
}
