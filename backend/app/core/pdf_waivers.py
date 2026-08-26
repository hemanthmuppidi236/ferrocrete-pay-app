"""
WI-5: render Ferrocrete's own CP/UP/CF/UF waiver PDFs (ReportLab).

generate_waiver_pdf(pay_app_id, waiver_type) -> (bytes, filename)

Statutory content + field mapping live in core/waiver_forms.py (pure, tested);
this module only lays it out.
"""

from io import BytesIO

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable

from .supabase_client import get_service_client
from . import waiver_forms as wf


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
                                fontSize=13, alignment=TA_CENTER, leading=16, spaceAfter=10),
        "notice": ParagraphStyle("wn", parent=ss["Normal"], fontName="Helvetica-Bold",
                                 fontSize=8.5, leading=11, spaceAfter=10),
        "h": ParagraphStyle("wh", parent=ss["Normal"], fontName="Helvetica-Bold",
                            fontSize=10.5, leading=13, spaceBefore=10, spaceAfter=4),
        "body": ParagraphStyle("wb", parent=ss["Normal"], fontName="Helvetica",
                               fontSize=9.5, leading=13, spaceAfter=6),
        "field": ParagraphStyle("wf", parent=ss["Normal"], fontName="Helvetica",
                                fontSize=10, leading=15),
    }


def render_waiver_pdf(ctx: dict) -> bytes:
    """Render a built waiver context (from waiver_forms.build_waiver) to PDF bytes."""
    st = _styles()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
        title=f"Ferrocrete {ctx['waiver_type']} Waiver",
    )
    story = []

    def field(label, value):
        story.append(Paragraph(
            f"<b>{label}:</b> {value or '&nbsp;'}", st["field"]))

    story.append(Paragraph(ctx["title"], st["title"]))
    story.append(Paragraph(ctx["notice"], st["notice"]))
    story.append(HRFlowable(width="100%", thickness=0.5, spaceBefore=2, spaceAfter=8,
                            color=(0.6, 0.6, 0.6)))

    story.append(Paragraph("Identifying Information", st["h"]))
    field("Name of Claimant", f"{ctx['claimant_name']}, {ctx['claimant_address']}")
    field("Name of Customer", ctx["customer"])
    field("Job Location", ctx["job_location"])
    field("Owner", ctx["owner"])
    if ctx["through_date"]:
        field("Through Date", _fmt_date(ctx["through_date"]))

    # Body
    section = ("Conditional Waiver and Release" if ctx["waiver_type"] in ("CP", "CF")
               else "Unconditional Waiver and Release")
    story.append(Paragraph(section, st["h"]))
    story.append(Paragraph(ctx["body"], st["body"]))

    if ctx["has_check_block"]:
        field("Maker of Check", ctx["maker_of_check"])
        field("Amount of Check", ctx["amount_of_check"])
        field("Check Payable to", ctx["check_payable_to"])
    elif ctx["shows_amount"]:
        field("Amount", ctx["amount_of_check"])

    story.append(Paragraph("Exceptions", st["h"]))
    for line in ctx["exceptions"]:
        story.append(Paragraph(line, st["body"]))

    story.append(Paragraph("Signature", st["h"]))
    field("Claimant's Signature", "____________________________________")
    field("Claimant's Title", ctx["claimant_title"])
    field("Date of Signature", _fmt_date(ctx["date_of_signature"])
          or "____________________")

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
