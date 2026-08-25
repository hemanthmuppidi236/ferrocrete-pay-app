"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import type {
  BillingSummaryResponse,
  BillingSummaryRow,
  BillingOverridePatch,
} from "@/lib/types";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "26-06" → "Jun 2026" (falls back to the raw period on any parse issue). */
function periodLabel(p: string | null): string {
  if (!p) return "—";
  const m = /^(\d{2})-(\d{2})$/.exec(p);
  if (!m) return p;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return p;
  return `${MONTHS[month - 1]} 20${m[1]}`;
}

function money(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  return fmtMoneyShort(v);
}

function pct(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export default function BillingSummaryPage() {
  const { user: currentUser } = useCurrentUser();
  const [period, setPeriod] = useState<string | null>(null);
  const [data, setData] = useState<BillingSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canEdit =
    currentUser?.role === "admin" ||
    currentUser?.role === "accountant" ||
    currentUser?.role === "pe";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const qs = period ? `?period=${encodeURIComponent(period)}` : "";
        const res = await api.get<BillingSummaryResponse>(`/billing-summary${qs}`);
        if (cancelled) return;
        setData(res);
        if (!period && res.period) setPeriod(res.period);
      } catch (e) {
        if (!cancelled) setError(formatApiError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  // Persist one manual field for a (project, period) cell.
  async function saveOverride(
    projectId: string,
    field: keyof Omit<BillingOverridePatch, "project_id" | "period">,
    value: string
  ) {
    if (!data?.period) return;
    // Optimistic local update so totals/labels reflect immediately.
    setData((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.project_id === projectId ? { ...r, [field]: value } : r
            ),
          }
        : prev
    );
    try {
      await api.patch("/billing-summary/override", {
        project_id: projectId,
        period: data.period,
        [field]: value === "" ? null : value,
      });
    } catch (e) {
      setError(formatApiError(e));
    }
  }

  const rows = data?.rows ?? [];
  const totals = data?.totals;

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">FERROCRETE BUILDERS, INC.</div>
          <h1 className="page-title">Billing Summary</h1>
          <div className="page-meta">
            {loading
              ? "Loading…"
              : (
                <>
                  <strong>{periodLabel(data?.period ?? period)}</strong> ·{" "}
                  {rows.length} project{rows.length === 1 ? "" : "s"}
                </>
              )}
          </div>
        </div>
        <div className="page-actions">
          <label
            style={{
              fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)",
              fontSize: 11,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--text-faint)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            Period
            <select
              className="input"
              value={data?.period ?? ""}
              onChange={(e) => setPeriod(e.target.value)}
              style={{ width: "auto", minWidth: 140 }}
            >
              {(data?.available_periods ?? []).map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="page-content">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {/* Accrued + period stat cards */}
        {data && (
          <div className="dash-stat-grid" style={{ marginBottom: 20 }}>
            <StatCard label="Billed this period" value={money(totals?.billed_amount ?? 0)} />
            <StatCard label="Net income this period" value={money(totals?.potential_net ?? 0)} />
            <StatCard
              label="Net income accrued to date"
              value={money(data.accrued.net)}
              highlight
            />
            <StatCard label="Total billed to date" value={money(data.accrued.billed)} />
          </div>
        )}

        <div className="section-card glass" style={{ padding: 0, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
              No billing activity for this period.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 1800,
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr>
                    <Th left sticky>Job</Th>
                    <Th>Due</Th>
                    <Th right>Revised Contract</Th>
                    <Th right>Completed</Th>
                    <Th right>Retention</Th>
                    <Th right>Balance</Th>
                    <Th right>Gross</Th>
                    <Th right>Ret%</Th>
                    <Th right>Billed</Th>
                    <Th right>Potential Net</Th>
                    <Th>BT</Th>
                    <Th right>Rebar</Th>
                    <Th right>CMU</Th>
                    <Th>CP/CF</Th>
                    <Th>UP/UF</Th>
                    <Th>Contact</Th>
                    <Th>Payment Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row
                      key={r.project_id}
                      row={r}
                      period={data?.period ?? ""}
                      canEdit={canEdit}
                      onSave={saveOverride}
                    />
                  ))}
                  {totals && (
                    <tr style={{ borderTop: "2px solid var(--border-strong)" }}>
                      <Td left sticky bold>Total</Td>
                      <Td />
                      <Td right bold>{money(totals.revised_contract)}</Td>
                      <Td right bold>{money(totals.total_completed)}</Td>
                      <Td right bold>{money(totals.retention)}</Td>
                      <Td right bold>{money(totals.balance_to_finish)}</Td>
                      <Td right bold>{money(totals.gross_billing)}</Td>
                      <Td />
                      <Td right bold>{money(totals.billed_amount)}</Td>
                      <Td right bold accent>{money(totals.potential_net)}</Td>
                      <Td /><Td /><Td /><Td /><Td /><Td /><Td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 12,
            fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)",
            fontSize: 11,
            color: "var(--text-faint)",
            letterSpacing: 0.3,
          }}
        >
          Auto columns recompute from pay apps + release trackers. Potential Net =
          invoice − sub checks − previous-month unbilled (the release tracker's
          Ferrocrete Net). Editable columns: Due, BT, Rebar, CMU, CP/CF, UP/UF,
          Contact, Payment Status.
        </div>
      </div>
    </>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────

function Row({
  row,
  period,
  canEdit,
  onSave,
}: {
  row: BillingSummaryRow;
  period: string;
  canEdit: boolean;
  onSave: (
    projectId: string,
    field: keyof Omit<BillingOverridePatch, "project_id" | "period">,
    value: string
  ) => void;
}) {
  const netNegative =
    row.potential_net !== null && parseFloat(row.potential_net) < 0;
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <Td left sticky>
        <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{row.job}</span>
      </Td>
      <EditCell
        value={row.billing_due_date}
        canEdit={canEdit}
        width={70}
        keyId={`${row.project_id}-${period}-due`}
        onSave={(v) => onSave(row.project_id, "billing_due_date", v)}
      />
      <Td right>{money(row.revised_contract)}</Td>
      <Td right>{money(row.total_completed)}</Td>
      <Td right>{money(row.retention)}</Td>
      <Td right>{money(row.balance_to_finish)}</Td>
      <Td right>{money(row.gross_billing)}</Td>
      <Td right muted>{pct(row.retention_rate)}</Td>
      <Td right>{money(row.billed_amount)}</Td>
      <Td right accent bold>
        <span style={netNegative ? { color: "var(--ferrocrete-red)" } : undefined}>
          {money(row.potential_net)}
        </span>
      </Td>
      <EditCell
        value={row.bt_note}
        canEdit={canEdit}
        width={140}
        keyId={`${row.project_id}-${period}-bt`}
        onSave={(v) => onSave(row.project_id, "bt_note", v)}
      />
      <EditCell
        value={row.rebar ?? ""}
        canEdit={canEdit}
        width={80}
        right
        keyId={`${row.project_id}-${period}-rebar`}
        onSave={(v) => onSave(row.project_id, "rebar", v)}
      />
      <EditCell
        value={row.cmu ?? ""}
        canEdit={canEdit}
        width={80}
        right
        keyId={`${row.project_id}-${period}-cmu`}
        onSave={(v) => onSave(row.project_id, "cmu", v)}
      />
      <EditCell
        value={row.cpcf_sent}
        canEdit={canEdit}
        width={60}
        keyId={`${row.project_id}-${period}-cpcf`}
        onSave={(v) => onSave(row.project_id, "cpcf_sent", v)}
      />
      <EditCell
        value={row.upuf_sent}
        canEdit={canEdit}
        width={60}
        keyId={`${row.project_id}-${period}-upuf`}
        onSave={(v) => onSave(row.project_id, "upuf_sent", v)}
      />
      <EditCell
        value={row.billing_contact}
        canEdit={canEdit}
        width={180}
        keyId={`${row.project_id}-${period}-contact`}
        onSave={(v) => onSave(row.project_id, "billing_contact", v)}
      />
      <EditCell
        value={row.payment_status}
        canEdit={canEdit}
        width={160}
        keyId={`${row.project_id}-${period}-pay`}
        onSave={(v) => onSave(row.project_id, "payment_status", v)}
      />
    </tr>
  );
}

// ─── Cells ────────────────────────────────────────────────────────────

const cellBase: React.CSSProperties = {
  padding: "8px 10px",
  fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)",
  whiteSpace: "nowrap",
};

function Th({
  children,
  right,
  left,
  sticky,
}: {
  children?: React.ReactNode;
  right?: boolean;
  left?: boolean;
  sticky?: boolean;
}) {
  return (
    <th
      style={{
        ...cellBase,
        textAlign: right ? "right" : left ? "left" : "left",
        fontSize: 10,
        letterSpacing: "1px",
        textTransform: "uppercase",
        color: "var(--accent-text)",
        fontWeight: 500,
        background: "var(--accent-dim)",
        borderBottom: "1px solid var(--accent-border)",
        position: sticky ? "sticky" : undefined,
        left: sticky ? 0 : undefined,
        zIndex: sticky ? 2 : undefined,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  left,
  sticky,
  bold,
  muted,
  accent,
}: {
  children?: React.ReactNode;
  right?: boolean;
  left?: boolean;
  sticky?: boolean;
  bold?: boolean;
  muted?: boolean;
  accent?: boolean;
}) {
  return (
    <td
      style={{
        ...cellBase,
        textAlign: right ? "right" : "left",
        fontWeight: bold ? 600 : 400,
        color: accent
          ? "var(--accent-text)"
          : muted
          ? "var(--text-faint)"
          : "var(--text-body)",
        position: sticky ? "sticky" : undefined,
        left: sticky ? 0 : undefined,
        background: sticky ? "var(--glass-bg-strong)" : undefined,
        zIndex: sticky ? 1 : undefined,
      }}
    >
      {children}
    </td>
  );
}

/** Editable cell: uncontrolled input (keyed so it resets on data reload),
 *  saves on blur. Read-only text when the user can't edit. */
function EditCell({
  value,
  canEdit,
  width,
  right,
  keyId,
  onSave,
}: {
  value: string;
  canEdit: boolean;
  width: number;
  right?: boolean;
  keyId: string;
  onSave: (v: string) => void;
}) {
  if (!canEdit) {
    return (
      <Td right={right} muted={!value}>
        {value || "—"}
      </Td>
    );
  }
  return (
    <td style={{ ...cellBase, padding: "4px 6px" }}>
      <input
        key={keyId}
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value !== value) onSave(e.target.value);
        }}
        style={{
          width,
          maxWidth: "100%",
          padding: "4px 6px",
          fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)",
          fontSize: 12,
          textAlign: right ? "right" : "left",
          border: "1px solid transparent",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          color: "var(--text-body)",
          transition: "border-color .15s, background .15s",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "var(--accent)";
          e.target.style.background = "var(--input-bg)";
        }}
        onBlurCapture={(e) => {
          e.target.style.borderColor = "transparent";
          e.target.style.background = "transparent";
        }}
      />
    </td>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`glass dash-stat-card ${highlight ? "dash-stat-card-highlight" : ""}`}>
      <div className="dash-stat-eyebrow">{label}</div>
      <div className="dash-stat-value">{value}</div>
    </div>
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
