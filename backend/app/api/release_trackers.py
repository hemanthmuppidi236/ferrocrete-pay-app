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
from ..core import release_stage as rs
from ..schemas.releases import (
    ReleaseTracker, ReleaseTrackerDetail, ReleaseTrackerCreate, ReleaseTrackerUpdate,
    ReleaseTrackerLinesUpdate, ReleaseLine, ReleaseUnbilledEntry,
)

router = APIRouter(prefix="/release-trackers", tags=["release_trackers"])


def _load_lines_with_np(sb, tracker_id: str):
    """Load a tracker's lines with each sub's is_non_prelimed flag, as a list
    of (line_dict, is_non_prelimed) for the stage-derivation helpers."""
    res = (sb.table("release_lines")
           .select("*, subs(is_non_prelimed)")
           .eq("release_tracker_id", tracker_id).execute())
    out = []
    for ln in (res.data or []):
        sub_data = ln.pop("subs", None) or {}
        out.append((ln, bool(sub_data.get("is_non_prelimed"))))
    return out


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
    trackers = res.data or []
    if not trackers:
        return trackers

    # Batch-load every line for these trackers, then derive per-tracker flags
    # and a stage summary in one pass (avoids an N+1 over the trackers).
    tracker_ids = [t["id"] for t in trackers]
    lines_res = (sb.table("release_lines")
                 .select("*, subs(is_non_prelimed)")
                 .in_("release_tracker_id", tracker_ids).execute())
    by_tracker = {}
    for ln in (lines_res.data or []):
        sub_data = ln.pop("subs", None) or {}
        by_tracker.setdefault(ln["release_tracker_id"], []).append(
            (ln, bool(sub_data.get("is_non_prelimed")))
        )
    for t in trackers:
        lwn = by_tracker.get(t["id"], [])
        t.update(rs.derive_tracker_flags(lwn))
        t.update(rs.summarize_stages(lwn))
    return trackers


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

    # Load lines with sub names + non-prelimed flag + email fields joined
    lines_res = (sb.table("release_lines")
                 .select("*, subs(name, parent_sub_id, is_non_prelimed, "
                         "billing_email, contact_email)")
                 .eq("release_tracker_id", str(tracker_id))
                 .execute())
    lines = []
    for ln in lines_res.data:
        sub_data = ln.pop("subs", None) or {}
        ln["sub_name"] = sub_data.get("name")
        ln["parent_sub_id"] = sub_data.get("parent_sub_id")
        ln["is_non_prelimed"] = bool(sub_data.get("is_non_prelimed"))
        ln["has_email"] = bool(sub_data.get("billing_email") or sub_data.get("contact_email"))
        # Derived per-line stage + overdue (WI-2).
        ln["stage"] = rs.derive_stage(ln, ln["is_non_prelimed"])
        ln["is_overdue"] = rs.is_overdue(ln, ln["stage"])
        lines.append(ln)

    # Most-recent reminder per line, for the "last emailed" note (WI-3).
    line_ids = [ln["id"] for ln in lines]
    if line_ids:
        try:
            rem = (sb.table("release_line_reminders")
                   .select("release_line_id, template_key, sent_at")
                   .in_("release_line_id", line_ids)
                   .order("sent_at", desc=True).execute())
            latest = {}
            for r in (rem.data or []):
                latest.setdefault(r["release_line_id"],
                                  {"template_key": r["template_key"], "sent_at": r["sent_at"]})
            for ln in lines:
                ln["last_reminder"] = latest.get(ln["id"])
        except Exception:
            pass  # table missing (migration not applied) — degrade gracefully

    tracker["lines"] = lines

    # Tracker-level workflow flags are DERIVED from the lines, not stored.
    lines_with_np = [(ln, ln["is_non_prelimed"]) for ln in lines]
    tracker.update(rs.derive_tracker_flags(lines_with_np))
    tracker.update(rs.summarize_stages(lines_with_np))

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

    # Seed lines = union of (prior tracker lines, zeroed) + (active subs not
    # already carried). Shared with the pay-app auto-create path. First ensure
    # the project's single catch-all non-prelim sub exists.
    from ..core.release_carry_forward import build_seed_lines, ensure_default_nonprelim_sub
    ensure_default_nonprelim_sub(sb, str(body.project_id))
    new_lines = build_seed_lines(sb, str(body.project_id), tracker["id"], body.period)
    if new_lines:
        sb.table("release_lines").insert(new_lines).execute()

    # Seed a single empty unbilled row (rarely used; more can be added on demand).
    sb.table("release_unbilled_entries").insert({
        "release_tracker_id": tracker["id"],
        "amount": "0",
        "sort_order": 0,
    }).execute()

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

    # WI-2: the three workflow flags are now DERIVED from the per-sub lifecycle,
    # not written by clients. Accept-and-ignore for one release, with a warning.
    # `approved` stays a real, manually-set flag.
    deprecated = [k for k in ("requested_releases", "verified_releases", "sent_to_gc")
                  if k in updates]
    if deprecated:
        print(f"[release_trackers] DEPRECATED: PATCH wrote derived flags "
              f"{deprecated} on tracker {tracker_id}; ignoring (now derived).",
              flush=True)
        for k in deprecated:
            updates.pop(k, None)

    row = existing.data[0]
    if updates:
        res = sb.table("release_trackers").update(updates).eq("id", str(tracker_id)).execute()
        audit.log(user.id, "release_tracker", str(tracker_id), "updated",
                  before=existing.data[0], after=res.data[0])
        row = res.data[0]

    # Attach derived flags + stage summary so the response matches GET.
    lwn = _load_lines_with_np(sb, str(tracker_id))
    row.update(rs.derive_tracker_flags(lwn))
    row.update(rs.summarize_stages(lwn))
    return row


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

    # Project grace window, used to compute bill_due_at when a bill is requested.
    proj = (sb.table("projects").select("grace_days")
            .eq("id", existing.data[0]["project_id"]).limit(1).execute())
    grace_days = 14
    if proj.data and proj.data[0].get("grace_days") is not None:
        grace_days = int(proj.data[0]["grace_days"])

    # Get current lines
    cur_lines = (sb.table("release_lines")
                 .select("id, sub_id, billed_amount, check_amount")
                 .eq("release_tracker_id", str(tracker_id)).execute())
    cur_by_sub = {ln["sub_id"]: ln["id"] for ln in cur_lines.data}
    cur_by_id = {ln["id"]: ln for ln in cur_lines.data}
    incoming_sub_ids = {str(ln.sub_id) for ln in body.lines}

    # Lines for subs no longer present are candidates for deletion. Only truly
    # empty lines (zero amounts, no waivers) may be removed — deleting a line
    # would cascade-delete its uploaded waivers, so protect those.
    to_delete = [cur_by_sub[s] for s in cur_by_sub if s not in incoming_sub_ids]
    if to_delete:
        wv = (sb.table("waivers").select("release_line_id")
              .in_("release_line_id", to_delete).execute())
        lines_with_waivers = {w["release_line_id"] for w in (wv.data or [])}
        for lid in to_delete:
            ln = cur_by_id.get(lid, {})
            has_amount = (Decimal(str(ln.get("billed_amount") or 0)) > 0
                          or Decimal(str(ln.get("check_amount") or 0)) > 0)
            if lid in lines_with_waivers or has_amount:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Cannot remove a sub that has waivers or nonzero amounts. "
                    "Clear its billed/check amounts and remove its waivers first.",
                )
        sb.table("release_lines").delete().in_("id", to_delete).execute()

    # Upsert each incoming line
    from datetime import timedelta

    def _iso(d):
        return d.isoformat() if d is not None else None

    for ln in body.lines:
        sub_id = str(ln.sub_id)
        # bill_due_at defaults to bill_requested_at + grace_days when a bill is
        # marked requested and no explicit due date was provided.
        bill_due_at = ln.bill_due_at
        if bill_due_at is None and ln.bill_requested_at is not None \
                and ln.bill_status in ("requested", "received"):
            bill_due_at = ln.bill_requested_at + timedelta(days=grace_days)

        payload = {
            "release_tracker_id": str(tracker_id),
            "sub_id": sub_id,
            "billed_amount": str(ln.billed_amount),
            "check_amount": str(ln.check_amount),
            "release_type": ln.release_type,
            "exception": ln.exception,
            "prev_month_status": ln.prev_month_status,
            "difference_note": ln.difference_note,
            "check_type": ln.check_type,
            "bill_requested_at": _iso(ln.bill_requested_at),
            "bill_received_at": _iso(ln.bill_received_at),
            "bill_due_at": _iso(bill_due_at),
            "conditional_received_at": _iso(ln.conditional_received_at),
            "conditional_sent_at": _iso(ln.conditional_sent_at),
            "check_received_at": _iso(ln.check_received_at),
            "check_sent_to_sub_at": _iso(ln.check_sent_to_sub_at),
            "unconditional_requested_at": _iso(ln.unconditional_requested_at),
            "unconditional_received_at": _iso(ln.unconditional_received_at),
            "unconditional_sent_at": _iso(ln.unconditional_sent_at),
        }
        # Only write status enums when provided (keep NOT NULL defaults otherwise).
        if ln.bill_status is not None:
            payload["bill_status"] = ln.bill_status
        if ln.conditional_status is not None:
            payload["conditional_status"] = ln.conditional_status
        if ln.unconditional_status is not None:
            payload["unconditional_status"] = ln.unconditional_status

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
