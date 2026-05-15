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
  period: Period;
  app_no: number;
  status: PayAppStatus;
  current_payment_due: Money;
  percent_complete: number;
  updated_at: string | null;
}

interface DashboardStats {
  open_drafts_count: number;
  open_drafts_projects: number;
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
    case "draft": return "pill-amber";
    case "submitted": return "pill-blue";
    case "paid": return "pill-green";
    case "void": return "pill-muted";
    default: return "pill-muted";
  }
}

// Inline style fallbacks for layout-critical grid (belt-and-suspenders against
// any CSS load order or scoping surprises).
const TABLE_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "90px minmax(0, 1fr) 60px 100px 130px 90px 80px",
  alignItems: "center",
  gap: "0.75rem",
};

// ─── Component ──────────────────────────────────────────────────

export default function PayAppsDashboard() {
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
            eyebrow="Submitted"
            value={stats ? String(stats.submitted_count) : "—"}
            subdetail={stats ? `${fmtMoneyCompact(stats.submitted_outstanding)} outstanding` : ""}
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
          <span className="dash-filter-eyebrow">PERIOD</span>
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

          <span className="dash-filter-eyebrow">FILTER</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="dash-dropdown"
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
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
            <div className="dash-th" style={{ textAlign: "right" }}>Current due</div>
            <div className="dash-th" style={{ textAlign: "right" }}>% Complete</div>
            <div className="dash-th" />
          </div>

          {loading && <div className="dash-table-empty">Loading…</div>}
          {!loading && error && <div className="dash-table-empty dash-table-error">{error}</div>}
          {!loading && !error && payApps.length === 0 && (
            <div className="dash-table-empty">No pay apps match these filters.</div>
          )}
          {!loading && !error && payApps.map(pa => (
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
                <span className={`pill ${statusPillClass(pa.status)}`}>{pa.status}</span>
              </div>
              <div className="dash-td-due" style={{ textAlign: "right" }}>
                {fmtMoneyShort(pa.current_payment_due)}
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
          ))}
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
      <div className="dash-stat-eyebrow">{eyebrow.toUpperCase()}</div>
      <div className="dash-stat-value">{value}</div>
      <div className="dash-stat-subdetail">{subdetail}</div>
    </div>
  );
}
