"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { api, ApiError, formatApiError } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import type {
  Project,
  SOVLine,
  ChangeOrder,
  PayApp,
  PayAppDetail,
  BillingLine,
  PayAppStatus,
} from "@/lib/types";
import {
  calculateG702Totals,
  fmtMoney,
  fmtMoneyShort,
} from "@/lib/payAppMath";

/**
 * Pay App Draft screen.
 *
 * The G702 sidebar recalculates on every keystroke using client-side math
 * that mirrors the backend. When the user saves, we PUT the billings to
 * /pay-apps/{id}/billings, the backend recomputes and persists totals.
 *
 * The Excel and PDF generation are async: click → backend regenerates →
 * we receive a signed URL → trigger browser download.
 */
export default function PayAppDraftPage({
  params,
}: {
  params: { id: string; period: string };
}) {
  const { id: projectId, period } = params;
  const { user } = useCurrentUser();
  const role = user?.role ?? "viewer";
  const isAdmin = role === "admin";
  const canMoveWorkflow = role === "admin" || role === "accountant";

  const [project, setProject] = useState<Project | null>(null);
  const [payApp, setPayApp] = useState<PayAppDetail | null>(null);
  const [sov, setSov] = useState<SOVLine[]>([]);
  const [cos, setCos] = useState<ChangeOrder[]>([]);
  const [prevCertificates, setPrevCertificates] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // Workflow action state
  const [workflowBusy, setWorkflowBusy] = useState<
    "none" | "submit" | "approve" | "reject" | "send" | "paid" | "recall" | "unapprove" | "unsend"
  >("none");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  // billings state — keyed by sov_line_id or co_id
  // Each holds previous/this_period/stored
  type Billing = {
    sov_line_id: string | null;
    change_order_id: string | null;
    previous_work: string;
    this_period_work: string;
    materials_stored: string;
  };
  const [billings, setBillings] = useState<Record<string, Billing>>({});

  // Auto-save status
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Action button states
  const [generating, setGenerating] = useState<"none" | "excel" | "pdf">("none");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // First find the pay app id from period
        const allPas = await api.get<PayApp[]>(
          `/pay-apps?project_id=${projectId}&period=${period}`
        );
        if (allPas.length === 0) {
          throw new ApiError(404, "Pay app not found for this period");
        }
        const payAppId = allPas[0].id;

        const [p, pa, s, c] = await Promise.all([
          api.get<Project>(`/projects/${projectId}`),
          api.get<PayAppDetail>(`/pay-apps/${payAppId}`),
          api.get<SOVLine[]>(`/projects/${projectId}/sov-lines`),
          api.get<ChangeOrder[]>(`/projects/${projectId}/change-orders`),
        ]);

        if (cancelled) return;

        setProject(p);
        setPayApp(pa);
        setSov(s);
        setCos(c);
        setPrevCertificates(parseFloat(pa.previous_certificates || "0"));

        // Seed billings from server
        const seeded: Record<string, Billing> = {};
        for (const b of pa.billings ?? []) {
          const key = b.sov_line_id || b.change_order_id || "";
          if (!key) continue;
          seeded[key] = {
            sov_line_id: b.sov_line_id,
            change_order_id: b.change_order_id,
            previous_work: b.previous_work || "0",
            this_period_work: b.this_period_work || "0",
            materials_stored: b.materials_stored || "0",
          };
        }
        setBillings(seeded);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, period]);

  // Billings are only editable while the pay app is in draft. Once it goes
  // to the accountant → Raz → GC chain, the math is frozen.
  const isReadOnly = !!(payApp?.status && payApp.status !== "draft");

  // ─── Live G702 calculation ─────────────────────────────────
  const totals = useMemo(() => {
    const billingsArr: BillingLine[] = Object.values(billings).map((b) => ({
      sov_line_id: b.sov_line_id,
      change_order_id: b.change_order_id,
      previous_work: b.previous_work,
      this_period_work: b.this_period_work,
      materials_stored: b.materials_stored,
    }));
    return calculateG702Totals({
      contractValue: project ? parseFloat(project.contract_value) : 0,
      retentionRate: project ? parseFloat(project.retention_rate) : 0,
      previousCertificates: prevCertificates,
      sovLines: sov,
      changeOrders: cos,
      billings: billingsArr,
    });
  }, [project, sov, cos, billings, prevCertificates]);

  // ─── Cell updaters ─────────────────────────────────────────
  function updateBilling(
    key: string,
    sovId: string | null,
    coId: string | null,
    field: "this_period_work" | "previous_work" | "materials_stored",
    value: string
  ) {
    // Sanitize: allow only digits + one decimal
    let clean = value.replace(/[^\d.]/g, "");
    const parts = clean.split(".");
    if (parts.length > 2) clean = parts[0] + "." + parts.slice(1).join("");

    setBillings((prev) => {
      const existing = prev[key] || {
        sov_line_id: sovId,
        change_order_id: coId,
        previous_work: "0",
        this_period_work: "0",
        materials_stored: "0",
      };
      return {
        ...prev,
        [key]: { ...existing, [field]: clean },
      };
    });
    scheduleSave();
  }

  function scheduleSave() {
    if (isReadOnly) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveBillings();
    }, 900);
  }

  async function saveBillings() {
    if (!payApp || isReadOnly) return;
    try {
      const payload = {
        billings: Object.values(billings).map((b) => ({
          sov_line_id: b.sov_line_id,
          change_order_id: b.change_order_id,
          previous_work: numOrZero(b.previous_work),
          this_period_work: numOrZero(b.this_period_work),
          materials_stored: numOrZero(b.materials_stored),
        })),
      };
      await api.put(`/pay-apps/${payApp.id}/billings`, payload);
      setSaveState("saved");
    } catch (e) {
      console.error("Save failed", e);
      setSaveState("error");
    }
  }

  // ─── Generate Excel/PDF ────────────────────────────────────
  async function generate(kind: "excel" | "pdf") {
    if (!payApp) return;
    setGenerating(kind);
    try {
      // Force save first
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        await saveBillings();
      }
      const endpoint =
        kind === "excel"
          ? `/pay-apps/${payApp.id}/generate-excel`
          : `/pay-apps/${payApp.id}/generate-pdf`;
      const result = await api.post<{ download_url: string }>(endpoint);
      // Trigger browser download
      window.open(result.download_url, "_blank");
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status}: ${e.detail}` : String(e);
      alert(`Failed to generate ${kind}: ${msg}`);
    } finally {
      setGenerating("none");
    }
  }

  // ─── Workflow transitions ──────────────────────────────────
  // Each helper hits the matching backend endpoint, refreshes the local
  // payApp state, and surfaces errors inline (not as alert()).

  async function refreshPayApp() {
    if (!payApp) return;
    try {
      const fresh = await api.get<PayAppDetail>(`/pay-apps/${payApp.id}`);
      setPayApp(fresh);
    } catch {
      /* non-fatal — the in-place state remains */
    }
  }

  async function flushPendingSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      await saveBillings();
    }
  }

  async function submitForApproval() {
    if (!payApp) return;
    setWorkflowError(null);
    setWorkflowBusy("submit");
    try {
      await flushPendingSave();
      await api.post(`/pay-apps/${payApp.id}/submit-for-approval`);
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  async function approve() {
    if (!payApp) return;
    setWorkflowError(null);
    setWorkflowBusy("approve");
    try {
      await api.post(`/pay-apps/${payApp.id}/approve`);
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  async function reject() {
    if (!payApp) return;
    if (!rejectReason.trim()) {
      setWorkflowError("Please write a reason — the accountant will see it.");
      return;
    }
    setWorkflowError(null);
    setWorkflowBusy("reject");
    try {
      await api.post(`/pay-apps/${payApp.id}/reject`, { reason: rejectReason.trim() });
      setRejectMode(false);
      setRejectReason("");
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  async function sendToGc() {
    if (!payApp || !project) return;
    const gcEmail = (project.gc_contact_email || "").trim();
    const ok = gcEmail
      ? confirm(`Send pay app #${payApp.app_no} to ${gcEmail}? Files will be attached.`)
      : confirm("This project has no GC email on file. Mark as submitted (you'll send via their portal)?");
    if (!ok) return;
    setWorkflowError(null);
    setWorkflowBusy("send");
    try {
      await api.post(`/pay-apps/${payApp.id}/send-to-gc`);
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  // ─── Revert helpers ─────────────────────────────────────────
  // Three "undo" transitions. Each prompts for confirmation since reverts are
  // unusual actions and shouldn't be triggered by a stray click.

  async function recall() {
    if (!payApp) return;
    if (!confirm("Recall this submission and move it back to draft? Admins will no longer see it in their approval queue.")) return;
    setWorkflowError(null);
    setWorkflowBusy("recall");
    try {
      await api.post(`/pay-apps/${payApp.id}/recall`);
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  async function unapprove() {
    if (!payApp) return;
    if (!confirm("Send this approved pay app back to draft? The accountant will be notified.")) return;
    setWorkflowError(null);
    setWorkflowBusy("unapprove");
    try {
      await api.post(`/pay-apps/${payApp.id}/unapprove`);
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  async function unsend() {
    if (!payApp) return;
    if (!confirm("Move this back to 'approved'? Note: if an email was sent to the GC, it has already been delivered — this only changes the app's status.")) return;
    setWorkflowError(null);
    setWorkflowBusy("unsend");
    try {
      await api.post(`/pay-apps/${payApp.id}/unsend`);
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

  async function markPaid() {
    if (!payApp) return;
    const defaultAmount = parseFloat(payApp.current_payment_due || "0").toFixed(2);
    const input = prompt("Amount received from the GC:", defaultAmount);
    if (input === null) return;
    const amt = parseFloat(input);
    if (isNaN(amt) || amt <= 0) {
      setWorkflowError("Enter a positive dollar amount.");
      return;
    }
    setWorkflowError(null);
    setWorkflowBusy("paid");
    try {
      await api.post(`/pay-apps/${payApp.id}/mark-paid`, { paid_amount: amt.toFixed(2) });
      await refreshPayApp();
    } catch (e) {
      setWorkflowError(formatApiError(e));
    } finally {
      setWorkflowBusy("none");
    }
  }

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
            Error
          </div>
          <div style={{ fontSize: 14 }}>{error}</div>
          <div className="form-actions">
            <Link
              href={`/projects/${projectId}`}
              className="btn btn-ghost"
            >
              Back to project
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!project || !payApp) {
    return (
      <div className="page-content">
        <div className="glass" style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
          Loading…
        </div>
      </div>
    );
  }

  const approvedCos = cos.filter((co) => co.status === "approved");
  const totalRow =
    sov.reduce((s, l) => s + parseFloat(l.scheduled_value || "0"), 0) +
    approvedCos.reduce((s, c) => s + parseFloat(c.amount || "0"), 0);

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            Pay application {isReadOnly ? `· ${payApp.status}` : "· Draft"}{" "}
            · App no. {payApp.app_no} · Period {payApp.period}
          </div>
          <h1 className="page-title">{project.name}</h1>
          <div className="page-meta">
            {project.address && <>{project.address} · </>}
            {project.gc_company && (
              <>
                GC <strong>{project.gc_company}</strong> ·{" "}
              </>
            )}
            Retention{" "}
            <strong>{Math.round(parseFloat(project.retention_rate) * 100)}%</strong>
          </div>
        </div>
        <div className="page-actions">
          <Link
            href={`/projects/${projectId}`}
            className="btn btn-ghost"
          >
            ← Project
          </Link>
        </div>
      </div>

      <div className="body-grid">
        <div className="sov-area">
          {/* Status / rejection banner */}
          <StatusBanner payApp={payApp} />

          {/* SOV section */}
          <SovTable
            title="Base Contract"
            sovLines={sov}
            cos={[]}
            billings={billings}
            project={project}
            isReadOnly={!!isReadOnly}
            onUpdate={updateBilling}
          />

          {/* Change Orders section */}
          {approvedCos.length > 0 && (
            <SovTable
              title="Approved change orders"
              sovLines={[]}
              cos={approvedCos}
              billings={billings}
              project={project}
              isReadOnly={!!isReadOnly}
              onUpdate={updateBilling}
            />
          )}

          <div style={{ marginTop: 24, fontSize: 12, color: "var(--text-faint)", fontFamily: "IBM Plex Mono, monospace", letterSpacing: "0.5px" }}>
            Total schedule of values: <strong>{fmtMoneyShort(totalRow)}</strong>
          </div>
        </div>

        {/* G702 Live Preview Sidebar */}
        <aside className="preview-sidebar">
          <div className="glass-strong preview-glass">
            <div className="preview-eyebrow">LIVE PREVIEW · AIA G702</div>
            <div className="preview-title">Application No. {payApp.app_no}</div>
            <div className="preview-subtitle">
              Period ending {payApp.period_to}
            </div>

            <PreviewLine label="Original contract sum" value={totals.originalContract} />
            <PreviewLine
              label="Net change by COs"
              value={totals.approvedCoTotal}
              muted
              showSign
            />
            <PreviewLine
              label="Revised contract sum"
              value={totals.revisedContract}
            />

            <div className="preview-divider" />

            <PreviewLine
              label="Total completed & stored"
              value={totals.totalCompletedToDate}
            />
            <PreviewLine
              label="Less retention"
              value={-totals.retentionHeld}
              muted
            />
            <PreviewLine
              label="Total earned less retention"
              value={totals.earnedLessRetention}
            />
            <PreviewLine
              label="Less previous certificates"
              value={-totals.previousCertificates}
              muted
            />

            <div className="preview-pay-due">
              <div className="preview-pay-due-label">Current payment due</div>
              <div className="preview-pay-due-value">
                {fmtMoney(totals.currentPaymentDue, { zero: "$0.00" })}
              </div>
              <div className="preview-pay-due-meta">
                Net of {Math.round(parseFloat(project.retention_rate) * 100)}%
                retention &amp; previous applications
              </div>
            </div>

            {/* ───── Workflow action panel ───── */}
            <WorkflowActions
              payApp={payApp}
              project={project}
              isAdmin={isAdmin}
              canMoveWorkflow={canMoveWorkflow}
              busy={workflowBusy}
              error={workflowError}
              rejectMode={rejectMode}
              rejectReason={rejectReason}
              onSubmitForApproval={submitForApproval}
              onApprove={approve}
              onStartReject={() => { setWorkflowError(null); setRejectMode(true); }}
              onCancelReject={() => { setRejectMode(false); setRejectReason(""); setWorkflowError(null); }}
              onChangeRejectReason={setRejectReason}
              onConfirmReject={reject}
              onSendToGc={sendToGc}
              onMarkPaid={markPaid}
              onRecall={recall}
              onUnapprove={unapprove}
              onUnsend={unsend}
            />

            <div className="preview-actions">
              <button
                className="btn"
                onClick={() => generate("excel")}
                disabled={generating !== "none"}
              >
                {generating === "excel" ? "Generating…" : "Download G703 (xlsx)"}
              </button>
              <button
                className="btn"
                onClick={() => generate("pdf")}
                disabled={generating !== "none"}
              >
                {generating === "pdf" ? "Generating…" : "Download G702 (PDF)"}
              </button>
            </div>

            <div className="preview-status">
              <span
                className="dot"
                style={{
                  background:
                    saveState === "saved"
                      ? "var(--status-green)"
                      : saveState === "error"
                        ? "var(--status-red)"
                        : saveState === "saving"
                          ? "var(--status-amber)"
                          : "var(--text-faint)",
                }}
              />
              {saveState === "idle" && "Ready"}
              {saveState === "saving" && "Saving…"}
              {saveState === "saved" && "Saved"}
              {saveState === "error" && "Save failed"}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────

function PreviewLine({
  label,
  value,
  muted,
  showSign,
}: {
  label: string;
  value: number;
  muted?: boolean;
  showSign?: boolean;
}) {
  const sign = showSign && value > 0 ? "+" : "";
  return (
    <div className={`preview-line${muted ? " muted" : ""}`}>
      <div className="preview-line-label">{label}</div>
      <div className="preview-line-value">
        {sign}
        {fmtMoney(value)}
      </div>
    </div>
  );
}

function SovTable({
  title,
  sovLines,
  cos,
  billings,
  project,
  isReadOnly,
  onUpdate,
}: {
  title: string;
  sovLines: SOVLine[];
  cos: ChangeOrder[];
  billings: Record<string, { previous_work: string; this_period_work: string; materials_stored: string }>;
  project: Project;
  isReadOnly: boolean;
  onUpdate: (
    key: string,
    sovId: string | null,
    coId: string | null,
    field: "this_period_work" | "previous_work" | "materials_stored",
    value: string
  ) => void;
}) {
  const retRate = parseFloat(project.retention_rate);

  return (
    <div className="sov-section">
      <div className="sov-section-label">{title}</div>
      <div className="glass sov-table">
        <div className="sov-row sov-row-header">
          <div>Item</div>
          <div>Description</div>
          <div style={{ textAlign: "right" }}>Scheduled</div>
          <div style={{ textAlign: "right" }}>Previous</div>
          <div style={{ textAlign: "right" }}>This period</div>
          <div style={{ textAlign: "right" }}>Total</div>
          <div style={{ textAlign: "right" }}>Retention</div>
        </div>

        {sovLines.map((line) => {
          const b = billings[line.id];
          const sched = parseFloat(line.scheduled_value || "0");
          const prev = parseFloat(b?.previous_work || "0");
          const thisP = parseFloat(b?.this_period_work || "0");
          const stored = parseFloat(b?.materials_stored || "0");
          const total = prev + thisP + stored;
          const pct = sched > 0 ? Math.round((total / sched) * 100) : 0;
          const ret = total * retRate;

          return (
            <div key={line.id} className="sov-row">
              <div className="sov-cell-level">{line.item_no || "·"}</div>
              <div className="sov-cell-desc">{line.description}</div>
              <div className="sov-cell-num faded">
                {sched === 0 ? "—" : fmtMoneyShort(sched)}
              </div>
              <div className="sov-cell-num primary">{fmtMoney(prev, { zero: "$0" })}</div>
              <div>
                {isReadOnly ? (
                  <div className="sov-cell-num primary">
                    {fmtMoney(thisP, { zero: "—" })}
                  </div>
                ) : (
                  <input
                    className="input-num"
                    inputMode="decimal"
                    value={b?.this_period_work || ""}
                    placeholder="—"
                    onChange={(e) =>
                      onUpdate(line.id, line.id, null, "this_period_work", e.target.value)
                    }
                  />
                )}
              </div>
              <div className="sov-cell-num primary">
                {total === 0 ? (
                  "—"
                ) : (
                  <>
                    {fmtMoney(total)}
                    <div className="sov-cell-pct">{pct}% complete</div>
                  </>
                )}
              </div>
              <div className="sov-cell-num">{ret === 0 ? "—" : fmtMoney(ret)}</div>
            </div>
          );
        })}

        {cos.map((co) => {
          const b = billings[co.id];
          const sched = parseFloat(co.amount || "0");
          const prev = parseFloat(b?.previous_work || "0");
          const thisP = parseFloat(b?.this_period_work || "0");
          const stored = parseFloat(b?.materials_stored || "0");
          const total = prev + thisP + stored;
          const pct = sched > 0 ? Math.round((total / sched) * 100) : 0;
          const ret = co.has_retention ? total * retRate : 0;

          return (
            <div key={co.id} className="sov-row">
              <div className="sov-cell-level" style={{ color: "var(--ferrocrete-red)" }}>
                {co.co_no}
              </div>
              <div className="sov-cell-desc">{co.description}</div>
              <div className="sov-cell-num faded">
                {sched === 0 ? "—" : fmtMoneyShort(sched)}
              </div>
              <div className="sov-cell-num primary">{fmtMoney(prev, { zero: "$0" })}</div>
              <div>
                {isReadOnly ? (
                  <div className="sov-cell-num primary">
                    {fmtMoney(thisP, { zero: "—" })}
                  </div>
                ) : (
                  <input
                    className="input-num"
                    inputMode="decimal"
                    value={b?.this_period_work || ""}
                    placeholder="—"
                    onChange={(e) =>
                      onUpdate(co.id, null, co.id, "this_period_work", e.target.value)
                    }
                  />
                )}
              </div>
              <div className="sov-cell-num primary">
                {total === 0 ? (
                  "—"
                ) : (
                  <>
                    {fmtMoney(total)}
                    <div className="sov-cell-pct">{pct}% complete</div>
                  </>
                )}
              </div>
              <div className="sov-cell-num">{ret === 0 ? "—" : fmtMoney(ret)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function numOrZero(s: string): string {
  const n = parseFloat(s);
  return isNaN(n) ? "0" : String(n);
}


// ─── Status banner (top of pay-app page) ────────────────────────
// Replaces the old generic "SUBMITTED · Read-only" tag with status-aware
// copy: shows who submitted/approved/rejected, when, and any rejection
// reason coming back to a re-opened draft.

function StatusBanner({ payApp }: { payApp: PayApp }) {
  const status = payApp.status;
  const wasRejected = status === "draft" && !!payApp.rejection_reason && !!payApp.rejected_at;

  let accent = "var(--accent)";
  let label = "";
  let body: React.ReactNode = null;

  if (wasRejected) {
    accent = "var(--ferrocrete-red)";
    label = "Sent back for revision";
    body = (
      <>
        Admin asked for changes:
        <blockquote style={{
          borderLeft: "3px solid var(--ferrocrete-red)", margin: "8px 0 4px",
          padding: "4px 12px", background: "rgba(213,59,52,0.06)",
          whiteSpace: "pre-wrap", fontFamily: "EB Garamond, serif",
        }}>{payApp.rejection_reason}</blockquote>
        Make the changes below and resubmit.
      </>
    );
  } else if (status === "draft") {
    label = "Draft";
    body = <>Type into <b>This period</b> to bill this month. The G702 sidebar updates live.</>;
  } else if (status === "pending_approval") {
    accent = "var(--status-amber)";
    label = "Pending approval";
    body = <>Submitted for admin approval{payApp.submitted_for_approval_at ? ` on ${fmtDate(payApp.submitted_for_approval_at)}` : ""}. Read-only until approved or sent back.</>;
  } else if (status === "approved") {
    accent = "var(--status-blue)";
    label = "Approved";
    body = <>Approved{payApp.approved_at ? ` on ${fmtDate(payApp.approved_at)}` : ""} — ready to send to the GC.</>;
  } else if (status === "submitted") {
    accent = "var(--status-blue)";
    label = "Sent to client";
    const where = payApp.sent_to_gc_email ? ` via ${payApp.sent_to_gc_email}` : " (submitted manually)";
    body = <>Sent{payApp.sent_to_gc_at ? ` on ${fmtDate(payApp.sent_to_gc_at)}` : ""}{where}.</>;
  } else if (status === "paid") {
    accent = "var(--status-green)";
    label = "Paid";
    body = <>Paid{payApp.paid_at ? ` on ${fmtDate(payApp.paid_at)}` : ""}{payApp.paid_amount ? ` — ${fmtMoney(parseFloat(payApp.paid_amount))}` : ""}.</>;
  } else if (status === "void") {
    accent = "var(--ferrocrete-red)";
    label = "Void";
    body = <>This pay app has been voided.</>;
  }

  return (
    <div
      className="glass"
      style={{
        padding: "13px 18px",
        marginBottom: 24,
        borderLeft: `3px solid ${accent}`,
        borderRadius: "var(--radius)",
      }}
    >
      <div
        style={{
          fontSize: 14,
          color: "var(--text-body)",
          fontFamily: "EB Garamond, serif",
        }}
      >
        <b style={{ color: accent }}>{label} · </b>
        {body}
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  // Strip time + tz for the banner; full datetime is too noisy.
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}


// ─── Workflow actions (in the G702 sidebar) ────────────────────
// Status-dependent buttons that move the pay app through the lifecycle.
// Hidden entirely when the current user has no permission to act.

function WorkflowActions({
  payApp, project,
  isAdmin, canMoveWorkflow,
  busy, error,
  rejectMode, rejectReason,
  onSubmitForApproval, onApprove, onStartReject, onCancelReject,
  onChangeRejectReason, onConfirmReject, onSendToGc, onMarkPaid,
  onRecall, onUnapprove, onUnsend,
}: {
  payApp: PayApp;
  project: Project;
  isAdmin: boolean;
  canMoveWorkflow: boolean;
  busy: "none" | "submit" | "approve" | "reject" | "send" | "paid" | "recall" | "unapprove" | "unsend";
  error: string | null;
  rejectMode: boolean;
  rejectReason: string;
  onSubmitForApproval: () => void;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onChangeRejectReason: (s: string) => void;
  onConfirmReject: () => void;
  onSendToGc: () => void;
  onMarkPaid: () => void;
  onRecall: () => void;
  onUnapprove: () => void;
  onUnsend: () => void;
}) {
  const status: PayAppStatus = payApp.status;
  const gcEmail = (project.gc_contact_email || "").trim();

  // Decide which buttons (if any) belong in the panel.
  let panel: React.ReactNode = null;

  if (status === "draft" && canMoveWorkflow) {
    panel = (
      <>
        <button
          className="btn dash-btn-red"
          onClick={onSubmitForApproval}
          disabled={busy !== "none"}
          style={{ width: "100%" }}
        >
          {busy === "submit" ? "Sending…" : "Send for approval →"}
        </button>
        <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 8,
                      fontFamily: "EB Garamond, serif" }}>
          Admins will be notified by email to review and approve.
        </div>
      </>
    );
  } else if (status === "pending_approval" && canMoveWorkflow) {
    // Admin: Approve / Reject (or reject-mode textarea) + Recall.
    // Accountant (non-admin): Recall only.
    panel = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {isAdmin && rejectMode && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label className="form-label">Reason for rejection</label>
            <textarea
              className="input"
              value={rejectReason}
              onChange={e => onChangeRejectReason(e.target.value)}
              rows={4}
              placeholder="What needs to change?"
              style={{ fontFamily: "EB Garamond, serif", fontSize: 14, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" onClick={onCancelReject}
                      disabled={busy !== "none"} style={{ flex: 1 }}>
                Cancel
              </button>
              <button className="btn dash-btn-red" onClick={onConfirmReject}
                      disabled={busy !== "none" || !rejectReason.trim()} style={{ flex: 1 }}>
                {busy === "reject" ? "Sending…" : "Send back"}
              </button>
            </div>
          </div>
        )}
        {isAdmin && !rejectMode && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" onClick={onStartReject}
                    disabled={busy !== "none"} style={{ flex: 1 }}>
              Reject
            </button>
            <button className="btn btn-accent" onClick={onApprove}
                    disabled={busy !== "none"} style={{ flex: 1 }}>
              {busy === "approve" ? "Approving…" : "Approve ✓"}
            </button>
          </div>
        )}
        {!rejectMode && (
          <RevertButton
            onClick={onRecall}
            busy={busy === "recall"}
            disabled={busy !== "none"}
            label="Recall submission"
            help={isAdmin
              ? "Move back to draft (cancels this approval request)."
              : "Pull back before admin reviews — moves to draft."}
          />
        )}
      </div>
    );
  } else if (status === "approved" && canMoveWorkflow) {
    panel = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          className="btn btn-accent"
          onClick={onSendToGc}
          disabled={busy !== "none"}
          style={{ width: "100%" }}
        >
          {busy === "send"
            ? "Sending…"
            : gcEmail
              ? `Email to GC (${gcEmail})`
              : "Mark as submitted (manual)"}
        </button>
        {!gcEmail && (
          <div style={{ fontSize: 12, color: "var(--status-amber)",
                        fontFamily: "EB Garamond, serif" }}>
            ⚠ No GC email on file for this project — submit through their portal
            using the downloaded files, then click above to mark it sent.
          </div>
        )}
        {isAdmin && (
          <RevertButton
            onClick={onUnapprove}
            busy={busy === "unapprove"}
            disabled={busy !== "none"}
            label="Send back to draft"
            help="Un-approve and reopen for editing (notifies the submitter)."
          />
        )}
      </div>
    );
  } else if (status === "submitted" && canMoveWorkflow) {
    panel = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          className="btn btn-accent"
          onClick={onMarkPaid}
          disabled={busy !== "none"}
          style={{ width: "100%" }}
        >
          {busy === "paid" ? "Recording…" : "Mark as paid"}
        </button>
        <RevertButton
          onClick={onUnsend}
          busy={busy === "unsend"}
          disabled={busy !== "none"}
          label="Undo send"
          help="Move back to 'approved'. Doesn't unsend any email already delivered."
        />
      </div>
    );
  } else {
    return null;    // nothing to do for this user/status combo
  }

  return (
    <div style={{
      marginTop: 18, paddingTop: 16,
      borderTop: "1px solid var(--border)",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {panel}
      {error && (
        <div style={{
          fontSize: 13, color: "var(--ferrocrete-red)",
          fontFamily: "EB Garamond, serif", marginTop: 6,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}


// Small ghost-styled revert button used in three places (recall / unapprove /
// unsend). Visually de-emphasized so it never competes with the primary action.

function RevertButton({
  onClick, busy, disabled, label, help,
}: {
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  label: string;
  help: string;
}) {
  return (
    <div style={{
      marginTop: 4, paddingTop: 10,
      borderTop: "1px dashed var(--border)",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <button
        className="btn btn-ghost"
        onClick={onClick}
        disabled={disabled}
        style={{ width: "100%", fontSize: 13, padding: "8px 14px" }}
      >
        {busy ? "Working…" : `↩ ${label}`}
      </button>
      <div style={{ fontSize: 11.5, color: "var(--text-faint)",
                    fontFamily: "EB Garamond, serif", textAlign: "center" }}>
        {help}
      </div>
    </div>
  );
}
