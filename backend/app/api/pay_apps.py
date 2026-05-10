"""
Pay Applications API.

  GET    /pay-apps                         all (filterable by project, status, period)
  GET    /pay-apps/{id}                    one (with billings)
  POST   /pay-apps                         create new (draft)
  PATCH  /pay-apps/{id}                    update metadata
  PUT    /pay-apps/{id}/billings           replace billings (recalcs totals)
  POST   /pay-apps/{id}/submit             draft -> submitted
  POST   /pay-apps/{id}/mark-paid          submitted -> paid
  DELETE /pay-apps/{id}                    only allowed on draft
"""

from datetime import datetime, timezone
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import List, Optional
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..core.pay_app_math import calculate_pay_app_totals, save_pay_app_totals
from ..schemas.pay_apps import (
    PayApp, PayAppDetail, PayAppCreate, PayAppUpdate,
    PayAppBillingsUpdate, BillingLine,
)

router = APIRouter(prefix="/pay-apps", tags=["pay_apps"])


@router.get("", response_model=List[PayApp])
def list_pay_apps(
    project_id: Optional[UUID] = Query(None),
    period: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    q = sb.table("pay_apps").select("*")
    if project_id:
        q = q.eq("project_id", str(project_id))
    if period:
        q = q.eq("period", period)
    if status_filter:
        q = q.eq("status", status_filter)
    res = q.order("period", desc=True).execute()
    return res.data


@router.get("/{pay_app_id}", response_model=PayAppDetail)
def get_pay_app(pay_app_id: UUID, user: CurrentUser = Depends(get_current_user)):
    sb = get_service_client()
    pa_res = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa_res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")
    pa = pa_res.data[0]

    bil_res = sb.table("pay_app_billings").select("*").eq("pay_app_id", str(pay_app_id)).execute()
    pa["billings"] = bil_res.data
    return pa


@router.post("", response_model=PayApp, status_code=status.HTTP_201_CREATED)
def create_pay_app(
    body: PayAppCreate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()

    # Verify project exists
    proj = sb.table("projects").select("*").eq("id", str(body.project_id)).limit(1).execute()
    if not proj.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

    payload = body.model_dump(mode="json")
    payload["status"] = "draft"

    try:
        res = sb.table("pay_apps").insert(payload).execute()
    except Exception as e:
        if "duplicate key" in str(e).lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"Pay app for {body.period} already exists in this project")
        raise

    pa = res.data[0]

    # Auto-create empty billing rows for each SOV line + CO
    sov_res = sb.table("sov_lines").select("id").eq("project_id", str(body.project_id)).execute()
    co_res = sb.table("change_orders").select("id").eq("project_id", str(body.project_id)).eq("status", "approved").execute()
    billings_to_insert = []
    for s in sov_res.data:
        billings_to_insert.append({
            "pay_app_id": pa["id"],
            "sov_line_id": s["id"],
            "previous_work": 0, "this_period_work": 0, "materials_stored": 0,
        })
    for c in co_res.data:
        billings_to_insert.append({
            "pay_app_id": pa["id"],
            "change_order_id": c["id"],
            "previous_work": 0, "this_period_work": 0, "materials_stored": 0,
        })
    if billings_to_insert:
        sb.table("pay_app_billings").insert(billings_to_insert).execute()

    # Compute and save totals (will be 0s for fresh app)
    pa = save_pay_app_totals(pa["id"])

    audit.log(user.id, "pay_app", pa["id"], "created", after=pa)
    return pa


@router.patch("/{pay_app_id}", response_model=PayApp)
def update_pay_app(
    pay_app_id: UUID,
    body: PayAppUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")

    updates = body.model_dump(mode="json", exclude_unset=True)
    if not updates:
        return existing.data[0]

    res = sb.table("pay_apps").update(updates).eq("id", str(pay_app_id)).execute()
    audit.log(user.id, "pay_app", str(pay_app_id), "updated",
              before=existing.data[0], after=res.data[0])
    return res.data[0]


@router.put("/{pay_app_id}/billings", response_model=PayApp)
def update_billings(
    pay_app_id: UUID,
    body: PayAppBillingsUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    """Replace the full set of billings for a pay app, then recalc totals."""
    sb = get_service_client()
    existing = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")
    if existing.data[0]["status"] != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Can only edit billings on draft pay apps")

    # Replace strategy: delete existing, insert new (keeps things simple).
    # Future optimization: upsert by (sov_line_id|change_order_id).
    sb.table("pay_app_billings").delete().eq("pay_app_id", str(pay_app_id)).execute()
    if body.billings:
        rows = []
        for b in body.billings:
            row = {
                "pay_app_id": str(pay_app_id),
                "previous_work": str(b.previous_work),
                "this_period_work": str(b.this_period_work),
                "materials_stored": str(b.materials_stored),
            }
            if b.sov_line_id:
                row["sov_line_id"] = str(b.sov_line_id)
            elif b.change_order_id:
                row["change_order_id"] = str(b.change_order_id)
            else:
                raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                    "Each billing must have sov_line_id or change_order_id")
            rows.append(row)
        sb.table("pay_app_billings").insert(rows).execute()

    pa = save_pay_app_totals(str(pay_app_id))
    audit.log(user.id, "pay_app", str(pay_app_id), "billings_updated",
              metadata={"line_count": len(body.billings)})
    return pa


@router.post("/{pay_app_id}/submit", response_model=PayApp)
def submit_pay_app(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    """Transition draft -> submitted. Recalcs totals first to make sure they're current."""
    sb = get_service_client()
    existing = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")
    if existing.data[0]["status"] != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Pay app is {existing.data[0]['status']}, not draft")

    save_pay_app_totals(str(pay_app_id))
    res = sb.table("pay_apps").update({
        "status": "submitted",
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "submitted_by": user.id,
    }).eq("id", str(pay_app_id)).execute()
    audit.log(user.id, "pay_app", str(pay_app_id), "submitted",
              before=existing.data[0], after=res.data[0])
    return res.data[0]


@router.post("/{pay_app_id}/mark-paid", response_model=PayApp)
def mark_pay_app_paid(
    pay_app_id: UUID,
    paid_amount: Decimal,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """Transition submitted -> paid. Records the actual amount received."""
    sb = get_service_client()
    existing = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")
    if existing.data[0]["status"] != "submitted":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Only submitted pay apps can be marked paid")
    res = sb.table("pay_apps").update({
        "status": "paid",
        "paid_at": datetime.now(timezone.utc).isoformat(),
        "paid_amount": str(paid_amount),
    }).eq("id", str(pay_app_id)).execute()
    audit.log(user.id, "pay_app", str(pay_app_id), "marked_paid",
              before=existing.data[0], after=res.data[0],
              metadata={"paid_amount": str(paid_amount)})
    return res.data[0]


@router.delete("/{pay_app_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_pay_app(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """Only drafts are deletable. Submitted/paid pay apps must be voided instead."""
    sb = get_service_client()
    existing = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")
    if existing.data[0]["status"] != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Only draft pay apps can be deleted; void instead")
    sb.table("pay_apps").delete().eq("id", str(pay_app_id)).execute()
    audit.log(user.id, "pay_app", str(pay_app_id), "deleted", before=existing.data[0])
