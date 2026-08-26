"""
WI-2: pure per-line stage derivation for release trackers.

A release line moves through:
  awaiting_bill -> awaiting_conditional -> awaiting_gc_payment
  -> awaiting_check_release -> awaiting_unconditional -> complete

Non-prelimed subs skip the conditional and unconditional stages:
  awaiting_bill -> awaiting_check_release -> complete

Lines marked not_applicable, or with zero billed AND zero check, show 'n/a'.

These functions take plain dicts (the shape returned by Supabase) so they are
trivially unit-testable and reused by both the detail and list endpoints.
"""

from datetime import date
from decimal import Decimal, InvalidOperation

STAGE_NA = "n/a"
STAGE_BILL = "awaiting_bill"
STAGE_CONDITIONAL = "awaiting_conditional"
STAGE_GC_PAYMENT = "awaiting_gc_payment"
STAGE_CHECK_RELEASE = "awaiting_check_release"
STAGE_UNCONDITIONAL = "awaiting_unconditional"
STAGE_COMPLETE = "complete"

# Order used for summarizing "the earliest outstanding stage" on the list page.
STAGE_ORDER = [
    STAGE_BILL, STAGE_CONDITIONAL, STAGE_GC_PAYMENT,
    STAGE_CHECK_RELEASE, STAGE_UNCONDITIONAL, STAGE_COMPLETE,
]

_CONDITIONAL_DONE = ("received", "verified", "sent_to_gc", "not_applicable")
_UNCONDITIONAL_DONE = ("sent_to_gc", "not_applicable")


def _dec(x):
    if x is None or x == "":
        return Decimal("0")
    try:
        return Decimal(str(x))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _as_date(x):
    if x is None or x == "":
        return None
    if isinstance(x, date):
        return x
    try:
        return date.fromisoformat(str(x)[:10])
    except ValueError:
        return None


def is_applicable(line):
    """A line participates in the workflow if it is not marked N/A and has
    some billed or check activity."""
    if (line.get("bill_status") or "") == "not_applicable":
        return False
    return _dec(line.get("billed_amount")) > 0 or _dec(line.get("check_amount")) > 0


def derive_stage(line, is_non_prelimed):
    """Return the coarse workflow stage for a single line."""
    if (line.get("bill_status") or "") == "not_applicable":
        return STAGE_NA
    if _dec(line.get("billed_amount")) == 0 and _dec(line.get("check_amount")) == 0:
        return STAGE_NA

    if (line.get("bill_status") or "not_requested") != "received":
        return STAGE_BILL

    if is_non_prelimed:
        if not line.get("check_sent_to_sub_at"):
            return STAGE_CHECK_RELEASE
        return STAGE_COMPLETE

    if (line.get("conditional_status") or "not_requested") not in _CONDITIONAL_DONE:
        return STAGE_CONDITIONAL
    if not line.get("check_received_at"):
        return STAGE_GC_PAYMENT
    if not line.get("check_sent_to_sub_at"):
        return STAGE_CHECK_RELEASE
    if (line.get("unconditional_status") or "not_requested") not in _UNCONDITIONAL_DONE:
        return STAGE_UNCONDITIONAL
    return STAGE_COMPLETE


def is_overdue(line, stage, today=None):
    """True when the line needs chasing: past its bill_due_at with no
    conditional yet, or an unconditional requested more than 7 days ago with
    nothing received."""
    if stage in (STAGE_NA, STAGE_COMPLETE):
        return False
    today = today or date.today()

    due = _as_date(line.get("bill_due_at"))
    if due and today > due and \
            (line.get("conditional_status") or "not_requested") in ("not_requested", "requested"):
        return True

    ureq = _as_date(line.get("unconditional_requested_at"))
    if ureq and (today - ureq).days > 7 and \
            (line.get("unconditional_status") or "not_requested") == "requested":
        return True

    return False


def derive_tracker_flags(lines_with_np):
    """Derive the tracker-level workflow flags from its lines.

    lines_with_np: iterable of (line_dict, is_non_prelimed).

    - requested_releases: every applicable line has bill_status != not_requested
    - verified_releases:  every applicable prelimed line's conditional is
                          verified or sent_to_gc (or not_applicable)
    - sent_to_gc:         every applicable prelimed line's unconditional is
                          sent_to_gc (or not_applicable)

    All three are False when there are no applicable lines.
    """
    applicable = [(l, np) for (l, np) in lines_with_np if is_applicable(l)]
    if not applicable:
        return {"requested_releases": False, "verified_releases": False, "sent_to_gc": False}

    requested = all((l.get("bill_status") or "not_requested") != "not_requested"
                    for l, _ in applicable)

    prelimed = [l for l, np in applicable if not np]
    verified = all((l.get("conditional_status") or "") in ("verified", "sent_to_gc", "not_applicable")
                   for l in prelimed)
    sent = all((l.get("unconditional_status") or "") in ("sent_to_gc", "not_applicable")
               for l in prelimed)

    return {
        "requested_releases": requested,
        "verified_releases": verified,
        "sent_to_gc": sent,
    }


def summarize_stages(lines_with_np, today=None):
    """Return {stage: count} over applicable lines, plus applicable_count,
    complete_count, and overdue_count. Used by the tracker list page."""
    counts = {s: 0 for s in STAGE_ORDER}
    counts[STAGE_NA] = 0
    applicable_count = 0
    overdue_count = 0
    for line, np in lines_with_np:
        stage = derive_stage(line, np)
        counts[stage] = counts.get(stage, 0) + 1
        if is_applicable(line):
            applicable_count += 1
            if is_overdue(line, stage, today=today):
                overdue_count += 1
    return {
        "stage_counts": counts,
        "applicable_count": applicable_count,
        "complete_count": counts.get(STAGE_COMPLETE, 0),
        "overdue_count": overdue_count,
    }
