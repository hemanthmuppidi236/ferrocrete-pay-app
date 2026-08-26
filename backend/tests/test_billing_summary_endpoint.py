"""
End-to-end test of the billing-summary GET pipeline with a faked Supabase
client — validates the query grouping, net/accrued math, inclusion set,
override + waiver-flag merge, totals, and period defaulting (the parts the
pure-function tests don't cover).
"""

from decimal import Decimal

import app.api.billing_summary as bs


# ─── Minimal fake of the Supabase query builder ───────────────────────

class _Query:
    def __init__(self, rows):
        self._rows = list(rows)

    def select(self, *a, **k):
        return self

    def eq(self, f, v):
        self._rows = [r for r in self._rows if str(r.get(f)) == str(v)]
        return self

    def lte(self, f, v):
        self._rows = [r for r in self._rows if r.get(f) is not None and r.get(f) <= v]
        return self

    def in_(self, f, vals):
        s = set(vals)
        self._rows = [r for r in self._rows if r.get(f) in s]
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    def order(self, *a, **k):
        return self

    def execute(self):
        return type("Res", (), {"data": self._rows})()


class _Client:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _Query(self._tables.get(name, []))


def _make_data():
    return {
        "projects": [
            {"id": "p1", "project_no": "25-01", "name": "Alpha",
             "contract_value": "1000000", "retention_rate": "0.10",
             "gc_contact_email": "a@x.com", "status": "active"},
            {"id": "p2", "project_no": "25-02", "name": "Beta",
             "contract_value": "500000", "retention_rate": "0.05",
             "gc_contact_email": "b@x.com", "status": "active"},
        ],
        "change_orders": [],
        "pay_apps": [
            {"id": "pa1a", "project_id": "p1", "period": "26-05", "due_date": "2026-05-31",
             "status": "submitted", "revised_contract": "1000000",
             "total_completed_to_date": "200000", "retention_held": "20000",
             "current_payment_due": "100000"},
            {"id": "pa1b", "project_id": "p1", "period": "26-06", "due_date": "2026-06-30",
             "status": "approved", "revised_contract": "1000000",
             "total_completed_to_date": "300000", "retention_held": "30000",
             "current_payment_due": "90000"},
            {"id": "pa2", "project_id": "p2", "period": "26-06", "due_date": None,
             "status": "draft", "revised_contract": "500000",
             "total_completed_to_date": "100000", "retention_held": "5000",
             "current_payment_due": "50000"},
        ],
        "release_trackers": [
            {"id": "t1a", "project_id": "p1", "period": "26-05", "invoice_amount": "100000"},
            {"id": "t1b", "project_id": "p1", "period": "26-06", "invoice_amount": "90000"},
            {"id": "t2", "project_id": "p2", "period": "26-06", "invoice_amount": "50000"},
        ],
        "release_lines": [
            {"id": "l1", "release_tracker_id": "t1a", "check_amount": "30000"},
            {"id": "l2", "release_tracker_id": "t1a", "check_amount": "20000"},
            {"id": "l3", "release_tracker_id": "t1b", "check_amount": "40000"},
            {"id": "l4", "release_tracker_id": "t1b", "check_amount": "10000"},
            {"id": "l5", "release_tracker_id": "t2", "check_amount": "20000"},
        ],
        "release_unbilled_entries": [
            {"release_tracker_id": "t1b", "amount": "5000"},
        ],
        "waivers": [
            {"release_line_id": "l3", "waiver_type": "CP"},
        ],
        "billing_summary_overrides": [
            {"project_id": "p2", "period": "26-06", "payment_status": "FedEx sent",
             "bt_note": "x"},
        ],
    }


def _run(monkeypatch, period):
    monkeypatch.setattr(bs, "get_service_client", lambda: _Client(_make_data()))
    return bs.get_billing_summary(period=period, user=None)


def test_period_defaults_to_latest(monkeypatch):
    res = _run(monkeypatch, None)
    assert res["period"] == "26-06"
    assert res["available_periods"] == ["26-06", "26-05"]


def test_rows_and_math(monkeypatch):
    res = _run(monkeypatch, "26-06")
    rows = {r["project_id"]: r for r in res["rows"]}
    # sorted by project_no
    assert [r["project_no"] for r in res["rows"]] == ["25-01", "25-02"]

    p1 = rows["p1"]
    assert p1["billed_amount"] == Decimal("90000")
    assert p1["gross_billing"] == Decimal("100000")          # 90000 / (1 - 0.10)
    assert p1["balance_to_finish"] == Decimal("700000")      # H = 1,000,000 − 300,000
    assert p1["balance_with_retention"] == Decimal("730000") # I = 1,000,000 − 300,000 + 30,000
    assert p1["potential_net"] == Decimal("35000")           # 90000 − 50000 − 5000
    assert p1["cpcf_sent"] == "Yes"                          # CP waiver auto-flag
    assert p1["upuf_sent"] == ""
    assert p1["payment_status"] == "Approved"
    assert p1["billing_contact"] == "a@x.com"

    p2 = rows["p2"]
    assert p2["potential_net"] == Decimal("30000")           # 50000 − 20000 − 0
    assert p2["payment_status"] == "FedEx sent"              # override wins
    assert p2["bt_note"] == "x"


def test_totals_and_accrued(monkeypatch):
    res = _run(monkeypatch, "26-06")
    t = res["totals"]
    assert t["billed_amount"] == Decimal("140000")           # 90000 + 50000
    assert t["potential_net"] == Decimal("65000")            # 35000 + 30000
    assert t["revised_contract"] == Decimal("1500000")

    acc = res["accrued"]
    # net across ALL trackers ≤ 26-06: 50000 (t1a) + 35000 (t1b) + 30000 (t2)
    assert acc["net"] == Decimal("115000")
    # billed across ALL pay apps ≤ 26-06: 100000 + 90000 + 50000
    assert acc["billed"] == Decimal("240000")
