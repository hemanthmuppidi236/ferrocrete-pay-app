"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="glass-strong w-full max-w-md p-10 text-center">
        <div style={{ color: "var(--text-muted)" }}>Loading…</div>
      </div>
    </div>
  );
}

function LoginForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = useSearchParams();
  const next = params.get("next") || "/projects";

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="glass-strong w-full max-w-md p-10">
        <div className="text-center mb-8">
          <div
            className="font-display text-5xl mb-3"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.02em" }}
          >
            Ferrocrete
          </div>
          <div
            className="font-mono text-xs uppercase tracking-widest"
            style={{ color: "var(--text-muted)", letterSpacing: "0.2em" }}
          >
            Pay Application System
          </div>
        </div>

        <div
          className="text-sm mb-6 text-center"
          style={{ color: "var(--text-muted)" }}
        >
          Sign in with your <span className="font-mono">@ferrocretebuilders.com</span> account.
        </div>

        <button
          onClick={signInWithGoogle}
          disabled={loading}
          className="btn btn-accent w-full text-base"
          style={{ padding: "12px 18px" }}
        >
          {loading ? (
            "Redirecting…"
          ) : (
            <>
              <GoogleIcon /> Continue with Google
            </>
          )}
        </button>

        {error && (
          <div
            className="mt-4 p-3 rounded text-sm"
            style={{
              background: "rgba(213,59,52,0.10)",
              color: "var(--ferrocrete-red)",
              border: "1px solid rgba(213,59,52,0.30)",
            }}
          >
            {error}
          </div>
        )}

        <div
          className="mt-8 pt-6 text-xs text-center"
          style={{
            color: "var(--text-faint)",
            borderTop: "1px solid var(--border)",
          }}
        >
          Restricted to authorized Ferrocrete personnel.
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#fff"
        opacity="0.95"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#fff"
        opacity="0.85"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#fff"
        opacity="0.75"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#fff"
        opacity="0.65"
      />
    </svg>
  );
}
