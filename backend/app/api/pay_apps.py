"""
Pay Applications API.

  GET    /pay-apps                                all (filterable by project, status, period)
  GET    /pay-apps/dashboard                      dashboard data: pay apps + aggregate stats
  GET    /pay-apps/{id}                           one (with billings)
  POST   /pay-apps                                create new (draft)
  PATCH  /pay-apps/{id}                           update metadata
  PUT    /pay-apps/{id}/billings                  replace billings (recalcs totals)

  POST   /pay-apps/{id}/submit-for-approval       draft → pending_approval  (accountant/admin)
  POST   /pay-apps/{id}/recall                    pending_approval → draft  (accountant/admin) — undo
  POST   /pay-apps/{id}/approve                   pending_approval → approved (admin)
  POST   /pay-apps/{id}/reject                    pending_approval → draft + reason (admin)
  POST   /pay-apps/{id}/unapprove                 approved → draft  (admin) — undo, notifies submitter
  POST   /pay-apps/{id}/send-to-gc                approved → submitted; emails GC if set
  POST   /pay-apps/{id}/unsend                    submitted → approved  (accountant/admin) — undo
                                                  (the email already left; this only fixes app state)
  POST   /pay-apps/{id}/mark-paid                 submitted → paid

  DELETE /pay-apps/{id}                           only allowed on draft
"""

from datetime import datetime, timezone
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import List, Optional
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit, email as email_svc
from ..core.config import settings
from ..core.pay_app_math import calculate_pay_app_totals, save_pay_app_totals
from ..schemas.pay_apps import (
    PayApp, PayAppDetail, PayAppCreate, PayAppUpdate,
    PayAppBillingsUpdate, BillingLine,
    PayAppRejectBody, PayAppMarkPaidBody,
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
# Sort order for the dashboard table within a single period — drafts and items
# needing action surface above completed work.
_STATUS_RANK = {
    "draft": 0,
    "pending_approval": 1,
    "approved": 2,
    "submitted": 3,
    "paid": 4,
    "void": 5,
}


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
                "id, project_id, period, app_no, status, due_date, "
                "current_payment_due, total_completed_to_date, revised_contract, "
                "submitted_for_approval_at, updated_at, "
                "projects(name, project_no, gc_company, gc_contact_email, deleted_at)"
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
                "gc_email_configured": bool((proj.get("gc_contact_email") or "").strip()),
                "period": r.get("period") or "",
                "app_no": r.get("app_no"),
                "status": (r.get("status") or "draft").strip().lower(),
                # Keep Money strings on the wire; fmtMoneyShort parses them.
                "current_payment_due": r.get("current_payment_due") or "0",
                "percent_complete": round(pct, 1),
                "due_date": r.get("due_date"),
                "submitted_for_approval_at": r.get("submitted_for_approval_at"),
                "updated_at": r.get("updated_at"),
            })

        # ─ Company-wide queue counts (UNFILTERED) ─
        open_drafts = [p for p in all_rows if p["status"] == "draft"]
        pending_approval_apps = [p for p in all_rows if p["status"] == "pending_approval"]
        approved_apps = [p for p in all_rows if p["status"] == "approved"]
        # Treat the legacy 'submitted' state as "out to client / awaiting payment"
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
            if norm in ("draft", "pending_approval", "approved", "submitted", "paid", "void"):
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

            # Raz's "your court" — pay apps awaiting admin approval
            "pending_approval_count": len(pending_approval_apps),
            "pending_approval_total": round(
                sum(_to_float(p["current_payment_due"]) for p in pending_approval_apps), 2
            ),

            # Accountant's "your court" — approved and ready to send to GC
            "approved_count": len(approved_apps),
            "approved_total": round(
                sum(_to_float(p["current_payment_due"]) for p in approved_apps), 2
            ),

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
        # Internal-only app: surface the real error to the client so we don't
        # have to dig through Render logs every time. Also log the full
        # traceback server-side for after-the-fact debugging.
        import traceback
        tb = traceback.format_exc()
        print(f"[dashboard] {type(e).__name__}: {e}\n{tb}", flush=True)
        raise HTTPException(
            status_code=503,
            detail=f"Could not load dashboard — {type(e).__name__}: {e}",
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

    # Auto-create a release tracker for this period (best-effort; non-fatal).
    # The tracker is linked to the pay app, picks up current_payment_due as its
    # invoice_amount, and gets release lines seeded from prior tracker or from
    # the project's active subs.
    _autocreate_release_tracker(sb, pa)

    audit.log(user.id, "pay_app", pa["id"], "created", after=pa)
    return pa


def _autocreate_release_tracker(sb, pa: dict) -> None:
    """Auto-create a release tracker for the given pay app's project + period.

    Best-effort: any failure is logged but doesn't fail the pay app creation.
    Skips if a tracker already exists for (project_id, period) — same
    behavior as the explicit POST endpoint, just without raising.
    """
    try:
        from decimal import Decimal
        from datetime import date
        import calendar

        project_id = pa["project_id"]
        period = pa["period"]

        # Skip if a tracker already exists for this period.
        existing = (sb.table("release_trackers").select("id")
                    .eq("project_id", project_id)
                    .eq("period", period).limit(1).execute())
        if existing.data:
            return

        # Conditional through date = last day of period
        yy, mm = period.split("-")
        year = 2000 + int(yy)
        month = int(mm)
        last_day = calendar.monthrange(year, month)[1]
        conditional_through = date(year, month, last_day).isoformat()

        # Invoice amount from current_payment_due (if positive)
        invoice_amount = None
        cpd = pa.get("current_payment_due")
        if cpd is not None and Decimal(str(cpd)) > 0:
            invoice_amount = str(Decimal(str(cpd)))

        tracker_payload = {
            "project_id": project_id,
            "pay_app_id": pa["id"],
            "period": period,
            "invoice_amount": invoice_amount,
            "conditional_through_date": conditional_through,
        }
        rt_res = sb.table("release_trackers").insert(tracker_payload).execute()
        tracker_id = rt_res.data[0]["id"]

        # Seed release lines: carry forward from prior period, or use active subs.
        prior = (sb.table("release_trackers").select("id")
                 .eq("project_id", project_id)
                 .lt("period", period)
                 .order("period", desc=True)
                 .limit(1).execute())
        if prior.data:
            prior_lines = (sb.table("release_lines").select("*")
                           .eq("release_tracker_id", prior.data[0]["id"]).execute())
            if prior_lines.data:
                new_lines = [{
                    "release_tracker_id": tracker_id,
                    "sub_id": pl["sub_id"],
                    "billed_amount": "0",
                    "check_amount": "0",
                    "release_type": pl.get("release_type"),
                    "exception": pl.get("exception"),
                    "prev_month_status": None,
                } for pl in prior_lines.data]
                sb.table("release_lines").insert(new_lines).execute()
        else:
            subs = (sb.table("subs").select("id, default_release_type")
                    .eq("project_id", project_id)
                    .eq("active", True).execute())
            if subs.data:
                new_lines = [{
                    "release_tracker_id": tracker_id,
                    "sub_id": s["id"],
                    "billed_amount": "0",
                    "check_amount": "0",
                    "release_type": s.get("default_release_type"),
                } for s in subs.data]
                sb.table("release_lines").insert(new_lines).execute()

        # Seed 5 empty unbilled entries
        sb.table("release_unbilled_entries").insert([{
            "release_tracker_id": tracker_id,
            "amount": "0",
            "sort_order": i,
        } for i in range(5)]).execute()
    except Exception as e:
        print(f"[pay_apps] auto-create release tracker failed (non-fatal): {e}", flush=True)


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


# ═══════════════════════════════════════════════════════════════════════
# Workflow transitions
#
#     draft ── submit-for-approval ──► pending_approval ── approve ──► approved
#                                            │                            │
#                                          reject (reason)         send-to-gc
#                                            │                            │
#                                            ▼                            ▼
#                                          draft                      submitted ── mark-paid ──► paid
#
# Each transition validates the current state, records actor + timestamp,
# and fires the matching notification email.
# ═══════════════════════════════════════════════════════════════════════


def _load_pay_app_or_404(sb, pay_app_id: UUID) -> dict:
    res = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pay app not found")
    return res.data[0]


def _load_user(sb, user_id: Optional[str]) -> dict:
    """Return {id, email, full_name} for a user, or {} if not found."""
    if not user_id:
        return {}
    res = (sb.table("app_users")
           .select("id, email, full_name")
           .eq("id", user_id).limit(1).execute())
    return (res.data or [{}])[0]


def _load_project(sb, project_id: str) -> dict:
    res = (sb.table("projects").select("*")
           .eq("id", project_id).limit(1).execute())
    return (res.data or [{}])[0]


@router.post("/{pay_app_id}/submit-for-approval", response_model=PayApp)
def submit_for_approval(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """draft → pending_approval. Recalcs totals and notifies all admins."""
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "draft":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; only draft pay apps can be sent for approval.",
        )

    save_pay_app_totals(str(pay_app_id))
    now = datetime.now(timezone.utc).isoformat()
    res = sb.table("pay_apps").update({
        "status": "pending_approval",
        "submitted_for_approval_at": now,
        "submitted_for_approval_by": user.id,
        # Clear any prior rejection state — this is a fresh submission.
        "rejection_reason": None,
        "rejected_at": None,
        "rejected_by": None,
    }).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "submitted_for_approval",
              before=existing, after=pa)

    # Notify admins (best-effort; never break the workflow on email failure)
    try:
        project = _load_project(sb, pa["project_id"])
        submitter = _load_user(sb, user.id) or {"id": user.id, "email": user.email,
                                                "full_name": user.full_name}
        email_svc.notify_submitted_for_approval(
            pa=pa, project=project, submitter=submitter,
        )
    except Exception as e:
        # Don't roll the state back; just log
        print(f"[pay_apps] approval notification failed: {e}", flush=True)

    return pa


@router.post("/{pay_app_id}/recall", response_model=PayApp)
def recall_pay_app(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """pending_approval → draft. Withdraws a submission before admin acts.

    No email goes out — the approval-needed email already went to admins, but
    they'll see the pay app drop out of their 'Awaiting your approval' queue
    on next dashboard load. The audit log records who recalled it.
    """
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "pending_approval":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; only pending_approval pay apps can be recalled.",
        )

    res = sb.table("pay_apps").update({
        "status": "draft",
        # Clear the submit-for-approval markers — it's as if it was never sent.
        "submitted_for_approval_at": None,
        "submitted_for_approval_by": None,
    }).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "recalled",
              before=existing, after=pa)
    return pa


@router.post("/{pay_app_id}/approve", response_model=PayApp)
def approve_pay_app(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin")),
):
    """pending_approval → approved. Notifies the submitter."""
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "pending_approval":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; only pending_approval pay apps can be approved.",
        )

    now = datetime.now(timezone.utc).isoformat()
    res = sb.table("pay_apps").update({
        "status": "approved",
        "approved_at": now,
        "approved_by": user.id,
    }).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "approved",
              before=existing, after=pa)

    try:
        project = _load_project(sb, pa["project_id"])
        submitter = _load_user(sb, pa.get("submitted_for_approval_by"))
        approver = _load_user(sb, user.id) or {"id": user.id, "email": user.email,
                                               "full_name": user.full_name}
        if submitter:
            email_svc.notify_approved(
                pa=pa, project=project, submitter=submitter, approver=approver,
            )
    except Exception as e:
        print(f"[pay_apps] approve notification failed: {e}", flush=True)

    return pa


@router.post("/{pay_app_id}/reject", response_model=PayApp)
def reject_pay_app(
    pay_app_id: UUID,
    body: PayAppRejectBody,
    user: CurrentUser = Depends(require_role("admin")),
):
    """pending_approval → draft. Stores the reason and notifies the submitter."""
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "pending_approval":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; only pending_approval pay apps can be rejected.",
        )

    now = datetime.now(timezone.utc).isoformat()
    res = sb.table("pay_apps").update({
        "status": "draft",
        "rejected_at": now,
        "rejected_by": user.id,
        "rejection_reason": body.reason.strip(),
    }).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "rejected",
              before=existing, after=pa,
              metadata={"reason": body.reason.strip()})

    try:
        project = _load_project(sb, pa["project_id"])
        submitter = _load_user(sb, pa.get("submitted_for_approval_by"))
        approver = _load_user(sb, user.id) or {"id": user.id, "email": user.email,
                                               "full_name": user.full_name}
        if submitter:
            email_svc.notify_rejected(
                pa=pa, project=project, submitter=submitter, approver=approver,
                reason=body.reason.strip(),
            )
    except Exception as e:
        print(f"[pay_apps] reject notification failed: {e}", flush=True)

    return pa


@router.post("/{pay_app_id}/unapprove", response_model=PayApp)
def unapprove_pay_app(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin")),
):
    """approved → draft. Lets an admin unwind an approval (e.g., approved too
    quickly, wants another look). Clears approval + submit-for-approval
    timestamps; status is back at draft. Notifies the original submitter so
    they aren't confused when their 'approved' pay app reappears in edits.
    """
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "approved":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; only approved pay apps can be un-approved.",
        )

    res = sb.table("pay_apps").update({
        "status": "draft",
        "approved_at": None,
        "approved_by": None,
        "submitted_for_approval_at": None,
        "submitted_for_approval_by": None,
    }).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "unapproved",
              before=existing, after=pa)

    try:
        project = _load_project(sb, pa["project_id"])
        submitter = _load_user(sb, existing.get("submitted_for_approval_by"))
        approver = _load_user(sb, user.id) or {"id": user.id, "email": user.email,
                                               "full_name": user.full_name}
        if submitter:
            email_svc.notify_unapproved(
                pa=pa, project=project, submitter=submitter, approver=approver,
            )
    except Exception as e:
        print(f"[pay_apps] unapprove notification failed: {e}", flush=True)

    return pa


@router.post("/{pay_app_id}/send-to-gc", response_model=PayApp)
def send_pay_app_to_gc(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """approved → submitted.

    If the project has gc_contact_email set: generate the G702 PDF and G703
    Excel (if not already), build signed URLs, and email them to the GC.
    Otherwise: just transition the state (the accountant is submitting via
    the GC's portal manually) and record sent_to_gc_email=NULL.
    """
    from ..core.storage import signed_url as _signed_url
    from ..core.excel_pay_app import generate_and_store_pay_app_excel
    from ..core.pdf_pay_app import generate_and_store_pay_app_pdf

    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "approved":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; approve it first.",
        )

    project = _load_project(sb, existing["project_id"])
    gc_email = (project.get("gc_contact_email") or "").strip() or None

    email_result = None
    if gc_email:
        # Regenerate Excel/PDF to make sure they reflect the latest totals
        # (the approved version), then build signed URLs for Resend.
        try:
            excel_meta = generate_and_store_pay_app_excel(str(pay_app_id))
            pdf_meta = generate_and_store_pay_app_pdf(str(pay_app_id))
        except Exception as e:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"Could not generate pay app files: {type(e).__name__}: {e}",
            )

        attachments = [
            {
                "filename": f"PayApp_{project.get('project_no','')}_{existing['period']}_G702.pdf",
                "url": pdf_meta["download_url"],
            },
            {
                "filename": f"PayApp_{project.get('project_no','')}_{existing['period']}_G703.xlsx",
                "url": excel_meta["download_url"],
            },
        ]

        sender = _load_user(sb, user.id) or {"id": user.id, "email": user.email,
                                             "full_name": user.full_name}
        try:
            email_result = email_svc.email_pay_app_to_gc(
                pa=existing, project=project, sender=sender,
                attachments=attachments,
            )
        except Exception as e:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Could not send email to GC: {type(e).__name__}: {e}",
            )

    now = datetime.now(timezone.utc).isoformat()
    update_payload = {
        "status": "submitted",
        "submitted_at": now,                # keep legacy field in sync
        "submitted_by": user.id,
        "sent_to_gc_at": now,
        "sent_to_gc_by": user.id,
        "sent_to_gc_email": gc_email,       # NULL for manual-portal submissions
    }
    res = sb.table("pay_apps").update(update_payload).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "sent_to_gc",
              before=existing, after=pa,
              metadata={
                  "gc_email": gc_email,
                  "manual": gc_email is None,
                  "email_outbox_id": (email_result or {}).get("outbox_id"),
                  "email_status": (email_result or {}).get("status"),
              })
    return pa


@router.post("/{pay_app_id}/unsend", response_model=PayApp)
def unsend_pay_app(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """submitted → approved. Moves the pay app back to the 'approved' state
    if it was clicked send-to-gc by mistake or the GC asked to resubmit.

    The email (if one was sent) is already in the GC's inbox — this endpoint
    only fixes the in-app state, it can't unsend the email. Caller should
    follow up with the GC out-of-band if needed.
    """
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "submitted":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Pay app is {existing['status']}; only submitted pay apps can be moved back to approved.",
        )

    res = sb.table("pay_apps").update({
        "status": "approved",
        # Clear send-to-GC markers so the accountant can resend cleanly.
        "sent_to_gc_at": None,
        "sent_to_gc_by": None,
        "sent_to_gc_email": None,
        # Keep the legacy submitted_at/submitted_by — they're audit-only and
        # never displayed once the new workflow took over.
    }).eq("id", str(pay_app_id)).execute()
    pa = res.data[0]

    audit.log(user.id, "pay_app", str(pay_app_id), "unsent",
              before=existing, after=pa,
              metadata={"prior_sent_to_gc_email": existing.get("sent_to_gc_email")})
    return pa


@router.post("/{pay_app_id}/mark-paid", response_model=PayApp)
def mark_pay_app_paid(
    pay_app_id: UUID,
    body: PayAppMarkPaidBody,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """submitted → paid. Records the actual amount received."""
    sb = get_service_client()
    existing = _load_pay_app_or_404(sb, pay_app_id)
    if existing["status"] != "submitted":
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Only submitted pay apps can be marked paid")
    res = sb.table("pay_apps").update({
        "status": "paid",
        "paid_at": datetime.now(timezone.utc).isoformat(),
        "paid_amount": str(body.paid_amount),
    }).eq("id", str(pay_app_id)).execute()
    audit.log(user.id, "pay_app", str(pay_app_id), "marked_paid",
              before=existing, after=res.data[0],
              metadata={"paid_amount": str(body.paid_amount)})
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
