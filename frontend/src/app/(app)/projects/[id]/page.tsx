"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type {
  Project,
  SOVLine,
  ChangeOrder,
  PayApp,
} from "@/lib/types";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";

export default function ProjectDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const [project, setProject] = useState<Project | null>(null);
  const [sov, setSov] = useState<SOVLine[] | null>(null);
  const [cos, setCos] = useState<ChangeOrder[] | null>(null);
  const [payApps, setPayApps] = useState<PayApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, s, c, pa] = await Promise.all([
          api.get<Project>(`/projects/${id}`),
          api.get<SOVLine[]>(`/projects/${id}/sov-lines`),
          api.get<ChangeOrder[]>(`/projects/${id}/change-orders`),
          api.get<PayApp[]>(`/pay-apps?project_id=${id}`),
        ]);
        if (cancelled) return;
        setProject(p);
        setSov(s);
        setCos(c);
        setPayApps(pa);
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
      <div className="page-content">
        <div
          className="glass"
          style={{
            padding: 20,
            borderColor: "rgba(213,59,52,0.30)",
            background: "rgba(213,59,52,0.06)",
          }}
        >
          <div className="form-label" style={{ color: "var(--ferrocrete-red)" }}>
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
        <div
          className="glass"
          style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}
        >
          Loading…
        </div>
      </div>
    );
  }

  const sovTotal = (sov ?? []).reduce(
    (sum, l) => sum + parseFloat(l.scheduled_value || "0"),
    0
  );
  const coTotal = (cos ?? [])
    .filter((c) => c.status === "approved")
    .reduce((sum, c) => sum + parseFloat(c.amount || "0"), 0);
  const revisedContract = parseFloat(project.contract_value) + coTotal;

  // Sort pay apps newest first
  const sortedPayApps = [...(payApps ?? [])].sort((a, b) =>
    b.period.localeCompare(a.period)
  );

  async function handleDelete() {
    if (!project) return;
    setDeleting(true);
    try {
      await api.delete(`/projects/${project.id}`);
      router.push("/projects");
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  const isAdmin = currentUser?.role === "admin";

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">PROJECT {project.project_no}</div>
          <h1 className="page-title">{project.name}</h1>
          <div className="page-meta">
            {project.address && <>{project.address} · </>}
            {project.gc_company && (
              <>
                GC <strong>{project.gc_company}</strong> ·{" "}
              </>
            )}
            Contract <strong>{fmtMoneyShort(project.contract_value)}</strong>
            {" · "}Retention{" "}
            <strong>{Math.round(parseFloat(project.retention_rate) * 100)}%</strong>
          </div>
        </div>
        {isAdmin && (
          <div className="page-actions">
            {confirmingDelete ? (
              <>
                <span
                  style={{
                    fontFamily: "IBM Plex Mono, monospace",
                    fontSize: 11,
                    letterSpacing: 1,
                    color: "var(--ferrocrete-red)",
                    textTransform: "uppercase",
                    marginRight: 10,
                  }}
                >
                  Delete this project?
                </span>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="btn"
                  style={{
                    color: "#fff",
                    background: "var(--ferrocrete-red)",
                    borderColor: "var(--ferrocrete-red)",
                  }}
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="btn btn-ghost"
                style={{ color: "var(--ferrocrete-red)" }}
                title="Permanently archive this project (admin only)"
              >
                Delete project
              </button>
            )}
          </div>
        )}
      </div>

      <div className="page-content">
        <div className="stat-grid">
          <Stat
            label="Original Contract"
            value={fmtMoneyShort(project.contract_value)}
          />
          <Stat label="Approved COs" value={fmtMoneyShort(coTotal)} />
          <Stat label="Revised Contract" value={fmtMoneyShort(revisedContract)} />
        </div>

        {/* Pay Apps section */}
        <div className="section-card glass">
          <div className="section-header">
            <h2 className="section-title">Pay Applications</h2>
            <Link
              href={`/projects/${id}/pay-apps/new`}
              className="btn btn-accent"
            >
              + New Period
            </Link>
          </div>

          {payApps === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : sortedPayApps.length === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                padding: "16px 0",
              }}
            >
              No pay applications yet. Create one to start billing.
            </div>
          ) : (
            <div className="pay-app-list">
              {sortedPayApps.map((pa) => (
                <Link
                  key={pa.id}
                  href={`/projects/${id}/pay-apps/${pa.period}`}
                  className="pay-app-row"
                >
                  <div className="pay-app-row-left">
                    <div className="pay-app-row-period">{pa.period}</div>
                    <div className="pay-app-row-app-no">
                      App #{pa.app_no}
                    </div>
                  </div>
                  <div className="pay-app-row-right">
                    <div className="pay-app-row-amount">
                      {fmtMoneyShort(pa.current_payment_due)}
                    </div>
                    <PayAppStatusPill status={pa.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* SOV section */}
        <div className="section-card glass" style={{ marginTop: 20 }}>
          <h2 className="section-title">Schedule of Values</h2>

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
                  <th style={{ ...thStyle, textAlign: "right" }}>
                    Scheduled Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {sov.map((line) => (
                  <tr
                    key={line.id}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td style={tdMono}>{line.item_no}</td>
                    <td style={tdProse}>{line.description}</td>
                    <td style={{ ...tdMono, textAlign: "right" }}>
                      {fmtMoneyShort(line.scheduled_value)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={{ paddingTop: 14 }}></td>
                  <td style={totalLabelStyle}>Total</td>
                  <td style={totalValueStyle}>{fmtMoneyShort(sovTotal)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass" style={{ padding: 18 }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function PayAppStatusPill({ status }: { status: PayApp["status"] }) {
  const map = {
    draft: "pill-amber",
    submitted: "pill-blue",
    paid: "pill-green",
    void: "pill-muted",
  };
  return <span className={`pill ${map[status]}`}>{status}</span>;
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
const totalLabelStyle: React.CSSProperties = {
  paddingTop: 14,
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};
const totalValueStyle: React.CSSProperties = {
  paddingTop: 14,
  textAlign: "right",
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 16,
  fontWeight: 600,
  color: "var(--text-primary)",
};
