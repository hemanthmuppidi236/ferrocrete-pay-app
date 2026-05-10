"""
Pay app PDF generation. Renders an AIA G702/G703-style PDF from DB data.

Page 1 (portrait) — Ferrocrete-branded G702 cover sheet, designed to match
the company's standard pay-app deliverable: logo top-right, two-column info
block, nine-line summary table with underlined dollar amounts, signature
block at bottom.

Page 2 (landscape) — G703 continuation sheet with the full line-item table.

Uses reportlab directly. No headless LibreOffice dependency.
"""

from io import BytesIO
from datetime import datetime, timezone, date
from decimal import Decimal
from pathlib import Path
from typing import List

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, landscape, portrait
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, NextPageTemplate, PageBreak,
    Paragraph, Spacer, Table, TableStyle, Image,
)
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

from .config import settings
from .supabase_client import get_service_client
from .pay_app_math import calculate_pay_app_totals
from . import storage as storage_helpers


# ─── Constants ────────────────────────────────────────────────────────

# Ferrocrete brand colors
COLOR_FERRO_RED = colors.HexColor("#D53B34")
COLOR_TEXT_BLACK = colors.HexColor("#1a1a1a")
COLOR_VALUE_BLUE = colors.HexColor("#0066CC")
COLOR_RULE_GREY = colors.HexColor("#cccccc")
COLOR_RULE_BLACK = colors.HexColor("#1a1a1a")

# Ferrocrete office address — hardcoded per discussion
FERROCRETE_NAME = "Ferrocrete Builders, Inc"
FERROCRETE_ADDR_LINE_1 = "440 Western Ave Suite 203"
FERROCRETE_ADDR_LINE_2 = "Glendale, CA 91201"

# Logo path — copied into backend/assets/ at deploy time
LOGO_PATH = Path(__file__).resolve().parents[2] / "assets" / "ferrocrete_logo.png"


# ─── Formatters ───────────────────────────────────────────────────────

def _money(v) -> str:
    """Format as X,XXX.XX. Returns '-' for zero."""
    if v is None:
        return "-"
    try:
        d = Decimal(str(v))
        if d == 0:
            return "-"
        return f"{d:,.2f}"
    except Exception:
        return str(v)


def _money_with_dollar(v) -> str:
    """Format as $X,XXX.XX (with dollar sign)."""
    if v is None:
        return "-"
    try:
        d = Decimal(str(v))
        if d == 0:
            return "-"
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


def _fmt_date(d) -> str:
    """Format a date as M/D/YYYY."""
    if d is None:
        return ""
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d.split("T")[0])
        except Exception:
            return d
    if isinstance(d, datetime):
        d = d.date()
    if isinstance(d, date):
        return f"{d.month}/{d.day}/{d.year}"
    return str(d)


# ─── Main PDF entrypoint ──────────────────────────────────────────────

def generate_pay_app_pdf(pay_app_id: str) -> bytes:
    """Render the pay app PDF: G702 cover (portrait) + G703 continuation (landscape)."""
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

    # Compute totals fresh from billings — single source of truth.
    totals = calculate_pay_app_totals(pay_app_id)

    buf = BytesIO()
    doc = _build_doc(buf, project, pa)

    story = []

    # ─── Page 1: G702 Cover (portrait) ────────────────────────────────
    story.append(NextPageTemplate("portrait"))
    _append_g702_cover(story, project, pa, totals, retention_rate)

    # ─── Page 2: G703 Continuation (landscape) ────────────────────────
    story.append(NextPageTemplate("landscape"))
    story.append(PageBreak())
    _append_g703_continuation(
        story, project, pa, sov_res.data, co_res.data,
        sov_billings, co_billings, retention_rate,
    )

    doc.build(story)
    return buf.getvalue()


# ─── Document setup with two page templates ───────────────────────────

def _build_doc(buf, project, pa):
    """Create a BaseDocTemplate with portrait + landscape page templates."""
    doc = BaseDocTemplate(
        buf,
        pagesize=portrait(letter),
        title=f"{project['name']} - Pay App {pa.get('period') or ''}",
        author="Ferrocrete Builders, Inc",
    )

    # Portrait frame (G702 cover) — letter size with reasonable margins
    portrait_frame = Frame(
        x1=0.6 * inch, y1=0.5 * inch,
        width=letter[0] - 1.2 * inch,
        height=letter[1] - 1.0 * inch,
        id="portrait_frame", showBoundary=0,
    )

    # Landscape frame (G703 continuation) — letter rotated
    ls_size = landscape(letter)
    landscape_frame = Frame(
        x1=0.4 * inch, y1=0.4 * inch,
        width=ls_size[0] - 0.8 * inch,
        height=ls_size[1] - 0.8 * inch,
        id="landscape_frame", showBoundary=0,
    )

    doc.addPageTemplates([
        PageTemplate(id="portrait", frames=[portrait_frame], pagesize=portrait(letter)),
        PageTemplate(id="landscape", frames=[landscape_frame], pagesize=landscape(letter)),
    ])
    return doc


# ─── Page 1: G702 Cover ───────────────────────────────────────────────

def _append_g702_cover(story, project, pa, totals, retention_rate):
    """Build the branded G702 cover page."""
    styles = getSampleStyleSheet()

    # Style definitions matching reference PDF
    style_title = ParagraphStyle(
        "Title", parent=styles["Normal"],
        fontName="Helvetica", fontSize=14,
        textColor=COLOR_TEXT_BLACK, leading=18,
    )
    style_label = ParagraphStyle(
        "Label", parent=styles["Normal"],
        fontName="Helvetica-Bold", fontSize=10,
        textColor=COLOR_TEXT_BLACK, leading=12,
    )
    style_value_blue = ParagraphStyle(
        "ValueBlue", parent=styles["Normal"],
        fontName="Helvetica", fontSize=10,
        textColor=COLOR_VALUE_BLUE, leading=13,
    )
    style_section_header = ParagraphStyle(
        "SectionHeader", parent=styles["Normal"],
        fontName="Helvetica-Bold", fontSize=12,
        textColor=COLOR_TEXT_BLACK, leading=14, spaceAfter=4,
    )
    style_body_small = ParagraphStyle(
        "BodySmall", parent=styles["Normal"],
        fontName="Helvetica", fontSize=8.5,
        textColor=COLOR_TEXT_BLACK, leading=11,
    )
    style_summary_label = ParagraphStyle(
        "SummaryLabel", parent=styles["Normal"],
        fontName="Helvetica", fontSize=10,
        textColor=COLOR_TEXT_BLACK, leading=12,
    )
    style_summary_label_bold = ParagraphStyle(
        "SummaryLabelBold", parent=styles["Normal"],
        fontName="Helvetica-Bold", fontSize=10,
        textColor=COLOR_TEXT_BLACK, leading=12,
    )

    # ─── Header row: title left, logo right ───────────────────────
    if LOGO_PATH.exists():
        logo = Image(str(LOGO_PATH), width=2.4 * inch, height=0.6 * inch, kind="proportional")
        header_table = Table(
            [[Paragraph("Application for Payment", style_title), logo]],
            colWidths=[3.5 * inch, 3.8 * inch],
        )
        header_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ("ALIGN", (1, 0), (1, 0), "RIGHT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(header_table)
    else:
        story.append(Paragraph("Application for Payment", style_title))

    # Horizontal rule under header
    rule = Table([[""]], colWidths=[7.3 * inch], rowHeights=[1])
    rule.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.75, COLOR_RULE_BLACK),
    ]))
    story.append(rule)
    story.append(Spacer(1, 0.15 * inch))

    # ─── Info block: two columns ──────────────────────────────────
    gc_company = project.get("gc_company") or ""
    gc_address = project.get("gc_address") or ""
    gc_email = project.get("gc_contact_email") or ""

    gc_lines = []
    if gc_company:
        gc_lines.append(gc_company)
    if gc_address:
        # Split only on newlines — preserve user's formatting (commas stay inline).
        for line in gc_address.split("\n"):
            if line.strip():
                gc_lines.append(line.strip())
    if gc_email:
        gc_lines.append(gc_email)
    gc_block_html = "<br/>".join(gc_lines) if gc_lines else "—"

    ferro_block_html = "<br/>".join([
        FERROCRETE_NAME, FERROCRETE_ADDR_LINE_1, FERROCRETE_ADDR_LINE_2,
    ])

    invoice_no = pa.get("app_no") or ""
    invoice_date = _fmt_date(datetime.now(timezone.utc).date())
    invoice_through = _fmt_date(pa.get("period_to"))

    info_rows = [
        [Paragraph("GENERAL CONTRACTOR", style_label),
         "",
         Paragraph("PROJECT:", style_label),
         Paragraph(project["name"] or "", style_value_blue)],
        [Paragraph(gc_block_html, style_value_blue),
         "",
         "", ""],
        ["", "",
         Paragraph("PROJECT #:", style_label),
         Paragraph(project.get("project_no") or "", style_value_blue)],
        ["", "", "", ""],
        ["", "",
         Paragraph("INVOICE #:", style_label),
         Paragraph(str(invoice_no), style_value_blue)],
        [Paragraph("FROM SUB-CONTRACTOR:", style_label),
         "",
         Paragraph("INVOICE DATE:", style_label),
         Paragraph(invoice_date, style_value_blue)],
        [Paragraph(ferro_block_html, style_value_blue),
         "",
         Paragraph("INVOICE THROUGH:", style_label),
         Paragraph(invoice_through, style_value_blue)],
    ]
    info_table = Table(
        info_rows,
        colWidths=[2.0 * inch, 1.7 * inch, 1.6 * inch, 2.0 * inch],
    )
    info_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 0.15 * inch))

    # Horizontal rule
    rule2 = Table([[""]], colWidths=[7.3 * inch], rowHeights=[1])
    rule2.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.75, COLOR_RULE_BLACK),
    ]))
    story.append(rule2)
    story.append(Spacer(1, 0.1 * inch))

    # ─── Section header + intro paragraph ─────────────────────────
    story.append(Paragraph("CONTRACTOR'S APPLICATION FOR PAYMENT", style_section_header))
    story.append(Paragraph(
        "Application is made for payment, as shown below, in connection with the Contract.<br/>"
        "Continuation Sheet, is attached.",
        style_body_small,
    ))
    story.append(Spacer(1, 0.15 * inch))

    # ─── The nine-line summary table ──────────────────────────────
    retention_pct_label = _pct(retention_rate)
    summary_rows = [
        [Paragraph("1.  ORIGINAL CONTRACT SUM", style_summary_label),
         "$", _money(totals["original_contract"])],
        [Paragraph("2.  CHANGE ORDERS", style_summary_label),
         "$", _money(totals["approved_co_total"])],
        [Paragraph("3.  REVISED CONTRACT SUM", style_summary_label),
         "$", _money(totals["revised_contract"])],

        [Paragraph("4.  TOTAL COMPLETED &amp; STORED TO DATE (Column G on attached sheet)", style_summary_label),
         "$", _money(totals["total_completed_to_date"])],
        [Paragraph(f"5.  RETAINAGE: <font color='#0066CC'>{retention_pct_label}</font>", style_summary_label),
         "$", _money(totals["retention_held"])],
        [Paragraph("6.  TOTAL EARNED LESS RETAINAGE", style_summary_label),
         "$", _money(totals["earned_less_retention"])],

        [Paragraph("7.  LESS PREVIOUS CERTIFICATES FOR PAYMENT (Line 6 from prior app)", style_summary_label),
         "$", _money(totals["previous_certificates"])],
        [Paragraph("8.  CURRENT PAYMENT DUE (Current gross less current retainage)", style_summary_label_bold),
         "$", _money(totals["current_payment_due"])],
        [Paragraph("9.  BALANCE TO FINISH, INCLUDING RETAINAGE", style_summary_label),
         "$", _money(totals["balance_to_finish"])],
    ]
    summary_table = Table(
        summary_rows,
        colWidths=[5.2 * inch, 0.2 * inch, 1.9 * inch],
    )
    summary_table.setStyle(TableStyle([
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("FONTSIZE", (1, 0), (-1, -1), 10),
        ("TEXTCOLOR", (2, 0), (2, -1), COLOR_VALUE_BLUE),
        ("ALIGN", (1, 0), (1, -1), "LEFT"),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 2), (-1, 2), 0.5, COLOR_RULE_BLACK),
        ("LINEBELOW", (0, 5), (-1, 5), 0.5, COLOR_RULE_BLACK),
        ("LINEBELOW", (1, 0), (2, 0), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 1), (2, 1), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 2), (2, 2), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 3), (2, 3), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 4), (2, 4), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 5), (2, 5), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 6), (2, 6), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 7), (2, 7), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (1, 8), (2, 8), 0.5, COLOR_TEXT_BLACK),
    ]))
    story.append(summary_table)
    story.append(Spacer(1, 0.25 * inch))

    # Horizontal rule
    rule3 = Table([[""]], colWidths=[7.3 * inch], rowHeights=[1])
    rule3.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.75, COLOR_RULE_BLACK),
    ]))
    story.append(rule3)
    story.append(Spacer(1, 0.08 * inch))

    # ─── Certification paragraph ──────────────────────────────────
    story.append(Paragraph(
        "The undersigned Subcontractor certifies that to the best of the Subcontractor's "
        "knowledge, information and belief the Work covered by this Application for Payment "
        "has been completed in accordance with the Contract Documents, that all amounts have "
        "been paid by the Contractor for Work for which previous Certificates for Payment "
        "were issued and payments received from the Owner, and that current payment shown "
        "herein is now due.",
        style_body_small,
    ))
    story.append(Spacer(1, 0.25 * inch))

    # ─── Signature block ──────────────────────────────────────────
    story.append(Paragraph("SUBCONTRACTOR", style_label))
    story.append(Spacer(1, 0.05 * inch))

    sig_data = [
        [
            Paragraph("By:", style_summary_label),
            "",
            Paragraph("Date:", style_summary_label),
            Paragraph(invoice_date, style_value_blue),
        ],
    ]
    sig_table = Table(sig_data, colWidths=[0.5 * inch, 4.5 * inch, 0.6 * inch, 1.7 * inch])
    sig_table.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LINEBELOW", (1, 0), (1, 0), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (3, 0), (3, 0), 0.5, COLOR_TEXT_BLACK),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
    ]))
    story.append(sig_table)


# ─── Page 2: G703 Continuation ────────────────────────────────────────

def _append_g703_continuation(
    story, project, pa, sov_data, co_data,
    sov_billings, co_billings, retention_rate,
):
    """Build the G703 line-item continuation sheet (landscape)."""
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1L", parent=styles["Heading1"], fontSize=14, alignment=TA_CENTER,
                        spaceAfter=4, textColor=COLOR_TEXT_BLACK)
    h2 = ParagraphStyle("H2L", parent=styles["Heading2"], fontSize=10, alignment=TA_LEFT,
                        spaceAfter=2, textColor=COLOR_TEXT_BLACK)

    story.append(Paragraph("CONTINUATION SHEET", h1))
    story.append(Paragraph(f"Pay Application #{pa['app_no']} — {project['name']}", h2))
    story.append(Spacer(1, 0.15 * inch))

    headers = ["#", "Description", "Sched Value",
               "Prev Work", "This Period", "Stored",
               "Total Completed", "%", "Balance", "Retention"]
    rows = [headers]

    tot_c = tot_g = tot_j = Decimal("0")
    for i, sov in enumerate(sov_data):
        b = sov_billings.get(sov["id"], {})
        sched = Decimal(str(sov.get("scheduled_value") or 0))
        prev = Decimal(str(b.get("previous_work") or 0))
        this_p = Decimal(str(b.get("this_period_work") or 0))
        stored = Decimal(str(b.get("materials_stored") or 0))
        total_g = prev + this_p + stored
        pct = (total_g / sched) if sched > 0 else Decimal(0)
        balance = sched - total_g
        retention = total_g * retention_rate

        tot_c += sched
        tot_g += total_g
        tot_j += retention

        rows.append([
            sov.get("item_no") or str(i + 1),
            sov.get("description") or "",
            _money_with_dollar(sched), _money_with_dollar(prev),
            _money_with_dollar(this_p), _money_with_dollar(stored),
            _money_with_dollar(total_g), _pct(pct),
            _money_with_dollar(balance), _money_with_dollar(retention),
        ])

    if co_data:
        rows.append(["", "Change Orders:", "", "", "", "", "", "", "", ""])
        for co in co_data:
            b = co_billings.get(co["id"], {})
            sched = Decimal(str(co.get("amount") or 0))
            prev = Decimal(str(b.get("previous_work") or 0))
            this_p = Decimal(str(b.get("this_period_work") or 0))
            stored = Decimal(str(b.get("materials_stored") or 0))
            total_g = prev + this_p + stored
            pct = (total_g / sched) if sched > 0 else Decimal(0)
            balance = sched - total_g
            retention = total_g * retention_rate if co.get("has_retention", True) else Decimal(0)

            tot_c += sched
            tot_g += total_g
            tot_j += retention

            rows.append([
                co["co_no"], co["description"] or "",
                _money_with_dollar(sched), _money_with_dollar(prev),
                _money_with_dollar(this_p), _money_with_dollar(stored),
                _money_with_dollar(total_g), _pct(pct),
                _money_with_dollar(balance), _money_with_dollar(retention),
            ])

    rows.append([
        "", "GRAND TOTALS",
        _money_with_dollar(tot_c), "", "", "",
        _money_with_dollar(tot_g),
        _pct((tot_g / tot_c) if tot_c > 0 else 0),
        _money_with_dollar(tot_c - tot_g),
        _money_with_dollar(tot_j),
    ])

    col_widths = [
        0.4 * inch, 2.7 * inch,
        0.95 * inch, 0.95 * inch, 0.95 * inch, 0.70 * inch,
        1.05 * inch, 0.55 * inch, 0.95 * inch, 0.95 * inch,
    ]
    t = Table(rows, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (1, -1), "LEFT"),
        ("BACKGROUND", (0, 0), (-1, 0), COLOR_TEXT_BLACK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f3ecdc")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEBELOW", (0, 0), (-1, 0), 1, COLOR_TEXT_BLACK),
        ("LINEBELOW", (0, -2), (-1, -2), 0.5, COLOR_TEXT_BLACK),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, COLOR_RULE_GREY),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(t)


# ─── Generate + store wrapper ─────────────────────────────────────────

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
        settings.bucket_pay_apps, path, pdf_bytes,
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
