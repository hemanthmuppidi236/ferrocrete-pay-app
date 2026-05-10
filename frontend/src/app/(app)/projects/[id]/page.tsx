"use client";

import { useEffect, useState } from "react";
import { use } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type { Project, SOVLine, ChangeOrder } from "@/lib/types";

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [sov, setSov] = useState<SOVLine[] | null>(null);
  const [cos, setCos] = useState<ChangeOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s, c] = await Promise.all([
          api.get<Project>(`/projects/${id}`),
          api.get<SOVLine[]>(`/projects/${id}/sov-lines`),
          api.get<ChangeOrder[]>(`/projects/${id}/change-orders`),
        ]);
        if (cancelled) return;
        setProject(p);
        setSov(s);
        setCos(c);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="glass p-6" style={{ borderColor: "rgba(213,59,52,0.30)" }}>
        <div className="font-mono text-xs" style={{ color: "var(--ferrocrete-red)" }}>
          {error}
        </div>
      </div>
    );
  }

  if (!project) {
    return <div className="glass p-8 text-center" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  }

  const sovTotal = (sov ?? []).reduce((sum, l) => sum + parseFloat(l.scheduled_value || "0"), 0);
  const coTotal = (cos ?? [])
    .filter((c) => c.status === "approved")
    .reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);

  return (
    <div>
      <Link
        href="/projects"
        className="text-sm font-mono uppercase tracking-wider mb-4 inline-block"
        style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}
      >
        ← All projects
      </Link>

      <div className="mb-8">
        <div
          className="font-mono text-xs uppercase mb-2"
          style={{ color: "var(--text-faint)", letterSpacing: "0.15em" }}
        >
          {project.project_no}
        </div>
        <h1
          className="font-display text-5xl mb-3"
          style={{ color: "var(--text-primary)", letterSpacing: "-0.02em" }}
        >
          {project.name}
        </h1>
        {project.gc_company && (
          <div className="text-sm" style={{ color: "var(--text-muted)" }}>
            GC: {project.gc_company}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <Stat
          label="Original Contract"
          value={fmtMoney(project.contract_value)}
        />
        <Stat label="Approved COs" value={fmtMoney(coTotal)} />
        <Stat
          label="Revised Contract"
          value={fmtMoney(parseFloat(project.contract_value) + coTotal)}
        />
      </div>

      <div className="glass p-8">
        <h2
          className="font-display text-2xl mb-4"
          style={{ color: "var(--text-primary)" }}
        >
          Schedule of Values
        </h2>
        {sov === null ? (
          <div style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : sov.length === 0 ? (
          <div className="text-sm" style={{ color: "var(--text-muted)" }}>
            No SOV lines yet.
          </div>
        ) : (
          <div>
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                  <th className="text-left py-2 font-mono text-xs uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
                    #
                  </th>
                  <th className="text-left py-2 font-mono text-xs uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
                    Description
                  </th>
                  <th className="text-right py-2 font-mono text-xs uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
                    Scheduled Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {sov.map((line) => (
                  <tr key={line.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td className="py-2 font-mono text-sm" style={{ color: "var(--text-faint)" }}>
                      {line.item_no}
                    </td>
                    <td className="py-2 text-sm" style={{ color: "var(--text-body)" }}>
                      {line.description}
                    </td>
                    <td className="py-2 text-right font-mono text-sm" style={{ color: "var(--text-body)" }}>
                      {fmtMoney(line.scheduled_value)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="py-3"></td>
                  <td className="py-3 font-mono text-xs uppercase" style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
                    Total
                  </td>
                  <td className="py-3 text-right font-mono text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                    {fmtMoney(sovTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6 text-sm text-center" style={{ color: "var(--text-faint)" }}>
        Pay app draft, change-order management, and release tracker UI coming
        in Phase 1B-β.
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass p-5">
      <div
        className="font-mono text-xs uppercase mb-2"
        style={{ color: "var(--text-muted)", letterSpacing: "0.15em" }}
      >
        {label}
      </div>
      <div
        className="font-display text-2xl"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </div>
    </div>
  );
}

function fmtMoney(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}
