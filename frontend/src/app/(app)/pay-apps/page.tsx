"use client";

/**
 * Pay Applications Dashboard — `/pay-apps`
 *
 * New default landing after login. Pay applications are the primary entity;
 * Projects remains accessible via the secondary nav pill.
 *
 * Styling: all dashboard-specific styles live in globals.css under the
 * `.dash-*` namespace (matches the existing codebase pattern — see
 * .pay-app-row, .project-card-*, .sov-row-* in globals.css).
 * Layout-critical grid is also set inline as belt-and-suspenders.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { fmtMoneyShort } from "@/lib/payAppMath";
import { useCurrentUser } from "@/lib/useCurrentUser";
import type { PayAppStatus, Project, UUID, Money, Period } from "@/lib/types";
import {
  PeriodType,
  PeriodOption,
  optionsForType,
  defaultOptionForType,
  billedEyebrow,
  billedSubdetail,
} from "@/lib/periodFilters";

// ─── Dashboard response types ───────────────────────────────────

interface DashboardPayApp {
  id: UUID;
  project_id: UUID;
  project_name: string;
  project_no: string;
  gc_company: string;
  gc_email_configured: boolean;
  period: Period;
  app_no: number;
  status: PayAppStatus;
  current_payment_due: Money;
  percent_complete: number;
  due_date: string | null;                  // ISO date
  submitted_for_approval_at: string | null; // ISO datetime
  updated_at: string | null;
}

interface DashboardStats {
  open_drafts_count: number;
  open_drafts_projects: number;
  pending_approval_count: number;
  pending_approval_total: number;
  approved_count: number;
  approved_total: number;
  submitted_count: number;
  submitted_outstanding: number;
  billed_total: number;
  billed_projects: number;
  revised_contract_total: number;
}

interface DashboardResponse {
  pay_apps: DashboardPayApp[];
  stats: DashboardStats;
}

// ─── Helpers ────────────────────────────────────────────────────

const MONTH_SHORTS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtPeriodLabel(period: string): string {
  if (!period || period.length !== 5) return period;
  const [yy, mm] = period.split("-");
  const idx = parseInt(mm, 10) - 1;
  if (idx < 0 || idx > 11) return period;
  return `${MONTH_SHORTS[idx]} 20${yy}`;
}

function fmtMoneyCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

function statusPillClass(status: PayAppStatus): string {
  switch (status) {
    case "draft": return "pill-muted";
    case "pending_approval": return "pill-amber";   // action: admin
    case "approved": return "pill-blue";            // action: accountant
    case "submitted": return "pill-blue";           // out to client
    case "paid": return "pill-green";
    case "void": return "pill-red";
    default: return "pill-muted";
  }
}

function statusLabel(status: PayAppStatus): string {
  switch (status) {
    case "draft": return "Draft";
    case "pending_approval": return "Pending approval";
    case "approved": return "Approved";
    case "submitted": return "Sent to client";
    case "paid": return "Paid";
    case "void": return "Void";
    default: return status;
  }
}

/** ISO date → short display like "May 31" (current year omitted). */
function fmtDeadline(iso: string | null): string {
  if (!iso) return "—";
  const [yyyy, mm, dd] = iso.split("-");
  const idx = parseInt(mm, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx > 11) return iso;
  const year = parseInt(yyyy, 10);
  const now = new Date();
  const sameYear = year === now.getFullYear();
  return sameYear
    ? `${MONTH_SHORTS[idx]} ${parseInt(dd, 10)}`
    : `${MONTH_SHORTS[idx]} ${parseInt(dd, 10)}, ${year}`;
}

/** Compare a YYYY-MM-DD date to today: -1 past, 0 within 3 days, 1 ok. */
function deadlineTone(iso: string | null): "past" | "soon" | "ok" | null {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const daysLeft = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  if (daysLeft < 0) return "past";
  if (daysLeft <= 3) return "soon";
  return "ok";
}

// Inline style fallbacks for layout-critical grid (belt-and-suspenders against
// any CSS load order or scoping surprises).
// Added a Deadline column between Status and Current due.
const TABLE_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "90px minmax(0, 1fr) 60px 130px 130px 110px 80px 80px",
  alignItems: "center",
  gap: "0.75rem",
};

// ─── Component ──────────────────────────────────────────────────

export default function PayAppsDashboard() {
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  const isAccountant = user?.role === "accountant";

  const [periodType, setPeriodType] = useState<PeriodType>("month");
  const [periodValue, setPeriodValue] = useState<string>("");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");

  const [payApps, setPayApps] = useState<DashboardPayApp[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const def = defaultOptionForType("month");
    if (def) setPeriodValue(def.value);
  }, []);

  useEffect(() => {
    if (periodType === "custom") return;
    const def = defaultOptionForType(periodType);
    setPeriodValue(def?.value ?? "");
  }, [periodType]);

  const currentOptions = useMemo(() => optionsForType(periodType), [periodType]);
  const selectedOption: PeriodOption | null = useMemo(() => {
    if (periodType === "custom") {
      if (!customStart || !customEnd) return null;
      return {
        value: "custom",
        label: `${customStart} to ${customEnd}`,
        startKey: customStart,
        endKey: customEnd,
      };
    }
    return currentOptions.find(o => o.value === periodValue) ?? null;
  }, [periodType, periodValue, customStart, customEnd, currentOptions]);

  const startKey = selectedOption?.startKey ?? "";
  const endKey = selectedOption?.endKey ?? "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Project[]>("/projects");
        if (!cancelled) setProjects(list);
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!startKey || !endKey) return;

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set("period_start", startKey);
    params.set("period_end", endKey);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (projectFilter !== "all") params.set("project_id", projectFilter);

    (async () => {
      try {
        const data = await api.get<DashboardResponse>(
          `/pay-apps/dashboard?${params.toString()}`,
          { signal: ctrl.signal }
        );
        if (ctrl.signal.aborted) return;
        setPayApps(data.pay_apps ?? []);
        setStats(data.stats ?? null);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        if (e instanceof ApiError) setError(`${e.status}: ${e.detail}`);
        else setError(String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [startKey, endKey, statusFilter, projectFilter]);

  return (
    <>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">FERROCRETE BUILDERS, INC.</div>
          <h1 className="page-title">Pay Applications</h1>
        </div>
        <div className="page-actions">
          <Link href="/projects" className="btn btn-ghost">Projects</Link>
          <Link href="/projects/import" className="btn btn-ghost">Import</Link>
          <Link
            href="/projects"
            className="btn dash-btn-red"
            title="Choose a project first, then start a new pay app"
          >
            + Start new pay app
          </Link>
        </div>
      </div>

      <div className="page-content">
        {/* ───── "Your court" section — role-aware queue at the top ───── */}
        {!loading && !error && stats && (
          <YourCourtSection
            isAdmin={isAdmin}
            isAccountant={isAccountant}
            stats={stats}
            payApps={payApps}
            onJumpToFilter={setStatusFilter}
          />
        )}

        {/* ───── Stat cards ───── */}
        <div className="dash-stat-grid">
          <DashStatCard
            eyebrow="Open drafts"
            value={stats ? String(stats.open_drafts_count) : "—"}
            subdetail={
              stats
                ? `${stats.open_drafts_projects} ${stats.open_drafts_projects === 1 ? "project" : "projects"}`
                : ""
            }
          />
          <DashStatCard
            eyebrow={isAdmin ? "Awaiting your approval" : "Awaiting Raz's approval"}
            value={stats ? String(stats.pending_approval_count) : "—"}
            subdetail={
              stats
                ? stats.pending_approval_count > 0
                  ? `${fmtMoneyCompact(stats.pending_approval_total)} pending`
                  : "Nothing to review"
                : ""
            }
            highlighted={isAdmin && (stats?.pending_approval_count ?? 0) > 0}
          />
          <DashStatCard
            eyebrow={billedEyebrow(periodType, selectedOption)}
            value={stats ? fmtMoneyCompact(stats.billed_total) : "—"}
            subdetail={stats ? billedSubdetail(periodType, selectedOption, stats.billed_projects) : ""}
            highlighted
          />
          <DashStatCard
            eyebrow="Revised contract"
            value={stats ? fmtMoneyCompact(stats.revised_contract_total) : "—"}
            subdetail="All active projects"
          />
        </div>

        {/* ───── Filter row ───── */}
        <div className="dash-filter-row">
          <span className="dash-filter-eyebrow">Period</span>
          <div className="dash-chip-group">
            {(["month", "quarter", "half", "year", "custom"] as PeriodType[]).map(t => (
              <button
                key={t}
                type="button"
                className={`dash-chip ${periodType === t ? "dash-chip-active" : ""}`}
                onClick={() => setPeriodType(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          <div className="dash-filter-divider" />

          {periodType === "custom" ? (
            <div className="dash-custom-range">
              <input
                type="month"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                className="dash-dropdown dash-date-input"
                aria-label="From month"
              />
              <span className="dash-range-dash">–</span>
              <input
                type="month"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                className="dash-dropdown dash-date-input"
                aria-label="To month"
              />
            </div>
          ) : (
            <select
              value={periodValue}
              onChange={e => setPeriodValue(e.target.value)}
              className="dash-dropdown"
              aria-label="Select period"
            >
              {currentOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}

          <div className="dash-filter-spacer" />

          <span className="dash-filter-eyebrow">Filter</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="dash-dropdown"
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending_approval">Pending approval</option>
            <option value="approved">Approved</option>
            <option value="submitted">Sent to client</option>
            <option value="paid">Paid</option>
            <option value="void">Void</option>
          </select>
          <select
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            className="dash-dropdown"
            aria-label="Filter by project"
          >
            <option value="all">All projects</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name} · {p.project_no}</option>
            ))}
          </select>
        </div>

        {/* ───── Pay apps table ───── */}
        <div className="glass dash-table">
          <div className="dash-table-header" style={TABLE_GRID_STYLE}>
            <div className="dash-th">Period</div>
            <div className="dash-th">Project / GC</div>
            <div className="dash-th" style={{ textAlign: "center" }}>App</div>
            <div className="dash-th" style={{ textAlign: "center" }}>Status</div>
            <div className="dash-th" style={{ textAlign: "right" }}>Amount billed</div>
            <div className="dash-th" style={{ textAlign: "center" }}>Deadline</div>
            <div className="dash-th" style={{ textAlign: "right" }}>% Done</div>
            <div className="dash-th" />
          </div>

          {loading && <div className="dash-table-empty">Loading…</div>}
          {!loading && error && <div className="dash-table-empty dash-table-error">{error}</div>}
          {!loading && !error && payApps.length === 0 && (
            <div className="dash-table-empty">No pay apps match these filters.</div>
          )}
          {!loading && !error && payApps.map(pa => {
            const tone = deadlineTone(pa.due_date);
            const deadlineColor =
              tone === "past" ? "var(--status-red)"
              : tone === "soon" ? "var(--status-amber)"
              : "var(--text-muted)";
            return (
              <div key={pa.id} className="dash-table-row" style={TABLE_GRID_STYLE}>
                <div className="dash-td-period">{fmtPeriodLabel(pa.period)}</div>
                <div className="dash-td-project">
                  <div className="dash-project-line">
                    <span className="dash-project-name">{pa.project_name}</span>
                    {pa.project_no && <span className="dash-project-no"> · {pa.project_no}</span>}
                  </div>
                  <div className="dash-gc-name">{pa.gc_company || "No GC info"}</div>
                </div>
                <div className="dash-td-app" style={{ textAlign: "center" }}>#{pa.app_no}</div>
                <div className="dash-td-status" style={{ textAlign: "center" }}>
                  <span className={`pill ${statusPillClass(pa.status)}`}>{statusLabel(pa.status)}</span>
                </div>
                <div className="dash-td-due" style={{ textAlign: "right" }}>
                  {fmtMoneyShort(pa.current_payment_due)}
                </div>
                <div
                  className="dash-td-due"
                  style={{ textAlign: "center", color: deadlineColor, fontWeight: tone === "past" ? 600 : 500 }}
                  title={pa.due_date ? `Submit by ${pa.due_date}` : "No deadline set"}
                >
                  {fmtDeadline(pa.due_date)}
                </div>
                <div className="dash-td-pct" style={{ textAlign: "right" }}>
                  {(pa.percent_complete ?? 0).toFixed(1)}%
                </div>
                <div className="dash-td-link" style={{ textAlign: "right" }}>
                  <Link
                    href={`/projects/${pa.project_id}/pay-apps/${pa.period}`}
                    className="dash-open-link"
                  >
                    Open →
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ─── StatCard subcomponent ──────────────────────────────────────

function DashStatCard({
  eyebrow,
  value,
  subdetail,
  highlighted = false,
}: {
  eyebrow: string;
  value: string;
  subdetail: string;
  highlighted?: boolean;
}) {
  return (
    <div className={highlighted ? "dash-stat-card dash-stat-card-highlight" : "dash-stat-card glass"}>
      <div className="dash-stat-eyebrow">{eyebrow}</div>
      <div className="dash-stat-value">{value}</div>
      <div className="dash-stat-subdetail">{subdetail}</div>
    </div>
  );
}


// ─── "Your court" queue ──────────────────────────────────────────
// Role-aware top-of-dashboard reminder. Admin sees pending_approval queue;
// accountant sees approved queue. PEs (and empty queues) see nothing.

function YourCourtSection({
  isAdmin,
  isAccountant,
  stats,
  payApps,
  onJumpToFilter,
}: {
  isAdmin: boolean;
  isAccountant: boolean;
  stats: DashboardStats;
  payApps: DashboardPayApp[];
  onJumpToFilter: (status: string) => void;
}) {
  let title = "";
  let statusKey: PayAppStatus | null = null;
  let count = 0;
  let totalAmount = 0;
  let helpText = "";

  if (isAdmin && stats.pending_approval_count > 0) {
    title = "Awaiting your approval";
    statusKey = "pending_approval";
    count = stats.pending_approval_count;
    totalAmount = stats.pending_approval_total;
    helpText = "Pay apps your accountants have submitted for your review.";
  } else if (isAccountant && stats.approved_count > 0) {
    title = "Ready to send to client";
    statusKey = "approved";
    count = stats.approved_count;
    totalAmount = stats.approved_total;
    helpText = "Approved by Raz — send to the GC or submit via their portal.";
  } else {
    return null;
  }

  // Pull just the items in this status from the loaded set, newest first.
  const items = payApps
    .filter(p => p.status === statusKey)
    .slice(0, 5);

  return (
    <div
      className="glass"
      style={{
        padding: "18px 22px 16px",
        marginBottom: 24,
        borderLeft: "3px solid var(--accent)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div className="dash-stat-eyebrow" style={{ color: "var(--accent-text)" }}>
            {title} ({count})
          </div>
          <div style={{
            fontFamily: "var(--font-serif)", fontSize: 14, color: "var(--text-muted)", marginTop: 4,
          }}>
            {helpText}
            {totalAmount > 0 && <>  ·  <b>{fmtMoneyCompact(totalAmount)}</b> total</>}
          </div>
        </div>
        <button
          type="button"
          className="dash-chip"
          onClick={() => statusKey && onJumpToFilter(statusKey)}
          title="Filter the table below to just these"
        >
          See all →
        </button>
      </div>

      {items.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map(pa => (
            <Link
              key={pa.id}
              href={`/projects/${pa.project_id}/pay-apps/${pa.period}`}
              className="pay-app-row"
              style={{ textDecoration: "none" }}
            >
              <div className="pay-app-row-left">
                <span className="pay-app-row-period">{pa.project_name}</span>
                <span className="pay-app-row-app-no">App #{pa.app_no} · {pa.period}</span>
              </div>
              <div className="pay-app-row-right">
                <span className={`pill ${statusPillClass(pa.status)}`}>{statusLabel(pa.status)}</span>
                <span className="pay-app-row-amount">{fmtMoneyShort(pa.current_payment_due)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
