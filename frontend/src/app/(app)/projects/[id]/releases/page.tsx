"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, formatApiError } from "@/lib/api";
import type {
  Project,
  ReleaseTracker,
  PayApp,
  Sub,
} from "@/lib/types";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";

export default function ProjectReleasesPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const [project, setProject] = useState<Project | null>(null);
  const [trackers, setTrackers] = useState<ReleaseTracker[] | null>(null);
  const [payApps, setPayApps] = useState<PayApp[] | null>(null);
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, t, pa, s] = await Promise.all([
          api.get<Project>(`/projects/${id}`),
          api.get<ReleaseTracker[]>(`/release-trackers?project_id=${id}`),
          api.get<PayApp[]>(`/pay-apps?project_id=${id}`),
          api.get<Sub[]>(`/projects/${id}/subs`),
        ]);
        if (cancelled) return;
        setProject(p);
        setTrackers(t);
        setPayApps(pa);
        setSubs(s);
      } catch (e) {
        if (cancelled) return;
        setError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const canEdit =
    currentUser?.role === "admin" ||
    currentUser?.role === "accountant" ||
    currentUser?.role === "pe";

  if (error && !project) {
    return (
      <div className="page-content">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
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

  const trackerList = trackers ?? [];
  const sortedTrackers = [...trackerList].sort((a, b) =>
    b.period.localeCompare(a.period)
  );

  // Pay apps that don't yet have a release tracker
  const trackerByPeriod = new Map(trackerList.map((t) => [t.period, t]));
  const payAppsWithoutTracker = (payApps ?? []).filter(
    (pa) => !trackerByPeriod.has(pa.period)
  );

  async function createForPayApp(pa: PayApp) {
    if (!canEdit) return;
    setCreating(pa.id);
    try {
      const tracker = await api.post<ReleaseTracker>("/release-trackers", {
        project_id: id,
        period: pa.period,
        pay_app_id: pa.id,
      });
      router.push(`/projects/${id}/releases/${tracker.period}`);
    } catch (e) {
      setError(formatApiError(e));
      setCreating(null);
    }
  }

  const hasSubs = (subs ?? []).length > 0;

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">PROJECT {project.project_no}</div>
          <h1 className="page-title">Release Trackers</h1>
          <div className="page-meta">
            {project.name} ·{" "}
            <Link
              href={`/projects/${id}`}
              style={{ color: "var(--accent-text)" }}
            >
              ← back to project
            </Link>
            {" · "}
            <Link
              href={`/projects/${id}/subs`}
              style={{ color: "var(--accent-text)" }}
            >
              Manage subs
            </Link>
          </div>
        </div>
      </div>

      <div className="page-content">
        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        )}

        {!hasSubs && (
          <div
            className="glass"
            style={{
              padding: 16,
              marginBottom: 16,
              borderColor: "var(--accent-border)",
              background: "var(--accent-dim)",
              fontSize: 14,
            }}
          >
            ℹ No subs on this project yet. Trackers will be empty until you{" "}
            <Link
              href={`/projects/${id}/subs`}
              style={{ color: "var(--accent-text)", fontWeight: 500 }}
            >
              add subs
            </Link>
            .
          </div>
        )}

        {/* Pay apps without trackers — quick "create" buttons */}
        {canEdit && payAppsWithoutTracker.length > 0 && (
          <div className="section-card glass" style={{ marginBottom: 20 }}>
            <h2 className="section-title">Create missing trackers</h2>
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              These pay apps don&apos;t have a release tracker yet:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {payAppsWithoutTracker.map((pa) => (
                <div
                  key={pa.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    background: "var(--accent-dim)",
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--accent-border)",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      minWidth: 70,
                    }}
                  >
                    {pa.period}
                  </div>
                  <div style={{ flex: "1 1 auto", fontSize: 14 }}>
                    App #{pa.app_no} ·{" "}
                    <span style={{ color: "var(--text-muted)" }}>
                      {fmtMoneyShort(pa.current_payment_due)} due
                    </span>
                  </div>
                  <button
                    onClick={() => createForPayApp(pa)}
                    disabled={creating !== null}
                    className="btn btn-accent"
                  >
                    {creating === pa.id ? "Creating…" : "Create tracker"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tracker list */}
        <div className="section-card glass">
          <h2 className="section-title">All release trackers</h2>

          {trackers === null ? (
            <div style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : sortedTrackers.length === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                padding: "16px 0",
              }}
            >
              No release trackers yet. They&apos;re auto-created when you make a
              new pay app, or you can create one above for an existing pay app.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sortedTrackers.map((t) => (
                <Link
                  key={t.id}
                  href={`/projects/${id}/releases/${t.period}`}
                  className="pay-app-row"
                >
                  <div className="pay-app-row-left">
                    <div className="pay-app-row-period">{t.period}</div>
                    <div className="pay-app-row-app-no">
                      <WorkflowDots tracker={t} />
                    </div>
                  </div>
                  <div className="pay-app-row-right">
                    <div className="pay-app-row-amount">
                      {t.invoice_amount
                        ? fmtMoneyShort(t.invoice_amount)
                        : "—"}
                    </div>
                    <WorkflowStatus tracker={t} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function WorkflowDots({ tracker }: { tracker: ReleaseTracker }) {
  const steps = [
    { key: "req", on: tracker.requested_releases, label: "Requested" },
    { key: "ver", on: tracker.verified_releases, label: "Verified" },
    { key: "app", on: tracker.approved, label: "Approved" },
    { key: "snt", on: tracker.sent_to_gc, label: "Sent" },
  ];
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 5,
        fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
        fontSize: 10,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: 1,
      }}
    >
      {steps.map((s) => (
        <span
          key={s.key}
          style={{
            color: s.on ? "var(--status-green)" : "var(--text-faint)",
          }}
          title={s.label}
        >
          {s.on ? "●" : "○"} {s.label}
        </span>
      ))}
    </span>
  );
}

function WorkflowStatus({ tracker }: { tracker: ReleaseTracker }) {
  let label = "Draft";
  let cls = "pill-amber";
  if (tracker.sent_to_gc) {
    label = "Sent";
    cls = "pill-green";
  } else if (tracker.approved) {
    label = "Approved";
    cls = "pill-blue";
  } else if (tracker.verified_releases) {
    label = "Verified";
    cls = "pill-blue";
  } else if (tracker.requested_releases) {
    label = "Requested";
    cls = "pill-amber";
  }
  return <span className={`pill ${cls}`}>{label}</span>;
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="glass"
      style={{
        padding: 14,
        marginBottom: 16,
        borderColor: "rgba(213,59,52,0.30)",
        background: "rgba(213,59,52,0.06)",
        fontSize: 14,
        color: "var(--ferrocrete-red)",
      }}
    >
      {message}
      <button
        onClick={onDismiss}
        style={{
          float: "right",
          background: "none",
          border: "none",
          color: "var(--ferrocrete-red)",
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}
