import Link from "next/link";

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const params = await searchParams;
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="glass-strong w-full max-w-md p-10">
        <h1 className="font-display text-3xl mb-4" style={{ color: "var(--text-primary)" }}>
          Sign-in failed
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
          {params.message || "Something went wrong during authentication."}
        </p>
        <p className="text-xs mb-8" style={{ color: "var(--text-faint)" }}>
          Common cause: signups are restricted to <span className="font-mono">@ferrocretebuilders.com</span>.
          If you used a different account, sign out of Google and retry with the right one.
        </p>
        <Link href="/login" className="btn btn-accent w-full">
          Try again
        </Link>
      </div>
    </div>
  );
}
