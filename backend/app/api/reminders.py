"""
Release reminder emails (WI-3). Reuses core/email.py for transport and logs a
per-line row to release_line_reminders for the tracker's "last emailed" note.

  POST /release-trackers/{id}/reminders/preview   compose subject/body + recipients
  POST /release-trackers/{id}/reminders/send       send to each line with an email
"""

from datetime import date, timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from uuid import UUID
from pydantic import BaseModel

from ..core.auth import CurrentUser, require_role
from ..core.supabase_client import get_service_client
from ..core import audit, email as email_svc
from ..core import reminder_templates as tpl

router = APIRouter(tags=["reminders"])


# ─── schemas ──────────────────────────────────────────────────────────

class ReminderPreviewRequest(BaseModel):
    template_key: str
    line_ids: List[UUID]


class ReminderRecipient(BaseModel):
    release_line_id: UUID
    sub_name: Optional[str] = None
    to: Optional[str] = None
    cc: Optional[str] = None
    has_email: bool


class ReminderPreviewResponse(BaseModel):
    template_key: str
    subject: str
    body: str
    recipients: List[ReminderRecipient]
    skipped: List[ReminderRecipient]


class ReminderSendRequest(BaseModel):
    template_key: str
    line_ids: List[UUID]
    subject: str
    body: str


class ReminderSendResponse(BaseModel):
    sent: int
    skipped: int
    failures: List[dict] = []


VALID = {"request_bill_cpcf", "cpcf_overdue", "request_upuf", "upuf_overdue"}


def _sub_email(sub: dict) -> Optional[str]:
    return (sub.get("billing_email") or sub.get("contact_email") or "").strip() or None


def _load_context(sb, tracker_id: str):
    """Return (tracker, project, {line_id: {line, sub}}) or raise 404."""
    rt = (sb.table("release_trackers").select("*")
          .eq("id", tracker_id).limit(1).execute())
    if not rt.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release tracker not found")
    tracker = rt.data[0]
    proj = (sb.table("projects")
            .select("name, project_no, grace_days")
            .eq("id", tracker["project_id"]).limit(1).execute())
    project = proj.data[0] if proj.data else {}
    return tracker, project


def _load_lines(sb, tracker_id: str, line_ids):
    res = (sb.table("release_lines")
           .select("*, subs(name, billing_email, contact_email, billing_cc)")
           .eq("release_tracker_id", tracker_id)
           .in_("id", [str(x) for x in line_ids]).execute())
    out = []
    for ln in (res.data or []):
        sub = ln.pop("subs", None) or {}
        out.append((ln, sub))
    return out


def _sender_name(sb, user: CurrentUser) -> str:
    try:
        r = (sb.table("app_users").select("full_name, name, email")
             .eq("id", user.id).limit(1).execute())
        if r.data:
            u = r.data[0]
            return (u.get("full_name") or u.get("name") or u.get("email")
                    or "the Ferrocrete team")
    except Exception:
        pass
    return "the Ferrocrete team"


def _ctx(tracker, project, sender_name, sub_name=None):
    return {
        "project_name": project.get("name", ""),
        "project_no": project.get("project_no", ""),
        "period": tracker.get("period", ""),
        "conditional_through_date": tracker.get("conditional_through_date"),
        "sender_name": sender_name,
        "sub_name": sub_name,
    }


@router.post("/release-trackers/{tracker_id}/reminders/preview",
             response_model=ReminderPreviewResponse)
def preview_reminders(
    tracker_id: UUID,
    body: ReminderPreviewRequest,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    if body.template_key not in VALID:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown template")
    sb = get_service_client()
    tracker, project = _load_context(sb, str(tracker_id))
    lines = _load_lines(sb, str(tracker_id), body.line_ids)
    sender = _sender_name(sb, user)

    # Fill {sub} only when a single line is targeted; otherwise keep the token.
    single_sub = lines[0][1].get("name") if len(lines) == 1 else None
    composed = tpl.build_reminder(body.template_key, _ctx(tracker, project, sender, single_sub))

    recipients, skipped = [], []
    for ln, sub in lines:
        to = _sub_email(sub)
        rec = ReminderRecipient(
            release_line_id=ln["id"], sub_name=sub.get("name"),
            to=to, cc=(sub.get("billing_cc") or None), has_email=bool(to),
        )
        (recipients if to else skipped).append(rec)

    return ReminderPreviewResponse(
        template_key=body.template_key,
        subject=composed["subject"], body=composed["body"],
        recipients=recipients, skipped=skipped,
    )


@router.post("/release-trackers/{tracker_id}/reminders/send",
             response_model=ReminderSendResponse)
def send_reminders(
    tracker_id: UUID,
    body: ReminderSendRequest,
    user: CurrentUser = Depends(require_role("admin", "accountant", "pe")),
):
    if body.template_key not in VALID:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown template")
    sb = get_service_client()
    tracker, project = _load_context(sb, str(tracker_id))
    lines = _load_lines(sb, str(tracker_id), body.line_ids)

    advances = tpl.ADVANCES.get(body.template_key)
    grace = int(project.get("grace_days") or 14)
    today = date.today()
    sent, skipped, failures = 0, 0, []

    for ln, sub in lines:
        to = _sub_email(sub)
        if not to:
            skipped += 1
            continue

        sub_name = sub.get("name") or "there"
        subject = tpl.personalize(body.subject, sub_name)
        text = tpl.personalize(body.body, sub_name)
        cc = [sub["billing_cc"]] if sub.get("billing_cc") else None

        res = email_svc.send_email(
            to=to, subject=subject,
            body_html=tpl.text_to_html(text), body_text=text, cc=cc,
            related_entity_type="release_line", related_entity_id=str(ln["id"]),
            created_by=user.id,
        )
        if res.get("status") == "failed":
            failures.append({"release_line_id": str(ln["id"]),
                             "error": res.get("error")})
            continue
        sent += 1

        # Per-line reminder log (for the "last emailed" note).
        recipients = ", ".join([to] + (cc or []))
        sb.table("release_line_reminders").insert({
            "release_line_id": ln["id"],
            "release_tracker_id": str(tracker_id),
            "template_key": body.template_key,
            "recipients": recipients,
            "email_outbox_id": res.get("outbox_id"),
            "sent_by": user.id,
        }).execute()

        # A "request" send advances the matching status to 'requested'.
        if advances == "bill" and (ln.get("bill_status") or "not_requested") == "not_requested":
            sb.table("release_lines").update({
                "bill_status": "requested",
                "bill_requested_at": today.isoformat(),
                "bill_due_at": (today + timedelta(days=grace)).isoformat(),
            }).eq("id", ln["id"]).execute()
        elif advances == "unconditional" and \
                (ln.get("unconditional_status") or "not_requested") == "not_requested":
            sb.table("release_lines").update({
                "unconditional_status": "requested",
                "unconditional_requested_at": today.isoformat(),
            }).eq("id", ln["id"]).execute()

    audit.log(user.id, "release_tracker", str(tracker_id), "reminders_sent",
              metadata={"template": body.template_key, "sent": sent, "skipped": skipped})
    return ReminderSendResponse(sent=sent, skipped=skipped, failures=failures)
