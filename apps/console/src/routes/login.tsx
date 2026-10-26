import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";

import logo from "../assets/logo-square.svg";
import { authClient } from "../lib/auth-client";
import { getSession } from "../server/auth";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const session = await getSession();
    if (session) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function LoginPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL: "/",
      });
      if (result.error) {
        setError(result.error.message ?? "GitHub sign-in failed.");
        setPending(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in failed.");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex items-center gap-3 px-5 py-5 sm:px-8">
        <span className="flex size-9 items-center justify-center rounded-lg border border-[var(--line)] bg-white">
          <img src={logo} alt="" className="size-6" />
        </span>
        <span>
          <span className="block text-[14px] font-semibold tracking-[-0.02em]">ResolveZero</span>
          <span className="block text-[10px] text-[var(--muted)]">Home DNS firewall</span>
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-[390px]">
          <div className="rz-card p-7">
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#fff1ea] text-[var(--accent)] ring-1 ring-[#f7d8c7]">
              <ShieldCheck size={19} />
            </span>
            <h1 className="mt-5 text-[24px] font-semibold tracking-[-0.04em]">Sign in</h1>
            <p className="mt-2 text-[13px] leading-6 text-[var(--muted)]">
              Continue with GitHub to manage your resolver, rules, and query history.
            </p>

            <button
              type="button"
              onClick={() => void signIn()}
              disabled={pending}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-[#111315] bg-[#111315] px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#25282b] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? <LoaderCircle size={16} className="animate-spin" /> : <GitHubMark />}
              {pending ? "Opening GitHub…" : "Continue with GitHub"}
            </button>

            {error ? (
              <p role="alert" className="mt-4 rounded-md border border-[#f0d7c8] bg-[#fff6f1] px-3 py-2 text-[11px] leading-5 text-[#9a3f1b]">
                {error}
              </p>
            ) : null}
          </div>

          <p className="mt-4 text-center text-[11px] leading-5 text-[var(--muted)]">
            Only the account that owns this resolver can access its data.
          </p>
        </div>
      </main>
    </div>
  );
}
