"""
Pydantic schemas — request bodies and response shapes for the API.

Naming convention:
  - `XYZCreate`: input for POST
  - `XYZUpdate`: input for PATCH (all fields optional)
  - `XYZ`:       full output shape (for GET)
"""

from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, Literal
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID


# ─── PROJECTS ─────────────────────────────────────────────────────────

class ProjectBase(BaseModel):
    project_no: str = Field(..., max_length=20)
    name: str
    address: Optional[str] = None
    gc_company: Optional[str] = None
    gc_contact_name: Optional[str] = None
    gc_contact_email: Optional[EmailStr] = None
    gc_contact_phone: Optional[str] = None
    contract_value: Decimal = Decimal("0.00")
    retention_rate: Decimal = Decimal("0.10")
    retention_drops_at_50_pct: bool = False
    retention_rate_after_50: Optional[Decimal] = None
    status: Literal["active", "closed", "on_hold"] = "active"
    started_at: Optional[date] = None
    substantial_completion_at: Optional[date] = None
    notes: Optional[str] = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    gc_company: Optional[str] = None
    gc_contact_name: Optional[str] = None
    gc_contact_email: Optional[EmailStr] = None
    gc_contact_phone: Optional[str] = None
    contract_value: Optional[Decimal] = None
    retention_rate: Optional[Decimal] = None
    retention_drops_at_50_pct: Optional[bool] = None
    retention_rate_after_50: Optional[Decimal] = None
    status: Optional[Literal["active", "closed", "on_hold"]] = None
    started_at: Optional[date] = None
    substantial_completion_at: Optional[date] = None
    notes: Optional[str] = None


class Project(ProjectBase):
    id: UUID
    created_by: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime


# ─── SOV LINES ────────────────────────────────────────────────────────

class SOVLineBase(BaseModel):
    item_no: Optional[str] = None
    description: str
    scheduled_value: Decimal = Decimal("0.00")
    sort_order: int = 0


class SOVLineCreate(SOVLineBase):
    pass


class SOVLineUpdate(BaseModel):
    item_no: Optional[str] = None
    description: Optional[str] = None
    scheduled_value: Optional[Decimal] = None
    sort_order: Optional[int] = None


class SOVLine(SOVLineBase):
    id: UUID
    project_id: UUID
    created_at: datetime
    updated_at: datetime


# ─── CHANGE ORDERS ────────────────────────────────────────────────────

class ChangeOrderBase(BaseModel):
    co_no: str
    description: str
    amount: Decimal
    status: Literal["pending", "approved", "rejected", "void"] = "pending"
    has_retention: bool = True
    submitted_at: Optional[date] = None
    approved_at: Optional[date] = None
    notes: Optional[str] = None


class ChangeOrderCreate(ChangeOrderBase):
    pass


class ChangeOrderUpdate(BaseModel):
    description: Optional[str] = None
    amount: Optional[Decimal] = None
    status: Optional[Literal["pending", "approved", "rejected", "void"]] = None
    has_retention: Optional[bool] = None
    submitted_at: Optional[date] = None
    approved_at: Optional[date] = None
    notes: Optional[str] = None


class ChangeOrder(ChangeOrderBase):
    id: UUID
    project_id: UUID
    created_at: datetime
    updated_at: datetime
