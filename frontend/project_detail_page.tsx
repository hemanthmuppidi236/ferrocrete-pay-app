"use client";

import { useEffect, useState, use } from "react";
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
    return () => { cancelled = true; };
  }, [id]);

  if (error) {
    return (
      <div className="page-content">
        <div
          className="glass"
          style={{
            padding: 20,
            borderColor: "rgba(213,59,52,0.30)",
            background: "rgba(213,59,52,0.06)",
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 11,
              color: "var(--ferrocrete-red)",
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Error loading project
          </div>
          <div style={{ fontSize: 14 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page-content">
        <div className="glass" style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
          Loading…
        </div>
      </div>
    );
  }

  const sovTotal = (sov ?? []).reduce(
    (sum: number, l: SOVLine) => sum + parseFloat(l.scheduled_value || "0"),
    0
  );
  const coTotal = (cos ?? [])
    .filter((c: ChangeOrder) => c.status === "approved")
    .reduce(
      (sum: number, c: ChangeOrder) => sum + parseFloat(c.amount || "0"),
      0
    );
  const revisedContract = parseFloat(project.contract_value) + coTotal;

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">PROJECT {project.project_no}</div>
          <h1 className="page-title">{project.name}</h1>
          <div className="page-meta">
            {project.address && <>{project.address} · </>}
            {project.gc_company && <>GC <strong>{project.gc_company}</strong> · </>}
            Contract <strong>{fmtMoney(project.contract_value)}</strong>
            {" · "}Retention <strong>{fmtPct(project.retention_rate)}</strong>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 20,
            marginBottom: 24,
          }}
        >
          <Stat label="Original Contract" value={fmtMoney(project.contract_value)} />
          <Stat label="Approved COs" value={fmtMoney(coTotal)} />
          <Stat label="Revised Contract" value={fmtMoney(revisedContract)} />
        </div>

        <div className="glass" style={{ padding: 28 }}>
          <h2
            style={{
              fontFamily: "EB Garamond, serif",
              fontSize: 24,
              fontWeight: 500,
              marginBottom: 16,
              color: "var(--text-primary)",
              letterSpacing: "-0.01em",
            }}
          >
            Schedule of Values
          </h2>

          {sov === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : sov.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 14 }}>
              No SOV lines yet.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                  <th style={thStyle}>#</th>
                  <th style={{ ...thStyle, textAlign: "left" }}>Description</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Scheduled Value</th>
                </tr>
              </thead>
              <tbody>
                {sov.map((line) => (
                  <tr key={line.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={tdMono}>{line.item_no}</td>
                    <td style={tdProse}>{line.description}</td>
                    <td style={{ ...tdMono, textAlign: "right" }}>
                      {fmtMoney(line.scheduled_value)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={{ paddingTop: 14 }}></td>
                  <td
                    style={{
                      paddingTop: 14,
                      fontFamily: "IBM Plex Mono, monospace",
                      fontSize: 10,
                      letterSpacing: "1.5px",
                      textTransform: "uppercase",
                      color: "var(--text-muted)",
                    }}
                  >
                    Total
                  </td>
                  <td
                    style={{
                      paddingTop: 14,
                      textAlign: "right",
                      fontFamily: "IBM Plex Mono, monospace",
                      fontSize: 16,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    {fmtMoney(sovTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

        <div
          style={{
            marginTop: 24,
            textAlign: "center",
            fontSize: 13,
            color: "var(--text-faint)",
            fontFamily: "IBM Plex Mono, monospace",
            letterSpacing: "0.5px",
          }}
        >
          Pay app draft, change orders, and release tracker — Phase 1B-β.
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass" style={{ padding: 18 }}>
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          color: "var(--text-faint)",
          letterSpacing: "1.5px",
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "EB Garamond, serif",
          fontSize: 26,
          fontWeight: 500,
          color: "var(--text-primary)",
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 8px",
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 500,
};
const tdMono: React.CSSProperties = {
  padding: "10px 8px",
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 13,
  color: "var(--text-body)",
};
const tdProse: React.CSSProperties = {
  padding: "10px 8px",
  fontSize: 15,
  color: "var(--text-body)",
};

function fmtMoney(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return `${Math.round(n * 100)}%`;
}
