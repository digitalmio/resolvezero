import { LoaderCircle } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { authClient } from '../../lib/auth-client'
import { Button } from '../ui/button'

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export function SignInCard() {
  const [stage, setStage] = useState<'email' | 'code'>('email')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  async function requestCode(event?: FormEvent) {
    event?.preventDefault()
    if (!email.trim()) return
    setPending(true)
    setError(null)
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: 'sign-in',
      })
      if (result.error) {
        setError(result.error.message ?? 'Could not send a code. Try again.')
        return
      }
      setStage('code')
      setInfo(`If ${email.trim()} can sign in, a 6-digit code is on its way.`)
      setCooldown(60)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a code. Try again.')
    } finally {
      setPending(false)
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault()
    if (!code.trim()) return
    setPending(true)
    setError(null)
    try {
      const result = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() })
      if (result.error) {
        setError(result.error.message ?? 'That code is invalid or expired.')
        return
      }
      window.location.assign('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code is invalid or expired.')
      setPending(false)
    }
  }

  async function signInWithGitHub() {
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
            <div className="border border-[var(--line-strong)] border-t-4 border-t-[var(--brand)] bg-[var(--card)] p-7 sm:p-8">
              <p className="rz-eyebrow">Welcome back</p>
              <h2 className="rz-display mt-3 text-[2.6rem]">Sign in</h2>
              <p className="mt-3 text-[12px] leading-6 text-[var(--muted)]">
                No password to lose. We email you a 6-digit code — it proves the address and gets you in.
              </p>

              {stage === 'email' ? (
                <form className="mt-7 space-y-2" onSubmit={requestCode}>
                  <input
                    type="email"
                    autoFocus
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    aria-label="Email address"
                    autoComplete="email"
                    spellCheck={false}
                    autoCapitalize="none"
                    className="rz-input w-full font-mono"
                  />
                  <Button type="submit" size="lg" disabled={pending || !email.trim()} className="w-full">
                    {pending ? <LoaderCircle size={16} className="animate-spin" /> : null}
                    {pending ? 'Sending…' : 'Email me a code'}
                  </Button>
                </form>
              ) : (
                <form className="mt-7 space-y-2" onSubmit={verifyCode}>
                  <input
                    inputMode="numeric"
                    autoFocus
                    required
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    aria-label="6-digit code"
                    autoComplete="one-time-code"
                    className="rz-input w-full text-center font-mono text-[20px] tracking-[0.4em]"
                  />
                  <Button type="submit" size="lg" disabled={pending || code.length < 6} className="w-full">
                    {pending ? <LoaderCircle size={16} className="animate-spin" /> : null}
                    {pending ? 'Checking…' : 'Verify code'}
                  </Button>
                  <div className="flex items-center justify-between pt-1 text-[10px] text-[var(--muted)]">
                    <button
                      type="button"
                      onClick={() => {
                        setStage('email')
                        setCode('')
                        setInfo(null)
                        setError(null)
                      }}
                      className="underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--ink)]"
                    >
                      Use a different email
                    </button>
                    <button
                      type="button"
                      disabled={cooldown > 0 || pending}
                      onClick={() => void requestCode()}
                      className="underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--ink)] disabled:no-underline disabled:opacity-50"
                    >
                      {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                    </button>
                  </div>
                </form>
              )}

              {info ? (
                <p className="mt-4 border border-[var(--line)] bg-[var(--sage)] px-3 py-2 text-[11px] leading-5 text-[var(--ink)]">
                  {info}
                </p>
              ) : null}

              {error ? (
                <p role="alert" className="mt-4 border border-[#e7b4ae] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]">
                  {error}
                </p>
              ) : null}

              <div className="mt-6 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--line)]" />
                <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">or</span>
                <span className="h-px flex-1 bg-[var(--line)]" />
              </div>

              <Button
                type="button"
                variant="secondary"
                onClick={() => void signInWithGitHub()}
                disabled={pending}
                className="mt-4 w-full"
              >
                <GitHubMark />
                Continue with GitHub
              </Button>
            </div>

  )
}
