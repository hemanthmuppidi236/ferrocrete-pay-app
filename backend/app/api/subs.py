"""
Subs API. Master list of subs per project. Used by release trackers.

  GET    /projects/{pid}/subs
  POST   /projects/{pid}/subs
  PATCH  /projects/{pid}/subs/{id}
  DELETE /projects/{pid}/subs/{id}
"""

from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..schemas.releases import Sub, SubCreate, SubUpdate

router = APIRouter(prefix="/projects/{project_id}/subs", tags=["subs"])


@router.get("", response_model=List[Sub])
def list_subs(
    project_id: UUID,
    include_inactive: bool = False,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    q = sb.table("subs").select("*").eq("project_id", str(project_id))
    if not include_inactive:
        q = q.eq("active", True)
    res = q.order("sort_order").order("name").execute()
    return res.data


@router.post("", response_model=Sub, status_code=status.HTTP_201_CREATED)
def create_sub(
    project_id: UUID,
    body: SubCreate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    payload = body.model_dump(mode="json")
    payload["project_id"] = str(project_id)

    # Validate parent_sub_id belongs to same project (if provided)
    if body.parent_sub_id:
        parent = sb.table("subs").select("project_id").eq("id", str(body.parent_sub_id)).limit(1).execute()
        if not parent.data or parent.data[0]["project_id"] != str(project_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "parent_sub_id must belong to same project")

    try:
        res = sb.table("subs").insert(payload).execute()
    except Exception as e:
        if "duplicate key" in str(e).lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "A sub with this name already exists")
        raise
    sub = res.data[0]
    audit.log(user.id, "sub", sub["id"], "created", after=sub,
              metadata={"project_id": str(project_id)})
    return sub


@router.patch("/{sub_id}", response_model=Sub)
def update_sub(
    project_id: UUID,
    sub_id: UUID,
    body: SubUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("subs").select("*").eq("id", str(sub_id)).limit(1).execute()
    if not existing.data or existing.data[0]["project_id"] != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sub not found")
    updates = body.model_dump(mode="json", exclude_unset=True)
    if not updates:
        return existing.data[0]
    res = sb.table("subs").update(updates).eq("id", str(sub_id)).execute()
    sub = res.data[0]
    audit.log(user.id, "sub", str(sub_id), "updated",
              before=existing.data[0], after=sub)
    return sub


@router.delete("/{sub_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sub(
    project_id: UUID,
    sub_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """Soft delete by setting active=False. Hard delete blocked if referenced
    by release_lines (would orphan release history)."""
    sb = get_service_client()
    existing = sb.table("subs").select("*").eq("id", str(sub_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sub not found")
    sb.table("subs").update({"active": False}).eq("id", str(sub_id)).execute()
    audit.log(user.id, "sub", str(sub_id), "deactivated", before=existing.data[0])
