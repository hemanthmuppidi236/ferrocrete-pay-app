"""
WI-3: plain-text email templates for release-tracker reminders.

Pure and testable: build_reminder(template_key, ctx) returns {subject, body}.
The literal token {sub} is left in place so a bulk send can personalize each
recipient; a single-recipient send fills it before preview.

House rules: short, plain text, from Ferrocrete Builders, signed by the sender.
NO em dashes anywhere (use commas, periods, or hyphens).
"""

from datetime import date

# template_key -> the per-line status this send advances (None = just a nudge).
ADVANCES = {
    "request_bill_cpcf": "bill",          # bill_status -> requested
    "request_upuf": "unconditional",      # unconditional_status -> requested
    "cpcf_overdue": None,
    "upuf_overdue": None,
}

TEMPLATE_TITLES = {
    "request_bill_cpcf": "Request bill and CP/CF",
    "cpcf_overdue": "Reminder: CP/CF overdue",
    "request_upuf": "Request UP/UF",
    "upuf_overdue": "Reminder: UP/UF overdue",
}


def month_year(period: str) -> str:
    """'26-07' -> 'July 2026'."""
    try:
        yy, mm = period.split("-")
        d = date(2000 + int(yy), int(mm), 1)
        return d.strftime("%B %Y")
    except Exception:
        return period


def _ctx_lines(ctx: dict):
    proj = ctx.get("project_name", "")
    no = ctx.get("project_no", "")
    my = month_year(ctx.get("period", ""))
    through = ctx.get("conditional_through_date") or ""
    sender = ctx.get("sender_name") or "Ferrocrete Builders"
    return proj, no, my, through, sender


def build_reminder(template_key: str, ctx: dict) -> dict:
    """Return {subject, body} for the given template.

    ctx keys: project_name, project_no, period (YY-MM), conditional_through_date,
    sender_name, and optionally sub_name (else the {sub} token is kept).
    """
    proj, no, my, through, sender = _ctx_lines(ctx)
    sub = ctx.get("sub_name") or "{sub}"
    job = f"{no} {proj}".strip()

    if template_key == "request_bill_cpcf":
        subject = f"{job}: {my} billing and conditional release"
        body = (
            f"Hello {sub},\n\n"
            f"Please send your invoice for {proj} (job {no}) for the {my} "
            f"billing period, along with a Conditional Progress (CP) or "
            f"Conditional Final (CF) waiver and release"
            + (f" through {through}" if through else "")
            + ".\n\n"
            f"We need these to include your billing in this period's pay "
            f"application. Please reply with both at your earliest convenience.\n\n"
            f"Thank you,\n{sender}\nFerrocrete Builders"
        )
    elif template_key == "cpcf_overdue":
        subject = f"{job}: reminder, CP/CF still needed for {my}"
        body = (
            f"Hello {sub},\n\n"
            f"This is a friendly reminder that we have not yet received your "
            f"Conditional Progress (CP) or Conditional Final (CF) waiver and "
            f"release for {proj} (job {no}) for the {my} billing period"
            + (f", through {through}" if through else "")
            + ".\n\n"
            f"Please send it as soon as you can so we can keep your billing on "
            f"schedule.\n\n"
            f"Thank you,\n{sender}\nFerrocrete Builders"
        )
    elif template_key == "request_upuf":
        subject = f"{job}: UP/UF needed, payment released for {my}"
        body = (
            f"Hello {sub},\n\n"
            f"Your payment for {proj} (job {no}), {my} billing period, has been "
            f"released to you. Please send your Unconditional Progress (UP) or "
            f"Unconditional Final (UF) waiver and release so we can forward it "
            f"to the general contractor.\n\n"
            f"Thank you,\n{sender}\nFerrocrete Builders"
        )
    elif template_key == "upuf_overdue":
        subject = f"{job}: reminder, UP/UF still needed for {my}"
        body = (
            f"Hello {sub},\n\n"
            f"This is a friendly reminder that we have not yet received your "
            f"Unconditional Progress (UP) or Unconditional Final (UF) waiver and "
            f"release for {proj} (job {no}), {my} billing period, after your "
            f"payment was released.\n\n"
            f"Please send it as soon as you can.\n\n"
            f"Thank you,\n{sender}\nFerrocrete Builders"
        )
    else:
        raise ValueError(f"Unknown template_key: {template_key}")

    return {"subject": subject, "body": body}


def personalize(text: str, sub_name: str) -> str:
    """Replace the {sub} token with a real sub name (idempotent if absent)."""
    return text.replace("{sub}", sub_name)


def text_to_html(text: str) -> str:
    """Minimal, safe HTML rendering of a plain-text body (for the MIME html part)."""
    esc = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    body = esc.replace("\n", "<br>")
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
        'color:#1a1a1a;line-height:1.5;">' + body + "</div>"
    )
