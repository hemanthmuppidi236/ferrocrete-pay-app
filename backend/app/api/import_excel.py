"""
Excel import.

Reads an existing Pay App Excel file (matching Demo 1 template structure) and
creates the corresponding database rows: project, SOV lines, change orders, and
optionally the pay app itself.

Used in two modes:
  1. New project setup — user uploads the latest pay app .xlsx for an active
     project, we create the project + SOV + COs.
  2. Pay app archival — same upload, but we also create the pay app row with
     billings populated from the file's D/E/F columns.

  POST /import/pay-app-excel?create_pay_app=true
       Multipart file upload. Returns the created project (and pay app, if any).
"""

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from io import BytesIO
from openpyxl import load_workbook
from typing import Optional

from ..core.auth import CurrentUser, require_role
from ..core.supabase_client import get_service_client
from ..core import audit
from ..core.pay_app_math import save_pay_app_totals

router = APIRouter(prefix="/import", tags=["import"])


# Cell map for AIA G702/G703 (matches Demo 1's payapp_engine)
CELL_PROJECT_NAME = "C1"
CELL_PROJECT_NO = "I3"
CELL_APP_NO = "I2"
CELL_PERIOD_TO = "I5"
SHEET_702 = "702"
SHEET_G703 = "G703"
SOV_BODY_START = 15
SOV_BODY_END = 72
CO_BODY_START = 74
CO_BODY_END = 76
S702_RETENTION_RATE = "C27"


def _safe_float(v) -> float:
    if v is None or v == "" or v == " ":
        return 0.0
    if isinstance(v, str):
        if v.startswith("="):
            return 0.0    # formula not evaluated
        try:
            return float(v.replace(",", "").replace("$", ""))
        except ValueError:
            return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _safe_str(v) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


@router.post("/pay-app-excel")
async def import_pay_app_excel(
    file: UploadFile = File(...),
    create_pay_app: bool = Query(False, description="Also create the pay app row from the file's billings"),
    user: CurrentUser = Depends(require_role("admin", "accountant")),
):
    """Read a pay app .xlsx and create project + SOV + COs in the database."""
    contents = await file.read()
    try:
        wb = load_workbook(BytesIO(contents), data_only=True)
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Failed to read Excel file: {e}")

    if SHEET_G703 not in wb.sheetnames or SHEET_702 not in wb.sheetnames:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"File must contain '{SHEET_G703}' and '{SHEET_702}' sheets")

    g703 = wb[SHEET_G703]
    s702 = wb[SHEET_702]

    # Extract project metadata
    project_name = _safe_str(g703[CELL_PROJECT_NAME].value)
    project_no = _safe_str(g703[CELL_PROJECT_NO].value)
    app_no = g703[CELL_APP_NO].value
    period_to = g703[CELL_PERIOD_TO].value
    retention_rate = _safe_float(s702[S702_RETENTION_RATE].value) or 0.10

    if not project_no:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Could not extract project number from cell I3 of G703")
    if not project_name:
        # Fall back to derive from filename or ask user
        project_name = file.filename.split("_-_")[0] if file.filename else f"Project {project_no}"

    # Extract SOV lines (rows 15-72)
    sov_lines = []
    for r in range(SOV_BODY_START, SOV_BODY_END + 1):
        item_no = _safe_str(g703.cell(row=r, column=1).value)
        desc = _safe_str(g703.cell(row=r, column=2).value)
        sched = _safe_float(g703.cell(row=r, column=3).value)
        prev = _safe_float(g703.cell(row=r, column=4).value)
        this_p = _safe_float(g703.cell(row=r, column=5).value)
        stored = _safe_float(g703.cell(row=r, column=6).value)
        if not desc and sched == 0 and prev == 0:
            continue
        sov_lines.append({
            "item_no": item_no,
            "description": desc or f"Line {r - SOV_BODY_START + 1}",
            "scheduled_value": sched,
            "billing": {
                "previous_work": prev,
                "this_period_work": this_p,
                "materials_stored": stored,
            },
            "_row": r,
        })

    # Extract COs (rows 74-76)
    cos = []
    for r in range(CO_BODY_START, CO_BODY_END + 1):
        co_no = _safe_str(g703.cell(row=r, column=1).value)
        desc = _safe_str(g703.cell(row=r, column=2).value)
        amount = _safe_float(g703.cell(row=r, column=3).value)
        prev = _safe_float(g703.cell(row=r, column=4).value)
        this_p = _safe_float(g703.cell(row=r, column=5).value)
        stored = _safe_float(g703.cell(row=r, column=6).value)
        if not desc and amount == 0:
            continue
        cos.append({
            "co_no": co_no or f"CO-{r - CO_BODY_START + 1:03d}",
            "description": desc or f"Change Order {r - CO_BODY_START + 1}",
            "amount": amount,
            "billing": {
                "previous_work": prev,
                "this_period_work": this_p,
                "materials_stored": stored,
            },
            "_row": r,
        })

    # Compute contract value as sum of SOV scheduled_value
    contract_value = sum(s["scheduled_value"] for s in sov_lines)

    sb = get_service_client()

    # Check for existing project
    existing = sb.table("projects").select("*").eq("project_no", project_no).limit(1).execute()
    if existing.data:
        project = existing.data[0]
        action = "matched_existing"
    else:
        proj_payload = {
            "project_no": project_no,
            "name": project_name,
            "contract_value": str(contract_value),
            "retention_rate": str(retention_rate),
            "status": "active",
            "created_by": user.id,
        }
        res = sb.table("projects").insert(proj_payload).execute()
        project = res.data[0]
        action = "created"
        audit.log(user.id, "project", project["id"], "imported_from_excel",
                  after=project, metadata={"source_file": file.filename})

    # Insert SOV lines (only if project was newly created — don't duplicate)
    if action == "created":
        sov_payload = [{
            "project_id": project["id"],
            "item_no": s["item_no"],
            "description": s["description"],
            "scheduled_value": str(s["scheduled_value"]),
            "sort_order": i,
        } for i, s in enumerate(sov_lines)]
        if sov_payload:
            sov_res = sb.table("sov_lines").insert(sov_payload).execute()
            # Map row → inserted id for billing creation later
            for i, s in enumerate(sov_lines):
                s["_db_id"] = sov_res.data[i]["id"]

        co_payload = [{
            "project_id": project["id"],
            "co_no": c["co_no"],
            "description": c["description"],
            "amount": str(c["amount"]),
            "status": "approved",
            "has_retention": True,
        } for c in cos]
        if co_payload:
            co_res = sb.table("change_orders").insert(co_payload).execute()
            for i, c in enumerate(cos):
                c["_db_id"] = co_res.data[i]["id"]
    else:
        # For existing projects, look up SOV/CO ids by description match (best-effort)
        sov_existing = sb.table("sov_lines").select("*").eq("project_id", project["id"]).execute()
        sov_by_desc = {s["description"]: s["id"] for s in sov_existing.data}
        for s in sov_lines:
            s["_db_id"] = sov_by_desc.get(s["description"])
        co_existing = sb.table("change_orders").select("*").eq("project_id", project["id"]).execute()
        co_by_no = {c["co_no"]: c["id"] for c in co_existing.data}
        for c in cos:
            c["_db_id"] = co_by_no.get(c["co_no"])

    result = {
        "project": project,
        "action": action,
        "sov_count": len(sov_lines),
        "co_count": len(cos),
    }

    # Optionally create the pay app row
    if create_pay_app and app_no:
        # Derive period from filename or period_to.
        # Look for the LAST YY-MM pattern in the filename, and ensure month is 01-12.
        # This avoids confusion with project numbers (also formatted like 25-05).
        period = None
        if file.filename:
            import re
            # Find all YY-MM patterns, take the last one where MM is a valid month
            matches = re.findall(r"(\d{2})-(\d{2})", file.filename)
            for yy, mm in reversed(matches):
                if 1 <= int(mm) <= 12:
                    period = f"{yy}-{mm}"
                    break
        if not period and period_to:
            try:
                from datetime import date
                if isinstance(period_to, date):
                    period = f"{period_to.year % 100:02d}-{period_to.month:02d}"
            except Exception:
                pass
        if not period:
            return {**result, "warning": "Could not determine period; pay app not created"}

        # Check for existing
        pa_existing = (sb.table("pay_apps")
                       .select("id").eq("project_id", project["id"])
                       .eq("period", period).limit(1).execute())
        if pa_existing.data:
            return {**result, "pay_app_id": pa_existing.data[0]["id"], "pay_app_action": "exists"}

        pa_payload = {
            "project_id": project["id"],
            "period": period,
            "app_no": int(app_no),
            "period_to": period_to.isoformat() if hasattr(period_to, "isoformat") else None,
            "status": "draft",
        }
        pa_res = sb.table("pay_apps").insert(pa_payload).execute()
        pa = pa_res.data[0]

        # Insert billings
        billing_rows = []
        for s in sov_lines:
            if s.get("_db_id"):
                billing_rows.append({
                    "pay_app_id": pa["id"],
                    "sov_line_id": s["_db_id"],
                    "previous_work": str(s["billing"]["previous_work"]),
                    "this_period_work": str(s["billing"]["this_period_work"]),
                    "materials_stored": str(s["billing"]["materials_stored"]),
                })
        for c in cos:
            if c.get("_db_id"):
                billing_rows.append({
                    "pay_app_id": pa["id"],
                    "change_order_id": c["_db_id"],
                    "previous_work": str(c["billing"]["previous_work"]),
                    "this_period_work": str(c["billing"]["this_period_work"]),
                    "materials_stored": str(c["billing"]["materials_stored"]),
                })
        if billing_rows:
            sb.table("pay_app_billings").insert(billing_rows).execute()

        # Recalc totals
        save_pay_app_totals(pa["id"])

        audit.log(user.id, "pay_app", pa["id"], "imported_from_excel",
                  after=pa, metadata={"source_file": file.filename})
        result["pay_app_id"] = pa["id"]
        result["pay_app_action"] = "created"

    return result
