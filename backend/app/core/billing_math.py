"""
Billing Period Summary — pure computation helpers.

The summary is an INTERNAL monthly roll-up (one row per project) that pulls:
  - contract / completed / retention / billed  ← the pay app (G702)
  - Potential Net (Ferrocrete's net income)     ← the release tracker
  - CP/CF + UP/UF "sent" flags                   ← release-tracker waivers
  - a few free-text columns                      ← manual overrides

Everything here is a pure function (no DB, no I/O) so the math is unit-testable
without Supabase. The API layer in api/billing_summary.py does the fetching and
calls into these.
"""

from decimal import Decimal, InvalidOperation
from typing import Optional


def dec(x) -> Decimal:
    """Coerce anything (None, str, int, float, Decimal) to a Decimal, defaulting
    to 0 on empty/None/garbage. Money is always Decimal — never float."""
    if x is None or x == "":
        return Decimal("0")
    if isinstance(x, Decimal):
        return x
    try:
        return Decimal(str(x))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def ferrocrete_net(
    invoice_amount,
    total_checks,
    total_unbilled,
) -> Optional[Decimal]:
    """Ferrocrete's net income for one project in one period.

        net = invoice − Σ(sub checks) − Σ(previous-month unbilled)

    Non-prelimed subs are ordinary release lines, so their checks are already
    inside `total_checks`. Mirrors the release tracker's "Ferrocrete Net" row.

    Returns None when there is no invoice (nothing was billed), so the summary
    shows "—" rather than a misleading negative number.
    """
    if invoice_amount is None or str(invoice_amount) == "":
        return None
    return dec(invoice_amount) - dec(total_checks) - dec(total_unbilled)


def gross_from_billed(billed, retention_rate) -> Decimal:
    """Gross billing (col I) from the net billed amount (col K) and the
    retention rate (col J), inverting the reference sheet's K = I × (1 − J).

    Guards a 100%+ retention rate (would divide by zero / go negative) by
    falling back to the billed amount itself.
    """
    b = dec(billed)
    r = dec(retention_rate)
    denom = Decimal("1") - r
    if denom <= 0:
        return b
    return (b / denom).quantize(Decimal("0.01"))


_STATUS_LABELS = {
    "draft": "Draft",
    "pending_approval": "Pending approval",
    "approved": "Approved",
    "submitted": "Sent to client",
    "paid": "Paid",
    "void": "Void",
}


def humanize_status(status: Optional[str]) -> str:
    if not status:
        return ""
    return _STATUS_LABELS.get(status.strip().lower(), status)


def _first_nonempty(*vals) -> str:
    for v in vals:
        if v is not None and str(v).strip() != "":
            return str(v)
    return ""


def assemble_row(
    *,
    project: dict,
    pay_app: Optional[dict],
    net: Optional[Decimal],
    override: dict,
    co_total,
    waiver_flags: dict,
) -> dict:
    """Build one summary row from its sources. Pure — all inputs are plain dicts.

    Auto-derives every column it can; `override` (the manual layer) wins for the
    free-text/manual columns (due date, BT note, rebar, cmu, sent flags, contact,
    payment status).
    """
    override = override or {}
    waiver_flags = waiver_flags or {}

    # Revised contract (E): from the pay app if one exists this period, else
    # derive from the project's base contract + approved change orders.
    if pay_app and pay_app.get("revised_contract") is not None:
        revised = dec(pay_app.get("revised_contract"))
    else:
        revised = dec(project.get("contract_value")) + dec(co_total)

    completed = dec(pay_app.get("total_completed_to_date")) if pay_app else Decimal("0")
    retention = dec(pay_app.get("retention_held")) if pay_app else Decimal("0")
    balance = revised - completed                       # H = E − F
    balance_ret = revised - completed + retention       # I = E − F + G
    billed = dec(pay_app.get("current_payment_due")) if pay_app else Decimal("0")  # L
    rate = dec(project.get("retention_rate"))           # K
    gross = gross_from_billed(billed, rate)             # J

    # P / Q auto-suggest from received waivers of that class; override wins.
    auto_cpcf = "Yes" if waiver_flags.get("cp_cf") else ""
    auto_upuf = "Yes" if waiver_flags.get("up_uf") else ""

    return {
        "project_id": project.get("id"),
        "project_no": project.get("project_no") or "",
        "project_name": project.get("name") or "",
        "job": f"{project.get('project_no') or ''} - {project.get('name') or ''}".strip(" -"),

        # Auto financial columns
        "revised_contract": revised,
        "total_completed": completed,
        "retention": retention,
        "balance_to_finish": balance,
        "balance_with_retention": balance_ret,
        "gross_billing": gross,
        "retention_rate": rate,
        "billed_amount": billed,
        "potential_net": net,
        "retention_billed": dec(pay_app.get("retention_billed_amount")) if pay_app else Decimal("0"),

        # Manual (auto default + override). Billing due date and contact default
        # to the project-level settings; a per-period override still wins.
        "billing_due_date": _first_nonempty(
            override.get("billing_due_date"),
            project.get("billing_due_rule"),
        ),
        "bt_note": _first_nonempty(override.get("bt_note")),
        "rebar": dec(override.get("rebar")) if override.get("rebar") not in (None, "") else None,
        "cmu": dec(override.get("cmu")) if override.get("cmu") not in (None, "") else None,
        "cpcf_sent": _first_nonempty(override.get("cpcf_sent"), auto_cpcf),
        "upuf_sent": _first_nonempty(override.get("upuf_sent"), auto_upuf),
        "billing_contact": _first_nonempty(
            override.get("billing_contact"),
            project.get("billing_contact"),
            project.get("gc_contact_email"),
        ),
        "payment_status": _first_nonempty(
            override.get("payment_status"),
            humanize_status(pay_app.get("status")) if pay_app else None,
        ),

        # Hints for the UI (deep links / badges)
        "has_pay_app": bool(pay_app),
        "pay_app_id": pay_app.get("id") if pay_app else None,
    }


def is_skip(billing_due_date) -> bool:
    """True when a row's Billing Due Date reads as 'skip' (sorts to the bottom)."""
    return str(billing_due_date or "").strip().lower() == "skip"


def summarize_totals(rows: list) -> dict:
    """Column totals across the rows (E, F, G, H, J, L, M, O, P). Skips None."""
    def s(key):
        return sum((r[key] for r in rows if r.get(key) is not None), Decimal("0"))

    return {
        "revised_contract": s("revised_contract"),
        "total_completed": s("total_completed"),
        "retention": s("retention"),
        "balance_to_finish": s("balance_to_finish"),
        "gross_billing": s("gross_billing"),
        "billed_amount": s("billed_amount"),
        "potential_net": s("potential_net"),
        "rebar": s("rebar"),
        "cmu": s("cmu"),
        "retention_billed": s("retention_billed"),
    }
