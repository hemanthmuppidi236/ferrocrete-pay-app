"""
WI-2: per-line stage derivation, overdue detection, and derived tracker flags.
"""

from datetime import date

from app.core import release_stage as rs


def _line(**kw):
    base = {
        "billed_amount": "1000", "check_amount": "0",
        "bill_status": "not_requested",
        "conditional_status": "not_requested",
        "unconditional_status": "not_requested",
        "check_received_at": None, "check_sent_to_sub_at": None,
        "bill_due_at": None, "unconditional_requested_at": None,
    }
    base.update(kw)
    return base


# ─── stage progression (prelimed) ─────────────────────────────────────

def test_zero_amount_is_na():
    assert rs.derive_stage(_line(billed_amount="0", check_amount="0"), False) == rs.STAGE_NA


def test_not_applicable_is_na():
    assert rs.derive_stage(_line(bill_status="not_applicable"), False) == rs.STAGE_NA


def test_awaiting_bill_until_received():
    assert rs.derive_stage(_line(bill_status="requested"), False) == rs.STAGE_BILL


def test_awaiting_conditional_after_bill():
    ln = _line(bill_status="received", conditional_status="not_requested")
    assert rs.derive_stage(ln, False) == rs.STAGE_CONDITIONAL


def test_conditional_received_advances_to_gc_payment():
    # Acceptance: uploading a CP sets conditional_status='received' -> stage advances
    ln = _line(bill_status="received", conditional_status="received")
    assert rs.derive_stage(ln, False) == rs.STAGE_GC_PAYMENT


def test_awaiting_check_release_after_gc_pays():
    ln = _line(bill_status="received", conditional_status="verified",
               check_received_at="2026-07-10")
    assert rs.derive_stage(ln, False) == rs.STAGE_CHECK_RELEASE


def test_awaiting_unconditional_after_check_released():
    ln = _line(bill_status="received", conditional_status="sent_to_gc",
               check_received_at="2026-07-10", check_sent_to_sub_at="2026-07-12",
               unconditional_status="requested")
    assert rs.derive_stage(ln, False) == rs.STAGE_UNCONDITIONAL


def test_complete_when_unconditional_sent():
    ln = _line(bill_status="received", conditional_status="sent_to_gc",
               check_received_at="2026-07-10", check_sent_to_sub_at="2026-07-12",
               unconditional_status="sent_to_gc")
    assert rs.derive_stage(ln, False) == rs.STAGE_COMPLETE


# ─── non-prelimed flow ────────────────────────────────────────────────

def test_non_prelimed_skips_conditional_and_unconditional():
    # bill received, no conditional needed -> straight to check release
    ln = _line(billed_amount="0", check_amount="500", bill_status="received",
               conditional_status="not_applicable", unconditional_status="not_applicable")
    assert rs.derive_stage(ln, True) == rs.STAGE_CHECK_RELEASE
    ln["check_sent_to_sub_at"] = "2026-07-12"
    assert rs.derive_stage(ln, True) == rs.STAGE_COMPLETE


# ─── overdue ──────────────────────────────────────────────────────────

def test_overdue_past_bill_due_with_no_conditional():
    ln = _line(bill_status="requested", bill_due_at="2026-07-01")
    stage = rs.derive_stage(ln, False)
    assert rs.is_overdue(ln, stage, today=date(2026, 7, 15)) is True


def test_not_overdue_before_due():
    ln = _line(bill_status="requested", bill_due_at="2026-07-20")
    stage = rs.derive_stage(ln, False)
    assert rs.is_overdue(ln, stage, today=date(2026, 7, 15)) is False


def test_overdue_unconditional_requested_over_7_days():
    ln = _line(bill_status="received", conditional_status="sent_to_gc",
               check_received_at="2026-07-01", check_sent_to_sub_at="2026-07-02",
               unconditional_status="requested", unconditional_requested_at="2026-07-01")
    stage = rs.derive_stage(ln, False)
    assert stage == rs.STAGE_UNCONDITIONAL
    assert rs.is_overdue(ln, stage, today=date(2026, 7, 15)) is True
    assert rs.is_overdue(ln, stage, today=date(2026, 7, 5)) is False


def test_complete_line_never_overdue():
    ln = _line(bill_status="received", conditional_status="sent_to_gc",
               check_received_at="2026-07-10", check_sent_to_sub_at="2026-07-12",
               unconditional_status="sent_to_gc", bill_due_at="2020-01-01")
    stage = rs.derive_stage(ln, False)
    assert rs.is_overdue(ln, stage, today=date(2026, 8, 1)) is False


# ─── derived tracker flags ────────────────────────────────────────────

def test_flags_false_when_no_applicable_lines():
    lines = [(_line(billed_amount="0", check_amount="0"), False)]
    f = rs.derive_tracker_flags(lines)
    assert f == {"requested_releases": False, "verified_releases": False, "sent_to_gc": False}


def test_requested_flag_true_when_all_bills_requested():
    lines = [
        (_line(bill_status="requested"), False),
        (_line(bill_status="received", check_amount="10"), False),
    ]
    assert rs.derive_tracker_flags(lines)["requested_releases"] is True


def test_requested_flag_false_if_one_line_not_requested():
    lines = [
        (_line(bill_status="requested"), False),
        (_line(bill_status="not_requested"), False),
    ]
    assert rs.derive_tracker_flags(lines)["requested_releases"] is False


def test_sent_to_gc_flag_true_only_when_all_unconditional_sent():
    # Acceptance: set every applicable line's unconditional to sent_to_gc -> Sent
    lines = [
        (_line(bill_status="received", conditional_status="sent_to_gc",
               unconditional_status="sent_to_gc"), False),
        (_line(bill_status="received", conditional_status="sent_to_gc",
               unconditional_status="sent_to_gc", check_amount="5"), False),
    ]
    f = rs.derive_tracker_flags(lines)
    assert f["sent_to_gc"] is True and f["verified_releases"] is True

    lines[1][0]["unconditional_status"] = "received"
    assert rs.derive_tracker_flags(lines)["sent_to_gc"] is False


def test_non_prelimed_not_blocking_verified_or_sent():
    # A non-prelimed applicable line (not_applicable conditional/unconditional)
    # must not hold back verified_releases / sent_to_gc.
    lines = [
        (_line(bill_status="received", conditional_status="sent_to_gc",
               unconditional_status="sent_to_gc"), False),
        (_line(billed_amount="0", check_amount="500", bill_status="received",
               conditional_status="not_applicable",
               unconditional_status="not_applicable", check_sent_to_sub_at="2026-07-12"), True),
    ]
    f = rs.derive_tracker_flags(lines)
    assert f["verified_releases"] is True and f["sent_to_gc"] is True


def test_summarize_stages_counts():
    lines = [
        (_line(bill_status="requested"), False),                       # awaiting_bill
        (_line(bill_status="received", conditional_status="received",
               check_received_at="2026-07-10", check_sent_to_sub_at="2026-07-11",
               unconditional_status="requested"), False),             # awaiting_unconditional
        (_line(billed_amount="0", check_amount="0"), False),          # n/a
    ]
    s = rs.summarize_stages(lines)
    assert s["applicable_count"] == 2
    assert s["stage_counts"][rs.STAGE_BILL] == 1
    assert s["stage_counts"][rs.STAGE_UNCONDITIONAL] == 1
    assert s["stage_counts"][rs.STAGE_NA] == 1
