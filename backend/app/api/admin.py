"""
Admin-only maintenance endpoints.

  POST /admin/recompute-pay-apps    recompute totals for every pay app
"""

from fastapi import APIRouter, Depends, HTTPException, status
from typing import Optional

from ..core.auth import CurrentUser, require_role
from ..core.supabase_client import get_service_client
from ..core.pay_app_math import save_pay_app_totals

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/recompute-pay-apps")
def recompute_pay_apps(
    project_id: Optional[str] = None,
    user: CurrentUser = Depends(require_role("admin")),
):
    """Recompute denormalized totals (including previous_certificates) for every
    pay app. Use after a math change to heal stored values.

    Optional `project_id` query param scopes the recompute to one project.
    Returns per-app results so the caller can see which (if any) failed.
    """
    sb = get_service_client()
    q = sb.table("pay_apps").select("id, project_id, period, app_no")
    if project_id:
        q = q.eq("project_id", project_id)
    rows = q.execute().data or []

    results = []
    failures = 0
    for r in rows:
        try:
            save_pay_app_totals(r["id"])
            results.append({"id": r["id"], "period": r["period"], "ok": True})
        except Exception as e:
            failures += 1
            results.append({
                "id": r["id"],
                "period": r["period"],
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
            })

    return {
        "total": len(rows),
        "succeeded": len(rows) - failures,
        "failed": failures,
        "results": results,
    }
