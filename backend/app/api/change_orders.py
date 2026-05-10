"""
Change Orders API.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..schemas.projects import ChangeOrder, ChangeOrderCreate, ChangeOrderUpdate

router = APIRouter(prefix="/projects/{project_id}/change-orders", tags=["change_orders"])


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
    audit.log(user.id, "change_order", co["id"], "created", after=co,
              metadata={"project_id": str(project_id)})
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
    updates = body.model_dump(mode="json", exclude_unset=True)
    if not updates:
        return existing.data[0]
    res = sb.table("change_orders").update(updates).eq("id", str(co_id)).execute()
    co = res.data[0]
    audit.log(user.id, "change_order", str(co_id), "updated",
              before=existing.data[0], after=co)
    return co


@router.delete("/{co_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_change_order(
    project_id: UUID,
    co_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    sb = get_service_client()
    existing = sb.table("change_orders").select("*").eq("id", str(co_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Change order not found")
    sb.table("change_orders").delete().eq("id", str(co_id)).execute()
    audit.log(user.id, "change_order", str(co_id), "deleted", before=existing.data[0])
