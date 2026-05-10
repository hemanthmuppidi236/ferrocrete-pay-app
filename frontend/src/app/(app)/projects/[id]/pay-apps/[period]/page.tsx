"use client";

import { useEffect, useMemo, useState, useRef, use } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type {
  Project,
  SOVLine,
  ChangeOrder,
  PayApp,
  PayAppDetail,
  BillingLine,
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
  params: Promise<{ id: string; period: string }>;
}) {
  const { id: projectId, period } = use(params);

  const [project, setProject] = useState<Project | null>(null);
  const [payApp, setPayApp] = useState<PayAppDetail | null>(null);
  const [sov, setSov] = useState<SOVLine[]>([]);
  const [cos, setCos] = useState<ChangeOrder[]>([]);
  const [prevCertificates, setPrevCertificates] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

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

  const isReadOnly = payApp?.status && payApp.status !== "draft";

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
            PAY APPLICATION {isReadOnly ? `· ${payApp.status.toUpperCase()}` : "DRAFT"}{" "}
            · APP NO. {payApp.app_no} · PERIOD {payApp.period}
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
          {/* Note banner */}
          <div
            className="glass"
            style={{
              padding: "13px 18px",
              marginBottom: 24,
              borderLeft: isReadOnly
                ? "3px solid var(--status-blue)"
                : "3px solid var(--accent)",
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
              {isReadOnly ? (
                <>
                  <b style={{ color: "var(--status-blue)" }}>
                    {payApp.status.toUpperCase()} ·
                  </b>{" "}
                  Read-only.
                </>
              ) : (
                <>
                  <b style={{ color: "var(--ferrocrete-red)" }}>Tip · </b>
                  Type into <b>This Period</b> to bill this month. The G702
                  sidebar updates live.
                </>
              )}
            </div>
          </div>

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
              title="Approved Change Orders"
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
              <div className="preview-pay-due-label">CURRENT PAYMENT DUE</div>
              <div className="preview-pay-due-value">
                {fmtMoney(totals.currentPaymentDue, { zero: "$0.00" })}
              </div>
              <div className="preview-pay-due-meta">
                Net of {Math.round(parseFloat(project.retention_rate) * 100)}%
                retention &amp; previous applications
              </div>
            </div>

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
          <div style={{ textAlign: "right" }}>This Period</div>
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
                    <span style={{ color: "var(--text-faint)", fontSize: 11, marginLeft: 6 }}>
                      · {pct}%
                    </span>
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
                    <span style={{ color: "var(--text-faint)", fontSize: 11, marginLeft: 6 }}>
                      · {pct}%
                    </span>
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
