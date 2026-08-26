/**
 * WI-2: shared per-line stage presentation (labels, pill colors) and the
 * tracker-level status/summary derived from stage counts. Mirrors the
 * server-side derivation in backend/app/core/release_stage.py.
 */

import type { Stage, ReleaseTracker, ReleaseLine, ReminderTemplateKey } from "./types";

export const REMINDER_TITLES: Record<ReminderTemplateKey, string> = {
  request_bill_cpcf: "Request bill + CP/CF",
  cpcf_overdue: "CP/CF reminder",
  request_upuf: "Request UP/UF",
  upuf_overdue: "UP/UF reminder",
};

const CONDITIONAL_DONE = ["received", "verified", "sent_to_gc", "not_applicable"];
const UNCONDITIONAL_DONE = ["sent_to_gc", "not_applicable"];

function num(x: unknown): number {
  const n = parseFloat(String(x ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

/** Client-side mirror of backend derive_stage, so the pill updates live as a
 * user marks actions before saving. */
export function deriveStage(
  line: Pick<
    ReleaseLine,
    | "billed_amount" | "check_amount" | "bill_status" | "conditional_status"
    | "unconditional_status" | "check_received_at" | "check_sent_to_sub_at"
  >,
  isNonPrelimed: boolean
): Stage {
  if (line.bill_status === "not_applicable") return "n/a";
  if (num(line.billed_amount) === 0 && num(line.check_amount) === 0) return "n/a";
  if ((line.bill_status || "not_requested") !== "received") return "awaiting_bill";
  if (isNonPrelimed) {
    return line.check_sent_to_sub_at ? "complete" : "awaiting_check_release";
  }
  if (!CONDITIONAL_DONE.includes(line.conditional_status || "not_requested"))
    return "awaiting_conditional";
  if (!line.check_received_at) return "awaiting_gc_payment";
  if (!line.check_sent_to_sub_at) return "awaiting_check_release";
  if (!UNCONDITIONAL_DONE.includes(line.unconditional_status || "not_requested"))
    return "awaiting_unconditional";
  return "complete";
}

export const STAGE_LABEL: Record<Stage, string> = {
  "n/a": "N/A",
  awaiting_bill: "Awaiting bill",
  awaiting_conditional: "Awaiting CP/CF",
  awaiting_gc_payment: "Awaiting GC approval / payment",
  awaiting_check_release: "Awaiting paid sub",
  awaiting_unconditional: "Awaiting UP/UF",
  complete: "Complete",
};

// Pill color class per stage. Overdue overrides to red at the call site.
export function stagePillClass(stage: Stage | null, overdue?: boolean): string {
  if (overdue) return "pill-red";
  switch (stage) {
    case "complete":
      return "pill-green";
    case "awaiting_gc_payment":
    case "awaiting_check_release":
      return "pill-blue";
    case "awaiting_bill":
    case "awaiting_conditional":
    case "awaiting_unconditional":
      return "pill-amber";
    default:
      return "pill-muted"; // n/a
  }
}

/** Short human summary of a tracker's outstanding work, e.g.
 * "3 of 9 awaiting UP/UF" or "All 9 complete". */
export function trackerStageSummary(t: ReleaseTracker): string {
  const counts = t.stage_counts ?? {};
  const applicable = t.applicable_count ?? 0;
  if (applicable === 0) return "No billed subs";
  const complete = t.complete_count ?? 0;
  if (complete === applicable) return `All ${applicable} complete`;

  // Report the earliest outstanding stage that has lines waiting.
  const order: [Stage, string][] = [
    ["awaiting_bill", "awaiting bill"],
    ["awaiting_conditional", "awaiting CP/CF"],
    ["awaiting_gc_payment", "awaiting GC approval / payment"],
    ["awaiting_check_release", "awaiting paid sub"],
    ["awaiting_unconditional", "awaiting UP/UF"],
  ];
  for (const [key, label] of order) {
    const n = counts[key] ?? 0;
    if (n > 0) return `${n} of ${applicable} ${label}`;
  }
  return `${complete} of ${applicable} complete`;
}

// ─── Row stepper (Concept A) ─────────────────────────────────────────

export const STEPPER_STAGES = ["Bill", "CP/CF", "GC pays", "Paid Sub", "UP/UF"];
export const STEPPER_STAGES_NP = ["Bill", "Paid Sub"];

export type NodeState = "done" | "current" | "overdue" | "pending" | "na";

/** Turn a line's derived stage into a per-node state list for the stepper. */
export function stepperModel(
  stage: Stage,
  nonPrelimed: boolean,
  overdue: boolean
): { labels: string[]; states: NodeState[]; complete: boolean } {
  const labels = nonPrelimed ? STEPPER_STAGES_NP : STEPPER_STAGES;
  if (stage === "n/a") {
    return { labels, states: labels.map(() => "na" as NodeState), complete: false };
  }
  let currentIdx: number;
  if (nonPrelimed) {
    currentIdx =
      stage === "awaiting_bill" ? 0 : stage === "awaiting_check_release" ? 1 : labels.length;
  } else {
    const map: Record<string, number> = {
      awaiting_bill: 0,
      awaiting_conditional: 1,
      awaiting_gc_payment: 2,
      awaiting_check_release: 3,
      awaiting_unconditional: 4,
      complete: 5,
    };
    currentIdx = map[stage] ?? 0;
  }
  const states: NodeState[] = labels.map((_, i) => {
    if (i < currentIdx) return "done";
    if (i === currentIdx) return overdue ? "overdue" : "current";
    return "pending";
  });
  return { labels, states, complete: currentIdx >= labels.length };
}

/** CSS var for the "current" node color, matching the pill hues:
 * blue when the ball is in Ferrocrete's court (GC payment / release),
 * amber when waiting on the sub (bill / CP-CF / UP-UF). */
export function currentNodeColor(stage: Stage): string {
  return stage === "awaiting_gc_payment" || stage === "awaiting_check_release"
    ? "var(--status-blue)"
    : "var(--status-amber)";
}

/** Derived status pill label + class for a tracker (list + detail header). */
export function trackerStatus(t: ReleaseTracker): { label: string; cls: string } {
  if (t.sent_to_gc) return { label: "Sent", cls: "pill-green" };
  if (t.approved) return { label: "Approved", cls: "pill-blue" };
  if (t.verified_releases) return { label: "Verified", cls: "pill-blue" };
  if (t.requested_releases) return { label: "Requested", cls: "pill-amber" };
  return { label: "Draft", cls: "pill-amber" };
}
