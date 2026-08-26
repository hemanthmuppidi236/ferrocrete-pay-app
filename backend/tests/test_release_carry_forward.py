"""
WI-1: carry-forward union logic for seeding a new release tracker's lines.

New tracker lines = (prior tracker lines, zeroed) UNION (active subs not
already carried). Inactive carried subs are kept only if they had a nonzero
amount or an unresolved conditional (CP/CF on file without matching UP/UF).

Uses a hand-rolled fake Supabase client, matching the house pattern in
test_billing_summary_endpoint.py.
"""

from app.core.release_carry_forward import build_seed_lines


# ─── Minimal fake Supabase query builder ──────────────────────────────

class _Query:
    def __init__(self, rows):
        self._rows = list(rows)

    def select(self, *a, **k):
        return self

    def eq(self, f, v):
        self._rows = [r for r in self._rows if str(r.get(f)) == str(v)]
        return self

    def lt(self, f, v):
        self._rows = [r for r in self._rows if r.get(f) is not None and r.get(f) < v]
        return self

    def in_(self, f, vals):
        s = set(vals)
        self._rows = [r for r in self._rows if r.get(f) in s]
        return self

    def order(self, f, desc=False):
        self._rows = sorted(self._rows, key=lambda r: r.get(f), reverse=desc)
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    def execute(self):
        return type("Res", (), {"data": self._rows})()


class _Client:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _Query(self._tables.get(name, []))


def _sub(id, name, active=True, drt=None, project_id="p1"):
    return {"id": id, "name": name, "active": active,
            "default_release_type": drt, "project_id": project_id}


def _line(id, tracker, sub_id, billed="0", check="0", rtype=None):
    return {"id": id, "release_tracker_id": tracker, "sub_id": sub_id,
            "billed_amount": billed, "check_amount": check,
            "release_type": rtype, "exception": None}


def _seeded_sub_ids(seed):
    return {s["sub_id"] for s in seed}


def test_no_prior_seeds_all_active_subs():
    tables = {
        "subs": [_sub("s1", "Alpha", drt="CP"), _sub("s2", "Beta"),
                 _sub("s9", "Inactive", active=False)],
        "release_trackers": [],
        "release_lines": [],
        "waivers": [],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert _seeded_sub_ids(seed) == {"s1", "s2"}          # inactive s9 excluded
    alpha = next(s for s in seed if s["sub_id"] == "s1")
    assert alpha["release_type"] == "CP"                  # default carried
    assert alpha["billed_amount"] == "0" and alpha["check_amount"] == "0"


def test_new_active_sub_added_alongside_carried():
    # Prior tracker had only s1; s2 was created afterward. Both must appear.
    tables = {
        "subs": [_sub("s1", "Alpha"), _sub("s2", "Beta")],
        "release_trackers": [{"id": "tPrior", "project_id": "p1", "period": "26-05"}],
        "release_lines": [_line("l1", "tPrior", "s1", rtype="CP")],
        "waivers": [],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert _seeded_sub_ids(seed) == {"s1", "s2"}


def test_carried_sub_not_duplicated_by_union():
    tables = {
        "subs": [_sub("s1", "Alpha")],
        "release_trackers": [{"id": "tPrior", "project_id": "p1", "period": "26-05"}],
        "release_lines": [_line("l1", "tPrior", "s1")],
        "waivers": [],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert [s["sub_id"] for s in seed] == ["s1"]          # exactly one


def test_inactive_carried_sub_dropped_when_empty():
    tables = {
        "subs": [_sub("s1", "Alpha"), _sub("s3", "Gone", active=False)],
        "release_trackers": [{"id": "tPrior", "project_id": "p1", "period": "26-05"}],
        "release_lines": [_line("l1", "tPrior", "s1"),
                          _line("l3", "tPrior", "s3")],   # zero amounts, no waivers
        "waivers": [],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert _seeded_sub_ids(seed) == {"s1"}                # s3 dropped


def test_inactive_carried_sub_kept_when_nonzero_amount():
    tables = {
        "subs": [_sub("s3", "Gone", active=False)],
        "release_trackers": [{"id": "tPrior", "project_id": "p1", "period": "26-05"}],
        "release_lines": [_line("l3", "tPrior", "s3", check="1500")],
        "waivers": [],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert _seeded_sub_ids(seed) == {"s3"}                # kept: had a check


def test_inactive_carried_sub_kept_when_unresolved_conditional():
    # CP waiver on file but no matching UP -> unconditional still outstanding.
    tables = {
        "subs": [_sub("s3", "Gone", active=False)],
        "release_trackers": [{"id": "tPrior", "project_id": "p1", "period": "26-05"}],
        "release_lines": [_line("l3", "tPrior", "s3", rtype="CP")],
        "waivers": [{"release_line_id": "l3", "waiver_type": "CP"}],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert _seeded_sub_ids(seed) == {"s3"}                # kept: CP without UP


def test_inactive_carried_sub_dropped_when_conditional_resolved():
    # Both CP and UP present -> resolved -> dropped (empty amounts).
    tables = {
        "subs": [_sub("s1", "Alpha"), _sub("s3", "Gone", active=False)],
        "release_trackers": [{"id": "tPrior", "project_id": "p1", "period": "26-05"}],
        "release_lines": [_line("l1", "tPrior", "s1"),
                          _line("l3", "tPrior", "s3", rtype="UP")],
        "waivers": [{"release_line_id": "l3", "waiver_type": "CP"},
                    {"release_line_id": "l3", "waiver_type": "UP"}],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    assert _seeded_sub_ids(seed) == {"s1"}                # s3 fully resolved -> dropped


def test_picks_most_recent_prior_tracker():
    # Two priors; only the latest (26-05) is the carry source.
    tables = {
        "subs": [_sub("s1", "Alpha"), _sub("s2", "Beta")],
        "release_trackers": [
            {"id": "tOld", "project_id": "p1", "period": "26-03"},
            {"id": "tPrior", "project_id": "p1", "period": "26-05"},
        ],
        "release_lines": [
            _line("lold", "tOld", "s1"),
            _line("l2", "tPrior", "s2", rtype="CF"),
        ],
        "waivers": [],
    }
    seed = build_seed_lines(_Client(tables), "p1", "tNew", "26-06")
    beta = next(s for s in seed if s["sub_id"] == "s2")
    assert beta["release_type"] == "CF"                   # from tPrior, not tOld
    assert _seeded_sub_ids(seed) == {"s1", "s2"}
