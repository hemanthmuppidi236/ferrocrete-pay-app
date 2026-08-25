"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, formatApiError } from "@/lib/api";
import type {
  Project,
  ReleaseTrackerDetail,
  ReleaseLine,
  ReleaseUnbilledEntry,
  ReleaseType,
  Sub,
  Waiver,
} from "@/lib/types";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { ErrorBanner } from "@/components/ErrorBanner";

export default function ReleaseTrackerDetailPage({
  params,
}: {
  params: { id: string; period: string };
}) {
  const { id: projectId, period } = params;
  const { user: currentUser } = useCurrentUser();

  const [project, setProject] = useState<Project | null>(null);
  const [tracker, setTracker] = useState<ReleaseTrackerDetail | null>(null);
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [waivers, setWaivers] = useState<Waiver[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Local edit state — initialized from tracker on load, edited freely, saved on action
  const [lines, setLines] = useState<ReleaseLine[]>([]);
  const [unbilled, setUnbilled] = useState<ReleaseUnbilledEntry[]>([]);
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceOverridden, setInvoiceOverridden] = useState(false);
  const [buildertrendTotal, setBuildertrendTotal] = useState("");
  const [lessMisc, setLessMisc] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Step 1: load the tracker by listing then getting detail
        const list = await api.get<ReleaseTrackerDetail[]>(
          `/release-trackers?project_id=${projectId}&period=${period}`
        );
        if (list.length === 0) {
          if (!cancelled)
            setError(
              "No release tracker for this period. Go back to create one."
            );
          return;
        }
        const trackerId = list[0].id;
        const [detail, p, s, w] = await Promise.all([
          api.get<ReleaseTrackerDetail>(`/release-trackers/${trackerId}`),
          api.get<Project>(`/projects/${projectId}`),
          api.get<Sub[]>(`/projects/${projectId}/subs?include_inactive=true`),
          api.get<Waiver[]>(`/release-trackers/${trackerId}/waivers`),
        ]);
        if (cancelled) return;
        setProject(p);
        setTracker(detail);
        setSubs(s);
        setWaivers(w);
        setLines(detail.lines ?? []);
        setUnbilled(detail.unbilled_entries ?? []);
        setInvoiceAmount(detail.invoice_amount ?? "");
        setInvoiceOverridden(detail.invoice_amount_overridden);
        setBuildertrendTotal(detail.buildertrend_total ?? "");
        setLessMisc(detail.less_misc_field_expenses ?? "");
      } catch (e) {
        if (cancelled) return;
        setError(
          formatApiError(e)
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, period]);

  const canEdit =
    currentUser?.role === "admin" ||
    currentUser?.role === "accountant" ||
    currentUser?.role === "pe";

  // Index waivers by (release_line_id, waiver_type) for quick lookup
  const waiverIndex = useMemo(() => {
    const m = new Map<string, Waiver>();
    for (const w of waivers) {
      m.set(`${w.release_line_id}:${w.waiver_type}`, w);
    }
    return m;
  }, [waivers]);

  // Build sub tree info for grouping lines
  const subById = useMemo(() => {
    const m = new Map<string, Sub>();
    for (const s of subs ?? []) m.set(s.id, s);
    return m;
  }, [subs]);

  // Group lines: those whose sub has parent_sub_id under their parent's row.
  // We render top-level lines first; child lines indented underneath their parent.
  const orderedLines = useMemo(() => {
    if (lines.length === 0) return [];
    const byId = new Map(lines.map((l) => [l.sub_id, l]));
    const childrenByParent = new Map<string | null, ReleaseLine[]>();
    for (const ln of lines) {
      const sub = subById.get(ln.sub_id);
      const parentId = sub?.parent_sub_id ?? null;
      // Only group under parent if parent has a line in this tracker too
      const effectiveParent = parentId && byId.has(parentId) ? parentId : null;
      if (!childrenByParent.has(effectiveParent))
        childrenByParent.set(effectiveParent, []);
      childrenByParent.get(effectiveParent)!.push(ln);
    }

    // Sort each level by sub name
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => (a.sub_name ?? "").localeCompare(b.sub_name ?? ""));
    }

    // Walk tree depth-first to produce display order with depth info
    const out: { line: ReleaseLine; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      const kids = childrenByParent.get(parent) ?? [];
      for (const ln of kids) {
        out.push({ line: ln, depth });
        walk(ln.sub_id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [lines, subById]);

  // Totals
  const billedTotal = lines.reduce(
    (s, l) => s + parseFloat(String(l.billed_amount) || "0"),
    0
  );
  const checkTotal = lines.reduce(
    (s, l) => s + parseFloat(String(l.check_amount) || "0"),
    0
  );
  const unbilledTotal = unbilled.reduce(
    (s, u) => s + parseFloat(String(u.amount) || "0"),
    0
  );
  const invoiceAmountNum = parseFloat(invoiceAmount || "0");
  const buildertrendNum = parseFloat(buildertrendTotal || "0");
  const lessMiscNum = parseFloat(lessMisc || "0");
  // Buildertrend reconciliation: BT total - misc - sum of checks should ~= 0
  const btReconDiff = buildertrendNum - lessMiscNum - checkTotal;

  function updateLine(subId: string, patch: Partial<ReleaseLine>) {
    setLines((prev) =>
      prev.map((l) => (l.sub_id === subId ? { ...l, ...patch } : l))
    );
  }

  function updateUnbilled(idx: number, patch: Partial<ReleaseUnbilledEntry>) {
    setUnbilled((prev) =>
      prev.map((u, i) => (i === idx ? { ...u, ...patch } : u))
    );
  }

  function flashSaved() {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }

  async function saveAll() {
    if (!tracker) return;
    setSaving(true);
    try {
      // Save header/workflow metadata
      const metaPatch: Record<string, unknown> = {
        invoice_amount: invoiceAmount ? String(parseFloat(invoiceAmount)) : null,
        invoice_amount_overridden: invoiceOverridden,
        buildertrend_total: buildertrendTotal
          ? String(parseFloat(buildertrendTotal))
          : null,
        less_misc_field_expenses: lessMisc ? String(parseFloat(lessMisc)) : "0",
      };
      await api.patch(`/release-trackers/${tracker.id}`, metaPatch);

      // Save lines (full replace)
      await api.put(`/release-trackers/${tracker.id}/lines`, {
        lines: lines.map((l) => ({
          sub_id: l.sub_id,
          billed_amount: String(parseFloat(String(l.billed_amount) || "0")),
          check_amount: String(parseFloat(String(l.check_amount) || "0")),
          release_type: l.release_type,
          exception: l.exception,
          prev_month_status: l.prev_month_status,
        })),
      });

      // Save unbilled entries (full replace)
      const unbilledPayload = unbilled.map((u, i) => ({
        description: u.description,
        amount: String(parseFloat(String(u.amount) || "0")),
        sort_order: u.sort_order ?? i,
      }));
      await api.put(
        `/release-trackers/${tracker.id}/unbilled-entries`,
        unbilledPayload
      );

      // Refetch so local state reflects what the server actually persisted
      // (totals, server-coerced values, line IDs for newly inserted rows).
      try {
        const fresh = await api.get<ReleaseTrackerDetail>(
          `/release-trackers/${tracker.id}`
        );
        setTracker(fresh);
        setLines(fresh.lines ?? []);
        setUnbilled(fresh.unbilled_entries ?? []);
      } catch {
        // Refetch is non-fatal — local state may be slightly stale but the
        // save itself succeeded.
      }

      flashSaved();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleWorkflow(key: keyof typeof workflowKeys) {
    if (!tracker) return;
    try {
      const newVal = !tracker[key as "requested_releases"];
      const res = await api.patch<ReleaseTrackerDetail>(
        `/release-trackers/${tracker.id}`,
        { [key]: newVal }
      );
      setTracker((prev) => (prev ? { ...prev, ...res } : prev));
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  if (error && !tracker) {
    return (
      <div className="page-content">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <Link
          href={`/projects/${projectId}/releases`}
          style={{ color: "var(--accent-text)" }}
        >
          ← back to release trackers
        </Link>
      </div>
    );
  }
  if (!tracker || !project) {
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

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            PROJECT {project.project_no} · RELEASE TRACKER · PERIOD {period}
          </div>
          <h1 className="page-title">{project.name}</h1>
          <div className="page-meta">
            <Link
              href={`/projects/${projectId}/releases`}
              style={{ color: "var(--accent-text)" }}
            >
              ← all trackers
            </Link>
            {tracker.pay_app_id && (
              <>
                {" · "}
                <Link
                  href={`/projects/${projectId}/pay-apps/${period}`}
                  style={{ color: "var(--accent-text)" }}
                >
                  view pay app
                </Link>
              </>
            )}
            {" · "}
            <Link
              href={`/projects/${projectId}/subs`}
              style={{ color: "var(--accent-text)" }}
            >
              manage subs
            </Link>
          </div>
        </div>
        {canEdit && (
          <div className="page-actions">
            <button
              onClick={saveAll}
              disabled={saving}
              className="btn btn-accent"
            >
              {saving ? "Saving…" : savedFlash ? "✓ Saved" : "Save changes"}
            </button>
          </div>
        )}
      </div>

      <div className="page-content">
        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        )}

        {/* Workflow + invoice header */}
        <div className="section-card glass" style={{ marginBottom: 16 }}>
          <div
            className="two-col-collapse"
            style={{
              gap: 24,
              alignItems: "start",
            }}
          >
            <div>
              <h2 className="section-title" style={{ marginBottom: 12 }}>
                Workflow
              </h2>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                <WorkflowCheckbox
                  label="Requested releases"
                  checked={tracker.requested_releases}
                  disabled={!canEdit}
                  onChange={() => toggleWorkflow("requested_releases" as never)}
                />
                <WorkflowCheckbox
                  label="Verified releases"
                  checked={tracker.verified_releases}
                  disabled={!canEdit}
                  onChange={() => toggleWorkflow("verified_releases" as never)}
                />
                <WorkflowCheckbox
                  label="Approved"
                  checked={tracker.approved}
                  disabled={!canEdit}
                  onChange={() => toggleWorkflow("approved" as never)}
                />
                <WorkflowCheckbox
                  label="Sent to GC"
                  checked={tracker.sent_to_gc}
                  disabled={!canEdit}
                  onChange={() => toggleWorkflow("sent_to_gc" as never)}
                />
              </div>
              {tracker.conditional_through_date && (
                <div
                  style={{
                    marginTop: 14,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  CONDITIONAL THROUGH:{" "}
                  <strong>{tracker.conditional_through_date}</strong>
                </div>
              )}
            </div>
            <div>
              <h2 className="section-title" style={{ marginBottom: 12 }}>
                Invoice
              </h2>
              <div>
                <label className="form-label">Invoice amount</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={invoiceAmount}
                  onChange={(e) => {
                    setInvoiceAmount(e.target.value);
                    setInvoiceOverridden(true);
                  }}
                  disabled={!canEdit}
                />
                {tracker.pay_app_id && invoiceOverridden && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      marginTop: 4,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Manually overridden. Click to{" "}
                    <button
                      type="button"
                      onClick={async () => {
                        // Refetch pay app to pull current_payment_due
                        try {
                          const pa = await api.get<{
                            current_payment_due: string;
                          }>(`/pay-apps/${tracker.pay_app_id}`);
                          setInvoiceAmount(pa.current_payment_due);
                          setInvoiceOverridden(false);
                        } catch {
                          /* ignore */
                        }
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent-text)",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      reset to pay app
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Release lines table */}
        <div className="section-card glass" style={{ marginBottom: 16 }}>
          <div className="section-header">
            <h2 className="section-title">Sub releases</h2>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-muted)",
              }}
            >
              {lines.length} sub{lines.length === 1 ? "" : "s"}
            </div>
          </div>

          {lines.length === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                padding: "16px 0",
              }}
            >
              No subs on this tracker.{" "}
              <Link
                href={`/projects/${projectId}/subs`}
                style={{ color: "var(--accent-text)" }}
              >
                Add subs
              </Link>
              , then re-create the tracker.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 1000,
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                    <th style={{ ...thStyle, textAlign: "left" }}>Sub</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Billed</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Check</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Exception</th>
                    <th style={thStyle}>Prev month</th>
                    <th style={thStyle}>Waivers</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedLines.map(({ line, depth }) => (
                    <ReleaseLineRow
                      key={line.id}
                      line={line}
                      depth={depth}
                      waiverIndex={waiverIndex}
                      canEdit={canEdit}
                      onChange={(patch) => updateLine(line.sub_id, patch)}
                      onWaiverChanged={async () => {
                        try {
                          const w = await api.get<Waiver[]>(
                            `/release-trackers/${tracker.id}/waivers`
                          );
                          setWaivers(w);
                        } catch {
                          /* ignore */
                        }
                      }}
                      onError={(msg) => setError(msg)}
                    />
                  ))}
                  <tr>
                    <td style={totalLabelStyle}>Total</td>
                    <td style={totalValueStyle}>
                      {fmtMoneyShort(billedTotal)}
                    </td>
                    <td style={totalValueStyle}>
                      {fmtMoneyShort(checkTotal)}
                    </td>
                    <td colSpan={4}></td>
                  </tr>
                  {Math.abs(billedTotal - invoiceAmountNum) > 0.01 && (
                    <tr>
                      <td colSpan={7}>
                        <div
                          style={{
                            marginTop: 10,
                            padding: "8px 14px",
                            background: "rgba(154,112,32,0.12)",
                            border: "1px solid rgba(154,112,32,0.30)",
                            borderRadius: "var(--radius-sm)",
                            fontSize: 13,
                            color: "var(--status-amber)",
                          }}
                        >
                          ⚠ Billed total ({fmtMoneyShort(billedTotal)})
                          doesn&apos;t match invoice amount (
                          {fmtMoneyShort(invoiceAmountNum)}). Difference:{" "}
                          {fmtMoneyShort(billedTotal - invoiceAmountNum)}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Previous-month unbilled entries */}
        <div className="section-card glass" style={{ marginBottom: 16 }}>
          <div className="section-header">
            <h2 className="section-title">Previous month(s) unbilled balance</h2>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              5 row slots
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 460 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
                <th style={{ ...thStyle, textAlign: "left" }}>Description</th>
                <th style={{ ...thStyle, textAlign: "right", width: 160 }}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {unbilled.map((u, idx) => (
                <tr
                  key={u.id ?? `unb-${idx}`}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <td style={{ padding: "6px 8px" }}>
                    <input
                      type="text"
                      className="input"
                      value={u.description ?? ""}
                      onChange={(e) =>
                        updateUnbilled(idx, { description: e.target.value })
                      }
                      disabled={!canEdit}
                      placeholder="Description (optional)"
                      style={{ fontSize: 14 }}
                    />
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <input
                      type="number"
                      step="0.01"
                      className="input"
                      value={u.amount}
                      onChange={(e) =>
                        updateUnbilled(idx, { amount: e.target.value })
                      }
                      disabled={!canEdit}
                      style={{ textAlign: "right", fontSize: 14 }}
                    />
                  </td>
                </tr>
              ))}
              <tr>
                <td style={totalLabelStyle}>Unbilled total</td>
                <td style={totalValueStyle}>{fmtMoneyShort(unbilledTotal)}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        {/* Buildertrend reconciliation */}
        <div className="section-card glass">
          <h2 className="section-title">Buildertrend reconciliation</h2>
          <div className="two-col-collapse" style={{ gap: "10px 14px" }}>
            <div>
              <label className="form-label">Buildertrend total</label>
              <input
                type="number"
                step="0.01"
                className="input"
                value={buildertrendTotal}
                onChange={(e) => setBuildertrendTotal(e.target.value)}
                disabled={!canEdit}
              />
            </div>
            <div>
              <label className="form-label">Less misc field expenses</label>
              <input
                type="number"
                step="0.01"
                className="input"
                value={lessMisc}
                onChange={(e) => setLessMisc(e.target.value)}
                disabled={!canEdit}
              />
            </div>
            <div style={{ gridColumn: "span 2" }}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  color: "var(--text-muted)",
                  marginTop: 6,
                }}
              >
                BT − Misc − Checks ={" "}
                <strong
                  style={{
                    color:
                      Math.abs(btReconDiff) < 0.01
                        ? "var(--status-green)"
                        : "var(--ferrocrete-red)",
                    fontSize: 14,
                  }}
                >
                  {fmtMoneyShort(btReconDiff)}
                </strong>
                {Math.abs(btReconDiff) < 0.01 && " ✓ reconciled"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Used only for typing; not exported
const workflowKeys = {
  requested_releases: true,
  verified_releases: true,
  approved: true,
  sent_to_gc: true,
};

// ─── Release line row ────────────────────────────────────────────────

function ReleaseLineRow({
  line,
  depth,
  waiverIndex,
  canEdit,
  onChange,
  onWaiverChanged,
  onError,
}: {
  line: ReleaseLine;
  depth: number;
  waiverIndex: Map<string, Waiver>;
  canEdit: boolean;
  onChange: (patch: Partial<ReleaseLine>) => void;
  onWaiverChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <td
        style={{
          padding: "8px 8px 8px " + (8 + depth * 18) + "px",
          fontSize: 14,
          minWidth: 220,
          maxWidth: 320,
        }}
      >
        {depth > 0 && (
          <span style={{ color: "var(--text-muted)", marginRight: 6 }}>↳</span>
        )}
        {line.sub_name ?? "(unnamed sub)"}
      </td>
      <td style={{ padding: "6px 8px", width: 130 }}>
        <input
          type="number"
          step="0.01"
          className="input"
          value={line.billed_amount}
          onChange={(e) => onChange({ billed_amount: e.target.value })}
          disabled={!canEdit}
          style={{ textAlign: "right", fontSize: 13 }}
        />
      </td>
      <td style={{ padding: "6px 8px", width: 130 }}>
        <input
          type="number"
          step="0.01"
          className="input"
          value={line.check_amount}
          onChange={(e) => onChange({ check_amount: e.target.value })}
          disabled={!canEdit}
          style={{ textAlign: "right", fontSize: 13 }}
        />
      </td>
      <td style={{ padding: "6px 8px", width: 95 }}>
        <select
          className="input"
          value={line.release_type ?? ""}
          onChange={(e) =>
            onChange({
              release_type: (e.target.value || null) as ReleaseType | null,
            })
          }
          disabled={!canEdit}
          style={{ fontSize: 13 }}
        >
          <option value="">—</option>
          <option value="CP">CP</option>
          <option value="UP">UP</option>
          <option value="CF">CF</option>
          <option value="UF">UF</option>
        </select>
      </td>
      <td style={{ padding: "6px 8px", width: 100 }}>
        <select
          className="input"
          value={line.exception ?? ""}
          onChange={(e) => onChange({ exception: e.target.value || null })}
          disabled={!canEdit}
          style={{ fontSize: 13 }}
        >
          <option value="">—</option>
          <option value="N">N</option>
          <option value="Y">Y</option>
          <option value="N/A">N/A</option>
        </select>
      </td>
      <td style={{ padding: "6px 8px", width: 115 }}>
        <select
          className="input"
          value={line.prev_month_status ?? ""}
          onChange={(e) =>
            onChange({ prev_month_status: e.target.value || null })
          }
          disabled={!canEdit}
          style={{ fontSize: 13 }}
        >
          <option value="">—</option>
          <option value="Received">Received</option>
          <option value="Requested">Requested</option>
          <option value="Pending">Pending</option>
        </select>
      </td>
      <td style={{ padding: "6px 8px" }}>
        <WaiverCell
          line={line}
          waiverIndex={waiverIndex}
          canEdit={canEdit}
          onWaiverChanged={onWaiverChanged}
          onError={onError}
        />
      </td>
    </tr>
  );
}

// ─── Waiver cell (4 slots: CP/UP/CF/UF) ──────────────────────────────

function WaiverCell({
  line,
  waiverIndex,
  canEdit,
  onWaiverChanged,
  onError,
}: {
  line: ReleaseLine;
  waiverIndex: Map<string, Waiver>;
  canEdit: boolean;
  onWaiverChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const types: ReleaseType[] = ["CP", "UP", "CF", "UF"];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {types.map((t) => {
        const w = waiverIndex.get(`${line.id}:${t}`);
        return (
          <WaiverSlot
            key={t}
            type={t}
            existing={w}
            releaseLineId={line.id}
            canEdit={canEdit}
            onWaiverChanged={onWaiverChanged}
            onError={onError}
          />
        );
      })}
    </div>
  );
}

function WaiverSlot({
  type,
  existing,
  releaseLineId,
  canEdit,
  onWaiverChanged,
  onError,
}: {
  type: ReleaseType;
  existing: Waiver | undefined;
  releaseLineId: string;
  canEdit: boolean;
  onWaiverChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("waiver_type", type);
      fd.append("file", file);
      await api.post(`/release-lines/${releaseLineId}/waivers`, undefined, {
        formData: fd,
      });
      await onWaiverChanged();
    } catch (e) {
      onError(formatApiError(e));
    } finally {
      setUploading(false);
    }
  }

  async function viewWaiver() {
    if (!existing) return;
    try {
      const res = await api.get<{ download_url: string }>(
        `/waivers/${existing.id}/download-url`
      );
      window.open(res.download_url, "_blank");
    } catch (e) {
      onError(formatApiError(e));
    }
  }

  async function removeWaiver() {
    if (!existing || !canEdit) return;
    try {
      await api.delete(`/waivers/${existing.id}`);
      await onWaiverChanged();
    } catch (e) {
      onError(formatApiError(e));
    }
  }

  // Three visual states: uploaded (green), uploading (amber), empty (gray dashed)
  if (existing) {
    return (
      <div
        title={`${type} — ${existing.file_name}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          padding: "3px 6px",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.5,
          background: "rgba(58,122,86,0.14)",
          color: "var(--status-green)",
          border: "1px solid rgba(58,122,86,0.30)",
          borderRadius: 4,
        }}
      >
        <button
          type="button"
          onClick={viewWaiver}
          style={{
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            padding: 0,
            fontFamily: "inherit",
            fontWeight: "inherit",
            fontSize: "inherit",
          }}
          title="View waiver"
        >
          ✓ {type}
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={removeWaiver}
            style={{
              background: "none",
              border: "none",
              color: "var(--ferrocrete-red)",
              cursor: "pointer",
              padding: "0 0 0 2px",
              fontSize: 11,
              lineHeight: 1,
            }}
            title="Remove waiver"
          >
            ×
          </button>
        )}
      </div>
    );
  }

  if (!canEdit) {
    return (
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-faint)",
          padding: "3px 6px",
          border: "1px dashed var(--border)",
          borderRadius: 4,
        }}
      >
        {type}
      </span>
    );
  }

  return (
    <label
      style={{
        cursor: uploading ? "wait" : "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: 0.5,
        padding: "3px 6px",
        border: "1px dashed var(--border-strong)",
        borderRadius: 4,
        color: uploading ? "var(--status-amber)" : "var(--text-muted)",
        background: uploading ? "rgba(154,112,32,0.12)" : "transparent",
      }}
      title={uploading ? "Uploading…" : `Upload ${type} waiver`}
    >
      {uploading ? "…" : type}
      <input
        type="file"
        accept="application/pdf,image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";    // reset so same file can be re-selected
        }}
        disabled={uploading}
      />
    </label>
  );
}

// ─── Other small components ──────────────────────────────────────────

function WorkflowCheckbox({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        cursor: disabled ? "default" : "pointer",
        fontSize: 14,
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span>{label}</span>
      {checked && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--status-green)",
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          ✓
        </span>
      )}
    </label>
  );
}


const thStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 500,
};
const totalLabelStyle: React.CSSProperties = {
  paddingTop: 14,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  textAlign: "right",
};
const totalValueStyle: React.CSSProperties = {
  paddingTop: 14,
  textAlign: "right",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-primary)",
};
