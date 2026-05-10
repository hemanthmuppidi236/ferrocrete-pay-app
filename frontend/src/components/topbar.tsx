"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function Topbar({
  email,
  firstName,
  initials,
}: {
  email: string;
  firstName: string;
  initials: string;
}) {
  const pathname = usePathname() || "";
  const router = useRouter();
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [logoSrc, setLogoSrc] = useState("/logo_white.png");
  const [menuOpen, setMenuOpen] = useState(false);
  const userBlockRef = useRef<HTMLDivElement>(null);

  // Initialize theme from localStorage
  useEffect(() => {
    const stored = (localStorage.getItem("theme") as "light" | "dark" | null) || "light";
    setTheme(stored);
    document.documentElement.dataset.theme = stored;
    document.body.dataset.theme = stored;
    // White logo on dark topbar (both themes have dark topbar)
    setLogoSrc("/logo_white.png");
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (userBlockRef.current && !userBlockRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.body.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Build breadcrumb based on the current path
  const segments = pathname.split("/").filter(Boolean);
  const inProject = segments[0] === "projects" && segments.length > 1;
  let crumbs: React.ReactNode = (
    <span className="breadcrumb-active">Pay Applications</span>
  );
  if (inProject) {
    if (segments[1] === "new") {
      crumbs = (
        <>
          <Link href="/projects" className="breadcrumb-link">
            Pay Applications
          </Link>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-active">New Project</span>
        </>
      );
    } else if (segments[1] === "import") {
      crumbs = (
        <>
          <Link href="/projects" className="breadcrumb-link">
            Pay Applications
          </Link>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-active">Import</span>
        </>
      );
    } else if (segments[2] === "pay-apps") {
      // /projects/:id/pay-apps/(new|:period)
      const projectId = segments[1];
      const sub = segments[3];
      crumbs = (
        <>
          <Link href="/projects" className="breadcrumb-link">
            Pay Applications
          </Link>
          <span className="breadcrumb-sep">/</span>
          <Link
            href={`/projects/${projectId}`}
            className="breadcrumb-link"
          >
            Project
          </Link>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-active">
            {sub === "new" ? "New Period" : sub}
          </span>
        </>
      );
    } else {
      crumbs = (
        <>
          <Link href="/projects" className="breadcrumb-link">
            Pay Applications
          </Link>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-active">Project</span>
        </>
      );
    }
  }

  const isProjects = segments[0] === "projects";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link href="/projects" aria-label="Home">
          <Image
            src={logoSrc}
            alt="Ferrocrete Builders, Inc."
            width={170}
            height={38}
            className="topbar-logo"
            priority
          />
        </Link>
        <div className="topbar-sep" />
        <div className="breadcrumb">{crumbs}</div>
      </div>

      <div className="topbar-right">
        <Link
          href="/projects"
          className={`nav-pill ${isProjects ? "active" : ""}`}
        >
          Projects
        </Link>

        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? "◐" : "☾"}
        </button>

        <div
          className="topbar-user"
          ref={userBlockRef}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <div className="avatar">{initials}</div>
          <div className="topbar-username">{firstName}</div>

          <div className={`user-menu ${menuOpen ? "open" : ""}`}>
            <div
              className="user-menu-item"
              style={{
                fontSize: 11,
                fontFamily: "IBM Plex Mono, monospace",
                color: "var(--text-faint)",
                letterSpacing: "0.5px",
                cursor: "default",
                pointerEvents: "none",
                textTransform: "lowercase",
              }}
            >
              {email}
            </div>
            <div className="user-menu-divider" />
            <button
              type="button"
              className="user-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                signOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
