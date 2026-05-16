"""
Pay Applications API.

  GET    /pay-apps                         all (filterable by project, status, period)
  GET    /pay-apps/dashboard               dashboard data: pay apps + aggregate stats
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


# ─── Dashboard helpers ──────────────────────────────────────────────────

_DASHBOARD_MAX_ROWS = 500
_STATUS_RANK = {"draft": 0, "submitted": 1, "paid": 2, "void": 3}


def _period_to_key(period: str) -> str:
    """'26-04' → '2026-04' (lexicographically sortable). Assumes 21st century."""
    if not period or len(period) != 5 or period[2] != "-":
        return ""
    yy, mm = period.split("-")
    if not (yy.isdigit() and mm.isdigit()):
        return ""
    return f"20{yy}-{mm}"


def _in_period_range(period: str, start: Optional[str], end: Optional[str]) -> bool:
    """Inclusive YY-MM range check against YYYY-MM bounds."""
    key = _period_to_key(period)
    if not key:
        return False
    if start and key < start:
        return False
    if end and key > end:
        return False
    return True


def _to_float(money_str) -> float:
    """Decimal-as-string → float, safely."""
    if money_str is None:
        return 0.0
    try:
        return float(Decimal(str(money_str)))
    except Exception:
        return 0.0


@router.get("/dashboard")
def dashboard(
    period_start: Optional[str] = Query(None, description="YYYY-MM, inclusive"),
    period_end: Optional[str] = Query(None, description="YYYY-MM, inclusive"),
    status_filter: Optional[str] = Query(None, alias="status"),
    project_id: Optional[UUID] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    """
    Dashboard data for /pay-apps page.

    Returns { pay_apps: [...with project info joined], stats: {...} }.

    Stats are computed at three independent scopes so the cards stay stable
    as the user explores the table with different filters:
      - open_drafts / submitted: company-wide (ignore all filters)
      - billed_total: responds to period filter ONLY (ignores status/project)
      - revised_contract_total: all active projects, fully unfiltered
    """
    sb = get_service_client()

    try:
        # Pull all (active project) pay apps + project info via PostgREST embed.
        # We over-fetch by design so we can compute company-wide stats from a
        # single query.
        rows_result = (
            sb.table("pay_apps")
            .select(
                "id, project_id, period, app_no, status, "
                "current_payment_due, total_completed_to_date, revised_contract, "
                "updated_at, "
                "projects(name, project_no, gc_company, deleted_at)"
            )
            .limit(_DASHBOARD_MAX_ROWS)
            .execute()
        )
        raw_rows = rows_result.data or []

        # Flatten + filter out pay apps from soft-deleted projects
        all_rows = []
        for r in raw_rows:
            proj = r.get("projects") or {}
            if proj.get("deleted_at"):
                continue
            completed = _to_float(r.get("total_completed_to_date"))
            revised = _to_float(r.get("revised_contract"))
            pct = (completed / revised * 100.0) if revised > 0 else 0.0
            all_rows.append({
                "id": r.get("id"),
                "project_id": r.get("project_id"),
                "project_name": proj.get("name") or "Unknown project",
                "project_no": proj.get("project_no") or "",
                "gc_company": proj.get("gc_company") or "",
                "period": r.get("period") or "",
                "app_no": r.get("app_no"),
                "status": (r.get("status") or "draft").strip().lower(),
                # Keep Money strings on the wire; fmtMoneyShort parses them.
                "current_payment_due": r.get("current_payment_due") or "0",
                "percent_complete": round(pct, 1),
                "updated_at": r.get("updated_at"),
            })

        # ─ Company-wide stats (UNFILTERED) ─
        open_drafts = [p for p in all_rows if p["status"] == "draft"]
        submitted_apps = [p for p in all_rows if p["status"] == "submitted"]

        # ─ Period-scoped billed total ─
        if period_start or period_end:
            period_scoped = [p for p in all_rows if _in_period_range(p["period"], period_start, period_end)]
        else:
            period_scoped = all_rows

        # ─ The table: apply ALL filters ─
        filtered = period_scoped
        if status_filter:
            norm = status_filter.strip().lower()
            if norm in ("draft", "submitted", "paid", "void"):
                filtered = [p for p in filtered if p["status"] == norm]
        if project_id:
            pid = str(project_id)
            filtered = [p for p in filtered if p["project_id"] == pid]

        # Sort: newest period first; within period, drafts before submitted before paid
        # before void; within status, app_no DESC; project name ASC final tiebreak.
        # Python's sort is stable — apply keys least-significant first.
        filtered.sort(key=lambda p: p["project_name"].lower())
        filtered.sort(key=lambda p: -(p["app_no"] or 0))
        filtered.sort(key=lambda p: _STATUS_RANK.get(p["status"], 9))
        filtered.sort(key=lambda p: _period_to_key(p["period"]), reverse=True)

        # ─ Revised contract: sum across active projects ─
        # Projects table has contract_value; CO totals must be aggregated from
        # the change_orders table (approved status only). Active + not-deleted.
        proj_result = (
            sb.table("projects")
            .select("id, contract_value, status, deleted_at")
            .execute()
        )
        proj_rows = proj_result.data or []
        active_projects = [
            p for p in proj_rows
            if (p.get("status") or "active") == "active" and not p.get("deleted_at")
        ]
        active_ids = [p["id"] for p in active_projects]

        co_total_by_project: dict = {}
        if active_ids:
            co_result = (
                sb.table("change_orders")
                .select("project_id, amount, status")
                .in_("project_id", active_ids)
                .eq("status", "approved")
                .execute()
            )
            for co in (co_result.data or []):
                pid = co.get("project_id")
                co_total_by_project[pid] = co_total_by_project.get(pid, 0.0) + _to_float(co.get("amount"))

        revised_total = sum(
            _to_float(p.get("contract_value")) + co_total_by_project.get(p["id"], 0.0)
            for p in active_projects
        )

        stats = {
            "open_drafts_count": len(open_drafts),
            "open_drafts_projects": len({p["project_id"] for p in open_drafts}),
            "submitted_count": len(submitted_apps),
            "submitted_outstanding": round(sum(_to_float(p["current_payment_due"]) for p in submitted_apps), 2),
            "billed_total": round(sum(_to_float(p["current_payment_due"]) for p in period_scoped), 2),
            "billed_projects": len({
                p["project_id"] for p in period_scoped if _to_float(p["current_payment_due"]) > 0
            }),
            "revised_contract_total": round(revised_total, 2),
        }

    except HTTPException:
        raise
    except Exception as e:
        # Don't leak Supabase internals.
        raise HTTPException(
            status_code=503,
            detail=f"Could not load dashboard: {type(e).__name__}",
        )

    return {"pay_apps": filtered, "stats": stats}


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

    # ─── Carry forward "previous_work" from the most recent prior pay app ───
    # For each SOV line / CO, the new pay app's previous_work = column G of the
    # most recent prior pay app (= previous_work + this_period_work + materials_stored).
    # This is what makes the G703 math work across periods: column D of period N+1
    # equals column G of period N.
    #
    # We carry forward from ANY prior pay app regardless of status (draft/submitted/paid).
    # Rationale: a draft pay app for a prior period represents real work that was
    # already billed in the paper/Excel world. The "submitted/paid" filter is only
    # used for the pay_apps.previous_certificates aggregate, which is a separate
    # field with stricter semantics.
    carry_forward: dict[str, dict] = {}    # key = "sov:{id}" or "co:{id}" -> totals
    prior_apps = (
        sb.table("pay_apps")
        .select("id, app_no")
        .eq("project_id", str(body.project_id))
        .lt("app_no", body.app_no)
        .order("app_no", desc=True)
        .limit(1)
        .execute()
    )
    if prior_apps.data:
        prior_pa_id = prior_apps.data[0]["id"]
        prior_billings = (
            sb.table("pay_app_billings").select("*")
            .eq("pay_app_id", prior_pa_id)
            .execute()
        )
        for b in (prior_billings.data or []):
            # column G = D + E + F
            prev = float(b.get("previous_work") or 0)
            this_p = float(b.get("this_period_work") or 0)
            stored = float(b.get("materials_stored") or 0)
            total_g = prev + this_p + stored
            if b.get("sov_line_id"):
                carry_forward[f"sov:{b['sov_line_id']}"] = {"prev": total_g}
            elif b.get("change_order_id"):
                carry_forward[f"co:{b['change_order_id']}"] = {"prev": total_g}

    # Auto-create billing rows for each SOV line + CO, populating previous_work
    # from the carry-forward map (defaulting to 0 if no prior pay app exists).
    sov_res = sb.table("sov_lines").select("id").eq("project_id", str(body.project_id)).execute()
    co_res = (sb.table("change_orders").select("id")
              .eq("project_id", str(body.project_id))
              .eq("status", "approved").execute())
    billings_to_insert = []
    for s in sov_res.data:
        cf = carry_forward.get(f"sov:{s['id']}", {})
        billings_to_insert.append({
            "pay_app_id": pa["id"],
            "sov_line_id": s["id"],
            "previous_work": str(cf.get("prev", 0)),
            "this_period_work": "0",
            "materials_stored": "0",
        })
    for c in co_res.data:
        cf = carry_forward.get(f"co:{c['id']}", {})
        billings_to_insert.append({
            "pay_app_id": pa["id"],
            "change_order_id": c["id"],
            "previous_work": str(cf.get("prev", 0)),
            "this_period_work": "0",
            "materials_stored": "0",
        })
    if billings_to_insert:
        sb.table("pay_app_billings").insert(billings_to_insert).execute()

    # Compute and save totals
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
