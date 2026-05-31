"""
Email sending + outbox.

Every outgoing message is recorded in the `email_outbox` table for an audit
trail. When Resend is configured (RESEND_API_KEY set and EMAIL_PROVIDER=resend)
the message is also sent via the Resend HTTP API and the outbox row is marked
'sent' or 'failed'. Otherwise the row stays 'pending' and can be sent later
once a real provider is wired up.

Attachments are passed by signed URL — Resend fetches them itself, so we don't
have to base64-encode large files in the API request body.

This module is intentionally synchronous (no background worker). Volume is low
(a handful of notifications per pay app) and a 500ms send latency is fine.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

from .config import settings
from .supabase_client import get_service_client


log = logging.getLogger("ferrocrete.email")

_RESEND_URL = "https://api.resend.com/emails"


def _admin_emails(exclude: Optional[set[str]] = None) -> list[str]:
    """All non-deactivated admins. Used as the audience for approval requests."""
    sb = get_service_client()
    res = (sb.table("app_users")
           .select("email, deactivated_at")
           .eq("role", "admin")
           .execute())
    out = []
    for u in (res.data or []):
        if u.get("deactivated_at"):
            continue
        email = (u.get("email") or "").strip()
        if not email:
            continue
        if exclude and email.lower() in exclude:
            continue
        out.append(email)
    return out


def send_email(
    to: list[str] | str,
    subject: str,
    body_html: str,
    body_text: Optional[str] = None,
    cc: Optional[list[str]] = None,
    attachments: Optional[list[dict]] = None,
    related_entity_type: Optional[str] = None,
    related_entity_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> dict:
    """Send an email.

    Args:
        to:            recipient(s)
        subject:       plain text subject
        body_html:     HTML body
        body_text:     optional plain-text alternative
        cc:            optional cc recipients
        attachments:   list of {"filename": str, "url": str (signed)}
        related_entity_type/id: for audit linking ("pay_app", "<uuid>")
        created_by:    user id (UUID string) that initiated the send

    Returns:
        {"outbox_id": str, "status": "sent"|"pending"|"failed", "error": Optional[str]}
    """
    if isinstance(to, str):
        to = [to]
    to = [e for e in (to or []) if e]
    cc = [e for e in (cc or []) if e]
    if not to:
        log.warning("send_email: no recipients (subject=%r) — skipping", subject)
        return {"outbox_id": None, "status": "skipped",
                "error": "no recipients"}

    # ─── 1. Always record in the outbox first ───────────────────────────
    sb = get_service_client()
    outbox_payload = {
        "to_email": to[0],
        "cc_emails": (to[1:] + cc) or None,
        "subject": subject,
        "body_html": body_html,
        "body_text": body_text,
        "attachments": attachments,
        "related_entity_type": related_entity_type,
        "related_entity_id": related_entity_id,
        "created_by": created_by,
        "status": "pending",
    }
    outbox_res = sb.table("email_outbox").insert(outbox_payload).execute()
    outbox_id = outbox_res.data[0]["id"] if outbox_res.data else None

    # ─── 2. Actually send (if enabled) ──────────────────────────────────
    if not settings.email_enabled:
        log.info("email_enabled=False — queued only (outbox_id=%s, subject=%r)",
                 outbox_id, subject)
        return {"outbox_id": outbox_id, "status": "pending",
                "error": "email_provider is outbox_only"}

    try:
        body = {
            "from": settings.email_from,
            "to": to,
            "subject": subject,
            "html": body_html,
        }
        if cc:
            body["cc"] = cc
        if body_text:
            body["text"] = body_text
        if attachments:
            # Resend accepts {"filename": ..., "path": URL} for URL fetch
            body["attachments"] = [
                {"filename": a["filename"], "path": a["url"]}
                for a in attachments if a.get("url")
            ]

        with httpx.Client(timeout=30) as client:
            resp = client.post(
                _RESEND_URL,
                headers={
                    "Authorization": f"Bearer {settings.resend_api_key}",
                    "Content-Type": "application/json",
                },
                content=json.dumps(body),
            )
        if resp.status_code >= 300:
            raise RuntimeError(
                f"Resend returned {resp.status_code}: {resp.text[:300]}"
            )

        sb.table("email_outbox").update({
            "status": "sent",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", outbox_id).execute()
        return {"outbox_id": outbox_id, "status": "sent", "error": None}

    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        log.error("Resend send failed (outbox_id=%s): %s", outbox_id, err)
        try:
            sb.table("email_outbox").update({
                "status": "failed",
                "failed_at": datetime.now(timezone.utc).isoformat(),
                "failure_reason": err,
            }).eq("id", outbox_id).execute()
        except Exception:
            pass
        return {"outbox_id": outbox_id, "status": "failed", "error": err}


# ═══════════════════════════════════════════════════════════════════════
# Notification helpers — one per workflow event.
# Each builds the right body, audience, and attachments and calls send_email.
# ═══════════════════════════════════════════════════════════════════════


def _pay_app_link(project_id: str, period: str) -> str:
    return f"{settings.app_url.rstrip('/')}/projects/{project_id}/pay-apps/{period}"


def _money(s) -> str:
    try:
        from decimal import Decimal
        d = Decimal(str(s or 0))
        return f"${d:,.2f}"
    except Exception:
        return str(s)


def notify_submitted_for_approval(*, pa: dict, project: dict, submitter: dict) -> dict:
    """Accountant just hit 'Send for approval'. Email all admins."""
    to = _admin_emails()
    if not to:
        return {"status": "skipped", "error": "no admins configured"}

    link = _pay_app_link(project["id"], pa["period"])
    submitter_name = submitter.get("full_name") or submitter.get("email") or "An accountant"
    amount = _money(pa.get("current_payment_due"))
    subject = f"Approval needed: Pay app #{pa['app_no']} for {project['name']}"
    body_html = f"""
    <p>{submitter_name} submitted a pay application for your approval.</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Project</td>
          <td><b>{project['name']}</b> ({project.get('project_no','')})</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Pay app #</td>
          <td>{pa['app_no']}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Period</td>
          <td>{pa['period']}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Amount due</td>
          <td><b>{amount}</b></td></tr>
    </table>
    <p><a href="{link}">Review &amp; approve →</a></p>
    """.strip()
    return send_email(
        to=to,
        cc=[submitter.get("email")] if submitter.get("email") else None,
        subject=subject,
        body_html=body_html,
        related_entity_type="pay_app",
        related_entity_id=pa["id"],
        created_by=submitter.get("id"),
    )


def notify_approved(*, pa: dict, project: dict, submitter: dict, approver: dict) -> dict:
    """Raz just approved. Tell the submitter."""
    if not submitter.get("email"):
        return {"status": "skipped", "error": "submitter has no email"}
    link = _pay_app_link(project["id"], pa["period"])
    approver_name = approver.get("full_name") or approver.get("email") or "Admin"
    subject = f"Approved: Pay app #{pa['app_no']} for {project['name']}"
    body_html = f"""
    <p>{approver_name} approved pay app <b>#{pa['app_no']}</b> for
       <b>{project['name']}</b>. It's ready to send to the client.</p>
    <p><a href="{link}">Open the pay app →</a></p>
    """.strip()
    return send_email(
        to=[submitter["email"]],
        cc=[approver["email"]] if approver.get("email") else None,
        subject=subject,
        body_html=body_html,
        related_entity_type="pay_app",
        related_entity_id=pa["id"],
        created_by=approver.get("id"),
    )


def notify_rejected(*, pa: dict, project: dict, submitter: dict,
                    approver: dict, reason: str) -> dict:
    """Raz rejected. Tell the submitter with the reason."""
    if not submitter.get("email"):
        return {"status": "skipped", "error": "submitter has no email"}
    link = _pay_app_link(project["id"], pa["period"])
    approver_name = approver.get("full_name") or approver.get("email") or "Admin"
    safe_reason = (reason or "(no reason provided)").strip()
    subject = f"Revisions needed: Pay app #{pa['app_no']} for {project['name']}"
    body_html = f"""
    <p>{approver_name} sent pay app <b>#{pa['app_no']}</b> for
       <b>{project['name']}</b> back for revision.</p>
    <p><b>Reason:</b></p>
    <blockquote style="border-left:3px solid #d53b34;margin:8px 0;padding:6px 12px;
                     background:#fbeae8;color:#333;white-space:pre-wrap">{safe_reason}</blockquote>
    <p><a href="{link}">Open and revise →</a></p>
    """.strip()
    return send_email(
        to=[submitter["email"]],
        cc=[approver["email"]] if approver.get("email") else None,
        subject=subject,
        body_html=body_html,
        related_entity_type="pay_app",
        related_entity_id=pa["id"],
        created_by=approver.get("id"),
    )


def email_pay_app_to_gc(
    *,
    pa: dict,
    project: dict,
    sender: dict,
    attachments: list[dict],
) -> dict:
    """Email the pay app (with G702 PDF + G703 Excel) to the GC contact.

    Caller is responsible for ensuring project['gc_contact_email'] is set
    (we double-check here and skip if not).
    """
    gc_email = (project.get("gc_contact_email") or "").strip()
    if not gc_email:
        return {"status": "skipped", "error": "project has no GC contact email"}

    gc_name = project.get("gc_contact_name") or "there"
    amount = _money(pa.get("current_payment_due"))
    period_to = pa.get("period_to") or pa.get("period")
    subject = f"Pay application #{pa['app_no']} — {project['name']} — period ending {period_to}"
    body_html = f"""
    <p>Hi {gc_name},</p>
    <p>Please find attached pay application <b>#{pa['app_no']}</b> for
       <b>{project['name']}</b>, period ending {period_to}.</p>
    <p>Total amount due this period: <b>{amount}</b>.</p>
    <p>Please let us know if you have any questions.</p>
    <p>Thanks,<br/>Ferrocrete Builders</p>
    """.strip()

    cc = []
    if sender.get("email"):
        cc.append(sender["email"])
    # also cc all admins so Raz has a record
    for a in _admin_emails(exclude={sender.get("email", "").lower()}):
        if a not in cc:
            cc.append(a)

    return send_email(
        to=[gc_email],
        cc=cc,
        subject=subject,
        body_html=body_html,
        attachments=attachments,
        related_entity_type="pay_app",
        related_entity_id=pa["id"],
        created_by=sender.get("id"),
    )
