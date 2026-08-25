"""
Unit tests for the Billing Summary math (pure functions — no DB).
"""

from decimal import Decimal

from app.core import billing_math as bm


# ─── ferrocrete_net ───────────────────────────────────────────────────

def test_net_basic():
    # invoice 450,000 − checks 120,000 − unbilled 11,633.25 = 318,366.75
    assert bm.ferrocrete_net("450000", "120000", "11633.25") == Decimal("318366.75")


def test_net_no_invoice_is_none():
    # No billing → None (renders as "—"), not a misleading negative.
    assert bm.ferrocrete_net(None, "5000", "0") is None
    assert bm.ferrocrete_net("", "5000", "0") is None


def test_net_can_be_negative():
    # Checks exceed invoice (over-paid subs this period) → negative net is real.
    assert bm.ferrocrete_net("1000", "1500", "0") == Decimal("-500")


def test_net_zero_checks():
    assert bm.ferrocrete_net("2000", 0, 0) == Decimal("2000")


# ─── gross_from_billed ────────────────────────────────────────────────

def test_gross_inverts_retention():
    # K = I*(1-J)  →  I = K/(1-J). billed 2,447,877.85 @ 10% → 2,719,864.28
    assert bm.gross_from_billed("2447877.85", "0.10") == Decimal("2719864.28")


def test_gross_zero_retention_equals_billed():
    assert bm.gross_from_billed("450000", "0") == Decimal("450000")


def test_gross_guards_full_retention():
    assert bm.gross_from_billed("500", "1") == Decimal("500")


# ─── humanize_status ──────────────────────────────────────────────────

def test_humanize_status():
    assert bm.humanize_status("submitted") == "Sent to client"
    assert bm.humanize_status("pending_approval") == "Pending approval"
    assert bm.humanize_status(None) == ""
    assert bm.humanize_status("weird") == "weird"


# ─── assemble_row ─────────────────────────────────────────────────────

PROJECT = {
    "id": "p1", "project_no": "25-16", "name": "Bungalows",
    "contract_value": "20436364.28", "retention_rate": "0.10",
    "gc_contact_email": "gc@example.com", "status": "active",
}


def test_assemble_row_full():
    pay_app = {
        "id": "pa1", "due_date": "2026-06-30", "status": "submitted",
        "revised_contract": "20436364.28", "total_completed_to_date": "9302864.28",
        "retention_held": "930286.44", "current_payment_due": "2447877.85",
    }
    row = bm.assemble_row(
        project=PROJECT, pay_app=pay_app, net=Decimal("892065.37"),
        override={}, co_total=Decimal("0"),
        waiver_flags={"cp_cf": True, "up_uf": False},
    )
    assert row["job"] == "25-16 - Bungalows"
    assert row["billed_amount"] == Decimal("2447877.85")            # K
    assert row["gross_billing"] == Decimal("2719864.28")           # I = K/(1-J)
    # H = E − F + G
    assert row["balance_to_finish"] == Decimal("20436364.28") - Decimal("9302864.28") + Decimal("930286.44")
    assert row["potential_net"] == Decimal("892065.37")            # L
    assert row["cpcf_sent"] == "Yes"      # auto from waiver
    assert row["upuf_sent"] == ""         # no UP/UF waiver
    assert row["billing_contact"] == "gc@example.com"
    assert row["payment_status"] == "Sent to client"


def test_assemble_row_override_wins():
    pay_app = {"status": "draft", "revised_contract": "100", "current_payment_due": "0",
               "total_completed_to_date": "0", "retention_held": "0", "due_date": "2026-06-30"}
    override = {
        "billing_due_date": "25th", "bt_note": "waiting on COs",
        "cpcf_sent": "No", "billing_contact": "override@x.com",
        "payment_status": "FedEx sent 7/24", "rebar": "1200.50",
    }
    row = bm.assemble_row(
        project=PROJECT, pay_app=pay_app, net=None, override=override,
        co_total=Decimal("0"), waiver_flags={"cp_cf": True},
    )
    assert row["billing_due_date"] == "25th"          # override beats pay-app due_date
    assert row["bt_note"] == "waiting on COs"
    assert row["cpcf_sent"] == "No"                   # override beats waiver auto "Yes"
    assert row["billing_contact"] == "override@x.com"
    assert row["payment_status"] == "FedEx sent 7/24"
    assert row["rebar"] == Decimal("1200.50")
    assert row["potential_net"] is None               # renders as —


def test_assemble_row_no_payapp_uses_contract_plus_co():
    row = bm.assemble_row(
        project=PROJECT, pay_app=None, net=None, override={},
        co_total=Decimal("500000"), waiver_flags={},
    )
    assert row["revised_contract"] == Decimal("20436364.28") + Decimal("500000")
    assert row["total_completed"] == Decimal("0")
    assert row["billed_amount"] == Decimal("0")
    assert row["has_pay_app"] is False
    assert row["payment_status"] == ""


# ─── summarize_totals ─────────────────────────────────────────────────

def test_summarize_totals_skips_none_net():
    rows = [
        {"revised_contract": Decimal("100"), "total_completed": Decimal("0"),
         "retention": Decimal("0"), "balance_to_finish": Decimal("100"),
         "gross_billing": Decimal("50"), "billed_amount": Decimal("45"),
         "potential_net": Decimal("30")},
        {"revised_contract": Decimal("200"), "total_completed": Decimal("0"),
         "retention": Decimal("0"), "balance_to_finish": Decimal("200"),
         "gross_billing": Decimal("0"), "billed_amount": Decimal("0"),
         "potential_net": None},
    ]
    t = bm.summarize_totals(rows)
    assert t["revised_contract"] == Decimal("300")
    assert t["billed_amount"] == Decimal("45")
    assert t["potential_net"] == Decimal("30")   # None skipped, not treated as 0-error
