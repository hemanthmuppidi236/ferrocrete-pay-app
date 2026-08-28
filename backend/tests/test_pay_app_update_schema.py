"""
Security regression: PayAppUpdate must not accept `status` or `paid_amount`.

The generic PATCH /pay-apps/{id} applies PayAppUpdate straight to the DB. If it
accepted `status`, any role allowed to PATCH (including `pe`) could set a pay
app to "approved"/"paid"/"void" directly, bypassing the admin-only approval
workflow. These fields must only change through the guarded workflow endpoints.
"""

import pytest
from pydantic import ValidationError

from app.schemas.pay_apps import PayAppUpdate


def test_status_is_rejected():
    with pytest.raises(ValidationError):
        PayAppUpdate(status="approved")


def test_paid_amount_is_rejected():
    with pytest.raises(ValidationError):
        PayAppUpdate(paid_amount="100000")


def test_unknown_field_is_rejected():
    # extra="forbid" — no silent-ignore of smuggled fields.
    with pytest.raises(ValidationError):
        PayAppUpdate(approved_by="00000000-0000-0000-0000-000000000000")


def test_legitimate_metadata_fields_pass():
    m = PayAppUpdate(notes="hello", retention_billed=True,
                     retention_billed_amount="250.00")
    dumped = m.model_dump(exclude_unset=True)
    assert dumped["notes"] == "hello"
    assert dumped["retention_billed"] is True
    # workflow-controlled fields never appear in the update payload
    assert "status" not in dumped
    assert "paid_amount" not in dumped
