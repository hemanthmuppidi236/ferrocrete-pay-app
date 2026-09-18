"""
Pay app Excel/PDF generation.

Bridges the database state (pay_apps + billings + sov_lines + change_orders) to the
existing `payapp_engine.py` from Demo 1, which operates on Excel files.

Strategy:
  1. Load pay app + billings + project + SOV + COs from DB
  2. Build an in-memory "project" data structure matching what payapp_engine expects
  3. Use a copy of the PayApp_Template.xlsx, populate via openpyxl directly
     (we don't reuse fabricate_projects.py because it does too much)
  4. Save the resulting bytes
  5. Upload to Supabase Storage
  6. Return a signed URL
"""

from io import BytesIO
from pathlib import Path
from datetime import datetime, timezone, date
from decimal import Decimal
from typing import List
import calendar
import shutil
import tempfile

from openpyxl import load_workbook

from .config import settings
from .supabase_client import get_service_client
from .pay_app_math import calculate_pay_app_totals
from . import storage as storage_helpers


# Path to the Excel template inside the backend repo
TEMPLATE_DIR = Path(__file__).resolve().parents[2] / "engines" / "templates"
PAY_APP_TEMPLATE = TEMPLATE_DIR / "PayApp_Template.xlsx"


# ─── Cell map (matches Demo 1's payapp_engine) ────────────────────────
CELL_PROJECT_NAME = "C1"
CELL_PROJECT_NO = "I3"
CELL_APP_NO = "I2"
CELL_APP_DATE = "I4"
CELL_PERIOD_TO = "I5"

SHEET_702 = "702"
SHEET_G703 = "G703"

SOV_BODY_START = 15
SOV_BODY_END = 72
CO_BODY_START = 74
CO_BODY_END = 76
GRAND_TOTAL_ROW = 78

S702_RETENTION_RATE = "C27"
S702_PREVIOUS_CERTS = "G29"


def generate_pay_app_excel(pay_app_id: str) -> bytes:
    """Generate the pay app Excel file. Returns bytes."""
    if not PAY_APP_TEMPLATE.exists():
        raise FileNotFoundError(
            f"Pay app template not found at {PAY_APP_TEMPLATE}. "
            "Make sure backend/engines/templates/PayApp_Template.xlsx exists."
        )

    sb = get_service_client()

    # Load pay app + project
    pa_res = sb.table("pay_apps").select("*, projects(*)").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa_res.data:
        raise ValueError(f"Pay app {pay_app_id} not found")
    pa = pa_res.data[0]
    project = pa["projects"]

    sov_res = sb.table("sov_lines").select("*").eq("project_id", project["id"]).order("sort_order").execute()
    co_res = sb.table("change_orders").select("*").eq("project_id", project["id"]).order("co_no").execute()
    bil_res = sb.table("pay_app_billings").select("*").eq("pay_app_id", str(pay_app_id)).execute()

    # Index billings by sov_line_id and change_order_id for quick lookup
    sov_billings = {b["sov_line_id"]: b for b in bil_res.data if b.get("sov_line_id")}
    co_billings = {b["change_order_id"]: b for b in bil_res.data if b.get("change_order_id")}

    # Load template into memory
    with open(PAY_APP_TEMPLATE, "rb") as f:
        template_bytes = f.read()
    wb = load_workbook(BytesIO(template_bytes))
    g703 = wb[SHEET_G703]
    s702 = wb[SHEET_702]

    # The template is wired for exactly three change orders: 702!G23 sums
    # G703!C74:C76, and GRAND TOTALS sits at row 78. When a project has more
    # COs, widen the CO band (insert rows above the spacer/GRAND TOTALS) and
    # repoint every dependent formula, so all COs — and correct totals — appear
    # on the download instead of being silently dropped.
    approved_cos = [co for co in co_res.data if co["status"] == "approved"]
    n_cos = len(approved_cos)
    co_capacity = CO_BODY_END - CO_BODY_START + 1
    co_last = CO_BODY_END
    gt_row = GRAND_TOTAL_ROW
    if n_cos > co_capacity:
        from copy import copy
        extra = n_cos - co_capacity
        # Insert blank rows just above the spacer row so new CO rows stay
        # contiguous with 74-76. openpyxl does NOT rewrite formula references on
        # shift, so GRAND TOTALS and the 702 cross-refs are rewritten below.
        g703.insert_rows(GRAND_TOTAL_ROW - 1, extra)
        co_last = CO_BODY_END + extra
        gt_row = GRAND_TOTAL_ROW + extra
        # Copy the appearance (borders, fonts, number formats, height) of an
        # existing CO row onto each newly inserted row.
        for r in range(CO_BODY_END + 1, co_last + 1):
            for c in range(1, 11):
                src = g703.cell(row=CO_BODY_END, column=c)
                dst = g703.cell(row=r, column=c)
                dst.font = copy(src.font)
                dst.border = copy(src.border)
                dst.fill = copy(src.fill)
                dst.alignment = copy(src.alignment)
                dst.number_format = src.number_format
            if g703.row_dimensions[CO_BODY_END].height is not None:
                g703.row_dimensions[r].height = g703.row_dimensions[CO_BODY_END].height
        # Per-row formulas for the whole CO band (G total, H %, I balance,
        # J retention at the project rate — matching the SOV rows).
        for r in range(CO_BODY_START, co_last + 1):
            g703.cell(row=r, column=7).value = f'=IF(D{r}+E{r}+F{r}=0,"",D{r}+E{r}+F{r})'
            g703.cell(row=r, column=8).value = f'=IF(G{r}=0,"",IF(ISERR(G{r}/C{r}),"",G{r}/C{r}))'
            g703.cell(row=r, column=9).value = f'=IF(C{r}-G{r}=0,"",C{r}-G{r})'
            g703.cell(row=r, column=10).value = f"=G{r}*'702'!$C$27"
        # Repoint GRAND TOTALS (now at gt_row) over the widened band.
        g703.cell(row=gt_row, column=3).value = f'=IF(SUM(C13:C{co_last})=0,"",SUM(C13:C{co_last}))'
        g703.cell(row=gt_row, column=4).value = f'=SUM(D13:D{co_last})'
        g703.cell(row=gt_row, column=5).value = f'=IF(SUM(E13:E{co_last})=0,"",SUM(E13:E{co_last}))'
        g703.cell(row=gt_row, column=6).value = f'=IF(SUM(F13:F{co_last})=0,"",SUM(F13:F{co_last}))'
        g703.cell(row=gt_row, column=7).value = f'=IF(SUM(G13:G{co_last})=0,"",SUM(G13:G{co_last}))'
        g703.cell(row=gt_row, column=8).value = f'=IF(G{gt_row}=0,"",IF(ISERR(G{gt_row}/C{gt_row}),"",G{gt_row}/C{gt_row}))'
        g703.cell(row=gt_row, column=9).value = f'=IF(C{gt_row}-G{gt_row}=0,"",C{gt_row}-G{gt_row})'
        g703.cell(row=gt_row, column=10).value = f'=SUM(J13:J{co_last})'
        # Repoint the 702 sheet's cross-references (CO contract sum + grand totals).
        s702["G23"].value = f"=SUM('G703'!C74:C{co_last})"
        s702["G26"].value = f"='G703'!G{gt_row}"
        s702["G27"].value = f"='G703'!J{gt_row}"
        s702["G29"].value = f"=(1-C27)*'G703'!D{gt_row}"
        # Keep the print area from clipping the moved GRAND TOTALS row.
        g703.print_area = f"A1:J{gt_row}"

    # Clear the template's example SOV + change-order rows first, so leftover
    # sample data (extra "Level 2/3", Overpours, Bond Fee, SCO #01, ...) never
    # leaks into this project's request for payment. Only the data columns
    # (A-F); the per-row total/retention formulas in G-J recompute from them.
    for _r in (list(range(SOV_BODY_START, SOV_BODY_END + 1))
               + list(range(CO_BODY_START, co_last + 1))):
        for _c in range(1, 7):
            g703.cell(row=_r, column=_c).value = None

    # Header
    g703[CELL_PROJECT_NAME] = project["name"]
    g703[CELL_PROJECT_NO] = project["project_no"]
    g703[CELL_APP_NO] = pa["app_no"]
    g703[CELL_APP_DATE] = datetime.now(timezone.utc).date()
    if pa.get("period_to"):
        period_to = pa["period_to"]
        if isinstance(period_to, str):
            period_to = date.fromisoformat(period_to)
        g703[CELL_PERIOD_TO] = period_to

    # Correct cell formats inherited from the template so the project number is
    # not rendered as a date and dates show as m/d/yyyy on both the G703 and 702.
    g703[CELL_PROJECT_NAME].number_format = "@"     # text (was currency)
    g703[CELL_PROJECT_NO].number_format = "@"       # text (was mm-dd-yy)
    g703[CELL_APP_NO].number_format = "0"
    g703[CELL_APP_DATE].number_format = "m/d/yyyy"
    g703[CELL_PERIOD_TO].number_format = "m/d/yyyy"
    for _coord, _fmt in (("G7", "@"), ("G9", "0"), ("G11", "m/d/yyyy"), ("G13", "m/d/yyyy")):
        s702[_coord].number_format = _fmt

    # Populate the Prelim Sheet from THIS project. The 702 header and the CP/UP/
    # CF/UF tabs all reference these cells, so without this they show the
    # template's example project (712 Seagaze). Cell map matches the template.
    if "Prelim Sheet" in wb.sheetnames:
        ps = wb["Prelim Sheet"]
        ps["F9"] = project.get("owner_name") or ""     # Owner name
        ps["F10"] = project.get("owner_address") or ""  # Owner address
        ps["F11"] = ""
        ps["F14"] = project.get("gc_company") or ""      # Customer (GC) name
        ps["F15"] = project.get("gc_address") or ""       # GC address
        ps["F16"] = ""
        ps["F29"] = project["name"]                       # Project name (702 header)
        ps["F30"] = project.get("address") or ""          # Job location
        ps["F31"] = ""
    # The GC billing email is hardcoded on 702!A9 in the template.
    s702["A9"] = project.get("gc_contact_email") or ""
    # Make Excel recompute the 702 formulas from the new G703 data on open, so
    # no stale template values (Seagaze totals) are shown.
    try:
        wb.calculation.fullCalcOnLoad = True
    except Exception:
        pass

    # Retention rate on 702!C27
    s702[S702_RETENTION_RATE] = float(project["retention_rate"])

    # Previous certificates (carried from prior pay apps)
    s702[S702_PREVIOUS_CERTS] = float(pa.get("previous_certificates") or 0)

    # SOV body — rows 15 to 72 (max 58 lines)
    if len(sov_res.data) > (SOV_BODY_END - SOV_BODY_START + 1):
        raise ValueError(f"Too many SOV lines ({len(sov_res.data)}); template supports {SOV_BODY_END - SOV_BODY_START + 1}")
    for i, sov in enumerate(sov_res.data):
        r = SOV_BODY_START + i
        g703.cell(row=r, column=1, value=sov.get("item_no") or str(i + 1))   # A: item #
        g703.cell(row=r, column=2, value=sov.get("description"))             # B: description
        g703.cell(row=r, column=3, value=float(sov.get("scheduled_value") or 0))  # C: scheduled value

        b = sov_billings.get(sov["id"])
        if b:
            g703.cell(row=r, column=4, value=float(b.get("previous_work") or 0))  # D
            g703.cell(row=r, column=5, value=float(b.get("this_period_work") or 0))  # E
            g703.cell(row=r, column=6, value=float(b.get("materials_stored") or 0))  # F

    # CO body — rows 74 to co_last. approved_cos was computed above and the band
    # widened if needed, so every change order is written (no silent truncation).
    for i, co in enumerate(approved_cos):
        r = CO_BODY_START + i
        g703.cell(row=r, column=1, value=co.get("co_no"))
        g703.cell(row=r, column=2, value=co.get("description"))
        g703.cell(row=r, column=3, value=float(co.get("amount") or 0))
        b = co_billings.get(co["id"])
        if b:
            g703.cell(row=r, column=4, value=float(b.get("previous_work") or 0))
            g703.cell(row=r, column=5, value=float(b.get("this_period_work") or 0))
            g703.cell(row=r, column=6, value=float(b.get("materials_stored") or 0))

    # Save to bytes
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def generate_and_store_pay_app_excel(pay_app_id: str) -> dict:
    """Generate the Excel, upload to storage, mark pay_app row, return metadata."""
    sb = get_service_client()
    pa_res = sb.table("pay_apps").select("*, projects(project_no, name)").eq("id", str(pay_app_id)).limit(1).execute()
    if not pa_res.data:
        raise ValueError(f"Pay app {pay_app_id} not found")
    pa = pa_res.data[0]
    project = pa["projects"]

    excel_bytes = generate_pay_app_excel(pay_app_id)
    path = storage_helpers.make_pay_app_excel_path(
        pa["period"], project["project_no"], project["name"],
    )
    storage_helpers.upload_bytes(
        settings.bucket_pay_apps,
        path,
        excel_bytes,
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    now = datetime.now(timezone.utc).isoformat()
    sb.table("pay_apps").update({
        "excel_file_path": path,
        "excel_generated_at": now,
    }).eq("id", str(pay_app_id)).execute()

    return {
        "file_path": path,
        "download_url": storage_helpers.signed_url(settings.bucket_pay_apps, path),
        "generated_at": now,
    }
