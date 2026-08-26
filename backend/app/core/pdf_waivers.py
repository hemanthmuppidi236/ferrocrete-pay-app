"""
WI-5: render Ferrocrete's own CP/UP/CF/UF waiver PDFs (ReportLab).

generate_waiver_pdf(pay_app_id, waiver_type) -> (bytes, filename)

Statutory content + field mapping live in core/waiver_forms.py (pure, tested);
this module only lays it out.
"""

from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Table, TableStyle,
    KeepTogether,
)

from .supabase_client import get_service_client
from . import waiver_forms as wf

SHADE = colors.Color(0.93, 0.93, 0.93)
GRID = colors.Color(0.55, 0.55, 0.55)
HAIRLINE = colors.Color(0.8, 0.8, 0.8)


def _fmt_date(v) -> str:
    if not v:
        return ""
    s = str(v)[:10].split("-")
    if len(s) == 3:
        return f"{int(s[1])}/{int(s[2])}/{s[0]}"
    return str(v)


def _styles():
    ss = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("wt", parent=ss["Normal"], fontName="Helvetica-Bold",
                                fontSize=13, alignment=TA_CENTER, leading=16, spaceAfter=12),
        "notice": ParagraphStyle("wn", parent=ss["Normal"], fontName="Helvetica-Bold",
                                 fontSize=9, alignment=TA_CENTER, leading=12, spaceAfter=4),
        "sec": ParagraphStyle("ws", parent=ss["Normal"], fontName="Helvetica-Bold",
                              fontSize=10.5, alignment=TA_CENTER, leading=13),
        "body": ParagraphStyle("wb", parent=ss["Normal"], fontName="Helvetica",
                               fontSize=9.5, leading=13, spaceAfter=5),
        "lbl": ParagraphStyle("wl", parent=ss["Normal"], fontName="Helvetica-Bold",
                              fontSize=9.5, leading=13),
        "val": ParagraphStyle("wv", parent=ss["Normal"], fontName="Helvetica",
                              fontSize=9.5, leading=13),
        "valb": ParagraphStyle("wvb", parent=ss["Normal"], fontName="Helvetica-Bold",
                               fontSize=9.5, leading=13),
    }


def render_waiver_pdf(ctx: dict) -> bytes:
    """Render a built waiver context to PDF, matching the native AIA form:
    centered section headers over bordered, alternately-shaded field tables."""
    st = _styles()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
        topMargin=0.6 * inch, bottomMargin=0.55 * inch,
        title=f"Ferrocrete {ctx['waiver_type']} Waiver",
    )
    content_w = doc.width
    story = []

    def section(text):
        return [
            HRFlowable(width="100%", thickness=1.1, color=colors.black,
                       spaceBefore=8, spaceAfter=4),
            Paragraph(text, st["sec"]),
            Spacer(1, 4),
        ]

    def field_table(rows, bold_values=None):
        """rows: list of (label, value). Bordered, alt-shaded, label bold."""
        bold_values = bold_values or set()
        data = []
        for lbl, val in rows:
            vstyle = st["valb"] if lbl in bold_values else st["val"]
            data.append([Paragraph(f"{lbl}:", st["lbl"]),
                         Paragraph((val or "&nbsp;"), vstyle)])
        t = Table(data, colWidths=[1.7 * inch, content_w - 1.7 * inch])
        style = [
            ("BOX", (0, 0), (-1, -1), 0.7, GRID),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ]
        for i in range(len(data)):
            if i < len(data) - 1:
                style.append(("LINEBELOW", (0, i), (-1, i), 0.4, HAIRLINE))
            if i % 2 == 1:
                style.append(("BACKGROUND", (0, i), (-1, i), SHADE))
        t.setStyle(TableStyle(style))
        return t

    # Title + notice
    story.append(Paragraph(ctx["title"], st["title"]))
    story.append(Paragraph(ctx["notice"], st["notice"]))

    # Identifying Information
    ident = [
        ("Name of Claimant", ctx["claimant_name"]),
        ("Name of Customer", ctx["customer"]),
        ("Job Location", ctx["job_location"]),
        ("Owner", ctx["owner"]),
    ]
    if ctx["through_date"]:
        ident.append(("Through Date", _fmt_date(ctx["through_date"])))
    story += section("Identifying Information")
    story.append(field_table(ident))

    # Waiver body
    story += section("Conditional Waiver and Release" if ctx["waiver_type"] in ("CP", "CF")
                     else "Unconditional Waiver and Release")
    story.append(Paragraph(ctx["body"], st["body"]))

    if ctx["has_check_block"]:
        story.append(field_table([
            ("Maker of Check", ctx["maker_of_check"]),
            ("Amount of Check", ctx["amount_of_check"]),
            ("Check Payable to", ctx["check_payable_to"]),
        ], bold_values={"Amount of Check"}))
    elif ctx["shows_amount"]:
        story.append(field_table([("Amount", ctx["amount_of_check"])],
                                 bold_values={"Amount"}))

    # Exceptions
    story += section("Exceptions")
    for line in ctx["exceptions"]:
        story.append(Paragraph(line, st["body"]))

    # Signature (blank line, no signature added) — kept together on one page.
    sig = section("Signature") + [field_table([
        ("Claimant's Signature", "&nbsp;"),
        ("Claimant's Title", ctx["claimant_title"]),
        ("Date of Signature", _fmt_date(ctx["date_of_signature"]) or "&nbsp;"),
    ])]
    story.append(KeepTogether(sig))

    doc.build(story)
    buf.seek(0)
    return buf.getvalue()


def generate_waiver_pdf(pay_app_id: str, waiver_type: str):
    """Load the pay app + project, build the form, and return (bytes, filename)."""
    sb = get_service_client()
    pa = sb.table("pay_apps").select("*").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa.data:
        raise ValueError("Pay app not found")
    pay_app = pa.data[0]
    proj = sb.table("projects").select("*").eq("id", pay_app["project_id"]).limit(1).execute()
    project = proj.data[0] if proj.data else {}

    ctx = wf.build_waiver(waiver_type, project=project, pay_app=pay_app)
    return render_waiver_pdf(ctx), ctx["filename"]
