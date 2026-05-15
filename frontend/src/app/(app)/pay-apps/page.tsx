"use client";

/**
 * Pay Applications Dashboard — `/pay-apps`
 *
 * New default landing after login. Pay applications are the primary entity;
 * Projects remains accessible via the secondary nav pill.
 *
 * Conventions matched to existing codebase:
 *   - api.get from @/lib/api (handles Supabase JWT auth + ApiError)
 *   - fmtMoneyShort from @/lib/payAppMath (parses Money strings)
 *   - Existing classes: glass, btn, btn-ghost, pill, pill-amber/blue/green/muted,
 *     page-header, page-title-block, page-eyebrow, page-title, page-actions,
 *     page-content
 *   - Token-driven colors via CSS vars so dark mode flips correctly
 *   - Hard-coded hex values from the LOCKED spec (red/amber gradient, etc.) use
 *     opacity-bearing rgba so they read well on both light cream and dark backgrounds
 *
 * Dashboard-specific styles use a `dash-` prefix to avoid colliding with
 * the global design system.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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

/** Compact dollar formatting for stat card values: $1.4M / $487k / $234 */
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

  // Initialize default period (current month) on first render
  useEffect(() => {
    const def = defaultOptionForType("month");
    if (def) setPeriodValue(def.value);
  }, []);

  // When the chip changes, reset to that type's default
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

  // Derive primitive keys for the fetch effect (avoid memoized-object identity churn)
  const startKey = selectedOption?.startKey ?? "";
  const endKey = selectedOption?.endKey ?? "";

  // Fetch projects once for the project filter dropdown
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Project[]>("/projects");
        if (!cancelled) setProjects(list);
      } catch {
        // non-fatal — filter just stays empty
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch dashboard data whenever filters change. AbortController prevents
  // pile-up when the user clicks through chips rapidly.
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

        {/* ───── Filter row (no panel — controls float on page bg) ───── */}
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
          <div className="dash-table-header">
            <div className="dash-th dash-th-period">Period</div>
            <div className="dash-th dash-th-project">Project / GC</div>
            <div className="dash-th dash-th-app">App</div>
            <div className="dash-th dash-th-status">Status</div>
            <div className="dash-th dash-th-due">Current due</div>
            <div className="dash-th dash-th-pct">% Complete</div>
            <div className="dash-th dash-th-link" />
          </div>

          {loading && <div className="dash-table-empty">Loading…</div>}
          {!loading && error && <div className="dash-table-empty dash-table-error">{error}</div>}
          {!loading && !error && payApps.length === 0 && (
            <div className="dash-table-empty">No pay apps match these filters.</div>
          )}
          {!loading && !error && payApps.map(pa => (
            <div key={pa.id} className="dash-table-row">
              <div className="dash-td dash-td-period">{fmtPeriodLabel(pa.period)}</div>
              <div className="dash-td dash-td-project">
                <div className="dash-project-line">
                  <span className="dash-project-name">{pa.project_name}</span>
                  {pa.project_no && <span className="dash-project-no"> · {pa.project_no}</span>}
                </div>
                <div className="dash-gc-name">{pa.gc_company || "No GC info"}</div>
              </div>
              <div className="dash-td dash-td-app">#{pa.app_no}</div>
              <div className="dash-td dash-td-status">
                <span className={`pill ${statusPillClass(pa.status)}`}>{pa.status}</span>
              </div>
              <div className="dash-td dash-td-due">{fmtMoneyShort(pa.current_payment_due)}</div>
              <div className="dash-td dash-td-pct">{(pa.percent_complete ?? 0).toFixed(1)}%</div>
              <div className="dash-td dash-td-link">
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

      <style jsx>{`
        /* Red CTA — there's no .btn-red in globals, so we define one here.
           Uses --ferrocrete-red which has light/dark mode token entries. */
        .dash-btn-red {
          background: var(--ferrocrete-red);
          color: #fff;
          border-color: var(--ferrocrete-red);
        }
        .dash-btn-red:hover {
          filter: brightness(1.05);
        }

        /* 4-column stat grid (overrides the global .stat-grid's auto-fit) */
        .dash-stat-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
          margin-bottom: 1.5rem;
        }
        @media (max-width: 900px) {
          .dash-stat-grid { grid-template-columns: repeat(2, 1fr); }
        }

        /* Filter row — no panel, controls float on page bg (locked spec) */
        .dash-filter-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
        }
        .dash-filter-eyebrow {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10.5px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: var(--text-faint);
          font-weight: 500;
          margin-right: 0.25rem;
        }
        .dash-chip-group { display: flex; gap: 0.4rem; }
        .dash-chip {
          font-family: 'EB Garamond', serif;
          font-size: 13.5px;
          font-weight: 500;
          padding: 0.4rem 0.85rem;
          border-radius: 999px;
          border: 1px solid var(--border-strong);
          background: transparent;
          color: var(--text-body);
          cursor: pointer;
          line-height: 1.2;
          transition: all 0.15s var(--glide);
        }
        .dash-chip:hover { background: var(--accent-dim); border-color: var(--border-hover); }
        .dash-chip-active {
          background: var(--text-primary);
          color: var(--grad-1);
          border-color: var(--text-primary);
        }
        .dash-chip-active:hover { background: var(--text-primary); }

        .dash-filter-divider {
          width: 1px;
          height: 18px;
          background: var(--border-strong);
          margin: 0 0.25rem;
        }

        .dash-dropdown {
          font-family: 'EB Garamond', serif;
          font-size: 14px;
          color: var(--text-body);
          background-color: var(--accent-dim);
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236b5c3a' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 0.7rem center;
          background-size: 10px 6px;
          border: 1px solid var(--accent-border);
          border-radius: var(--radius-sm);
          padding: 0.45rem 1.85rem 0.45rem 0.85rem;
          cursor: pointer;
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          line-height: 1.2;
          transition: border-color 0.15s var(--glide);
        }
        .dash-dropdown:hover { border-color: var(--accent); }
        .dash-dropdown:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px rgba(184,133,42,0.18);
        }
        .dash-date-input { background-image: none; padding-right: 0.65rem; }
        .dash-custom-range { display: flex; align-items: center; gap: 0.5rem; }
        .dash-range-dash {
          font-family: 'EB Garamond', serif;
          color: var(--text-muted);
          font-size: 14px;
        }
        .dash-filter-spacer { flex: 1 1 auto; }

        /* Table — locked column widths */
        .dash-table {
          padding: 0;
          overflow: hidden;
        }
        .dash-table-header, .dash-table-row {
          display: grid;
          grid-template-columns: 80px minmax(0, 1fr) 50px 95px 130px 80px 80px;
          align-items: center;
          gap: 0.75rem;
        }
        .dash-table-header {
          background: var(--accent-dim);
          border-bottom: 1px solid var(--accent-border);
          padding: 0.7rem 1.125rem;
        }
        .dash-th {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          color: var(--accent-text);
          font-weight: 500;
        }
        .dash-th-app, .dash-th-status { text-align: center; }
        .dash-th-due, .dash-th-pct { text-align: right; }

        .dash-table-row {
          padding: 14px 18px;
          border-bottom: 1px solid var(--border);
          transition: background 0.12s var(--glide);
        }
        .dash-table-row:last-child { border-bottom: none; }
        .dash-table-row:hover { background: var(--accent-dim); }

        .dash-td-period {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: var(--text-muted);
        }
        .dash-project-line { display: flex; align-items: baseline; min-width: 0; }
        .dash-project-name {
          font-family: 'EB Garamond', serif;
          font-size: 17px;
          font-weight: 500;
          color: var(--text-primary);
          line-height: 1.25;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dash-project-no {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          margin-left: 0.15rem;
          flex-shrink: 0;
        }
        .dash-gc-name {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10.5px;
          color: var(--text-faint);
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dash-td-app {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: var(--text-muted);
          text-align: center;
        }
        .dash-td-status { text-align: center; }
        .dash-td-due {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13.5px;
          font-weight: 500;
          color: var(--text-primary);
          text-align: right;
        }
        .dash-td-pct {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: var(--text-muted);
          text-align: right;
        }
        .dash-td-link { text-align: right; }
        .dash-open-link {
          font-family: 'EB Garamond', serif;
          font-size: 14px;
          color: var(--ferrocrete-red);
          text-decoration: none;
          font-weight: 500;
        }
        .dash-open-link:hover { filter: brightness(1.05); text-decoration: underline; }

        .dash-table-empty {
          padding: 2rem;
          text-align: center;
          color: var(--text-muted);
          font-family: 'EB Garamond', serif;
          font-size: 15px;
        }
        .dash-table-error { color: var(--ferrocrete-red); }
      `}</style>
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
    <div className={`dash-stat-card ${highlighted ? "dash-stat-card-highlight" : "glass"}`}>
      <div className="dash-stat-eyebrow">{eyebrow.toUpperCase()}</div>
      <div className="dash-stat-value">{value}</div>
      <div className="dash-stat-subdetail">{subdetail}</div>

      <style jsx>{`
        .dash-stat-card {
          border-radius: var(--radius-lg);
          padding: 1.1rem 1.2rem 1.05rem;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          min-height: 110px;
        }
        /* The "Billed this period" card — same gradient as .preview-pay-due
           uses (red→amber) so it reads consistently with the pay-app draft UI. */
        .dash-stat-card-highlight {
          background: linear-gradient(135deg, rgba(213, 59, 52, 0.10) 0%, rgba(212, 160, 74, 0.14) 100%);
          border: 1px solid var(--accent-border);
        }
        .dash-stat-eyebrow {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10.5px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: ${highlighted ? "var(--accent-text)" : "var(--text-faint)"};
          font-weight: 500;
        }
        .dash-stat-value {
          font-family: 'EB Garamond', serif;
          font-size: 32px;
          font-weight: 500;
          color: ${highlighted ? "var(--accent-text)" : "var(--text-primary)"};
          line-height: 1.05;
          letter-spacing: -0.01em;
        }
        .dash-stat-subdetail {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10.5px;
          color: ${highlighted ? "var(--accent-text)" : "var(--text-muted)"};
          letter-spacing: 0.5px;
        }
      `}</style>
    </div>
  );
}
