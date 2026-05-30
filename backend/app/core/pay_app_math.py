"""
Pay app calculations — the G702/G703 math, but on database rows.

Mirrors the formulas in `payapp_engine.py`:
  G703 row.G = D + E + F           (per line: previous_work + this_period + materials_stored)
  G703 row.J = G * retention_rate  (per line; CO with has_retention=False excluded)
  G703.G78  = SUM(G_rows)          (total completed)
  G703.J78  = SUM(J_rows)          (retention held)
  G702.G24  = original + approved CO total  (revised contract)
  G702.G26  = G703.G78                       (total completed & stored)
  G702.G27  = G703.J78                       (retention)
  G702.G28  = G26 - G27                      (earned less retention)
  G702.G29  = sum of (earned - retention) of all PRIOR submitted/paid pay apps
  G702.G30  = G28 - G29                      (current payment due)
  G702.G31  = G24 - G28                      (balance to finish)
"""

from decimal import Decimal
from typing import List, Optional, Tuple
from uuid import UUID

from .supabase_client import get_service_client


ZERO = Decimal("0.00")


def calculate_pay_app_totals(pay_app_id: str) -> dict:
    """Compute all G702/G703 totals for a pay app from its current billings.

    Returns a dict with all the denormalized total fields (matches PayApp schema).
    Does NOT save to DB — caller decides when to persist.
    """
    sb = get_service_client()

    # Load pay app + project
    pa_res = sb.table("pay_apps").select("*, projects(*)").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa_res.data:
        raise ValueError(f"Pay app {pay_app_id} not found")
    pa = pa_res.data[0]
    project = pa["projects"]
    project_id = project["id"]
    retention_rate = Decimal(str(project["retention_rate"]))

    # Load SOV lines and CO lines
    sov_res = sb.table("sov_lines").select("*").eq("project_id", project_id).execute()
    sov_total = sum(
        (Decimal(str(s["scheduled_value"])) for s in sov_res.data),
        Decimal(0),
    )

    co_res = sb.table("change_orders").select("*").eq("project_id", project_id).execute()
    approved_co_total = sum(
        (Decimal(str(co["amount"])) for co in co_res.data if co["status"] == "approved"),
        Decimal(0),
    )

    # Load this pay app's billings (joined to know if SOV or CO)
    bil_res = sb.table("pay_app_billings").select("*").eq("pay_app_id", str(pay_app_id)).execute()

    # Index COs by id for has_retention lookup
    co_by_id = {co["id"]: co for co in co_res.data}

    total_completed = ZERO
    total_retention = ZERO
    # Derive previous_certs directly from column D (previous_work). By the
    # carry-forward invariant, column D of period N equals column G of period
    # N-1 — so summing column D across lines (less retention) gives the
    # cumulative prior earned-less-retention regardless of whether the prior
    # pay app rows exist or what status they're in. This is correct for
    # mid-project imports where prior apps may be drafts (or absent entirely).
    previous_completed = ZERO
    previous_retention = ZERO

    for b in bil_res.data:
        prev = Decimal(str(b.get("previous_work") or 0))
        this_p = Decimal(str(b.get("this_period_work") or 0))
        stored = Decimal(str(b.get("materials_stored") or 0))
        line_g = prev + this_p + stored
        total_completed += line_g
        previous_completed += prev

        # Retention applies unless it's a CO with has_retention=False
        applies_retention = True
        if b.get("change_order_id"):
            co = co_by_id.get(b["change_order_id"])
            if co and not co.get("has_retention", True):
                applies_retention = False
        if applies_retention:
            total_retention += line_g * retention_rate
            previous_retention += prev * retention_rate

    # Quantize to cents
    total_completed = total_completed.quantize(Decimal("0.01"))
    total_retention = total_retention.quantize(Decimal("0.01"))

    earned_less_ret = (total_completed - total_retention).quantize(Decimal("0.01"))

    previous_certs = (previous_completed - previous_retention).quantize(Decimal("0.01"))

    current_pay_due = (earned_less_ret - previous_certs).quantize(Decimal("0.01"))

    revised_contract = (Decimal(str(project["contract_value"])) + approved_co_total).quantize(Decimal("0.01"))
    balance_to_finish = (revised_contract - earned_less_ret).quantize(Decimal("0.01"))

    return {
        "original_contract": Decimal(str(project["contract_value"])).quantize(Decimal("0.01")),
        "approved_co_total": approved_co_total.quantize(Decimal("0.01")),
        "revised_contract": revised_contract,
        "total_completed_to_date": total_completed,
        "retention_held": total_retention,
        "earned_less_retention": earned_less_ret,
        "previous_certificates": previous_certs,
        "current_payment_due": current_pay_due,
        "balance_to_finish": balance_to_finish,
    }


def save_pay_app_totals(pay_app_id: str, totals: Optional[dict] = None) -> dict:
    """Compute (if not provided) and persist the totals fields on a pay app."""
    if totals is None:
        totals = calculate_pay_app_totals(pay_app_id)
    sb = get_service_client()
    # Convert Decimals to strings for JSON serialization
    payload = {k: str(v) if isinstance(v, Decimal) else v for k, v in totals.items()}
    res = sb.table("pay_apps").update(payload).eq("id", str(pay_app_id)).execute()
    return res.data[0]
