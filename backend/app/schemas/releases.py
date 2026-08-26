"""
Release tracker + sub schemas.
"""

from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Literal, List
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


# ─── SUBS ─────────────────────────────────────────────────────────────

class SubBase(BaseModel):
    name: str
    parent_sub_id: Optional[UUID] = None
    default_release_type: Optional[Literal["CP", "UP", "CF", "UF"]] = None
    contact_name: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    billing_email: Optional[EmailStr] = None
    billing_cc: Optional[EmailStr] = None
    is_non_prelimed: bool = False
    sort_order: int = 0
    active: bool = True


class SubCreate(SubBase):
    pass


class SubUpdate(BaseModel):
    name: Optional[str] = None
    default_release_type: Optional[Literal["CP", "UP", "CF", "UF"]] = None
    contact_name: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    billing_email: Optional[EmailStr] = None
    billing_cc: Optional[EmailStr] = None
    is_non_prelimed: Optional[bool] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class Sub(SubBase):
    id: UUID
    project_id: UUID
    created_at: datetime
    updated_at: datetime


# ─── RELEASE LINES ────────────────────────────────────────────────────

# WI-2 per-line lifecycle enums.
BillStatus = Literal["not_requested", "requested", "received", "not_applicable"]
WaiverStatus = Literal[
    "not_requested", "requested", "received", "verified", "sent_to_gc", "not_applicable"
]
CheckType = Literal["joint", "individual", "none"]
Stage = Literal[
    "n/a", "awaiting_bill", "awaiting_conditional", "awaiting_gc_payment",
    "awaiting_check_release", "awaiting_unconditional", "complete",
]


class ReleaseLineUpdate(BaseModel):
    sub_id: UUID
    billed_amount: Decimal = Decimal("0.00")
    check_amount: Decimal = Decimal("0.00")
    release_type: Optional[Literal["CP", "UP", "CF", "UF"]] = None
    exception: Optional[str] = None
    prev_month_status: Optional[str] = None
    # Per-line lifecycle (WI-2). All optional so partial saves are fine.
    bill_status: Optional[BillStatus] = None
    bill_requested_at: Optional[date] = None
    bill_received_at: Optional[date] = None
    bill_due_at: Optional[date] = None
    conditional_status: Optional[WaiverStatus] = None
    conditional_received_at: Optional[date] = None
    conditional_sent_at: Optional[date] = None
    check_type: Optional[CheckType] = None
    check_received_at: Optional[date] = None
    check_sent_to_sub_at: Optional[date] = None
    unconditional_status: Optional[WaiverStatus] = None
    unconditional_requested_at: Optional[date] = None
    unconditional_received_at: Optional[date] = None
    unconditional_sent_at: Optional[date] = None
    difference_note: Optional[str] = None


class ReleaseLine(BaseModel):
    id: UUID
    release_tracker_id: UUID
    sub_id: UUID
    sub_name: Optional[str] = None        # joined for convenience
    parent_sub_id: Optional[UUID] = None  # joined for grouping
    is_non_prelimed: bool = False         # joined; drives which stages apply
    billed_amount: Decimal
    check_amount: Decimal
    release_type: Optional[str] = None
    exception: Optional[str] = None
    prev_month_status: Optional[str] = None
    # Per-line lifecycle (WI-2).
    bill_status: BillStatus = "not_requested"
    bill_requested_at: Optional[date] = None
    bill_received_at: Optional[date] = None
    bill_due_at: Optional[date] = None
    conditional_status: WaiverStatus = "not_requested"
    conditional_received_at: Optional[date] = None
    conditional_sent_at: Optional[date] = None
    check_type: Optional[CheckType] = None
    check_received_at: Optional[date] = None
    check_sent_to_sub_at: Optional[date] = None
    unconditional_status: WaiverStatus = "not_requested"
    unconditional_requested_at: Optional[date] = None
    unconditional_received_at: Optional[date] = None
    unconditional_sent_at: Optional[date] = None
    difference_note: Optional[str] = None
    # Derived, computed server-side on the detail payload.
    stage: Optional[Stage] = None
    is_overdue: bool = False
    has_email: bool = False               # sub has a billing/contact email (WI-3)
    last_reminder: Optional[dict] = None  # {template_key, sent_at} of most recent
    created_at: datetime
    updated_at: datetime


# ─── RELEASE TRACKERS ─────────────────────────────────────────────────

class ReleaseTrackerCreate(BaseModel):
    project_id: UUID
    period: str = Field(..., pattern=r"^\d{2}-\d{2}$")
    pay_app_id: Optional[UUID] = None
    invoice_amount: Optional[Decimal] = None


class ReleaseTrackerUpdate(BaseModel):
    invoice_amount: Optional[Decimal] = None
    invoice_amount_overridden: Optional[bool] = None
    conditional_through_date: Optional[date] = None
    requested_releases: Optional[bool] = None
    verified_releases: Optional[bool] = None
    approved: Optional[bool] = None
    sent_to_gc: Optional[bool] = None
    buildertrend_total: Optional[Decimal] = None
    less_misc_field_expenses: Optional[Decimal] = None
    notes: Optional[str] = None


class ReleaseTrackerLinesUpdate(BaseModel):
    """Replace the full set of release lines for a tracker."""
    lines: List[ReleaseLineUpdate]


class ReleaseUnbilledEntry(BaseModel):
    id: Optional[UUID] = None
    description: Optional[str] = None
    amount: Decimal = Decimal("0.00")
    sort_order: int


class ReleaseTracker(BaseModel):
    id: UUID
    project_id: UUID
    pay_app_id: Optional[UUID] = None
    period: str
    invoice_amount: Optional[Decimal] = None
    invoice_amount_overridden: bool = False
    conditional_through_date: Optional[date] = None
    requested_releases: bool
    verified_releases: bool
    approved: bool
    sent_to_gc: bool
    buildertrend_total: Optional[Decimal] = None
    less_misc_field_expenses: Optional[Decimal] = None
    excel_file_path: Optional[str] = None
    excel_generated_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # Derived stage summary (WI-2) — populated on list/detail responses.
    stage_counts: Optional[dict] = None
    applicable_count: Optional[int] = None
    complete_count: Optional[int] = None
    overdue_count: Optional[int] = None


class ReleaseTrackerDetail(ReleaseTracker):
    """Full tracker with lines + unbilled entries."""
    lines: List[ReleaseLine] = []
    unbilled_entries: List[ReleaseUnbilledEntry] = []
    # Ferrocrete's net income for this project/period:
    #   invoice − Σ(sub checks) − Σ(prev-month unbilled)
    # This is the value the Billing Summary's "Potential Net" column consumes.
    ferrocrete_net: Optional[Decimal] = None
    # Retention billed on the linked pay app this period (provision, #6).
    retention_billed_amount: Optional[Decimal] = None


# ─── WAIVERS ──────────────────────────────────────────────────────────

class Waiver(BaseModel):
    id: UUID
    release_line_id: UUID
    waiver_type: Literal["CP", "UP", "CF", "UF"]
    file_path: str
    file_name: str
    file_size_bytes: Optional[int] = None
    mime_type: Optional[str] = None
    received_at: Optional[date] = None
    uploaded_by: Optional[UUID] = None
    uploaded_at: datetime
    notes: Optional[str] = None
