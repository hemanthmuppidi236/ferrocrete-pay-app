"""
Pay app PDF generation. Renders an AIA G702/G703-style PDF from DB data.

Uses reportlab to draw the document directly. No headless LibreOffice dependency.
Layout is a faithful approximation of AIA G702/G703 — headers, line items table,
totals block, signatures.
"""

from io import BytesIO
from datetime import datetime, timezone, date
from decimal import Decimal
from typing import List

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

from .config import settings
from .supabase_client import get_service_client
from .pay_app_math import calculate_pay_app_totals
from . import storage as storage_helpers


def _money(v) -> str:
    if v is None:
        return ""
    try:
        d = Decimal(str(v))
        if d == 0:
            return "—"
        return f"${d:,.2f}"
    except Exception:
        return str(v)


def _pct(v) -> str:
    if v is None:
        return ""
    try:
        return f"{float(v) * 100:.1f}%"
    except Exception:
        return ""


def generate_pay_app_pdf(pay_app_id: str) -> bytes:
    """Render a multi-page PDF: page 1 = G702 summary, page 2 = G703 line items."""
    sb = get_service_client()

    pa_res = sb.table("pay_apps").select("*, projects(*)").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa_res.data:
        raise ValueError(f"Pay app {pay_app_id} not found")
    pa = pa_res.data[0]
    project = pa["projects"]

    sov_res = sb.table("sov_lines").select("*").eq("project_id", project["id"]).order("sort_order").execute()
    co_res = sb.table("change_orders").select("*").eq("project_id", project["id"]).eq("status", "approved").order("co_no").execute()
    bil_res = sb.table("pay_app_billings").select("*").eq("pay_app_id", str(pay_app_id)).execute()

    sov_billings = {b["sov_line_id"]: b for b in bil_res.data if b.get("sov_line_id")}
    co_billings = {b["change_order_id"]: b for b in bil_res.data if b.get("change_order_id")}
    retention_rate = Decimal(str(project["retention_rate"]))

    # Compute totals fresh from billings — don't rely on the denormalized
    # columns on the pay_apps row, which can lag behind billings updates.
    totals = calculate_pay_app_totals(pay_app_id)

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(letter),
        leftMargin=0.4 * inch, rightMargin=0.4 * inch,
        topMargin=0.4 * inch, bottomMargin=0.4 * inch,
        title=f"{project['name']} - Pay App {pa['period']}",
    )

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=14, alignment=TA_CENTER,
                       spaceAfter=4, textColor=colors.HexColor("#14140e"))
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=10, alignment=TA_LEFT,
                       spaceAfter=2, textColor=colors.HexColor("#14140e"))
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=8.5,
                          textColor=colors.HexColor("#14140e"), leading=10)
    small = ParagraphStyle("Small", parent=body, fontSize=7.5, leading=9)

    story = []

    # ─── Page 1: G702 Summary ────────────────────────────────────────
    story.append(Paragraph("APPLICATION AND CERTIFICATE FOR PAYMENT", h1))
    story.append(Paragraph(f"AIA Document G702 — Pay Application #{pa['app_no']}", h2))
    story.append(Spacer(1, 0.15 * inch))

    # Header info table
    header_data = [
        ["TO OWNER:", project.get("gc_company") or "—",
         "PROJECT:", project["name"]],
        ["", project.get("address") or "",
         "APPLICATION NO:", str(pa["app_no"])],
        ["FROM CONTRACTOR:", "Ferrocrete Builders, Inc.",
         "PERIOD TO:", str(pa["period_to"]) if pa.get("period_to") else ""],
        ["", "", "PROJECT NO:", project["project_no"]],
    ]
    t = Table(header_data, colWidths=[1.2 * inch, 3.0 * inch, 1.2 * inch, 3.0 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("LINEBELOW", (1, 0), (1, -1), 0.5, colors.grey),
        ("LINEBELOW", (3, 0), (3, -1), 0.5, colors.grey),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.25 * inch))

    # Summary calculations — pulled from freshly-computed totals
    summary_rows = [
        ["1.", "ORIGINAL CONTRACT SUM", _money(totals["original_contract"])],
        ["2.", "Net change by Change Orders", _money(totals["approved_co_total"])],
        ["3.", "CONTRACT SUM TO DATE (Line 1 ± 2)", _money(totals["revised_contract"])],
        ["4.", "TOTAL COMPLETED & STORED TO DATE", _money(totals["total_completed_to_date"])],
        ["5.", f"RETAINAGE ({_pct(retention_rate)}):", _money(totals["retention_held"])],
        ["6.", "TOTAL EARNED LESS RETAINAGE (Line 4 − 5)", _money(totals["earned_less_retention"])],
        ["7.", "LESS PREVIOUS CERTIFICATES FOR PAYMENT", _money(totals["previous_certificates"])],
        ["8.", "CURRENT PAYMENT DUE", _money(totals["current_payment_due"])],
        ["9.", "BALANCE TO FINISH, INCLUDING RETAINAGE", _money(totals["balance_to_finish"])],
    ]
    t = Table(summary_rows, colWidths=[0.4 * inch, 5.5 * inch, 2.5 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.lightgrey),
        ("BACKGROUND", (0, 7), (-1, 7), colors.HexColor("#f3ecdc")),  # row 8 (Current Pay Due)
        ("FONTNAME", (0, 7), (-1, 7), "Helvetica-Bold"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)

    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph(
        "The undersigned Contractor certifies that to the best of the Contractor's "
        "knowledge, information and belief the Work covered by this Application for "
        "Payment has been completed in accordance with the Contract Documents, that "
        "all amounts have been paid by the Contractor for Work for which previous "
        "Certificates for Payment were issued and payments received from the Owner, "
        "and that current payment shown herein is now due.",
        small,
    ))

    story.append(Spacer(1, 0.4 * inch))
    sig_data = [
        ["CONTRACTOR:", "Ferrocrete Builders, Inc.", "DATE:", ""],
        ["BY:", "_" * 30, "", ""],
    ]
    sig = Table(sig_data, colWidths=[1.0 * inch, 3.0 * inch, 0.7 * inch, 3.0 * inch])
    sig.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
    ]))
    story.append(sig)

    # ─── Page 2: G703 Continuation Sheet ─────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("CONTINUATION SHEET", h1))
    story.append(Paragraph(f"AIA Document G703 — Pay Application #{pa['app_no']}", h2))
    story.append(Spacer(1, 0.15 * inch))

    # Line item table
    headers = ["#", "Description", "Sched Value",
               "Prev Work", "This Period", "Stored",
               "Total Completed", "%", "Balance", "Retention"]

    rows = [headers]

    # SOV lines
    sov_total_c = sov_total_g = sov_total_j = Decimal("0")
    for i, sov in enumerate(sov_res.data):
        b = sov_billings.get(sov["id"], {})
        sched = Decimal(str(sov.get("scheduled_value") or 0))
        prev = Decimal(str(b.get("previous_work") or 0))
        this_p = Decimal(str(b.get("this_period_work") or 0))
        stored = Decimal(str(b.get("materials_stored") or 0))
        total_g = prev + this_p + stored
        pct = (total_g / sched) if sched > 0 else Decimal(0)
        balance = sched - total_g
        retention = total_g * retention_rate

        sov_total_c += sched
        sov_total_g += total_g
        sov_total_j += retention

        rows.append([
            sov.get("item_no") or str(i + 1),
            sov.get("description") or "",
            _money(sched), _money(prev), _money(this_p), _money(stored),
            _money(total_g), _pct(pct), _money(balance), _money(retention),
        ])

    # CO lines
    if co_res.data:
        rows.append(["", "Change Orders:", "", "", "", "", "", "", "", ""])
        for co in co_res.data:
            b = co_billings.get(co["id"], {})
            sched = Decimal(str(co.get("amount") or 0))
            prev = Decimal(str(b.get("previous_work") or 0))
            this_p = Decimal(str(b.get("this_period_work") or 0))
            stored = Decimal(str(b.get("materials_stored") or 0))
            total_g = prev + this_p + stored
            pct = (total_g / sched) if sched > 0 else Decimal(0)
            balance = sched - total_g
            retention = total_g * retention_rate if co.get("has_retention", True) else Decimal(0)

            sov_total_c += sched
            sov_total_g += total_g
            sov_total_j += retention

            rows.append([
                co["co_no"], co["description"] or "",
                _money(sched), _money(prev), _money(this_p), _money(stored),
                _money(total_g), _pct(pct), _money(balance), _money(retention),
            ])

    # Grand totals
    rows.append([
        "", "GRAND TOTALS",
        _money(sov_total_c), "", "", "",
        _money(sov_total_g),
        _pct((sov_total_g / sov_total_c) if sov_total_c > 0 else 0),
        _money(sov_total_c - sov_total_g),
        _money(sov_total_j),
    ])

    col_widths = [
        0.4 * inch,  # #
        2.7 * inch,  # description
        0.85 * inch,  # sched
        0.85 * inch,  # prev
        0.85 * inch,  # this period
        0.65 * inch,  # stored
        0.95 * inch,  # total completed
        0.5 * inch,  # %
        0.85 * inch,  # balance
        0.85 * inch,  # retention
    ]
    t = Table(rows, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (1, -1), "LEFT"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e1e1c")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#ede9e0")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f3ecdc")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEBELOW", (0, 0), (-1, 0), 1, colors.HexColor("#14140e")),
        ("LINEBELOW", (0, -2), (-1, -2), 0.5, colors.HexColor("#14140e")),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.lightgrey),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(t)

    doc.build(story)
    return buf.getvalue()


def generate_and_store_pay_app_pdf(pay_app_id: str) -> dict:
    sb = get_service_client()
    pa_res = sb.table("pay_apps").select("*, projects(project_no, name)").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa_res.data:
        raise ValueError(f"Pay app {pay_app_id} not found")
    pa = pa_res.data[0]
    project = pa["projects"]

    pdf_bytes = generate_pay_app_pdf(pay_app_id)
    path = storage_helpers.make_pay_app_pdf_path(
        pa["period"], project["project_no"], project["name"],
    )
    storage_helpers.upload_bytes(
        settings.bucket_pay_apps,
        path,
        pdf_bytes,
        content_type="application/pdf",
    )

    now = datetime.now(timezone.utc).isoformat()
    sb.table("pay_apps").update({
        "pdf_file_path": path,
        "pdf_generated_at": now,
    }).eq("id", str(pay_app_id)).execute()

    return {
        "file_path": path,
        "download_url": storage_helpers.signed_url(settings.bucket_pay_apps, path),
        "generated_at": now,
    }
