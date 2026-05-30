"""
Tests for the pure G702/G703 math.

These cover the calculation behavior in isolation from Supabase — the
DB-loading wrapper `calculate_pay_app_totals` is a thin shim around
`compute_totals`, so the math itself is fully exercised here.
"""

from decimal import Decimal

import pytest

from app.core.pay_app_math import compute_totals


# ─── helpers ────────────────────────────────────────────────────────

def D(s):
    """Shorthand: Decimal from string/number."""
    return Decimal(str(s))


def sov_billing(line_id, prev=0, this_period=0, stored=0):
    return {
        "sov_line_id": line_id,
        "change_order_id": None,
        "previous_work": str(prev),
        "this_period_work": str(this_period),
        "materials_stored": str(stored),
    }


def co_billing(co_id, prev=0, this_period=0, stored=0):
    return {
        "sov_line_id": None,
        "change_order_id": co_id,
        "previous_work": str(prev),
        "this_period_work": str(this_period),
        "materials_stored": str(stored),
    }


def co(co_id, amount, status="approved", has_retention=True):
    return {
        "id": co_id,
        "amount": str(amount),
        "status": status,
        "has_retention": has_retention,
    }


# ─── tests ──────────────────────────────────────────────────────────

def test_basic_first_period_with_retention():
    """App #1 of a project: no prior work. Retention applies to all SOV billing."""
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.10"),
        change_orders=[],
        billings=[
            sov_billing("sov1", prev=0, this_period=20000),
            sov_billing("sov2", prev=0, this_period=10000),
        ],
    )
    assert totals["original_contract"] == D("100000.00")
    assert totals["approved_co_total"] == D("0.00")
    assert totals["revised_contract"] == D("100000.00")
    assert totals["total_completed_to_date"] == D("30000.00")
    assert totals["retention_held"] == D("3000.00")        # 10% of 30k
    assert totals["earned_less_retention"] == D("27000.00")
    assert totals["previous_certificates"] == D("0.00")    # no prior work
    assert totals["current_payment_due"] == D("27000.00")  # all of earned_less_ret
    assert totals["balance_to_finish"] == D("73000.00")


def test_carry_forward_previous_certificates_derived_from_column_d():
    """The fix: previous_certificates derives from column D (previous_work),
    not from prior pay app row status. Verifies the Melodia-style scenario
    where prior apps may be drafts or entirely absent."""
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.10"),
        change_orders=[],
        # Column D = 30000 → represents $30k billed in prior periods.
        # Column E = 15000 → $15k this period.
        billings=[
            sov_billing("sov1", prev=20000, this_period=10000),
            sov_billing("sov2", prev=10000, this_period=5000),
        ],
    )
    # Total completed = 45,000; retention = 4,500; earned less ret = 40,500
    assert totals["total_completed_to_date"] == D("45000.00")
    assert totals["retention_held"] == D("4500.00")
    assert totals["earned_less_retention"] == D("40500.00")
    # Previous certificates = 30,000 (col D total) × 0.9 = 27,000
    assert totals["previous_certificates"] == D("27000.00")
    # Current due = 40,500 - 27,000 = 13,500 (= this period $15k × 0.9)
    assert totals["current_payment_due"] == D("13500.00")
    assert totals["balance_to_finish"] == D("59500.00")


def test_co_with_no_retention_excluded_from_retention_calc():
    """A CO with has_retention=False (e.g., bond fees) should NOT have
    retention withheld, even though it contributes to total_completed."""
    cos = [
        co("co1", amount=5000, status="approved", has_retention=True),
        co("co2", amount=2000, status="approved", has_retention=False),  # bond fee
    ]
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.10"),
        change_orders=cos,
        billings=[
            sov_billing("sov1", this_period=10000),
            co_billing("co1", this_period=5000),    # retainable
            co_billing("co2", this_period=2000),    # NOT retainable
        ],
    )
    assert totals["approved_co_total"] == D("7000.00")
    assert totals["revised_contract"] == D("107000.00")
    assert totals["total_completed_to_date"] == D("17000.00")
    # Retention only on $15k (sov + retainable CO), not on the bond fee
    assert totals["retention_held"] == D("1500.00")
    assert totals["earned_less_retention"] == D("15500.00")
    assert totals["current_payment_due"] == D("15500.00")


def test_unapproved_co_excluded_from_contract_total():
    """COs in 'pending' or 'rejected' status are not in the revised contract."""
    cos = [
        co("co1", amount=5000, status="approved"),
        co("co2", amount=3000, status="pending"),
        co("co3", amount=2000, status="rejected"),
    ]
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.10"),
        change_orders=cos,
        billings=[],
    )
    assert totals["approved_co_total"] == D("5000.00")
    assert totals["revised_contract"] == D("105000.00")


def test_materials_stored_counted_in_completed_and_retention():
    """Column F (materials stored) behaves like column E for the math —
    counts toward total completed and (for SOV) toward retention."""
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.10"),
        change_orders=[],
        billings=[
            sov_billing("sov1", this_period=10000, stored=5000),
        ],
    )
    assert totals["total_completed_to_date"] == D("15000.00")
    assert totals["retention_held"] == D("1500.00")
    assert totals["earned_less_retention"] == D("13500.00")


def test_rounding_to_cents():
    """Retention rates can produce fractional cents — verify quantize to 0.01."""
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.0725"),    # 7.25%
        change_orders=[],
        billings=[
            sov_billing("sov1", this_period=333.33),
        ],
    )
    # 333.33 × 0.0725 = 24.16,... → 24.17 (ROUND_HALF_EVEN default)
    # Just assert it has at most 2 decimal places and the obvious total.
    assert totals["total_completed_to_date"] == D("333.33")
    assert totals["retention_held"].as_tuple().exponent == -2
    # Earned less retention + retention must equal total completed (within cents).
    assert totals["earned_less_retention"] + totals["retention_held"] == D("333.33")


def test_zero_retention_rate():
    """A project with no retention (rare but possible) should pass through cleanly."""
    totals = compute_totals(
        contract_value=D("50000"),
        retention_rate=D("0"),
        change_orders=[],
        billings=[
            sov_billing("sov1", prev=10000, this_period=5000),
        ],
    )
    assert totals["retention_held"] == D("0.00")
    assert totals["earned_less_retention"] == D("15000.00")
    assert totals["previous_certificates"] == D("10000.00")
    assert totals["current_payment_due"] == D("5000.00")


def test_empty_billings():
    """A pay app with no billings yet (just created) reports zeros for all
    derived totals but still computes contract figures."""
    totals = compute_totals(
        contract_value=D("100000"),
        retention_rate=D("0.10"),
        change_orders=[co("co1", amount=5000, status="approved")],
        billings=[],
    )
    assert totals["revised_contract"] == D("105000.00")
    assert totals["total_completed_to_date"] == D("0.00")
    assert totals["retention_held"] == D("0.00")
    assert totals["earned_less_retention"] == D("0.00")
    assert totals["previous_certificates"] == D("0.00")
    assert totals["current_payment_due"] == D("0.00")
    assert totals["balance_to_finish"] == D("105000.00")


def test_melodia_style_app_5_scenario():
    """Regression test for the original bug: prior pay apps are absent (or
    drafts), but per-line column D values were imported correctly from the
    spreadsheet. previous_certificates must be derived from column D so that
    'current payment due' shows the PERIOD payment, not billed-to-date."""
    # Simulate Melodia App #5: $300k billed prior, $50k this period, 10% retention.
    totals = compute_totals(
        contract_value=D("400000"),
        retention_rate=D("0.10"),
        change_orders=[],
        billings=[
            # Single-line approximation; real Melodia has many SOV lines but
            # the math is line-additive.
            sov_billing("sov1", prev=300000, this_period=50000),
        ],
    )
    assert totals["total_completed_to_date"] == D("350000.00")
    assert totals["earned_less_retention"] == D("315000.00")
    assert totals["previous_certificates"] == D("270000.00")   # 300k × 0.9
    # Current period payment = 50k × 0.9 = 45k (NOT 315k, which was the bug)
    assert totals["current_payment_due"] == D("45000.00")
