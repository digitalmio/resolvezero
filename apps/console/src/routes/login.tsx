import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { Ban, FileText, House } from 'lucide-react'
import type { ReactNode } from 'react'

import logo from '../assets/logo-square.svg'
import { SignInCard } from '../components/auth/sign-in-card'
import { getSession } from '../server/auth'

export const Route = createFileRoute('/login')({
  // Better Auth redirects rejected OAuth callbacks here with ?error=<code>.
  validateSearch: (search: Record<string, unknown>) => {
    const error = typeof search.error === 'string' ? search.error.slice(0, 64) : undefined
    return error ? { error } : {}
  },
  beforeLoad: async () => {
    const session = await getSession()
    if (session) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function authErrorMessage(error: string | undefined): string | null {
  if (!error) return null
  if (error === 'signup_disabled' || error === 'invite_only') {
    return 'This beta is invite-only. Ask for an invite to sign in.'
  }
  return 'Sign-in failed. Try again, or ask for an invite.'
}

function Proof({ index, icon, title, detail }: { index: string; icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="grid grid-cols-[2.25rem_1fr] gap-3 border-t border-dashed border-white/20 py-4">
      <span className="rz-mono pt-0.5 text-[9px] text-[var(--signal)]">{index}</span>
      <div>
        <p className="flex items-center gap-2 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-[var(--sidebar-text)]">
          <span className="text-[var(--sidebar-muted)]">{icon}</span>
          {title}
        </p>
        <p className="mt-1.5 text-[11px] leading-5 text-[var(--sidebar-muted)]">{detail}</p>
      </div>
    </div>
  )
}

function LoginPage() {
  const { error } = Route.useSearch()
  const message = authErrorMessage(error)
  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)] lg:grid lg:grid-cols-2">
      <section className="relative flex flex-col overflow-hidden bg-[var(--sidebar)] px-5 py-5 text-[var(--sidebar-text)] lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 -right-8 hidden select-none rz-serif text-[20rem] italic leading-none text-white/[0.05] lg:block lg:text-[28rem]"
        >
          RØ
        </div>

        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logo} alt="ResolveZero" className="size-10 shrink-0 invert" />
            <span className="rz-font-display text-[17px] font-semibold tracking-[-0.03em] lg:hidden">
              ResolveZero
            </span>
          </div>
          <span className="border border-[var(--signal)] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--signal)]">
            Beta / Invite only
          </span>
        </div>

        <div className="relative z-10 hidden flex-1 flex-col justify-center py-16 lg:flex">
          <p className="mb-6 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--sidebar-muted)]">
            01 — Open-source DNS firewall
          </p>
          <h1 className="rz-hero-title max-w-[600px]">
            Your DNS.
            <br />
            Your rules.
          </h1>
          <p className="mt-7 max-w-[430px] text-[14px] leading-6 text-[var(--sidebar-muted)]">
            Filter at the edge, resolve local names, and keep the logs in storage you own.
            No third-party resolver in the middle.
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

        <p className="relative z-10 hidden justify-between border-t border-dashed border-white/20 pt-4 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--sidebar-muted)] lg:flex">
          <span>Private by default</span>
          <span>No third-party DNS</span>
          <span>Self-hosted friendly</span>
        </p>
      </section>

      <section className="relative flex min-h-[calc(100vh-5rem)] flex-col bg-[var(--paper)] px-5 pb-6 pt-5 sm:px-8 lg:min-h-screen lg:px-14 lg:py-12 xl:px-20">
        <main className="flex flex-1 items-center justify-center py-10 lg:py-14">
          <div className="w-full max-w-[420px]">
            {message ? (
              <p
                role="alert"
                className="mb-3 border border-[#e7b4ae] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]"
              >
                {message}
              </p>
            ) : null}
            <SignInCard />

            <p className="mt-5 text-center font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
              No account yet?{' '}
              <Link
                to="/waitlist"
                className="font-medium text-[var(--ink)] underline decoration-[var(--green)] decoration-2 underline-offset-4 hover:text-[var(--green)]"
              >
                Join the waitlist
              </Link>
            </p>
          </div>
        </main>

        <footer className="flex justify-between border-t border-[var(--line-strong)] pt-4 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">
          <span>Self-hosted friendly</span>
          <span>Open-source console</span>
        </footer>
      </section>
    </div>
  )
}
