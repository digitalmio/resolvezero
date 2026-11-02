import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Server } from 'lucide-react'

import logo from '../assets/logo-square.svg'
import { Button } from '../components/ui/button'

export const Route = createFileRoute('/waitlist')({ component: WaitlistPage })

function WaitlistPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4 sm:px-8">
        <Link to="/login" className="flex items-center gap-3" aria-label="ResolveZero sign in">
          <img src={logo} alt="" className="size-9" />
          <span className="rz-font-display text-[18px] font-bold uppercase tracking-[-0.035em]">
            ResolveZero
          </span>
        </Link>
        <Link to="/login" className="rz-pill hover:text-[var(--ink)]">
          <ArrowLeft size={11} /> Back to sign in
        </Link>
      </header>

      <main className="grid flex-1 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="relative flex flex-col justify-between overflow-hidden border-b border-[var(--line)] px-5 py-12 sm:px-8 lg:border-b-0 lg:border-r lg:px-14 lg:py-16 xl:px-20">
          <div>
            <p className="rz-eyebrow">Early access / 001</p>
            <h1 className="rz-display mt-5 max-w-[760px] text-[clamp(3.4rem,7.4vw,7rem)]">
              Hosted access is not open yet.
            </h1>
            <p className="mt-6 max-w-[480px] text-[14px] leading-7 text-[var(--muted)]">
              ResolveZero accounts are being rolled out gradually. The hosted service is not taking signups on this page yet.
            </p>
          </div>

          <div className="mt-12 border-t border-[var(--line)] pt-5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
            Self-host today · Hosted soon · Open source
          </div>
        </section>

        <section className="flex items-center justify-center px-5 py-10 sm:px-8 lg:px-12">
          <div className="w-full max-w-[430px]">
            <div className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--card)] p-7 shadow-[var(--shadow-card)] sm:p-8">
              <p className="rz-eyebrow">Two paths</p>
              <h2 className="rz-display mt-3 text-[2.5rem]">Run it yourself.</h2>
              <p className="mt-3 text-[12px] leading-6 text-[var(--muted)]">
                The edge and console are self-hostable now. Bring Postgres and a GitHub OAuth app; the README covers the rest.
              </p>

              <div className="mt-6 border border-[var(--line)] bg-[var(--paper)] p-4">
                <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
                  <Server size={14} className="text-[var(--brand)]" />
                  Self-host
                </p>
                <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
                  Clone the repo, run migrations, start the edge and console. No waitlist.
                </p>
              </div>

              <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                <Button asChild className="flex-1">
                  <a
                    href="https://github.com/digitalmio/resolvezero"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={13} /> View on GitHub
                  </a>
                </Button>
                <Button asChild variant="secondary" className="flex-1">
                  <Link to="/login">
                    <ArrowLeft size={13} /> Sign in
                  </Link>
                </Button>
              </div>
            </div>

            <p className="mt-4 text-center text-[10px] leading-5 text-[var(--muted)]">
              Already have access?{' '}
              <Link to="/login" className="font-semibold text-[var(--ink)] underline decoration-[var(--brand)] decoration-2 underline-offset-4">
                Sign in
              </Link>
              .
            </p>
          </div>
        </section>
      </main>

      <footer className="flex items-center justify-between border-t border-[var(--line)] px-5 py-4 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--muted)] sm:px-8">
        <span>Self-hosted friendly · open-source console</span>
        <span className="hidden sm:inline">DNS / Privacy</span>
      </footer>
    </div>
  )
}
