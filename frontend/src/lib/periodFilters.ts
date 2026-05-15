/**
 * Period filter utilities for the pay-apps dashboard.
 *
 * The dashboard exposes 5 chips: Month / Quarter / Half / Year / Custom.
 * Each chip changes (a) the second dropdown's options and (b) the date range
 * sent to the backend for filtering and "Billed this period" aggregation.
 *
 * Periods are stored in the DB as YY-MM (e.g. "26-04") but the backend filter
 * takes YYYY-MM. This module converts and generates human-readable labels.
 */

export type PeriodType = "month" | "quarter" | "half" | "year" | "custom";

export interface PeriodOption {
  /** Stable id used as <option value> */
  value: string;
  /** Human-readable label shown in the dropdown */
  label: string;
  /** YYYY-MM (inclusive) */
  startKey: string;
  /** YYYY-MM (inclusive) */
  endKey: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "2026-04" → "26-04" (the Ferrocrete project-number style) */
export function yymmFromYyyymm(key: string): string {
  if (!key || key.length !== 7) return "";
  return `${key.slice(2, 4)}-${key.slice(5, 7)}`;
}

/** Current month as YYYY-MM */
export function currentMonthKey(today = new Date()): string {
  return `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
}

/** Build month options for the past 24 months + next 3 months */
export function monthOptions(today = new Date()): PeriodOption[] {
  const opts: PeriodOption[] = [];
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-indexed
  for (let offset = 3; offset >= -24; offset--) {
    const d = new Date(y, m + offset, 1);
    const yyyy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const key = `${yyyy}-${pad2(mm)}`;
    const yy = String(yyyy).slice(2);
    opts.push({
      value: key,
      label: `${MONTH_NAMES[d.getMonth()]} ${yyyy} (${yy}-${pad2(mm)})`,
      startKey: key,
      endKey: key,
    });
  }
  return opts;
}

/** Build quarter options for past 8 quarters + next 1 */
export function quarterOptions(today = new Date()): PeriodOption[] {
  const opts: PeriodOption[] = [];
  const y = today.getFullYear();
  const currentQ = Math.floor(today.getMonth() / 3) + 1;
  const tuples: Array<[number, number]> = [];
  let yy = y, qq = currentQ + 1;
  for (let i = 0; i < 10; i++) {
    if (qq < 1) { qq = 4; yy -= 1; }
    if (qq > 4) { qq = 1; yy += 1; }
    tuples.push([yy, qq]);
    qq -= 1;
  }
  for (const [yr, q] of tuples) {
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const yyShort = String(yr).slice(2);
    opts.push({
      value: `${yr}-Q${q}`,
      label: `Q${q} ${yr} (${yyShort}-${pad2(startMonth)} through ${yyShort}-${pad2(endMonth)})`,
      startKey: `${yr}-${pad2(startMonth)}`,
      endKey: `${yr}-${pad2(endMonth)}`,
    });
  }
  return opts;
}

/** Build half-year options for past 4 halves + next 1 */
export function halfOptions(today = new Date()): PeriodOption[] {
  const opts: PeriodOption[] = [];
  const y = today.getFullYear();
  const currentH = today.getMonth() < 6 ? 1 : 2;
  const tuples: Array<[number, number]> = [];
  let yy = y, hh = currentH + 1;
  for (let i = 0; i < 6; i++) {
    if (hh < 1) { hh = 2; yy -= 1; }
    if (hh > 2) { hh = 1; yy += 1; }
    tuples.push([yy, hh]);
    hh -= 1;
  }
  for (const [yr, h] of tuples) {
    const startMonth = h === 1 ? 1 : 7;
    const endMonth = h === 1 ? 6 : 12;
    const rangeLabel = h === 1 ? "Jan–Jun" : "Jul–Dec";
    opts.push({
      value: `${yr}-H${h}`,
      label: `H${h} ${yr} (${rangeLabel})`,
      startKey: `${yr}-${pad2(startMonth)}`,
      endKey: `${yr}-${pad2(endMonth)}`,
    });
  }
  return opts;
}

/** Build year options for past 4 years + next 1 */
export function yearOptions(today = new Date()): PeriodOption[] {
  const opts: PeriodOption[] = [];
  const y = today.getFullYear();
  for (let offset = 1; offset >= -4; offset--) {
    const yr = y + offset;
    opts.push({
      value: `${yr}`,
      label: `${yr}`,
      startKey: `${yr}-01`,
      endKey: `${yr}-12`,
    });
  }
  return opts;
}

/** Options for a given period type. Custom returns [] — handled separately. */
export function optionsForType(type: PeriodType, today = new Date()): PeriodOption[] {
  switch (type) {
    case "month": return monthOptions(today);
    case "quarter": return quarterOptions(today);
    case "half": return halfOptions(today);
    case "year": return yearOptions(today);
    case "custom": return [];
  }
}

/** Default option for a given period type (current month, current quarter, etc.) */
export function defaultOptionForType(type: PeriodType, today = new Date()): PeriodOption | null {
  const opts = optionsForType(type, today);
  if (opts.length === 0) return null;
  switch (type) {
    case "month": {
      const key = currentMonthKey(today);
      return opts.find(o => o.value === key) ?? opts[0];
    }
    case "quarter": {
      const q = Math.floor(today.getMonth() / 3) + 1;
      return opts.find(o => o.value === `${today.getFullYear()}-Q${q}`) ?? opts[0];
    }
    case "half": {
      const h = today.getMonth() < 6 ? 1 : 2;
      return opts.find(o => o.value === `${today.getFullYear()}-H${h}`) ?? opts[0];
    }
    case "year": {
      return opts.find(o => o.value === `${today.getFullYear()}`) ?? opts[0];
    }
    default: return null;
  }
}

/**
 * Eyebrow label for the highlighted "Billed this period" stat card.
 * Returns "Billed this month" for the current month, "Billed Feb 2026" for past,
 * etc. Falls back to "Billed this period" for custom ranges.
 */
export function billedEyebrow(
  type: PeriodType,
  selected: PeriodOption | null,
  today = new Date()
): string {
  if (!selected || type === "custom") return "Billed this period";

  const isCurrent = (() => {
    switch (type) {
      case "month": return selected.value === currentMonthKey(today);
      case "quarter": {
        const q = Math.floor(today.getMonth() / 3) + 1;
        return selected.value === `${today.getFullYear()}-Q${q}`;
      }
      case "half": {
        const h = today.getMonth() < 6 ? 1 : 2;
        return selected.value === `${today.getFullYear()}-H${h}`;
      }
      case "year": return selected.value === `${today.getFullYear()}`;
      default: return false;
    }
  })();

  if (isCurrent) {
    switch (type) {
      case "month": return "Billed this month";
      case "quarter": return "Billed this quarter";
      case "half": return "Billed this half";
      case "year": return "Billed this year";
    }
  }

  if (type === "month") {
    // "April 2026 (26-04)" → "Apr 2026"
    const m = selected.label.split(" (")[0];
    const parts = m.split(" ");
    if (parts.length === 2) {
      return `Billed ${parts[0].slice(0, 3)} ${parts[1]}`;
    }
    return `Billed ${m}`;
  }
  if (type === "quarter") {
    const [yr, q] = selected.value.split("-");
    return `Billed ${q} ${yr}`;
  }
  if (type === "half") {
    const [yr, h] = selected.value.split("-");
    return `Billed ${h} ${yr}`;
  }
  return `Billed ${selected.value}`;
}

/** Subdetail line under the highlighted stat card value */
export function billedSubdetail(
  type: PeriodType,
  selected: PeriodOption | null,
  projectCount: number
): string {
  const projectLabel = projectCount === 1 ? "1 project" : `${projectCount} projects`;
  if (!selected) return projectLabel;
  if (type === "custom") {
    return `${projectLabel} · ${selected.label}`;
  }
  if (type === "month") {
    const m = selected.label.split(" (")[0];
    return `${projectLabel} · ${m}`;
  }
  return `${projectLabel} · ${selected.label.split(" (")[0]}`;
}
