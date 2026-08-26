"""WI-3: reminder template rendering."""

from app.core import reminder_templates as tpl


CTX = {
    "project_name": "A Street",
    "project_no": "25-20",
    "period": "26-07",
    "conditional_through_date": "2026-07-31",
    "sender_name": "Raz",
}


def test_month_year():
    assert tpl.month_year("26-07") == "July 2026"
    assert tpl.month_year("26-01") == "January 2026"


def test_all_templates_render_and_carry_context():
    for key in ("request_bill_cpcf", "cpcf_overdue", "request_upuf", "upuf_overdue"):
        out = tpl.build_reminder(key, CTX)
        blob = out["subject"] + " " + out["body"]
        assert "25-20" in blob and "A Street" in blob
        assert "July 2026" in blob
        assert out["body"].strip().endswith("Ferrocrete Builders")


def test_no_em_dashes_anywhere():
    for key in ("request_bill_cpcf", "cpcf_overdue", "request_upuf", "upuf_overdue"):
        out = tpl.build_reminder(key, CTX)
        assert "—" not in (out["subject"] + out["body"])  # em dash
        assert "–" not in (out["subject"] + out["body"])  # en dash


def test_sub_token_kept_when_absent_and_personalized():
    out = tpl.build_reminder("request_bill_cpcf", CTX)
    assert "{sub}" in out["body"]
    filled = tpl.personalize(out["body"], "LMS Reinforcing")
    assert "{sub}" not in filled and "LMS Reinforcing" in filled


def test_sub_name_filled_when_provided():
    ctx = dict(CTX, sub_name="Atlas Construction")
    out = tpl.build_reminder("request_upuf", ctx)
    assert "Atlas Construction" in out["body"] and "{sub}" not in out["body"]


def test_conditional_through_appears_in_bill_request():
    out = tpl.build_reminder("request_bill_cpcf", CTX)
    assert "2026-07-31" in out["body"]


def test_advances_mapping():
    assert tpl.ADVANCES["request_bill_cpcf"] == "bill"
    assert tpl.ADVANCES["request_upuf"] == "unconditional"
    assert tpl.ADVANCES["cpcf_overdue"] is None
    assert tpl.ADVANCES["upuf_overdue"] is None


def test_unknown_template_raises():
    try:
        tpl.build_reminder("nope", CTX)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_text_to_html_escapes_and_breaks():
    html = tpl.text_to_html("a < b\nsecond line")
    assert "&lt;" in html and "<br>" in html
