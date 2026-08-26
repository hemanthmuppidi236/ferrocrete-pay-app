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

    # Auto financial columns (recomputed from pay app + release tracker).
    # Column letters match the reference sheet 26-08.
    revised_contract: Decimal                 # E
    total_completed: Decimal                  # F
    retention: Decimal                        # G
    balance_to_finish: Decimal                # H = E − F
    balance_with_retention: Decimal           # I = E − F + G
    gross_billing: Decimal                    # J
    retention_rate: Decimal                   # K
    billed_amount: Decimal                    # L = J × (1 − K)
    potential_net: Optional[Decimal] = None   # M  ← release tracker (Ferrocrete Net)

    # Manual (auto-defaulted, override wins)
    billing_due_date: str = ""                # D
    bt_note: str = ""                         # N
    rebar: Optional[Decimal] = None           # O
    cmu: Optional[Decimal] = None             # P
    cpcf_sent: str = ""                        # Q
    upuf_sent: str = ""                        # R
    billing_contact: str = ""                 # S
    payment_status: str = ""                  # T

    has_pay_app: bool = False
    pay_app_id: Optional[UUID] = None


class BillingSummaryTotals(BaseModel):
    # Totals row: E, F, G, H, J, L, M, O, P.
    revised_contract: Decimal
    total_completed: Decimal
    retention: Decimal
    balance_to_finish: Decimal
    gross_billing: Decimal
    billed_amount: Decimal
    potential_net: Decimal
    rebar: Decimal
    cmu: Decimal


class BillingSummaryAccrued(BaseModel):
    """Cumulative figures across every period up to and including the selected one."""
    net: Decimal                          # Net income accrued to date (Σ Potential Net)
    billed: Decimal                       # Total billed to date (Σ current payment due)


class BillingSummaryFooter(BaseModel):
    """Footer reconciliation metrics matching the Excel."""
    net_pct_of_billed: Optional[Decimal] = None    # M total / L total
    quickbooks_total: Optional[Decimal] = None     # manual, per period
    quickbooks_diff: Optional[Decimal] = None      # Quickbooks − Billed total
    running_total_billed: Decimal = Decimal("0")   # Σ Billed across the year


class BillingSummaryResponse(BaseModel):
    period: Optional[str] = None
    available_periods: List[str] = []
    rows: List[BillingSummaryRow] = []
    totals: BillingSummaryTotals
    accrued: BillingSummaryAccrued
    footer: BillingSummaryFooter


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


class QuickbooksUpdate(BaseModel):
    """Set the per-period Quickbooks total (footer reconciliation)."""
    period: str = Field(..., pattern=r"^\d{2}-\d{2}$")
    quickbooks_total: Optional[Decimal] = None
