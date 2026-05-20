"""
Change Orders API.

When a CO is added, approved, or has its `has_retention` flag changed, we
need to keep DRAFT pay apps consistent:

  - Add a billing row for the CO to each draft pay app for the project.
  - Recompute pay app totals (revised_contract, retention_held, etc.).

We never touch billings on submitted/paid/void pay apps — those are
historical snapshots. The construction-industry convention is that a CO
flows into the *current draft and future apps*, not retroactively into
already-signed-off periods.
"""

from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core.pay_app_math import save_pay_app_totals
from ..core import audit
from ..schemas.projects import ChangeOrder, ChangeOrderCreate, ChangeOrderUpdate

router = APIRouter(prefix="/projects/{project_id}/change-orders", tags=["change_orders"])


# ─── Helpers ──────────────────────────────────────────────────────────


def _billing_has_work(b: dict) -> bool:
    """Return True if a billing row has any non-zero work logged.

    Uses Decimal to compare currency values (not float, which can have
    subtle precision issues for values like 0.1 + 0.2).
    """
    for key in ("previous_work", "this_period_work", "materials_stored"):
        v = b.get(key)
        if v is None:
            continue
        try:
            if Decimal(str(v)) != 0:
                return True
        except Exception:
            # If a value is malformed, treat it as non-zero out of caution
            # (better to refuse a destructive operation than to silently
            # drop billed work).
            return True
    return False



def _list_draft_pay_apps(sb, project_id: str) -> list:
    """Return all draft pay app rows for a project."""
    res = (sb.table("pay_apps")
           .select("id, app_no, status")
           .eq("project_id", project_id)
           .eq("status", "draft")
           .execute())
    return res.data or []


def _add_co_billing_to_drafts(sb, project_id: str, co_id: str) -> int:
    """
    Insert a zero-valued billing row for `co_id` into every draft pay app
    for `project_id`, unless one already exists. Returns how many were added.

    Recomputes totals on each affected draft.
    """
    drafts = _list_draft_pay_apps(sb, project_id)
    added = 0
    for pa in drafts:
        existing = (sb.table("pay_app_billings").select("id")
                    .eq("pay_app_id", pa["id"])
                    .eq("change_order_id", co_id)
                    .limit(1).execute())
        if existing.data:
            continue
        sb.table("pay_app_billings").insert({
            "pay_app_id": pa["id"],
            "change_order_id": co_id,
            "previous_work": "0",
            "this_period_work": "0",
            "materials_stored": "0",
        }).execute()
        added += 1
        try:
            save_pay_app_totals(pa["id"])
        except Exception as e:
            print(f"[CO sync] save_pay_app_totals failed for {pa['id']}: {e}", flush=True)
    return added


def _remove_co_billing_from_drafts(sb, project_id: str, co_id: str) -> tuple[int, list]:
    """
    Remove this CO's billing from every draft pay app — but only where
    nothing has been billed yet (all three value columns are 0).

    Returns (deleted_count, list_of_blocking_app_nos).
    """
    drafts = _list_draft_pay_apps(sb, project_id)
    deleted = 0
    blocking = []
    for pa in drafts:
        existing = (sb.table("pay_app_billings").select("*")
                    .eq("pay_app_id", pa["id"])
                    .eq("change_order_id", co_id)
                    .limit(1).execute())
        if not existing.data:
            continue
        b = existing.data[0]
        if _billing_has_work(b):
            blocking.append(pa["app_no"])
            continue
        sb.table("pay_app_billings").delete().eq("id", b["id"]).execute()
        deleted += 1
        try:
            save_pay_app_totals(pa["id"])
        except Exception as e:
            print(f"[CO sync] save_pay_app_totals failed for {pa['id']}: {e}", flush=True)
    return deleted, blocking


def _recalc_drafts(sb, project_id: str) -> int:
    """Recompute totals on every draft pay app for the project."""
    drafts = _list_draft_pay_apps(sb, project_id)
    count = 0
    for pa in drafts:
        try:
            save_pay_app_totals(pa["id"])
            count += 1
        except Exception as e:
            print(f"[CO sync] save_pay_app_totals failed for {pa['id']}: {e}", flush=True)
    return count


# ─── Endpoints ────────────────────────────────────────────────────────


@router.get("", response_model=List[ChangeOrder])
def list_change_orders(project_id: UUID, user: CurrentUser = Depends(get_current_user)):
    sb = get_service_client()
    res = sb.table("change_orders").select("*").eq("project_id", str(project_id)).order("co_no").execute()
    return res.data


@router.post("", response_model=ChangeOrder, status_code=status.HTTP_201_CREATED)
def create_change_order(
    project_id: UUID,
    body: ChangeOrderCreate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    payload = body.model_dump(mode="json")
    payload["project_id"] = str(project_id)
    try:
        res = sb.table("change_orders").insert(payload).execute()
    except Exception as e:
        if "duplicate key" in str(e).lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"CO number '{body.co_no}' already exists for this project")
        raise
    co = res.data[0]

    # If created as approved, sync to drafts immediately.
    synced = 0
    if co["status"] == "approved":
        synced = _add_co_billing_to_drafts(sb, str(project_id), co["id"])

    audit.log(user.id, "change_order", co["id"], "created", after=co,
              metadata={"project_id": str(project_id), "drafts_synced": synced})

    return co


@router.patch("/{co_id}", response_model=ChangeOrder)
def update_change_order(
    project_id: UUID,
    co_id: UUID,
    body: ChangeOrderUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("change_orders").select("*").eq("id", str(co_id)).limit(1).execute()
    if not existing.data or existing.data[0]["project_id"] != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Change order not found")

    before = existing.data[0]
    updates = body.model_dump(mode="json", exclude_unset=True)
    if not updates:
        return before

    # Determine transition kind BEFORE updating.
    was_approved = before.get("status") == "approved"
    will_be_approved = updates.get("status", before["status"]) == "approved"
    has_retention_changed = (
        "has_retention" in updates
        and updates["has_retention"] != before.get("has_retention")
    )

    # Refuse status transition AWAY from approved if billed work exists.
    if was_approved and not will_be_approved:
        drafts = _list_draft_pay_apps(sb, str(project_id))
        blocked = []
        for pa in drafts:
            b = (sb.table("pay_app_billings").select("*")
                 .eq("pay_app_id", pa["id"])
                 .eq("change_order_id", str(co_id))
                 .limit(1).execute())
            if b.data and _billing_has_work(b.data[0]):
                blocked.append(pa["app_no"])
        if blocked:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot un-approve this CO: work has been billed against it in "
                f"draft pay app(s) #{', #'.join(str(x) for x in blocked)}. "
                f"Zero out the billed work first, then change the CO status."
            )

    # Apply the update.
    res = sb.table("change_orders").update(updates).eq("id", str(co_id)).execute()
    co = res.data[0]

    # Sync effects.
    sync_info: dict = {}
    if not was_approved and will_be_approved:
        sync_info["drafts_synced_added"] = _add_co_billing_to_drafts(sb, str(project_id), str(co_id))
    elif was_approved and not will_be_approved:
        deleted, _ = _remove_co_billing_from_drafts(sb, str(project_id), str(co_id))
        sync_info["drafts_synced_removed"] = deleted
    elif will_be_approved and (has_retention_changed or "amount" in updates):
        sync_info["drafts_recalculated"] = _recalc_drafts(sb, str(project_id))

    audit.log(user.id, "change_order", str(co_id), "updated",
              before=before, after=co, metadata=sync_info or None)
    return co


@router.delete("/{co_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_change_order(
    project_id: UUID,
    co_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    sb = get_service_client()
    existing = sb.table("change_orders").select("*").eq("id", str(co_id)).limit(1).execute()
    if not existing.data or existing.data[0]["project_id"] != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Change order not found")

    # Protect billed history.
    bil = (sb.table("pay_app_billings")
           .select("id, pay_app_id, previous_work, this_period_work, materials_stored")
           .eq("change_order_id", str(co_id))
           .execute())
    if bil.data:
        pa_ids = list({b["pay_app_id"] for b in bil.data})
        pas = (sb.table("pay_apps").select("id, app_no, status")
               .in_("id", pa_ids).execute()).data or []
        pa_status = {p["id"]: p["status"] for p in pas}
        pa_appno = {p["id"]: p["app_no"] for p in pas}

        blocking = []
        for b in bil.data:
            status_val = pa_status.get(b["pay_app_id"])
            if status_val != "draft":
                blocking.append(f"App #{pa_appno.get(b['pay_app_id'])} ({status_val})")
                continue
            if _billing_has_work(b):
                blocking.append(f"App #{pa_appno.get(b['pay_app_id'])} (draft, has billed work)")
        if blocking:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot delete CO: it has billings in {', '.join(blocking)}. "
                f"Void the work in those pay apps first, or change this CO to "
                f"'rejected' instead of deleting."
            )

    sb.table("change_orders").delete().eq("id", str(co_id)).execute()
    _recalc_drafts(sb, str(project_id))

    audit.log(user.id, "change_order", str(co_id), "deleted", before=existing.data[0])
