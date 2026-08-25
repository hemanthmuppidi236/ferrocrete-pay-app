"""
Billing Period Summary schemas.
"""

from pydantic import BaseModel, Field
from typing import Optional, List
from decimal import Decimal
from uuid import UUID


class BillingSummaryRow(BaseModel):
    project_id: UUID
    project_no: str
    project_name: str
    job: str

    # Auto financial columns (recomputed from pay app + release tracker)
    revised_contract: Decimal            # E
    total_completed: Decimal             # F
    retention: Decimal                   # G
    balance_to_finish: Decimal           # H = E − F + G
    gross_billing: Decimal               # I
    retention_rate: Decimal              # J
    billed_amount: Decimal               # K
    potential_net: Optional[Decimal] = None   # L  ← release tracker (Ferrocrete Net)

    # Manual (auto-defaulted, override wins)
    billing_due_date: str = ""
    bt_note: str = ""
    rebar: Optional[Decimal] = None
    cmu: Optional[Decimal] = None
    cpcf_sent: str = ""                   # P
    upuf_sent: str = ""                   # Q
    billing_contact: str = ""
    payment_status: str = ""

    has_pay_app: bool = False
    pay_app_id: Optional[UUID] = None


class BillingSummaryTotals(BaseModel):
    revised_contract: Decimal
    total_completed: Decimal
    retention: Decimal
    balance_to_finish: Decimal
    gross_billing: Decimal
    billed_amount: Decimal
    potential_net: Decimal


class BillingSummaryAccrued(BaseModel):
    """Cumulative figures across every period up to and including the selected one."""
    net: Decimal                          # Net income accrued to date (Σ Potential Net)
    billed: Decimal                       # Total billed to date (Σ current payment due)


class BillingSummaryResponse(BaseModel):
    period: Optional[str] = None
    available_periods: List[str] = []
    rows: List[BillingSummaryRow] = []
    totals: BillingSummaryTotals
    accrued: BillingSummaryAccrued


class BillingOverrideUpdate(BaseModel):
    """Upsert the manual columns for one (project, period) cell-set."""
    project_id: UUID
    period: str = Field(..., pattern=r"^\d{2}-\d{2}$")
    billing_due_date: Optional[str] = None
    bt_note: Optional[str] = None
    rebar: Optional[Decimal] = None
    cmu: Optional[Decimal] = None
    cpcf_sent: Optional[str] = None
    upuf_sent: Optional[str] = None
    billing_contact: Optional[str] = None
    payment_status: Optional[str] = None
