"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSignOut() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      disabled={loading}
      className="text-xs font-mono uppercase tracking-widest"
      style={{
        color: "var(--topbar-muted)",
        letterSpacing: "0.15em",
        background: "transparent",
        border: "1px solid transparent",
        padding: "6px 10px",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
      }}
    >
      {loading ? "…" : "Sign out"}
    </button>
  );
}
