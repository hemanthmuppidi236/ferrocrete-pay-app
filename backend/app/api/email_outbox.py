"""
Email outbox API. Phase 1 only queues emails; Phase 2 wires SMTP/Resend send.

  POST   /email/queue                queue an email
  GET    /email                      list queued/sent emails (filterable by status)
  POST   /email/{id}/cancel          mark a pending email as failed (cancel before send)
"""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr
from typing import List, Optional
from uuid import UUID

from ..core.auth import CurrentUser, get_current_user, require_role
from ..core.supabase_client import get_service_client
from ..core import audit

router = APIRouter(prefix="/email", tags=["email"])


class EmailAttachment(BaseModel):
    path: str             # storage path (e.g., "pay-apps/26-05/seagaze.pdf")
    bucket: str           # which storage bucket
    name: str             # filename for the email attachment


class EmailQueueRequest(BaseModel):
    to_email: EmailStr
    cc_emails: Optional[List[EmailStr]] = None
    bcc_emails: Optional[List[EmailStr]] = None
    subject: str
    body_html: str
    body_text: Optional[str] = None
    attachments: Optional[List[EmailAttachment]] = None
    related_entity_type: Optional[str] = None
    related_entity_id: Optional[UUID] = None


class EmailRecord(BaseModel):
    id: UUID
    to_email: str
    cc_emails: Optional[List[str]] = None
    bcc_emails: Optional[List[str]] = None
    subject: str
    status: str
    sent_at: Optional[datetime] = None
    failed_at: Optional[datetime] = None
    failure_reason: Optional[str] = None
    retries: int
    related_entity_type: Optional[str] = None
    related_entity_id: Optional[UUID] = None
    created_by: Optional[UUID] = None
    created_at: datetime


@router.post("/queue", response_model=EmailRecord)
def queue_email(
    body: EmailQueueRequest,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    payload = {
        "to_email": body.to_email,
        "cc_emails": body.cc_emails,
        "bcc_emails": body.bcc_emails,
        "subject": body.subject,
        "body_html": body.body_html,
        "body_text": body.body_text,
        "attachments": [a.model_dump() for a in body.attachments] if body.attachments else None,
        "related_entity_type": body.related_entity_type,
        "related_entity_id": str(body.related_entity_id) if body.related_entity_id else None,
        "created_by": user.id,
    }
    res = sb.table("email_outbox").insert(payload).execute()
    audit.log(user.id, "email", res.data[0]["id"], "queued",
              after=res.data[0],
              metadata={"to": body.to_email})
    return res.data[0]


@router.get("", response_model=List[EmailRecord])
def list_emails(
    status_filter: Optional[str] = Query(None, alias="status"),
    related_entity_type: Optional[str] = None,
    related_entity_id: Optional[UUID] = None,
    user: CurrentUser = Depends(get_current_user),
):
    sb = get_service_client()
    q = sb.table("email_outbox").select(
        "id, to_email, cc_emails, bcc_emails, subject, status, "
        "sent_at, failed_at, failure_reason, retries, "
        "related_entity_type, related_entity_id, created_by, created_at"
    )
    if status_filter:
        q = q.eq("status", status_filter)
    if related_entity_type:
        q = q.eq("related_entity_type", related_entity_type)
    if related_entity_id:
        q = q.eq("related_entity_id", str(related_entity_id))
    res = q.order("created_at", desc=True).limit(100).execute()
    return res.data


@router.post("/{email_id}/cancel", response_model=EmailRecord)
def cancel_email(
    email_id: UUID,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    sb = get_service_client()
    existing = sb.table("email_outbox").select("*").eq("id", str(email_id)).limit(1).execute()
    if not existing.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Email not found")
    if existing.data[0]["status"] != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only pending emails can be cancelled")
    res = sb.table("email_outbox").update({
        "status": "failed",
        "failed_at": datetime.now(timezone.utc).isoformat(),
        "failure_reason": "Cancelled by user",
    }).eq("id", str(email_id)).execute()
    audit.log(user.id, "email", str(email_id), "cancelled", before=existing.data[0])
    return res.data[0]
