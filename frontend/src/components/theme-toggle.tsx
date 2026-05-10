"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as "light" | "dark" | null;
    const initial = stored ?? "light";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
    document.body.dataset.theme = initial;
  }, []);

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.body.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  return (
    <button
      onClick={toggle}
      title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      className="text-xs font-mono"
      style={{
        color: "var(--topbar-muted)",
        background: "transparent",
        border: "1px solid var(--topbar-sep)",
        padding: "4px 10px",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
      }}
    >
      {theme === "light" ? "◐" : "◑"}
    </button>
  );
}
