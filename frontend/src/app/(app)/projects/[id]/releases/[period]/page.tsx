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
  BillStatus,
  WaiverStatus,
  CheckType,
  ReminderTemplateKey,
  ReminderPreview,
  ReminderSendResult,
} from "@/lib/types";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";
import {
  STAGE_LABEL,
  deriveStage,
  stepperModel,
  currentNodeColor,
  REMINDER_TITLES,
  type NodeState,
} from "@/lib/releaseStage";

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
  const [addSubId, setAddSubId] = useState("");
  const [expandedSub, setExpandedSub] = useState<string | null>(null);
  const [reminder, setReminder] = useState<{
    templateKey: ReminderTemplateKey;
    lineIds: string[];
  } | null>(null);
  const [remindFlash, setRemindFlash] = useState<string | null>(null);

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

  // Full reconciliation, in the Excel's order (WI-2 §3).
  const subsVendorsCheck = lines
    .filter((l) => !l.is_non_prelimed)
    .reduce((s, l) => s + parseFloat(String(l.check_amount) || "0"), 0);
  const nonPrelimCheck = lines
    .filter((l) => l.is_non_prelimed)
    .reduce((s, l) => s + parseFloat(String(l.check_amount) || "0"), 0);
  const ferrocreteTotal = invoiceAmountNum - subsVendorsCheck;
  const ferrocreteNet = ferrocreteTotal - nonPrelimCheck - unbilledTotal;
  const btSide = buildertrendNum + unbilledTotal - lessMiscNum;
  const spreadsheetSide = subsVendorsCheck + nonPrelimCheck + unbilledTotal;
  const discrepancy = btSide - spreadsheetSide;

  function openReminder(templateKey: ReminderTemplateKey, lineIds: string[]) {
    const ids = lineIds.filter(Boolean);
    if (ids.length === 0) return;
    setReminder({ templateKey, lineIds: ids });
  }

  // After a send, refresh so status advances + "last emailed" show.
  async function afterReminderSent(result: ReminderSendResult) {
    setReminder(null);
    setRemindFlash(
      `Sent ${result.sent}${result.skipped ? `, skipped ${result.skipped} with no email` : ""}` +
        (result.failures.length ? `, ${result.failures.length} failed` : "")
    );
    setTimeout(() => setRemindFlash(null), 4000);
    if (!tracker) return;
    try {
      const fresh = await api.get<ReleaseTrackerDetail>(`/release-trackers/${tracker.id}`);
      setTracker(fresh);
      setLines(fresh.lines ?? []);
    } catch {
      /* non-fatal */
    }
  }

  // Bulk reminder eligibility, computed from the current lines.
  const bulk = useMemo(() => {
    const billReq: string[] = [], cpcfRem: string[] = [], upufReq: string[] = [], upufRem: string[] = [];
    for (const l of lines) {
      if (!l.id) continue; // unsaved
      const np = l.is_non_prelimed;
      const stage = deriveStage(l, np);
      if (stage === "awaiting_bill") billReq.push(l.id);
      if (!np && l.is_overdue && l.bill_status !== "not_requested" &&
          ["not_requested", "requested"].includes(l.conditional_status)) cpcfRem.push(l.id);
      if (!np && l.check_sent_to_sub_at && l.unconditional_status === "not_requested") upufReq.push(l.id);
      if (!np && l.is_overdue && l.unconditional_status === "requested") upufRem.push(l.id);
    }
    return { billReq, cpcfRem, upufReq, upufRem };
  }, [lines]);

  // Active subs not yet on this tracker — the "Add sub" dropdown source.
  const addableSubs = useMemo(() => {
    const onTracker = new Set(lines.map((l) => l.sub_id));
    return (subs ?? [])
      .filter((s) => s.active && !onTracker.has(s.id))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [subs, lines]);

  function addSubLine(subId: string) {
    const sub = subById.get(subId);
    if (!sub) return;
    // Unsaved line: empty id signals "persist on Save before waivers can attach".
    const naStatus = sub.is_non_prelimed ? "not_applicable" : "not_requested";
    const newLine = {
      id: "",
      release_tracker_id: tracker?.id ?? "",
      sub_id: sub.id,
      sub_name: sub.name,
      parent_sub_id: sub.parent_sub_id ?? null,
      is_non_prelimed: sub.is_non_prelimed,
      billed_amount: "0",
      check_amount: "0",
      release_type: sub.default_release_type ?? null,
      exception: null,
      prev_month_status: null,
      bill_status: "not_requested",
      conditional_status: naStatus,
      unconditional_status: naStatus,
      check_type: null,
      stage: "n/a",
      is_overdue: false,
    } as unknown as ReleaseLine;
    setLines((prev) => [...prev, newLine]);
    setAddSubId("");
  }

  function removeLine(subId: string) {
    setLines((prev) => prev.filter((l) => l.sub_id !== subId));
  }

  function updateLine(subId: string, patch: Partial<ReleaseLine>) {
    setLines((prev) =>
      prev.map((l) => (l.sub_id === subId ? { ...l, ...patch } : l))
    );
  }

  function addUnbilledRow() {
    setUnbilled((prev) => [
      ...prev,
      { description: null, amount: "0", sort_order: prev.length },
    ]);
  }

  function removeUnbilledRow(idx: number) {
    setUnbilled((prev) => prev.filter((_, i) => i !== idx));
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

  // The waiver endpoints advance a line's status server-side. Mirror that in
  // local state (so the stage pill updates) WITHOUT refetching the whole
  // tracker, which would clobber unsaved billed/check edits. Also refresh the
  // waiver list so the slots repaint.
  function applyWaiverStatus(
    subId: string,
    waiverType: ReleaseType,
    action: "upload" | "delete"
  ) {
    const today = new Date().toISOString().slice(0, 10);
    const isCond = waiverType === "CP" || waiverType === "CF";
    setLines((prev) =>
      prev.map((l) => {
        if (l.sub_id !== subId) return l;
        if (action === "upload") {
          if (isCond && ["not_requested", "requested"].includes(l.conditional_status))
            return { ...l, conditional_status: "received", conditional_received_at: today };
          if (!isCond && ["not_requested", "requested"].includes(l.unconditional_status))
            return { ...l, unconditional_status: "received", unconditional_received_at: today };
        } else {
          if (isCond && l.conditional_status === "received")
            return { ...l, conditional_status: "requested", conditional_received_at: null };
          if (!isCond && l.unconditional_status === "received")
            return { ...l, unconditional_status: "requested", unconditional_received_at: null };
        }
        return l;
      })
    );
  }

  async function handleWaiverChanged(
    subId: string,
    waiverType: ReleaseType,
    action: "upload" | "delete"
  ) {
    if (!tracker) return;
    try {
      const w = await api.get<Waiver[]>(`/release-trackers/${tracker.id}/waivers`);
      setWaivers(w);
    } catch {
      /* non-fatal */
    }
    applyWaiverStatus(subId, waiverType, action);
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
          // Per-line lifecycle (WI-2)
          bill_status: l.bill_status,
          bill_requested_at: l.bill_requested_at,
          bill_received_at: l.bill_received_at,
          bill_due_at: l.bill_due_at,
          conditional_status: l.conditional_status,
          conditional_received_at: l.conditional_received_at,
          conditional_sent_at: l.conditional_sent_at,
          check_type: l.check_type,
          check_received_at: l.check_received_at,
          check_sent_to_sub_at: l.check_sent_to_sub_at,
          unconditional_status: l.unconditional_status,
          unconditional_requested_at: l.unconditional_requested_at,
          unconditional_received_at: l.unconditional_received_at,
          unconditional_sent_at: l.unconditional_sent_at,
          difference_note: l.difference_note,
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
                {/* These three are DERIVED from the per-sub lifecycle below. */}
                <DerivedFlag label="Bills received" on={tracker.requested_releases} />
                <DerivedFlag label="CP/CF sent to GC" on={tracker.verified_releases} />
                {/* The one manually-set flag. */}
                <WorkflowCheckbox
                  label="GC approved / payment received"
                  checked={tracker.approved}
                  disabled={!canEdit}
                  onChange={() => toggleWorkflow("approved" as never)}
                />
                <DerivedFlag label="UP/UF received" on={tracker.sent_to_gc} />
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: "var(--text-faint)",
                }}
              >
                Bills received / CP/CF sent / UP/UF received are derived from the sub stages below.
              </div>
              {tracker.conditional_through_date && (
                <div
                  style={{
                    marginTop: 14,
                    fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
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
                      fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
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
              {tracker.retention_billed_amount != null &&
                parseFloat(String(tracker.retention_billed_amount)) !== 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 13,
                      color: "var(--status-blue)",
                    }}
                  >
                    Retention billed this period:{" "}
                    <strong>{fmtMoneyShort(tracker.retention_billed_amount)}</strong>
                  </div>
                )}
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

          {canEdit && addableSubs.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <select
                className="input"
                value={addSubId}
                onChange={(e) => setAddSubId(e.target.value)}
                style={{ fontSize: 13, maxWidth: 280 }}
              >
                <option value="">Add sub to this tracker…</option>
                {addableSubs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-accent"
                disabled={!addSubId}
                onClick={() => addSubId && addSubLine(addSubId)}
              >
                Add
              </button>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Added subs persist when you Save.
              </span>
            </div>
          )}

          {canEdit && lines.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                marginBottom: 14,
              }}
            >
              <span
                style={{
                  fontFamily:
                    "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  marginRight: 2,
                }}
              >
                Email subs
              </span>
              <BulkRemindBtn
                label="Request bill + CP/CF"
                count={bulk.billReq.length}
                onClick={() => openReminder("request_bill_cpcf", bulk.billReq)}
              />
              <BulkRemindBtn
                label="CP/CF reminders"
                count={bulk.cpcfRem.length}
                onClick={() => openReminder("cpcf_overdue", bulk.cpcfRem)}
              />
              <BulkRemindBtn
                label="Request UP/UF"
                count={bulk.upufReq.length}
                onClick={() => openReminder("request_upuf", bulk.upufReq)}
              />
              <BulkRemindBtn
                label="UP/UF reminders"
                count={bulk.upufRem.length}
                onClick={() => openReminder("upuf_overdue", bulk.upufRem)}
              />
              {remindFlash && (
                <span style={{ fontSize: 13, color: "var(--status-green)", marginLeft: 4 }}>
                  ✓ {remindFlash}
                </span>
              )}
            </div>
          )}

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
            <>
              <StageTable
                title="Subs / Vendors"
                rows={orderedLines.filter((o) => !o.line.is_non_prelimed)}
                nonPrelimed={false}
                canEdit={canEdit}
                waiverIndex={waiverIndex}
                expandedSub={expandedSub}
                onToggleExpand={(id) =>
                  setExpandedSub((cur) => (cur === id ? null : id))
                }
                onChange={updateLine}
                onRemove={removeLine}
                onWaiverChanged={handleWaiverChanged}
                onRemind={openReminder}
                onError={setError}
              />
              <StageTable
                title="Non-Prelimed Bills"
                rows={orderedLines.filter((o) => o.line.is_non_prelimed)}
                nonPrelimed
                canEdit={canEdit}
                waiverIndex={waiverIndex}
                expandedSub={expandedSub}
                onToggleExpand={(id) =>
                  setExpandedSub((cur) => (cur === id ? null : id))
                }
                onChange={updateLine}
                onRemove={removeLine}
                onWaiverChanged={handleWaiverChanged}
                onRemind={openReminder}
                onError={setError}
              />
              {Math.abs(billedTotal - invoiceAmountNum) > 0.01 && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "8px 14px",
                    background: "rgba(245, 158, 11, 0.10)",
                    border: "1px solid rgba(245, 158, 11, 0.30)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 13,
                    color: "var(--status-amber, #b45309)",
                  }}
                >
                  ⚠ Billed total ({fmtMoneyShort(billedTotal)}) doesn&apos;t
                  match invoice amount ({fmtMoneyShort(invoiceAmountNum)}).
                  Difference: {fmtMoneyShort(billedTotal - invoiceAmountNum)}
                </div>
              )}
            </>
          )}
        </div>

        {/* Previous-month unbilled entries */}
        <div className="section-card glass" style={{ marginBottom: 16 }}>
          <div className="section-header">
            <h2 className="section-title">Previous month(s) unbilled balance</h2>
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
              Rarely used
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
                <th style={{ width: 30 }}></th>
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
                  <td style={{ padding: "6px 4px", textAlign: "center" }}>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => removeUnbilledRow(idx)}
                        title="Remove row"
                        style={{
                          background: "none", border: "none",
                          color: "var(--ferrocrete-red)", cursor: "pointer",
                          fontSize: 14, lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={totalLabelStyle}>Unbilled total</td>
                <td style={totalValueStyle}>{fmtMoneyShort(unbilledTotal)}</td>
                <td />
              </tr>
            </tbody>
          </table>
          </div>
          {canEdit && (
            <button
              type="button"
              className="btn"
              onClick={addUnbilledRow}
              style={{ marginTop: 10, fontSize: 13 }}
            >
              + Add row
            </button>
          )}
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
          </div>

          {/* Full reconciliation block, in the Excel's order. */}
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gap: "3px 18px",
              gridTemplateColumns: "1fr auto",
              fontFamily:
                "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
              fontSize: 13,
              maxWidth: 460,
            }}
          >
            <ReconLine label="Subs / Vendors Total" value={subsVendorsCheck} />
            <ReconLine label="Ferrocrete Total (Invoice − Subs)" value={ferrocreteTotal} />
            <ReconLine label="Non-Prelimed Total" value={nonPrelimCheck} />
            <ReconLine label="Previous Month(s) Unbilled Total" value={unbilledTotal} />
            <ReconLine label="Ferrocrete Net" value={ferrocreteNet} strong />
            <div style={{ gridColumn: "span 2", height: 6 }} />
            <ReconLine label="Buildertrend side (BT + Unbilled − Misc)" value={btSide} />
            <ReconLine label="Spreadsheet side (Subs + Non-Prelim + Unbilled)" value={spreadsheetSide} />
            <div
              style={{
                gridColumn: "span 2",
                marginTop: 6,
                paddingTop: 6,
                borderTop: "1px solid var(--border)",
              }}
            />
            <span style={{ color: "var(--text-muted)" }}>Discrepancy</span>
            <strong
              style={{
                textAlign: "right",
                color:
                  Math.abs(discrepancy) < 0.01
                    ? "var(--status-green)"
                    : "var(--ferrocrete-red)",
              }}
            >
              {fmtMoneyShort(discrepancy)}
              {Math.abs(discrepancy) < 0.01 ? " ✓" : ""}
            </strong>
          </div>
        </div>
      </div>

      {reminder && tracker && (
        <ReminderModal
          trackerId={tracker.id}
          templateKey={reminder.templateKey}
          lineIds={reminder.lineIds}
          onClose={() => setReminder(null)}
          onSent={afterReminderSent}
          onError={setError}
        />
      )}
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

// ─── Stage table (one section: Subs/Vendors or Non-Prelimed) ─────────

type OrderedLine = { line: ReleaseLine; depth: number };

type WaiverChanged = (
  subId: string,
  waiverType: ReleaseType,
  action: "upload" | "delete"
) => void;

const todayISO = () => new Date().toISOString().slice(0, 10);
const money = (billed: unknown, check: unknown) =>
  parseFloat(String(billed) || "0") - parseFloat(String(check) || "0");

function StageTable({
  title,
  rows,
  nonPrelimed,
  canEdit,
  waiverIndex,
  expandedSub,
  onToggleExpand,
  onChange,
  onRemove,
  onWaiverChanged,
  onRemind,
  onError,
}: {
  title: string;
  rows: OrderedLine[];
  nonPrelimed: boolean;
  canEdit: boolean;
  waiverIndex: Map<string, Waiver>;
  expandedSub: string | null;
  onToggleExpand: (subId: string) => void;
  onChange: (subId: string, patch: Partial<ReleaseLine>) => void;
  onRemove: (subId: string) => void;
  onWaiverChanged: WaiverChanged;
  onRemind: (templateKey: ReminderTemplateKey, lineIds: string[]) => void;
  onError: (msg: string) => void;
}) {
  if (rows.length === 0) return null;
  const billed = rows.reduce(
    (s, { line }) => s + parseFloat(String(line.billed_amount) || "0"),
    0
  );
  const check = rows.reduce(
    (s, { line }) => s + parseFloat(String(line.check_amount) || "0"),
    0
  );
  const colCount = nonPrelimed ? 6 : 7;

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontFamily:
            "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
          fontSize: 11,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--text-muted)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", minWidth: nonPrelimed ? 720 : 1060 }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
              <th style={{ ...thStyle, textAlign: "left" }}>Sub</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Billed</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Check</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Difference</th>
              {!nonPrelimed && <th style={thStyle}>Check type</th>}
              <th style={thStyle}>Stage</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ line, depth }) => (
              <StageRow
                key={line.id || line.sub_id}
                line={line}
                depth={depth}
                nonPrelimed={nonPrelimed}
                canEdit={canEdit}
                waiverIndex={waiverIndex}
                expanded={expandedSub === line.sub_id}
                onToggle={() => onToggleExpand(line.sub_id)}
                onChange={(patch) => onChange(line.sub_id, patch)}
                onRemove={() => onRemove(line.sub_id)}
                onWaiverChanged={onWaiverChanged}
                onRemind={onRemind}
                onError={onError}
              />
            ))}
            <tr>
              <td style={totalLabelStyle}>{title} total</td>
              <td style={totalValueStyle}>{fmtMoneyShort(billed)}</td>
              <td style={totalValueStyle}>{fmtMoneyShort(check)}</td>
              <td style={totalValueStyle}>{fmtMoneyShort(billed - check)}</td>
              <td colSpan={colCount - 4}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StageRow({
  line,
  depth,
  nonPrelimed,
  canEdit,
  waiverIndex,
  expanded,
  onToggle,
  onChange,
  onRemove,
  onWaiverChanged,
  onRemind,
  onError,
}: {
  line: ReleaseLine;
  depth: number;
  nonPrelimed: boolean;
  canEdit: boolean;
  waiverIndex: Map<string, Waiver>;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ReleaseLine>) => void;
  onRemove: () => void;
  onWaiverChanged: WaiverChanged;
  onRemind: (templateKey: ReminderTemplateKey, lineIds: string[]) => void;
  onError: (msg: string) => void;
}) {
  const saved = Boolean(line.id);
  const stage = deriveStage(line, nonPrelimed);
  const overdue = line.is_overdue && stage !== "complete" && stage !== "n/a";
  const hasWaivers = (["CP", "UP", "CF", "UF"] as const).some((t) =>
    waiverIndex.has(`${line.id}:${t}`)
  );
  const isEmpty =
    parseFloat(String(line.billed_amount) || "0") === 0 &&
    parseFloat(String(line.check_amount) || "0") === 0;
  const removable = canEdit && !hasWaivers && isEmpty;
  const colCount = nonPrelimed ? 6 : 7;

  return (
    <>
      <tr style={{ borderBottom: "1px solid var(--border)" }}>
        <td
          style={{
            padding: "8px 8px 8px " + (8 + depth * 18) + "px",
            fontSize: 14,
            minWidth: 200,
            maxWidth: 300,
          }}
        >
          {depth > 0 && (
            <span style={{ color: "var(--text-muted)", marginRight: 6 }}>↳</span>
          )}
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              title="Remove this sub from the tracker"
              style={{
                background: "none",
                border: "none",
                color: "var(--ferrocrete-red)",
                cursor: "pointer",
                padding: "0 6px 0 0",
                fontSize: 13,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
          {line.sub_name ?? "(unnamed sub)"}
          {!saved && (
            <span
              style={{
                marginLeft: 6,
                fontFamily:
                  "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                fontSize: 9,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "var(--status-amber)",
              }}
              title="Save to persist this sub"
            >
              unsaved
            </span>
          )}
        </td>
        <td style={{ padding: "6px 8px", width: 120 }}>
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
        <td style={{ padding: "6px 8px", width: 120 }}>
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
        <td
          style={{
            padding: "6px 8px",
            width: 110,
            textAlign: "right",
            fontFamily:
              "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
            fontSize: 13,
            color:
              Math.abs(money(line.billed_amount, line.check_amount)) > 0.01
                ? "var(--status-amber)"
                : "var(--text-muted)",
          }}
          title={line.difference_note ?? ""}
        >
          {fmtMoneyShort(money(line.billed_amount, line.check_amount))}
        </td>
        {!nonPrelimed && (
          <td style={{ padding: "6px 8px", width: 110 }}>
            <select
              className="input"
              value={line.check_type ?? ""}
              onChange={(e) =>
                onChange({ check_type: (e.target.value || null) as CheckType | null })
              }
              disabled={!canEdit}
              style={{ fontSize: 13 }}
            >
              <option value="">—</option>
              <option value="joint">Joint</option>
              <option value="individual">Individual</option>
              <option value="none">None</option>
            </select>
          </td>
        )}
        <td style={{ padding: "6px 8px", minWidth: nonPrelimed ? 150 : 300 }}>
          <StageStepper line={line} stage={stage} nonPrelimed={nonPrelimed} overdue={overdue} />
        </td>
        <td style={{ padding: "6px 8px", textAlign: "right" }}>
          <button
            type="button"
            onClick={onToggle}
            className="btn"
            style={{ fontSize: 12, padding: "3px 8px" }}
            title="Show the stage detail"
          >
            {expanded ? "Hide" : "Steps"} {expanded ? "▲" : "▼"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={colCount} style={{ padding: 0 }}>
            <StageStrip
              line={line}
              nonPrelimed={nonPrelimed}
              canEdit={canEdit}
              saved={saved}
              waiverIndex={waiverIndex}
              onChange={onChange}
              onWaiverChanged={onWaiverChanged}
              onRemind={onRemind}
              onError={onError}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Row stepper: connected node per stage, inline on the row ────────

function mdShort(iso: string | null): string {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  if (p.length !== 3) return "";
  return `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}`;
}

function StageStepper({
  line,
  stage,
  nonPrelimed,
  overdue,
}: {
  line: ReleaseLine;
  stage: ReturnType<typeof deriveStage>;
  nonPrelimed: boolean;
  overdue: boolean;
}) {
  const { labels, states } = stepperModel(stage, nonPrelimed, overdue);
  const curColor = currentNodeColor(stage);
  const dates = nonPrelimed
    ? [line.bill_received_at, line.check_sent_to_sub_at]
    : [
        line.bill_received_at,
        line.conditional_sent_at || line.conditional_received_at,
        line.check_received_at,
        line.check_sent_to_sub_at,
        line.unconditional_sent_at || line.unconditional_received_at,
      ];

  const nodeStyle = (st: NodeState): React.CSSProperties => {
    const base: React.CSSProperties = {
      width: 24,
      height: 24,
      borderRadius: "50%",
      display: "grid",
      placeItems: "center",
      zIndex: 1,
      background: "var(--surface, var(--bg))",
      border: "2px solid var(--border-strong)",
      fontFamily:
        "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
      fontSize: 11,
      fontWeight: 600,
      color: "var(--text-faint)",
    };
    if (st === "done")
      return { ...base, background: "var(--status-green)", borderColor: "var(--status-green)", color: "#fff" };
    if (st === "current")
      return { ...base, borderColor: curColor, color: curColor, boxShadow: `0 0 0 3px color-mix(in srgb, ${curColor} 18%, transparent)` };
    if (st === "overdue")
      return { ...base, borderColor: "var(--status-red)", color: "var(--status-red)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-red) 18%, transparent)" };
    return base; // pending / na
  };

  const title =
    stage === "n/a"
      ? "No billed activity"
      : `${STAGE_LABEL[stage]}${overdue ? " · overdue" : ""}`;

  return (
    <div style={{ display: "flex", alignItems: "flex-start", opacity: stage === "n/a" ? 0.5 : 1 }} title={title}>
      {labels.map((lbl, i) => {
        const st = states[i];
        const reached = st === "done" || st === "current" || st === "overdue";
        const connColor =
          st === "done" || st === "current" || st === "overdue"
            ? "var(--status-green)"
            : "var(--border-strong)";
        const d = mdShort(dates[i] ?? null);
        return (
          <div
            key={lbl}
            style={{
              position: "relative",
              flex: "1 1 0",
              minWidth: 46,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
            title={`${lbl}${st === "done" ? (d ? " · done " + d : " · done") : st === "current" ? " · in progress" : st === "overdue" ? " · overdue" : " · pending"}`}
          >
            {i > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: 11,
                  left: "-50%",
                  width: "100%",
                  height: 2,
                  background: connColor,
                  zIndex: 0,
                }}
              />
            )}
            <div style={nodeStyle(st)}>{st === "done" ? "✓" : i + 1}</div>
            <div
              style={{
                fontFamily:
                  "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                fontSize: 9,
                letterSpacing: 0.3,
                textTransform: "uppercase",
                color: reached ? "var(--text-muted)" : "var(--text-faint)",
                marginTop: 5,
                whiteSpace: "nowrap",
              }}
            >
              {lbl}
            </div>
            <div
              style={{
                fontFamily:
                  "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
                fontSize: 8.5,
                color: "var(--text-faint)",
                marginTop: 1,
                minHeight: 10,
              }}
            >
              {d}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Stage strip: Bill -> CP/CF -> Check -> UP/UF, with mark-as actions ─

function StageStrip({
  line,
  nonPrelimed,
  canEdit,
  saved,
  waiverIndex,
  onChange,
  onWaiverChanged,
  onRemind,
  onError,
}: {
  line: ReleaseLine;
  nonPrelimed: boolean;
  canEdit: boolean;
  saved: boolean;
  waiverIndex: Map<string, Waiver>;
  onChange: (patch: Partial<ReleaseLine>) => void;
  onWaiverChanged: WaiverChanged;
  onRemind: (templateKey: ReminderTemplateKey, lineIds: string[]) => void;
  onError: (msg: string) => void;
}) {
  const canEmail = canEdit && saved && line.has_email;
  const remind = (k: Parameters<typeof onRemind>[0]) => onRemind(k, [line.id]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "16px 18px",
        background: "var(--accent-dim)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* Status banner: no-email warning + last emailed */}
      {(saved && !line.has_email) || line.last_reminder ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {saved && !line.has_email && (
            <span style={{ fontSize: 12, color: "var(--status-amber)" }}>
              ⚠ No email on file for this sub — add one on{" "}
              <span style={{ textDecoration: "underline" }}>Manage subs</span> to email reminders.
            </span>
          )}
          {line.last_reminder && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Last emailed: {mdShort(line.last_reminder.sent_at)} (
              {REMINDER_TITLES[line.last_reminder.template_key]})
            </span>
          )}
        </div>
      ) : null}

      {/* Stage cards — equal columns that fill the width */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${nonPrelimed ? 2 : 4}, minmax(0, 1fr))`,
          gap: 14,
          alignItems: "stretch",
        }}
      >
      {/* Bill */}
      <StageGroup title="Bill" status={line.bill_status}>
        <DateLine label="requested" value={line.bill_requested_at} />
        <DateLine label="due" value={line.bill_due_at} />
        <DateLine label="received" value={line.bill_received_at} />
        {canEdit && (
          <div style={stripBtnRow}>
            <MarkBtn
              onClick={() =>
                onChange({ bill_status: "requested", bill_requested_at: todayISO() })
              }
            >
              Requested
            </MarkBtn>
            <MarkBtn
              onClick={() =>
                onChange({ bill_status: "received", bill_received_at: todayISO() })
              }
            >
              Received
            </MarkBtn>
            <MarkBtn onClick={() => onChange({ bill_status: "not_applicable" })}>
              N/A
            </MarkBtn>
          </div>
        )}
        {canEmail && line.bill_status !== "received" && line.bill_status !== "not_applicable" && (
          <div style={stripBtnRow}>
            <MarkBtn onClick={() => remind("request_bill_cpcf")}>✉ Request bill + CP/CF</MarkBtn>
            {line.is_overdue && !nonPrelimed && (
              <MarkBtn onClick={() => remind("cpcf_overdue")}>✉ CP/CF reminder</MarkBtn>
            )}
          </div>
        )}
      </StageGroup>

      {/* Conditional CP/CF (prelimed only) */}
      {!nonPrelimed && (
        <StageGroup title="CP / CF" status={line.conditional_status}>
          <DateLine label="received" value={line.conditional_received_at} />
          <DateLine label="sent" value={line.conditional_sent_at} />
          <WaiverRow
            line={line}
            types={["CP", "CF"]}
            saved={saved}
            canEdit={canEdit}
            waiverIndex={waiverIndex}
            onWaiverChanged={onWaiverChanged}
            onError={onError}
          />
          {canEdit && (
            <div style={stripBtnRow}>
              <MarkBtn onClick={() => onChange({ conditional_status: "verified" })}>
                Verified
              </MarkBtn>
              <MarkBtn
                onClick={() =>
                  onChange({ conditional_status: "sent_to_gc", conditional_sent_at: todayISO() })
                }
              >
                Sent to GC
              </MarkBtn>
            </div>
          )}
        </StageGroup>
      )}

      {/* Check received (GC pays) + released to sub (Paid Sub) */}
      <StageGroup title="Check / Paid Sub">
        <DateLine label="received" value={line.check_received_at} />
        <DateLine label="released to sub" value={line.check_sent_to_sub_at} />
        {canEdit && (
          <div style={stripBtnRow}>
            <MarkBtn onClick={() => onChange({ check_received_at: todayISO() })}>
              Check received
            </MarkBtn>
            <MarkBtn onClick={() => onChange({ check_sent_to_sub_at: todayISO() })}>
              Released to sub
            </MarkBtn>
          </div>
        )}
      </StageGroup>

      {/* Unconditional UP/UF (prelimed only) */}
      {!nonPrelimed && (
        <StageGroup title="UP / UF" status={line.unconditional_status}>
          <DateLine label="requested" value={line.unconditional_requested_at} />
          <DateLine label="received" value={line.unconditional_received_at} />
          <DateLine label="sent" value={line.unconditional_sent_at} />
          <WaiverRow
            line={line}
            types={["UP", "UF"]}
            saved={saved}
            canEdit={canEdit}
            waiverIndex={waiverIndex}
            onWaiverChanged={onWaiverChanged}
            onError={onError}
          />
          {canEdit && (
            <div style={stripBtnRow}>
              <MarkBtn
                onClick={() =>
                  onChange({
                    unconditional_status: "requested",
                    unconditional_requested_at: todayISO(),
                  })
                }
              >
                Requested
              </MarkBtn>
              <MarkBtn onClick={() => onChange({ unconditional_status: "verified" })}>
                Verified
              </MarkBtn>
              <MarkBtn
                onClick={() =>
                  onChange({
                    unconditional_status: "sent_to_gc",
                    unconditional_sent_at: todayISO(),
                  })
                }
              >
                Sent to GC
              </MarkBtn>
            </div>
          )}
          {canEmail && line.check_sent_to_sub_at && line.unconditional_status === "not_requested" && (
            <div style={stripBtnRow}>
              <MarkBtn onClick={() => remind("request_upuf")}>✉ Request UP/UF</MarkBtn>
            </div>
          )}
          {canEmail && line.unconditional_status === "requested" && line.is_overdue && (
            <div style={stripBtnRow}>
              <MarkBtn onClick={() => remind("upuf_overdue")}>✉ UP/UF reminder</MarkBtn>
            </div>
          )}
        </StageGroup>
      )}
      </div>

      {/* Difference note — its own full-width line */}
      <div>
        <div style={stripGroupTitle}>Difference note</div>
        <input
          type="text"
          className="input"
          value={line.difference_note ?? ""}
          onChange={(e) => onChange({ difference_note: e.target.value || null })}
          disabled={!canEdit}
          placeholder="e.g. Amount to be deposited to Ferrocrete account"
          style={{ fontSize: 13, width: "100%", maxWidth: 560 }}
        />
      </div>
    </div>
  );
}

function WaiverRow({
  line,
  types,
  saved,
  canEdit,
  waiverIndex,
  onWaiverChanged,
  onError,
}: {
  line: ReleaseLine;
  types: ReleaseType[];
  saved: boolean;
  canEdit: boolean;
  waiverIndex: Map<string, Waiver>;
  onWaiverChanged: WaiverChanged;
  onError: (msg: string) => void;
}) {
  if (!saved) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-faint)", margin: "4px 0" }}>
        Save to add waivers
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 4, margin: "4px 0" }}>
      {types.map((t) => (
        <WaiverSlot
          key={t}
          type={t}
          existing={waiverIndex.get(`${line.id}:${t}`)}
          releaseLineId={line.id}
          canEdit={canEdit}
          onWaiverChanged={(wt, action) => onWaiverChanged(line.sub_id, wt, action)}
          onError={onError}
        />
      ))}
    </div>
  );
}

const stripBtnRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 6,
};
const stripGroupTitle: React.CSSProperties = {
  fontFamily:
    "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  marginBottom: 4,
};

function StageGroup({
  title,
  status,
  children,
}: {
  title: string;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--surface, var(--bg))",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm, 6px)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div style={{ ...stripGroupTitle, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span>{title}</span>
        {status ? (
          <span style={{ color: "var(--text-primary)", textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
            {status.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function DateLine({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
      {label}: <strong style={{ color: "var(--text-primary)" }}>{value}</strong>
    </div>
  );
}

function MarkBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn"
      style={{ fontSize: 11, padding: "2px 7px" }}
    >
      {children}
    </button>
  );
}

function DerivedFlag({ label, on }: { label: string; on: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
      <span
        style={{
          width: 14,
          textAlign: "center",
          color: on ? "var(--status-green)" : "var(--text-faint)",
        }}
      >
        {on ? "●" : "○"}
      </span>
      <span style={{ color: on ? "var(--text-primary)" : "var(--text-muted)" }}>
        {label}
      </span>
      <span
        style={{
          fontFamily:
            "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
          fontSize: 9,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--text-faint)",
        }}
      >
        derived
      </span>
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
  onWaiverChanged: (waiverType: ReleaseType, action: "upload" | "delete") => void;
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
      await onWaiverChanged(type, "upload");
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
      await onWaiverChanged(type, "delete");
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
          fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.5,
          background: "rgba(22, 163, 74, 0.12)",
          color: "var(--status-green)",
          border: "1px solid rgba(22, 163, 74, 0.30)",
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
          fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
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
        fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: 0.5,
        padding: "3px 6px",
        border: "1px dashed var(--border-strong)",
        borderRadius: 4,
        color: uploading ? "var(--status-amber)" : "var(--text-muted)",
        background: uploading ? "rgba(245, 158, 11, 0.10)" : "transparent",
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

const MONO =
  "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace";

function BulkRemindBtn({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0}
      className="btn"
      style={{ fontSize: 12, padding: "4px 10px", opacity: count === 0 ? 0.45 : 1 }}
      title={count === 0 ? "No eligible subs" : `${count} sub${count === 1 ? "" : "s"}`}
    >
      ✉ {label}
      {count > 0 && <span style={{ fontFamily: MONO, color: "var(--text-muted)" }}> · {count}</span>}
    </button>
  );
}

function ReminderModal({
  trackerId,
  templateKey,
  lineIds,
  onClose,
  onSent,
  onError,
}: {
  trackerId: string;
  templateKey: ReminderTemplateKey;
  lineIds: string[];
  onClose: () => void;
  onSent: (r: ReminderSendResult) => void;
  onError: (msg: string) => void;
}) {
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api.post<ReminderPreview>(
          `/release-trackers/${trackerId}/reminders/preview`,
          { template_key: templateKey, line_ids: lineIds }
        );
        if (cancelled) return;
        setPreview(p);
        setSubject(p.subject);
        setBody(p.body);
      } catch (e) {
        if (!cancelled) {
          onError(formatApiError(e));
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trackerId, templateKey, lineIds, onClose, onError]);

  async function send() {
    setSending(true);
    try {
      const r = await api.post<ReminderSendResult>(
        `/release-trackers/${trackerId}/reminders/send`,
        { template_key: templateKey, line_ids: lineIds, subject, body }
      );
      onSent(r);
    } catch (e) {
      onError(formatApiError(e));
      setSending(false);
    }
  }

  const recipients = preview?.recipients ?? [];
  const skipped = preview?.skipped ?? [];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "grid",
        placeItems: "center",
        padding: 20,
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          background: "var(--surface, var(--bg))",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius)",
          width: "min(680px, 100%)",
          maxHeight: "88vh",
          overflowY: "auto",
          padding: 22,
          boxShadow: "0 20px 60px rgba(0,0,0,.35)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            {REMINDER_TITLES[templateKey]}
          </h2>
          <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--text-muted)" }}>
            {recipients.length} recipient{recipients.length === 1 ? "" : "s"}
            {skipped.length ? ` · ${skipped.length} skipped` : ""}
          </span>
        </div>

        {loading ? (
          <div style={{ color: "var(--text-muted)", padding: "20px 0" }}>Composing…</div>
        ) : (
          <>
            <div style={{ marginTop: 12 }}>
              <label className="form-label">Subject</label>
              <input
                type="text"
                className="input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="form-label">Body</label>
              <textarea
                className="input"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                style={{ fontFamily: "inherit", resize: "vertical", lineHeight: 1.5 }}
              />
              {body.includes("{sub}") && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  <code>{"{sub}"}</code> is replaced with each subcontractor&apos;s name.
                </div>
              )}
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>
                To
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {recipients.map((r) => (
                  <span
                    key={r.release_line_id}
                    title={r.cc ? `cc ${r.cc}` : undefined}
                    style={{
                      fontSize: 12.5,
                      background: "var(--accent-dim)",
                      border: "1px solid var(--accent-border)",
                      borderRadius: 6,
                      padding: "3px 9px",
                    }}
                  >
                    {r.sub_name}{" "}
                    <span style={{ color: "var(--text-muted)", fontFamily: MONO, fontSize: 11 }}>
                      {r.to}
                    </span>
                    {r.cc ? <span style={{ color: "var(--text-faint)" }}> +cc</span> : null}
                  </span>
                ))}
                {recipients.length === 0 && (
                  <span style={{ color: "var(--status-amber)", fontSize: 13 }}>
                    None of these subs have an email on file.
                  </span>
                )}
              </div>
              {skipped.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
                  Skipped (no email): {skipped.map((s) => s.sub_name).join(", ")}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button
                onClick={send}
                disabled={sending || recipients.length === 0}
                className="btn btn-accent"
              >
                {sending ? "Sending…" : `Send to ${recipients.length}`}
              </button>
              <button onClick={onClose} disabled={sending} className="btn btn-ghost">
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReconLine({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <>
      <span style={{ color: strong ? "var(--text-primary)" : "var(--text-muted)" }}>
        {label}
      </span>
      <span
        style={{
          textAlign: "right",
          fontWeight: strong ? 700 : 400,
          color: "var(--text-primary)",
        }}
      >
        {fmtMoneyShort(value)}
      </span>
    </>
  );
}

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
            fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
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

const thStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 8px",
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 500,
};
const totalLabelStyle: React.CSSProperties = {
  paddingTop: 14,
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 10,
  letterSpacing: "1.5px",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  textAlign: "right",
};
const totalValueStyle: React.CSSProperties = {
  paddingTop: 14,
  textAlign: "right",
  fontFamily: "IBM Plex Mono, 'Cascadia Mono', Consolas, 'Courier New', ui-monospace, monospace",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-primary)",
};
