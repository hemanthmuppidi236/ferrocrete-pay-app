"""
Supabase Storage helpers.

We use 3 buckets:
  - pay-apps          (generated .xlsx and .pdf files for pay applications)
  - release-trackers  (generated .xlsx files for release trackers)
  - waivers           (uploaded signed waiver PDFs from subs)

Path conventions:
  pay-apps/{period}/{project_id}/{filename}.xlsx
  pay-apps/{period}/{project_id}/{filename}.pdf
  release-trackers/{period}/{project_id}/{filename}.xlsx
  waivers/{tracker_id}/{waiver_type}/{filename}
"""

from datetime import datetime
from pathlib import Path
from typing import Optional
from .supabase_client import get_service_client
from .config import settings


def upload_bytes(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
    upsert: bool = True,
) -> str:
    """Upload bytes to a bucket. Returns the storage path."""
    sb = get_service_client()
    # storage3 client requires file_options as dict of strings
    file_options = {"content-type": content_type, "upsert": "true" if upsert else "false"}
    sb.storage.from_(bucket).upload(path, data, file_options=file_options)
    return path


def signed_url(bucket: str, path: str, expires_in: int = 3600) -> str:
    """Get a signed download URL valid for `expires_in` seconds (default 1hr)."""
    sb = get_service_client()
    res = sb.storage.from_(bucket).create_signed_url(path, expires_in)
    # supabase-py returns dict {"signedURL": "..."}
    return res.get("signedURL") or res.get("signed_url") or ""


def delete_object(bucket: str, path: str) -> None:
    sb = get_service_client()
    sb.storage.from_(bucket).remove([path])


def download_bytes(bucket: str, path: str) -> bytes:
    """Download a stored object as bytes. Used for email attachments."""
    sb = get_service_client()
    return sb.storage.from_(bucket).download(path)


def make_pay_app_excel_path(period: str, project_no: str, project_name: str) -> str:
    safe = _safe(project_name)
    return f"{period}/{project_no}_{safe}_-_{period}.xlsx"


def make_pay_app_pdf_path(period: str, project_no: str, project_name: str) -> str:
    safe = _safe(project_name)
    return f"{period}/{project_no}_{safe}_-_{period}.pdf"


def make_release_tracker_path(period: str, project_no: str, project_name: str) -> str:
    safe = _safe(project_name)
    return f"{period}/{project_no}_{safe}_-_{period}_Release_Tracker.xlsx"


def make_waiver_path(tracker_id: str, waiver_type: str, original_filename: str) -> str:
    # Sanitize filename — keep extension, prefix with timestamp to avoid collisions
    p = Path(original_filename)
    stem = _safe(p.stem)
    ext = p.suffix.lower() or ".bin"
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return f"{tracker_id}/{waiver_type}/{ts}_{stem}{ext}"


def _safe(s: str) -> str:
    """Sanitize a string for use as a path segment."""
    import re
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s)[:80]
