"""
SOV lines API. Nested under projects.

  GET   /projects/{pid}/sov-lines
  POST  /projects/{pid}/sov-lines
  PATCH /projects/{pid}/sov-lines/{id}
  DELETE /projects/{pid}/sov-lines/{id}
  PUT   /projects/{pid}/sov-lines              # bulk replace (for SOV editor save)
"""

from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..schemas.projects import SOVLine, SOVLineCreate, SOVLineUpdate

router = APIRouter(prefix="/projects/{project_id}/sov-lines", tags=["sov_lines"])


@router.get("", response_model=List[SOVLine])
def list_sov_lines(project_id: UUID, user: CurrentUser = Depends(get_current_user)):
    sb = get_service_client()
    res = sb.table("sov_lines").select("*").eq("project_id", str(project_id)).order("sort_order").execute()
    return res.data


@router.post("", response_model=SOVLine, status_code=status.HTTP_201_CREATED)
def create_sov_line(
    project_id: UUID,
    body: SOVLineCreate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    payload = body.model_dump(mode="json")
    payload["project_id"] = str(project_id)
    res = sb.table("sov_lines").insert(payload).execute()
    line = res.data[0]
    audit.log(user.id, "sov_line", line["id"], "created", after=line,
              metadata={"project_id": str(project_id)})
    return line


@router.patch("/{line_id}", response_model=SOVLine)
def update_sov_line(
    project_id: UUID,
    line_id: UUID,
    body: SOVLineUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("sov_lines").select("*").eq("id", str(line_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SOV line not found")
    if existing.data[0]["project_id"] != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SOV line not in this project")

    updates = body.model_dump(mode="json", exclude_unset=True)
    if not updates:
        return existing.data[0]
    res = sb.table("sov_lines").update(updates).eq("id", str(line_id)).execute()
    line = res.data[0]
    audit.log(user.id, "sov_line", str(line_id), "updated",
              before=existing.data[0], after=line)
    return line


@router.delete("/{line_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sov_line(
    project_id: UUID,
    line_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("sov_lines").select("*").eq("id", str(line_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SOV line not found")
    sb.table("sov_lines").delete().eq("id", str(line_id)).execute()
    audit.log(user.id, "sov_line", str(line_id), "deleted", before=existing.data[0])


@router.put("", response_model=List[SOVLine])
def bulk_replace_sov_lines(
    project_id: UUID,
    lines: List[SOVLineCreate],
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    """Replace the entire SOV for a project. Used by the SOV editor 'Save' button.
    Existing pay app billings reference SOV lines by id — only safe to call before
    the first pay app is submitted, OR when keeping ids stable.

    For now: this endpoint deletes-and-recreates. The frontend should use
    individual PATCH/POST/DELETE endpoints for ongoing edits to preserve ids.
    """
    sb = get_service_client()
    # Check: are there pay apps? If so, refuse bulk replace (would orphan billings).
    pa = sb.table("pay_apps").select("id").eq("project_id", str(project_id)).limit(1).execute()
    if pa.data:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cannot bulk-replace SOV after pay apps exist. Use individual line edits.",
        )
    sb.table("sov_lines").delete().eq("project_id", str(project_id)).execute()
    if lines:
        payload = [{**ln.model_dump(mode="json"), "project_id": str(project_id)}
                   for ln in lines]
        res = sb.table("sov_lines").insert(payload).execute()
        audit.log(user.id, "sov_line", str(project_id), "bulk_replaced",
                  metadata={"count": len(payload)})
        return res.data
    return []
