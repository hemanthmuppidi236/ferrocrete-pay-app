/**
 * Client-side pay app math — mirrors backend `calculate_pay_app_totals`.
 *
 * The G702 sidebar recomputes on every keystroke, so we can't round-trip to the
 * server for each calc. This function gives byte-identical results to the
 * backend's calculation, so when the user clicks Submit, the saved row matches
 * what they were looking at.
 *
 * Keep this file in sync with backend/app/core/pay_app_math.py
 */

import type { SOVLine, ChangeOrder, BillingLine } from "@/lib/types";

export interface G702Totals {
  originalContract: number;
  approvedCoTotal: number;
  revisedContract: number;
  totalCompletedToDate: number;
  retentionHeld: number;
  earnedLessRetention: number;
  previousCertificates: number;
  currentPaymentDue: number;
  balanceToFinish: number;
}

export interface PayAppInputs {
  /** Project contract value (original, pre-CO) */
  contractValue: number;
  /** Retention rate, e.g. 0.10 for 10% */
  retentionRate: number;
  /** Previous certificates (sum of prior pay apps' earned_less_retention) */
  previousCertificates: number;
  /** All SOV lines for the project */
  sovLines: SOVLine[];
  /** All change orders for the project */
  changeOrders: ChangeOrder[];
  /** Current billings map (sov_line_id or change_order_id → BillingLine) */
  billings: BillingLine[];
}

export function calculateG702Totals(inputs: PayAppInputs): G702Totals {
  const {
    contractValue,
    retentionRate,
    previousCertificates,
    sovLines,
    changeOrders,
    billings,
  } = inputs;

  // Approved COs only
  const approvedCos = changeOrders.filter((co) => co.status === "approved");
  const approvedCoTotal = approvedCos.reduce(
    (sum, co) => sum + parseFloat(co.amount || "0"),
    0
  );
  const revisedContract = contractValue + approvedCoTotal;

  // Index billings by sov_line_id and change_order_id
  const sovBillings = new Map<string, BillingLine>();
  const coBillings = new Map<string, BillingLine>();
  for (const b of billings) {
    if (b.sov_line_id) sovBillings.set(b.sov_line_id, b);
    if (b.change_order_id) coBillings.set(b.change_order_id, b);
  }

  // Total completed = sum over SOV + CO of (prev + this_period + stored)
  let totalCompleted = 0;
  let retentionable = 0;

  for (const sov of sovLines) {
    const b = sovBillings.get(sov.id);
    if (!b) continue;
    const prev = parseFloat(b.previous_work || "0");
    const thisPeriod = parseFloat(b.this_period_work || "0");
    const stored = parseFloat(b.materials_stored || "0");
    const line = prev + thisPeriod + stored;
    totalCompleted += line;
    retentionable += line; // SOV always retainable
  }

  for (const co of approvedCos) {
    const b = coBillings.get(co.id);
    if (!b) continue;
    const prev = parseFloat(b.previous_work || "0");
    const thisPeriod = parseFloat(b.this_period_work || "0");
    const stored = parseFloat(b.materials_stored || "0");
    const line = prev + thisPeriod + stored;
    totalCompleted += line;
    if (co.has_retention) retentionable += line;
  }

  const retentionHeld = round2(retentionable * retentionRate);
  const earnedLessRetention = round2(totalCompleted - retentionHeld);
  const currentPaymentDue = round2(earnedLessRetention - previousCertificates);
  const balanceToFinish = round2(revisedContract - earnedLessRetention);

  return {
    originalContract: round2(contractValue),
    approvedCoTotal: round2(approvedCoTotal),
    revisedContract: round2(revisedContract),
    totalCompletedToDate: round2(totalCompleted),
    retentionHeld,
    earnedLessRetention,
    previousCertificates: round2(previousCertificates),
    currentPaymentDue,
    balanceToFinish,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a number as USD currency, with em-dash for zero. */
export function fmtMoney(n: number | string, opts?: { zero?: string }): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return String(n);
  if (num === 0 && opts?.zero !== undefined) return opts.zero;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/** Format a number as integer dollars (no cents). */
export function fmtMoneyShort(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return String(n);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

/** Format a 0..1 rate as a whole-number percent, e.g. 0.1 -> "10%". */
export function fmtPct(v: number | string): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return `${Math.round(n * 100)}%`;
}
