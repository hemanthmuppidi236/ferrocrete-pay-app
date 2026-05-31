"""
Email sending + outbox.

Every outgoing message is recorded in the `email_outbox` table for an audit
trail. When Gmail API is configured (EMAIL_PROVIDER=gmail_api and the four
GMAIL_OAUTH_* env vars set) the message is also sent via the Gmail HTTP API
and the outbox row is marked 'sent' or 'failed'. Otherwise the row stays
'pending' and can be sent later once credentials are wired up.

Why Gmail API instead of SMTP:
  - Render blocks outbound SMTP (ports 25/465/587) on all plans to prevent
    abuse. Gmail's HTTP API uses port 443 (always allowed).
  - We already have Google Workspace for @ferrocretebuilders.com mail.
  - OAuth single-user mode means no Workspace admin involvement —
    one user clicks "Allow" once, and the refresh token works indefinitely.

Attachments are passed by signed URL — we fetch the bytes via httpx and
embed them as MIME parts in the outgoing message. This keeps the API
contract clean (callers don't need to know about the underlying transport).

This module is intentionally synchronous (no background worker). Volume is
low (a handful of notifications per pay app) and ~1s send latency is fine.
"""

from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr
from typing import Optional

import httpx

from .config import settings
from .supabase_client import get_service_client


log = logging.getLogger("ferrocrete.email")

# Minimum scope: just send. We never read or modify the inbox.
_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


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
        body_text:     optional plain-text alternative (auto-derived if omitted)
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
                "error": "Gmail OAuth credentials not configured"}

    try:
        msg = _build_message(
            to=to, cc=cc, subject=subject,
            body_html=body_html, body_text=body_text,
            attachments=attachments,
        )
        _send_via_gmail_api(msg)

        sb.table("email_outbox").update({
            "status": "sent",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", outbox_id).execute()
        return {"outbox_id": outbox_id, "status": "sent", "error": None}

    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        log.error("Gmail send failed (outbox_id=%s): %s", outbox_id, err)
        try:
            sb.table("email_outbox").update({
                "status": "failed",
                "failed_at": datetime.now(timezone.utc).isoformat(),
                "failure_reason": err,
            }).eq("id", outbox_id).execute()
        except Exception:
            pass
        return {"outbox_id": outbox_id, "status": "failed", "error": err}


def _build_message(
    *,
    to: list[str],
    cc: list[str],
    subject: str,
    body_html: str,
    body_text: Optional[str],
    attachments: Optional[list[dict]],
) -> EmailMessage:
    """Build a MIME message with HTML body, text alternative, and attachments
    fetched from URL."""
    msg = EmailMessage()
    sender_email = settings.gmail_sender_email or settings.email_from
    msg["From"] = formataddr(("Ferrocrete Builders", sender_email))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject

    # Text part is the primary content; HTML is the alternative. Without a
    # text part, some spam filters score the message higher.
    fallback_text = body_text or _html_to_plaintext(body_html)
    msg.set_content(fallback_text)
    msg.add_alternative(body_html, subtype="html")

    if attachments:
        with httpx.Client(timeout=60) as client:
            for a in attachments:
                url = a.get("url")
                filename = a.get("filename") or "attachment.bin"
                if not url:
                    continue
                resp = client.get(url)
                if resp.status_code >= 300:
                    raise RuntimeError(
                        f"Could not fetch attachment {filename!r} "
                        f"(HTTP {resp.status_code}): {resp.text[:200]}"
                    )
                mime_type = resp.headers.get("content-type", "application/octet-stream")
                maintype, _, subtype = mime_type.partition("/")
                if not subtype:
                    maintype, subtype = "application", "octet-stream"
                msg.add_attachment(
                    resp.content,
                    maintype=maintype,
                    subtype=subtype,
                    filename=filename,
                )
    return msg


def _send_via_gmail_api(msg: EmailMessage) -> None:
    """Encode the MIME message and POST to Gmail's users.messages.send endpoint.

    Credentials are constructed fresh on each call — google-auth handles
    refresh-token-to-access-token exchange internally and caches in memory
    for the (short) life of the process. For our send-then-exit pattern that
    overhead is fine (~200ms per send).
    """
    # Imports are inside the function so the module can still load when the
    # Google libraries aren't installed (e.g. in test environments).
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    creds = Credentials(
        token=None,
        refresh_token=settings.gmail_oauth_refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.gmail_oauth_client_id,
        client_secret=settings.gmail_oauth_client_secret,
        scopes=_GMAIL_SCOPES,
    )
    creds.refresh(Request())

    # `cache_discovery=False` skips an on-disk cache that breaks on read-only
    # filesystems (which Render's container has by default).
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
    service.users().messages().send(
        userId="me",
        body={"raw": raw},
    ).execute()


def _html_to_plaintext(html: str) -> str:
    """Very rough HTML → text fallback for the text/plain alternative.
    Not a real parser — just strips tags so the recipient's text-only client
    sees readable copy. Real markup happens in the HTML part."""
    import re
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    text = re.sub(r"</p>", "\n\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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


def notify_unapproved(*, pa: dict, project: dict, submitter: dict, approver: dict) -> dict:
    """Admin un-approved a previously-approved pay app. Tell the submitter so
    they know the pay app reopened for editing."""
    if not submitter.get("email"):
        return {"status": "skipped", "error": "submitter has no email"}
    link = _pay_app_link(project["id"], pa["period"])
    approver_name = approver.get("full_name") or approver.get("email") or "Admin"
    subject = f"Reopened for editing: Pay app #{pa['app_no']} for {project['name']}"
    body_html = f"""
    <p>{approver_name} reopened pay app <b>#{pa['app_no']}</b> for
       <b>{project['name']}</b> — it's back in draft state.</p>
    <p>If they intend revisions, you'll likely hear from them separately.
       Otherwise, edit and re-submit when ready.</p>
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
