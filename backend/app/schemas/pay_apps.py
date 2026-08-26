"""
Pay app + billing schemas.
"""

from pydantic import BaseModel, Field
from typing import Optional, Literal, List
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


# ─── PAY APP BILLINGS ─────────────────────────────────────────────────

class BillingLine(BaseModel):
    """A single row in the G703 (one per SOV line or CO)."""
    id: Optional[UUID] = None
    sov_line_id: Optional[UUID] = None
    change_order_id: Optional[UUID] = None
    previous_work: Decimal = Decimal("0.00")
    this_period_work: Decimal = Decimal("0.00")
    materials_stored: Decimal = Decimal("0.00")


# ─── PAY APPS ─────────────────────────────────────────────────────────

class PayAppCreate(BaseModel):
    project_id: UUID
    period: str = Field(..., pattern=r"^\d{2}-\d{2}$")
    app_no: int = Field(..., gt=0)
    period_to: date
    due_date: Optional[date] = None
    notes: Optional[str] = None


PayAppStatusLiteral = Literal[
    "draft",
    "pending_approval",
    "approved",
    "submitted",
    "paid",
    "void",
]


class PayAppUpdate(BaseModel):
    """Edit pay app metadata. Billings updated via separate endpoint."""
    period_to: Optional[date] = None
    due_date: Optional[date] = None
    status: Optional[PayAppStatusLiteral] = None
    paid_amount: Optional[Decimal] = None
    notes: Optional[str] = None
    retention_billed: Optional[bool] = None
    retention_billed_amount: Optional[Decimal] = None


class PayAppBillingsUpdate(BaseModel):
    """Replace the full set of billings for a pay app."""
    billings: List[BillingLine]


class PayAppRejectBody(BaseModel):
    """Body for POST /pay-apps/{id}/reject."""
    reason: str = Field(..., min_length=1, max_length=2000)


class PayAppMarkPaidBody(BaseModel):
    """Body for POST /pay-apps/{id}/mark-paid (replaces query-param form)."""
    paid_amount: Decimal


class PayApp(BaseModel):
    id: UUID
    project_id: UUID
    period: str
    app_no: int
    period_to: date
    due_date: Optional[date] = None
    status: PayAppStatusLiteral

    # Computed totals
    original_contract: Decimal
    approved_co_total: Decimal
    revised_contract: Decimal
    total_completed_to_date: Decimal
    retention_held: Decimal
    earned_less_retention: Decimal
    previous_certificates: Decimal
    current_payment_due: Decimal
    balance_to_finish: Decimal

    # Workflow timestamps and actors
    submitted_for_approval_at: Optional[datetime] = None
    submitted_for_approval_by: Optional[UUID] = None
    approved_at: Optional[datetime] = None
    approved_by: Optional[UUID] = None
    rejected_at: Optional[datetime] = None
    rejected_by: Optional[UUID] = None
    rejection_reason: Optional[str] = None
    sent_to_gc_at: Optional[datetime] = None
    sent_to_gc_by: Optional[UUID] = None
    sent_to_gc_email: Optional[str] = None

    # Legacy single-submit (preserved for already-submitted historical rows)
    submitted_at: Optional[datetime] = None
    submitted_by: Optional[UUID] = None

    paid_at: Optional[datetime] = None
    paid_amount: Optional[Decimal] = None

    # Retention billed this period (manager feedback #6)
    retention_billed: bool = False
    retention_billed_amount: Decimal = Decimal("0")

    # Ferrocrete's own waivers sent (WI-5)
    cpcf_sent_at: Optional[date] = None
    upuf_sent_at: Optional[date] = None

    excel_file_path: Optional[str] = None
    pdf_file_path: Optional[str] = None
    excel_generated_at: Optional[datetime] = None
    pdf_generated_at: Optional[datetime] = None

    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class PayAppDetail(PayApp):
    """Full pay app with its line billings."""
    billings: List[BillingLine] = []


# ─── ARTIFACTS (Excel / PDF generation responses) ─────────────────────

class GeneratedFile(BaseModel):
    file_path: str          # Storage path (e.g., "pay-apps/26-05/seagaze.xlsx")
    download_url: str       # Signed URL valid for ~1 hour
    generated_at: datetime
