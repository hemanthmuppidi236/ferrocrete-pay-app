"""
Shared carry-forward logic for seeding a new release tracker's lines.

Used by both creation paths so they stay in sync:
  - backend/app/api/release_trackers.py :: create_release_tracker  (explicit POST)
  - backend/app/api/pay_apps.py         :: _autocreate_release_tracker (on pay-app create)

The rule (WI-1): a new tracker's lines are the UNION of
  1. lines carried from the most recent prior tracker (amounts zeroed), and
  2. all currently-active subs for the project not already present,
     seeded with their default_release_type.

An inactive sub carried from the prior tracker is kept only if, on that prior
tracker, it had a nonzero billed or check amount OR an unresolved conditional
(a CP/CF waiver on file without the matching UP/UF, or a release_type of UP/UF
with no matching waiver yet). Otherwise it is dropped, so stale inactive subs
do not accumulate forever.
"""

from decimal import Decimal, InvalidOperation


def _dec(x):
    if x is None or x == "":
        return Decimal("0")
    try:
        return Decimal(str(x))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _is_unresolved_unconditional(release_type, waiver_types):
    """True when a conditional was given but the matching unconditional is not
    yet on file, or an unconditional is expected by release_type but missing.

    waiver_types: set of waiver_type strings ('CP','UP','CF','UF') on the line.
    """
    if "CP" in waiver_types and "UP" not in waiver_types:
        return True
    if "CF" in waiver_types and "UF" not in waiver_types:
        return True
    if release_type in ("UP", "UF") and release_type not in waiver_types:
        return True
    return False


DEFAULT_NONPRELIM_NAME = "Non-Prelim Payments"


def ensure_default_nonprelim_sub(sb, project_id):
    """Make sure the project has its single catch-all non-prelim sub.

    Non-prelim payment detail is tracked in a separate app, so this app only
    needs one lump line. Creates the default sub if none named like it exists.
    Returns the default sub's id.
    """
    existing = (sb.table("subs")
                .select("id, name, is_non_prelimed")
                .eq("project_id", project_id).execute()).data or []
    for s in existing:
        if s.get("is_non_prelimed") and (s.get("name") or "").strip().lower() == \
                DEFAULT_NONPRELIM_NAME.lower():
            return s["id"]
    res = sb.table("subs").insert({
        "project_id": project_id,
        "name": DEFAULT_NONPRELIM_NAME,
        "is_non_prelimed": True,
        "active": True,
        "sort_order": 999,
    }).execute()
    return res.data[0]["id"] if res.data else None


def build_seed_lines(sb, project_id, tracker_id, period):
    """Return the list of release_lines insert payloads for a new tracker.

    Args:
        sb: service Supabase client
        project_id: project UUID (str)
        tracker_id: the just-created tracker's UUID (str)
        period: 'YY-MM' of the new tracker

    Returns a list of dicts ready for sb.table('release_lines').insert(...).
    Amounts are zeroed; prev_month_status is left null (not auto-tracked).
    """
    # All subs on the project (need inactive ones too, to judge carried lines).
    all_subs = (sb.table("subs")
                .select("id, default_release_type, active")
                .eq("project_id", project_id).execute()).data or []
    sub_active = {s["id"]: bool(s.get("active")) for s in all_subs}
    active_subs = [s for s in all_subs if s.get("active")]

    seed = []
    carried_sub_ids = set()

    # Most recent prior tracker for this project.
    prior = (sb.table("release_trackers").select("id")
             .eq("project_id", project_id)
             .lt("period", period)
             .order("period", desc=True)
             .limit(1).execute()).data

    if prior:
        prior_lines = (sb.table("release_lines").select("*")
                       .eq("release_tracker_id", prior[0]["id"]).execute()).data or []

        # Waivers for the prior lines, for the unresolved-unconditional test.
        line_ids = [pl["id"] for pl in prior_lines]
        waivers_by_line = {}
        if line_ids:
            wv = (sb.table("waivers").select("release_line_id, waiver_type")
                  .in_("release_line_id", line_ids).execute()).data or []
            for w in wv:
                waivers_by_line.setdefault(w["release_line_id"], set()).add(w["waiver_type"])

        for pl in prior_lines:
            sub_id = pl["sub_id"]
            if not sub_active.get(sub_id, False):
                # Inactive: keep only if it still carries value or an open release.
                has_amount = _dec(pl.get("billed_amount")) > 0 or _dec(pl.get("check_amount")) > 0
                unresolved = _is_unresolved_unconditional(
                    pl.get("release_type"), waivers_by_line.get(pl["id"], set())
                )
                if not (has_amount or unresolved):
                    continue
            seed.append({
                "release_tracker_id": tracker_id,
                "sub_id": sub_id,
                "billed_amount": "0",
                "check_amount": "0",
                "release_type": pl.get("release_type"),
                "exception": pl.get("exception"),
                "prev_month_status": None,
            })
            carried_sub_ids.add(sub_id)

    # Union in active subs that were not carried from the prior tracker.
    for s in active_subs:
        if s["id"] in carried_sub_ids:
            continue
        seed.append({
            "release_tracker_id": tracker_id,
            "sub_id": s["id"],
            "billed_amount": "0",
            "check_amount": "0",
            "release_type": s.get("default_release_type"),
        })

    return seed
