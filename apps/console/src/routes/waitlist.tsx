import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Server } from 'lucide-react'

import logo from '../assets/logo-square.svg'

export const Route = createFileRoute('/waitlist')({ component: WaitlistPage })

function WaitlistPage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <div aria-hidden="true" className="rz-dot-grid pointer-events-none absolute inset-x-0 top-0 h-[460px] opacity-60" />

      <header className="relative z-10 flex items-center justify-between px-5 py-5 sm:px-8">
        <Link to="/login" aria-label="ResolveZero sign in">
          <img src={logo} alt="ResolveZero" className="size-10" />
        </Link>
        <Link to="/login" className="rz-pill hover:text-[var(--ink)]">
          <ArrowLeft size={11} /> Back to sign in
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-[480px]">
          <div className="rz-card p-7 sm:p-9">
            <p className="rz-eyebrow">Early access</p>
            <h1 className="mt-3 font-[var(--font-display)] text-[32px] font-semibold leading-[1.08] tracking-[-0.055em]">
              Registration isn’t open yet.
            </h1>
            <p className="mt-3 text-[13px] leading-6 text-[var(--muted)]">
              Hosted ResolveZero accounts are being rolled out gradually. We’re not taking signups on this page yet.
            </p>

            <div className="mt-6 rounded-[10px] border border-[var(--line)] bg-[var(--sage)] p-4">
              <p className="flex items-center gap-2 text-[12px] font-medium">
                <Server size={14} className="text-[var(--green)]" />
                Want to run it yourself?
              </p>
              <p className="mt-1.5 text-[11px] leading-5 text-[var(--muted)]">
                The edge and console are self-hostable today. The README covers local setup and deployment.
              </p>
            </div>

            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Link to="/login" className="rz-button-primary flex-1">
                <ArrowLeft size={13} /> Back to sign in
              </Link>
              <a
                href="https://github.com/digitalmio/resolvezero"
                target="_blank"
                rel="noreferrer"
                className="rz-button-secondary flex-1"
              >
                <ExternalLink size={13} /> View on GitHub
              </a>
            </div>
          </div>

          <p className="mt-4 text-center text-[11px] leading-5 text-[var(--muted)]">
            Already have access? <Link to="/login" className="font-medium text-[var(--ink)] underline underline-offset-2">Sign in</Link>.
          </p>
        </div>
      </main>

      <footer className="relative z-10 px-5 pb-6 text-[10px] text-[var(--muted)] sm:px-8">
        Self-hosted friendly · open-source console
      </footer>
    </div>
  )
}
