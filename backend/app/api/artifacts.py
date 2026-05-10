"""
Artifacts API.

Endpoints for generating and downloading the Excel/PDF artifacts for pay apps
and release trackers.

  POST /pay-apps/{id}/generate-excel       generate (or regenerate) the .xlsx
  POST /pay-apps/{id}/generate-pdf         generate (or regenerate) the .pdf
  GET  /pay-apps/{id}/excel-url            signed URL for the existing .xlsx
  GET  /pay-apps/{id}/pdf-url              signed URL for the existing .pdf

  POST /release-trackers/{id}/generate-excel
  GET  /release-trackers/{id}/excel-url
"""

from fastapi import APIRouter, Depends, HTTPException, status
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit, storage as storage_helpers
from ..core.config import settings
from ..core.excel_pay_app import generate_and_store_pay_app_excel
from ..core.pdf_pay_app import generate_and_store_pay_app_pdf
from ..core.excel_release_tracker import generate_and_store_release_tracker_excel
from ..schemas.pay_apps import GeneratedFile

router = APIRouter(tags=["artifacts"])


# ─── PAY APP ARTIFACTS ────────────────────────────────────────────────

@router.post("/pay-apps/{pay_app_id}/generate-excel", response_model=GeneratedFile)
def generate_pay_app_excel_endpoint(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    try:
        result = generate_and_store_pay_app_excel(str(pay_app_id))
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except Exception as e:
        # Surface unexpected errors so the client sees what went wrong
        import traceback
        tb = traceback.format_exc()
        print(f"[generate-excel] unexpected error: {e}\n{tb}", flush=True)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"{type(e).__name__}: {e}",
        )
    audit.log(user.id, "pay_app", str(pay_app_id), "excel_generated",
              metadata={"file_path": result["file_path"]})
    return result


@router.post("/pay-apps/{pay_app_id}/generate-pdf", response_model=GeneratedFile)
def generate_pay_app_pdf_endpoint(
    pay_app_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    try:
        result = generate_and_store_pay_app_pdf(str(pay_app_id))
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[generate-pdf] unexpected error: {e}\n{tb}", flush=True)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"{type(e).__name__}: {e}",
        )
    audit.log(user.id, "pay_app", str(pay_app_id), "pdf_generated",
              metadata={"file_path": result["file_path"]})
    return result


@router.get("/pay-apps/{pay_app_id}/excel-url")
def get_pay_app_excel_url(
    pay_app_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    pa = sb.table("pay_apps").select("excel_file_path").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa.data or not pa.data[0].get("excel_file_path"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Excel file not generated yet")
    url = storage_helpers.signed_url(settings.bucket_pay_apps, pa.data[0]["excel_file_path"])
    return {"download_url": url}


@router.get("/pay-apps/{pay_app_id}/pdf-url")
def get_pay_app_pdf_url(
    pay_app_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    pa = sb.table("pay_apps").select("pdf_file_path").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa.data or not pa.data[0].get("pdf_file_path"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF not generated yet")
    url = storage_helpers.signed_url(settings.bucket_pay_apps, pa.data[0]["pdf_file_path"])
    return {"download_url": url}


# ─── RELEASE TRACKER ARTIFACTS ────────────────────────────────────────

@router.post("/release-trackers/{tracker_id}/generate-excel", response_model=GeneratedFile)
def generate_release_tracker_excel_endpoint(
    tracker_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    try:
        result = generate_and_store_release_tracker_excel(str(tracker_id))
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    audit.log(user.id, "release_tracker", str(tracker_id), "excel_generated",
              metadata={"file_path": result["file_path"]})
    return result


@router.get("/release-trackers/{tracker_id}/excel-url")
def get_release_tracker_excel_url(
    tracker_id: UUID,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    rt = sb.table("release_trackers").select("excel_file_path").eq("id", str(tracker_id)).limit(1).execute()
    if not rt.data or not rt.data[0].get("excel_file_path"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Excel file not generated yet")
    url = storage_helpers.signed_url(settings.bucket_release_trackers, rt.data[0]["excel_file_path"])
    return {"download_url": url}
