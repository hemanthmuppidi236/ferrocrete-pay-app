"""WI-5: Ferrocrete's own CP/UP/CF/UF waiver field mapping + verbatim text."""

import pytest

from app.core import waiver_forms as wf


PROJECT = {
    "project_no": "25-20", "name": "A Street",
    "gc_company": "Rockwood Construction",
    "gc_address": "33332 Valle Rd, #200, San Juan Capistrano, California 92675",
    "address": "2935 A Street, San Diego, California 92102",
    "owner_name": "A Street Cedar Property Owner LLC",
    "owner_address": "151 West Huron St., Chicago, IL 60654",
}
PAY_APP = {"period": "26-07", "period_to": "2026-07-31",
           "current_payment_due": "759839.04"}


def _b(wt):
    return wf.build_waiver(wt, project=PROJECT, pay_app=PAY_APP)


def test_claimant_is_ferrocrete_constant():
    for wt in wf.WAIVER_TYPES:
        c = _b(wt)
        assert c["claimant_name"] == "Ferrocrete Builders, Inc."
        assert c["claimant_title"] == "Project Executive"


def test_customer_owner_job_mapping():
    c = _b("CP")
    assert "Rockwood Construction" in c["customer"]
    assert "A Street Cedar Property Owner LLC" in c["owner"]
    assert c["job_location"] == "2935 A Street, San Diego, California 92102"


def test_cp_amount_and_through_date():
    # Acceptance: Amount of Check = G702 line 8; Through Date = 7/31/2026.
    c = _b("CP")
    assert c["amount_of_check"] == "$759,839.04"
    assert c["through_date"] == "2026-07-31"
    assert c["has_check_block"] is True
    assert c["maker_of_check"] == c["customer"]
    assert c["check_payable_to"] == "Ferrocrete Builders, Inc."


def test_cf_amount_no_through_date():
    c = _b("CF")
    assert c["amount_of_check"] == "$759,839.04"     # same G702 line 8
    assert c["through_date"] is None                 # not on final form
    assert c["has_check_block"] is True


def test_up_shows_amount_no_check_block():
    c = _b("UP")
    assert c["shows_amount"] is True
    assert c["amount_of_check"] == "$759,839.04"
    assert c["has_check_block"] is False
    assert c["through_date"] == "2026-07-31"


def test_uf_no_amount_no_through():
    c = _b("UF")
    assert c["shows_amount"] is False
    assert c["amount_of_check"] is None
    assert c["has_check_block"] is False
    assert c["through_date"] is None


def test_titles_and_notices_verbatim():
    assert _b("CP")["title"] == "CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT"
    assert _b("UF")["title"] == "UNCONDITIONAL WAIVER AND RELEASE ON FINAL PAYMENT"
    assert _b("CP")["notice"].startswith("NOTICE: THIS DOCUMENT WAIVES THE CLAIMANT'S LIEN")
    assert _b("UP")["notice"].startswith("NOTICE TO CLAIMANT:")


def test_body_verbatim_key_phrases():
    assert "through the Through Date of this document" in _b("CP")["body"]
    assert _b("UF")["body"].strip().endswith("The claimant has been paid in full.")
    assert "received the following progress payment:" in _b("UP")["body"]


def test_exceptions_by_type():
    assert any("Retentions." in e for e in _b("CP")["exceptions"])
    assert any("previously given a conditional waiver" in e for e in _b("CP")["exceptions"])
    assert any("Disputed claims for extras" in e for e in _b("CF")["exceptions"])
    # UP has no "prior conditional payments" clause
    assert not any("previously given a conditional waiver" in e for e in _b("UP")["exceptions"])


def test_filename():
    assert _b("CP")["filename"] == "25-20_26-07_Ferrocrete_CP.pdf"
    assert _b("UF")["filename"] == "25-20_26-07_Ferrocrete_UF.pdf"


def test_no_em_dashes():
    for wt in wf.WAIVER_TYPES:
        blob = " ".join([_b(wt)["body"], _b(wt)["notice"]] + _b(wt)["exceptions"])
        assert "—" not in blob and "–" not in blob


def test_unknown_type_raises():
    with pytest.raises(ValueError):
        wf.build_waiver("XX", project=PROJECT, pay_app=PAY_APP)
