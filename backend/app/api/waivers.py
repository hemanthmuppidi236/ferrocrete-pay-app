"""
Waivers API. Upload signed waiver PDFs from subs, list them, get download URLs.

  POST   /release-lines/{id}/waivers           upload waiver file (multipart)
  GET    /release-lines/{id}/waivers           list waivers for a release line
  GET    /waivers/{id}/download-url            signed download URL
  DELETE /waivers/{id}                         remove waiver

  GET    /release-trackers/{id}/waivers        list all waivers for a tracker
"""

from datetime import date
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from typing import List, Optional
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit, storage as storage_helpers
from ..core.config import settings
from ..schemas.releases import Waiver

router = APIRouter(tags=["waivers"])


@router.post("/release-lines/{release_line_id}/waivers", response_model=Waiver)
async def upload_waiver(
    release_line_id: UUID,
    waiver_type: str = Form(..., pattern="^(CP|UP|CF|UF)$"),
    received_at: Optional[date] = Form(None),
    notes: Optional[str] = Form(None),
    file: UploadFile = File(...),
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()

    # Verify release line exists
    rl = sb.table("release_lines").select("*, release_trackers(id)").eq("id", str(release_line_id)).limit(1).execute()
    if not rl.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release line not found")
    tracker_id = rl.data[0]["release_trackers"]["id"]

    # Read file bytes
    file_bytes = await file.read()
    if len(file_bytes) > 25 * 1024 * 1024:    # 25MB cap
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (max 25MB)")

    # Upload to storage
    storage_path = storage_helpers.make_waiver_path(
        tracker_id, waiver_type, file.filename or f"waiver.{waiver_type}.pdf",
    )
    storage_helpers.upload_bytes(
        settings.bucket_waivers,
        storage_path,
        file_bytes,
        content_type=file.content_type or "application/pdf",
    )

    # Insert / upsert waiver record
    payload = {
        "release_line_id": str(release_line_id),
        "waiver_type": waiver_type,
        "file_path": storage_path,
        "file_name": file.filename or "waiver.pdf",
        "file_size_bytes": len(file_bytes),
        "mime_type": file.content_type,
        "received_at": received_at.isoformat() if received_at else None,
        "uploaded_by": user.id,
        "notes": notes,
    }
    # Upsert by unique (release_line_id, waiver_type)
    existing = (sb.table("waivers")
                .select("id, file_path")
                .eq("release_line_id", str(release_line_id))
                .eq("waiver_type", waiver_type).limit(1).execute())
    if existing.data:
        # Delete old file in storage, then update record
        old_path = existing.data[0]["file_path"]
        try:
            storage_helpers.delete_object(settings.bucket_waivers, old_path)
        except Exception:
            pass    # not fatal
        res = sb.table("waivers").update(payload).eq("id", existing.data[0]["id"]).execute()
    else:
        res = sb.table("waivers").insert(payload).execute()

    waiver = res.data[0]
    audit.log(user.id, "waiver", waiver["id"], "uploaded",
              after=waiver,
              metadata={"release_line_id": str(release_line_id), "waiver_type": waiver_type})
    return waiver


@router.get("/release-lines/{release_line_id}/waivers", response_model=List[Waiver])
def list_waivers_for_line(
    release_line_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    res = sb.table("waivers").select("*").eq("release_line_id", str(release_line_id)).execute()
    return res.data


@router.get("/release-trackers/{tracker_id}/waivers", response_model=List[Waiver])
def list_waivers_for_tracker(
    tracker_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    """List all waivers across all release lines in a tracker."""
    sb = get_service_client()
    # Get all release line ids for this tracker
    rl = sb.table("release_lines").select("id").eq("release_tracker_id", str(tracker_id)).execute()
    if not rl.data:
        return []
    line_ids = [r["id"] for r in rl.data]
    res = sb.table("waivers").select("*").in_("release_line_id", line_ids).execute()
    return res.data


@router.get("/waivers/{waiver_id}/download-url")
def get_waiver_download_url(
    waiver_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    w = sb.table("waivers").select("file_path").eq("id", str(waiver_id)).limit(1).execute()
    if not w.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Waiver not found")
    url = storage_helpers.signed_url(settings.bucket_waivers, w.data[0]["file_path"])
    return {"download_url": url}


@router.delete("/waivers/{waiver_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_waiver(
    waiver_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("waivers").select("*").eq("id", str(waiver_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Waiver not found")
    # Remove from storage
    try:
        storage_helpers.delete_object(settings.bucket_waivers, existing.data[0]["file_path"])
    except Exception:
        pass
    sb.table("waivers").delete().eq("id", str(waiver_id)).execute()
    audit.log(user.id, "waiver", str(waiver_id), "deleted", before=existing.data[0])
