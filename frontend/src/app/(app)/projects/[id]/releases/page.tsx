"use client";
import { ErrorBanner } from "@/components/ErrorBanner";

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
import { trackerStageSummary, trackerStatus } from "@/lib/releaseStage";

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
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualPeriod, setManualPeriod] = useState("");
  const [manualInvoice, setManualInvoice] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
  const isAdmin = currentUser?.role === "admin";

  async function deleteTracker(t: ReleaseTracker) {
    if (!isAdmin) return;
    setDeletingId(t.id);
    try {
      await api.delete(`/release-trackers/${t.id}`);
      setTrackers((prev) => (prev ?? []).filter((x) => x.id !== t.id));
      setConfirmDeleteId(null);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setDeletingId(null);
    }
  }

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

  // Back-enter a tracker for an arbitrary period (e.g. historical data with no
  // pay app in the system). Subs + prior-period lines carry forward; amounts
  // start at zero.
  async function createForPeriod() {
    if (!canEdit) return;
    const period = manualPeriod.trim();
    if (!/^\d{2}-\d{2}$/.test(period)) {
      setError("Period must be in YY-MM format (e.g. 26-03).");
      return;
    }
    setAddingManual(true);
    try {
      const body: {
        project_id: string;
        period: string;
        invoice_amount?: string;
      } = { project_id: id, period };
      const inv = manualInvoice.trim();
      if (inv !== "") body.invoice_amount = inv;
      const tracker = await api.post<ReleaseTracker>("/release-trackers", body);
      router.push(`/projects/${id}/releases/${tracker.period}`);
    } catch (e) {
      setError(formatApiError(e));
      setAddingManual(false);
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <h2 className="section-title" style={{ marginBottom: 0 }}>
              All release trackers
            </h2>
            {canEdit && (
              <button
                className="btn"
                onClick={() => {
                  setShowManualAdd((v) => !v);
                  setManualPeriod("");
                  setManualInvoice("");
                }}
              >
                {showManualAdd ? "Cancel" : "＋ Add tracker for a period"}
              </button>
            )}
          </div>

          {showManualAdd && canEdit && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "flex-end",
                gap: 12,
                padding: 14,
                marginBottom: 16,
                background: "var(--accent-dim)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--accent-border)",
              }}
            >
              <div>
                <label className="form-label">Period (YY-MM) *</label>
                <input
                  type="text"
                  className="input"
                  value={manualPeriod}
                  onChange={(e) => setManualPeriod(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !addingManual) createForPeriod();
                  }}
                  placeholder="e.g. 26-03"
                  style={{ width: 120 }}
                />
              </div>
              <div>
                <label className="form-label">Invoice amount (optional)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  className="input"
                  value={manualInvoice}
                  onChange={(e) => setManualInvoice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !addingManual) createForPeriod();
                  }}
                  placeholder="0.00"
                  style={{ width: 160 }}
                />
              </div>
              <button
                className="btn btn-accent"
                onClick={createForPeriod}
                disabled={addingManual}
              >
                {addingManual ? "Adding…" : "Add tracker"}
              </button>
              <div
                className="form-help"
                style={{
                  flexBasis: "100%",
                  color: "var(--text-muted)",
                  fontSize: 12,
                }}
              >
                For back-entering a historical period that has no pay app. Subs
                and prior-period lines carry forward automatically; amounts start
                at zero and can be edited on the tracker.
              </div>
            </div>
          )}

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
              new pay app, you can create one above for an existing pay app, or
              use &ldquo;Add tracker for a period&rdquo; to back-enter a past
              period.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sortedTrackers.map((t) => (
                <div key={t.id} className="pay-app-row" style={{ gap: 12 }}>
                  <Link
                    href={`/projects/${id}/releases/${t.period}`}
                    style={{
                      display: "flex",
                      flex: "1 1 auto",
                      minWidth: 0,
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 14,
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <div className="pay-app-row-left">
                      <div className="pay-app-row-period">{t.period}</div>
                      <div
                        className="pay-app-row-app-no"
                        style={{ color: t.overdue_count ? "var(--status-red)" : undefined }}
                      >
                        {trackerStageSummary(t)}
                        {t.overdue_count ? ` · ${t.overdue_count} overdue` : ""}
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
                  {isAdmin &&
                    (confirmDeleteId === t.id ? (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexShrink: 0,
                        }}
                      >
                        <button
                          onClick={() => deleteTracker(t)}
                          disabled={deletingId === t.id}
                          className="btn"
                          style={{
                            color: "#fff",
                            background: "var(--ferrocrete-red)",
                            borderColor: "var(--ferrocrete-red)",
                          }}
                        >
                          {deletingId === t.id ? "Deleting…" : "Yes, delete"}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={deletingId === t.id}
                          className="btn btn-ghost"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(t.id)}
                        className="btn btn-ghost"
                        style={{ color: "var(--ferrocrete-red)", flexShrink: 0 }}
                        title="Permanently delete this release tracker (admin only)"
                      >
                        Delete
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function WorkflowStatus({ tracker }: { tracker: ReleaseTracker }) {
  const { label, cls } = trackerStatus(tracker);
  return <span className={`pill ${cls}`}>{label}</span>;
}
