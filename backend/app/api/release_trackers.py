"""
Release Trackers API.

  GET    /release-trackers                       list (filterable by project, period)
  GET    /release-trackers/{id}                  full detail with lines + unbilled entries
  POST   /release-trackers                       create new (carries forward from prior period)
  PATCH  /release-trackers/{id}                  update metadata (workflow checkboxes, etc.)
  PUT    /release-trackers/{id}/lines            replace release lines (sub amounts)
  PUT    /release-trackers/{id}/unbilled-entries replace previous-month unbilled entries
"""

from datetime import datetime, timezone
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import List, Optional
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..schemas.releases import (
    ReleaseTracker, ReleaseTrackerDetail, ReleaseTrackerCreate, ReleaseTrackerUpdate,
    ReleaseTrackerLinesUpdate, ReleaseLine, ReleaseUnbilledEntry,
)

router = APIRouter(prefix="/release-trackers", tags=["release_trackers"])


@router.get("", response_model=List[ReleaseTracker])
def list_release_trackers(
    project_id: Optional[UUID] = Query(None),
    period: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    q = sb.table("release_trackers").select("*")
    if project_id:
        q = q.eq("project_id", str(project_id))
    if period:
        q = q.eq("period", period)
    res = q.order("period", desc=True).execute()
    return res.data


@router.get("/{tracker_id}", response_model=ReleaseTrackerDetail)
def get_release_tracker(
    tracker_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    rt = sb.table("release_trackers").select("*").eq("id", str(tracker_id)).limit(1).execute()
    if not rt.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release tracker not found")
    tracker = rt.data[0]

    # Load lines with sub names joined
    lines_res = (sb.table("release_lines")
                 .select("*, subs(name, parent_sub_id)")
                 .eq("release_tracker_id", str(tracker_id))
                 .execute())
    lines = []
    for ln in lines_res.data:
        sub_data = ln.pop("subs", None) or {}
        ln["sub_name"] = sub_data.get("name")
        ln["parent_sub_id"] = sub_data.get("parent_sub_id")
        lines.append(ln)
    tracker["lines"] = lines

    unb_res = (sb.table("release_unbilled_entries")
               .select("*").eq("release_tracker_id", str(tracker_id))
               .order("sort_order").execute())
    tracker["unbilled_entries"] = unb_res.data

    # Ferrocrete Net = invoice − Σ(sub checks) − Σ(prev-month unbilled).
    # Single source of truth for the Billing Summary's "Potential Net" column.
    from ..core import billing_math as bm
    total_checks = sum((bm.dec(ln.get("check_amount")) for ln in lines), Decimal("0"))
    total_unbilled = sum((bm.dec(u.get("amount")) for u in (unb_res.data or [])), Decimal("0"))
    tracker["ferrocrete_net"] = bm.ferrocrete_net(
        tracker.get("invoice_amount"), total_checks, total_unbilled
    )

    return tracker


@router.post("", response_model=ReleaseTracker, status_code=status.HTTP_201_CREATED)
def create_release_tracker(
    body: ReleaseTrackerCreate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    """Create a new release tracker for a project + period.

    Carry-forward: copies the sub list from the most recent prior tracker
    (if any) and zeroes out amounts. Pulls invoice amount from the linked
    pay app's current_payment_due (if pay_app_id provided).
    """
    sb = get_service_client()

    # Verify project + uniqueness
    proj = sb.table("projects").select("*").eq("id", str(body.project_id)).limit(1).execute()
    if not proj.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

    # Auto-pull invoice amount from pay app if linked
    invoice_amount = body.invoice_amount
    if body.pay_app_id and invoice_amount is None:
        pa = sb.table("pay_apps").select("current_payment_due").eq("id", str(body.pay_app_id)).limit(1).execute()
        if pa.data:
            cpd = pa.data[0].get("current_payment_due")
            if cpd is not None and Decimal(str(cpd)) > 0:
                invoice_amount = Decimal(str(cpd))

    # Compute conditional through date = last day of period (period is YY-MM)
    import calendar
    yy, mm = body.period.split("-")
    year = 2000 + int(yy)
    month = int(mm)
    last_day = calendar.monthrange(year, month)[1]
    from datetime import date
    conditional_through = date(year, month, last_day)

    payload = {
        "project_id": str(body.project_id),
        "pay_app_id": str(body.pay_app_id) if body.pay_app_id else None,
        "period": body.period,
        "invoice_amount": str(invoice_amount) if invoice_amount is not None else None,
        "conditional_through_date": conditional_through.isoformat(),
    }

    try:
        res = sb.table("release_trackers").insert(payload).execute()
    except Exception as e:
        if "duplicate key" in str(e).lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"Release tracker for {body.period} already exists in this project")
        raise

    tracker = res.data[0]

    # Carry-forward lines from prior tracker
    prior_res = (sb.table("release_trackers")
                 .select("id, period")
                 .eq("project_id", str(body.project_id))
                 .lt("period", body.period)
                 .order("period", desc=True)
                 .limit(1).execute())
    if prior_res.data:
        prior_id = prior_res.data[0]["id"]
        prior_lines = sb.table("release_lines").select("*").eq("release_tracker_id", prior_id).execute()
        if prior_lines.data:
            new_lines = []
            for pl in prior_lines.data:
                new_lines.append({
                    "release_tracker_id": tracker["id"],
                    "sub_id": pl["sub_id"],
                    "billed_amount": "0",
                    "check_amount": "0",
                    "release_type": pl.get("release_type"),
                    "exception": pl.get("exception"),
                    "prev_month_status": None,    # not auto-tracked per user spec
                })
            sb.table("release_lines").insert(new_lines).execute()
    else:
        # No prior — seed with all active subs
        subs_res = (sb.table("subs").select("id, default_release_type")
                    .eq("project_id", str(body.project_id))
                    .eq("active", True).execute())
        if subs_res.data:
            new_lines = [{
                "release_tracker_id": tracker["id"],
                "sub_id": s["id"],
                "billed_amount": "0",
                "check_amount": "0",
                "release_type": s.get("default_release_type"),
            } for s in subs_res.data]
            sb.table("release_lines").insert(new_lines).execute()

    # Always seed 5 empty unbilled entries (matches the layout's 5-row block)
    unb_seed = [{
        "release_tracker_id": tracker["id"],
        "amount": "0",
        "sort_order": i,
    } for i in range(5)]
    sb.table("release_unbilled_entries").insert(unb_seed).execute()

    audit.log(user.id, "release_tracker", tracker["id"], "created", after=tracker)
    return tracker


@router.patch("/{tracker_id}", response_model=ReleaseTracker)
def update_release_tracker(
    tracker_id: UUID,
    body: ReleaseTrackerUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("release_trackers").select("*").eq("id", str(tracker_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release tracker not found")
    updates = body.model_dump(mode="json", exclude_unset=True)
    if not updates:
        return existing.data[0]
    res = sb.table("release_trackers").update(updates).eq("id", str(tracker_id)).execute()
    audit.log(user.id, "release_tracker", str(tracker_id), "updated",
              before=existing.data[0], after=res.data[0])
    return res.data[0]


@router.put("/{tracker_id}/lines", response_model=ReleaseTrackerDetail)
def update_release_lines(
    tracker_id: UUID,
    body: ReleaseTrackerLinesUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    """Replace all release lines for a tracker.

    Strategy: upsert by sub_id (so existing line ids are preserved if possible).
    Lines for subs not in the body are deleted.
    """
    sb = get_service_client()
    existing = sb.table("release_trackers").select("*").eq("id", str(tracker_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release tracker not found")

    # Get current lines
    cur_lines = sb.table("release_lines").select("id, sub_id").eq("release_tracker_id", str(tracker_id)).execute()
    cur_by_sub = {ln["sub_id"]: ln["id"] for ln in cur_lines.data}
    incoming_sub_ids = {str(ln.sub_id) for ln in body.lines}

    # Delete lines for subs no longer present
    to_delete = [cur_by_sub[s] for s in cur_by_sub if s not in incoming_sub_ids]
    if to_delete:
        sb.table("release_lines").delete().in_("id", to_delete).execute()

    # Upsert each incoming line
    for ln in body.lines:
        sub_id = str(ln.sub_id)
        payload = {
            "release_tracker_id": str(tracker_id),
            "sub_id": sub_id,
            "billed_amount": str(ln.billed_amount),
            "check_amount": str(ln.check_amount),
            "release_type": ln.release_type,
            "exception": ln.exception,
            "prev_month_status": ln.prev_month_status,
        }
        if sub_id in cur_by_sub:
            sb.table("release_lines").update(payload).eq("id", cur_by_sub[sub_id]).execute()
        else:
            sb.table("release_lines").insert(payload).execute()

    audit.log(user.id, "release_tracker", str(tracker_id), "lines_updated",
              metadata={"line_count": len(body.lines)})

    # Return full detail
    return get_release_tracker(tracker_id, user)


@router.put("/{tracker_id}/unbilled-entries", response_model=List[ReleaseUnbilledEntry])
def update_unbilled_entries(
    tracker_id: UUID,
    entries: List[ReleaseUnbilledEntry],
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    sb.table("release_unbilled_entries").delete().eq("release_tracker_id", str(tracker_id)).execute()
    if entries:
        rows = [{
            "release_tracker_id": str(tracker_id),
            "description": e.description,
            "amount": str(e.amount),
            "sort_order": e.sort_order,
        } for e in entries]
        sb.table("release_unbilled_entries").insert(rows).execute()
    res = sb.table("release_unbilled_entries").select("*").eq("release_tracker_id", str(tracker_id)).order("sort_order").execute()
    return res.data
