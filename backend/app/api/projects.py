"""
Projects API.

Endpoints:
  GET    /projects                  list active projects
  GET    /projects/{id}             one project (with totals)
  POST   /projects                  create project
  PATCH  /projects/{id}             update project
  DELETE /projects/{id}             soft-delete (sets deleted_at)
"""

from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..schemas.projects import Project, ProjectCreate, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=List[Project])
def list_projects(
    status_filter: str = "active",
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    q = sb.table("projects").select("*").is_("deleted_at", None)
    if status_filter != "all":
        q = q.eq("status", status_filter)
    res = q.order("project_no", desc=False).execute()
    return res.data


@router.get("/{project_id}", response_model=Project)
def get_project(
    project_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    res = sb.table("projects").select("*").eq("id", str(project_id)).limit(1).execute()
    if not res.data or res.data[0].get("deleted_at"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return res.data[0]


@router.post("", response_model=Project, status_code=status.HTTP_201_CREATED)
def create_project(
    body: ProjectCreate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    payload = body.model_dump(mode="json")
    payload["created_by"] = user.id

    try:
        res = sb.table("projects").insert(payload).execute()
    except Exception as e:
        # 23505 is Postgres unique violation — surface a friendly error
        if "duplicate key" in str(e).lower():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"Project number '{body.project_no}' already exists")
        raise

    project = res.data[0]
    audit.log(user.id, "project", project["id"], "created", after=project)
    return project


@router.patch("/{project_id}", response_model=Project)
def update_project(
    project_id: UUID,
    body: ProjectUpdate,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()

    # Fetch existing for audit
    existing = sb.table("projects").select("*").eq("id", str(project_id)).limit(1).execute()
    if not existing.data or existing.data[0].get("deleted_at"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

    updates = body.model_dump(mode="json", exclude_unset=True)

    # Lock fields that, if changed mid-project, would silently corrupt all
    # historical pay-app math. The proper way to change the contract amount
    # is a change order; retention can drop via retention_drops_at_50_pct.
    LOCKED_FIELDS = {"contract_value", "retention_rate"}
    rejected = LOCKED_FIELDS & updates.keys()
    if rejected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"These fields are locked after project creation: {', '.join(sorted(rejected))}. "
            f"To change the contract amount, add a change order. To change retention "
            f"behavior mid-project, use the 'retention_drops_at_50_pct' flag."
        )

    if not updates:
        return existing.data[0]

    res = sb.table("projects").update(updates).eq("id", str(project_id)).execute()
    project = res.data[0]
    audit.log(user.id, "project", str(project_id), "updated",
              before=existing.data[0], after=project)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: UUID,
    user: CurrentUser = Depends(require_role("admin")),
):
    """Soft-delete (sets deleted_at). Hard delete is admin-only via SQL."""
    from datetime import datetime, timezone
    sb = get_service_client()

    existing = sb.table("projects").select("*").eq("id", str(project_id)).limit(1).execute()
    if not existing.data or existing.data[0].get("deleted_at"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")

    sb.table("projects").update({
        "deleted_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", str(project_id)).execute()

    audit.log(user.id, "project", str(project_id), "deleted", before=existing.data[0])
