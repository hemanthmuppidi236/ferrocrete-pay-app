import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <>
      <header className="topbar">
        <div className="flex items-center gap-6">
          <Link
            href="/projects"
            className="font-display text-2xl"
            style={{ color: "var(--topbar-text)", letterSpacing: "-0.02em" }}
          >
            Ferrocrete
          </Link>
          <nav className="flex items-center gap-4">
            <NavLink href="/projects">Projects</NavLink>
            {/* Future links: <NavLink href="/tracker">Tracker</NavLink> */}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span
            className="font-mono text-xs"
            style={{ color: "var(--topbar-muted)" }}
          >
            {user.email}
          </span>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-6 py-8 max-w-[1400px] w-full mx-auto">
        {children}
      </main>
    </>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-sm font-mono uppercase tracking-wider"
      style={{ color: "var(--topbar-text)", letterSpacing: "0.1em" }}
    >
      {children}
    </Link>
  );
}
