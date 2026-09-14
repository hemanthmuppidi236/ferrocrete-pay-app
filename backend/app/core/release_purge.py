"""
Hard-delete helpers for release trackers.

Release trackers have no soft-delete column. Deleting a tracker row lets
Postgres cascade-delete its release_lines, release_unbilled_entries, and
waivers (FKs are ON DELETE CASCADE). Waiver *files* live in Storage and are
NOT covered by the DB cascade, so these helpers remove them first (best-effort)
to avoid orphaning objects in the bucket.

Shared by:
  - DELETE /release-trackers/{id}      (single tracker)
  - DELETE /projects/{id}              (purge all trackers on the project)
"""

from .config import settings
from . import storage as storage_helpers


def _cleanup_waiver_files(sb, tracker_ids: list[str]) -> None:
    """Remove the storage objects for every waiver under the given trackers."""
    if not tracker_ids:
        return
    lines = (sb.table("release_lines").select("id")
             .in_("release_tracker_id", tracker_ids).execute().data or [])
    line_ids = [ln["id"] for ln in lines]
    if not line_ids:
        return
    waivers = (sb.table("waivers").select("file_path")
               .in_("release_line_id", line_ids).execute().data or [])
    for w in waivers:
        fp = w.get("file_path")
        if not fp:
            continue
        try:
            storage_helpers.delete_object(settings.bucket_waivers, fp)
        except Exception as e:
            print(f"[release_purge] waiver file cleanup failed for {fp}: {e}",
                  flush=True)


def purge_tracker(sb, tracker_id: str) -> None:
    """Best-effort waiver storage cleanup, then hard-delete one tracker.

    The DB cascade removes the tracker's lines / unbilled entries / waiver rows.
    """
    try:
        _cleanup_waiver_files(sb, [str(tracker_id)])
    except Exception as e:
        print(f"[release_purge] storage cleanup skipped for tracker "
              f"{tracker_id}: {e}", flush=True)
    sb.table("release_trackers").delete().eq("id", str(tracker_id)).execute()


def purge_project_trackers(sb, project_id: str) -> int:
    """Hard-delete every release tracker on a project. Returns the count purged.

    Cleans waiver storage for all trackers first, then deletes them in one call
    (the DB cascade handles each tracker's children).
    """
    trackers = (sb.table("release_trackers").select("id")
                .eq("project_id", str(project_id)).execute().data or [])
    tracker_ids = [t["id"] for t in trackers]
    if not tracker_ids:
        return 0
    try:
        _cleanup_waiver_files(sb, tracker_ids)
    except Exception as e:
        print(f"[release_purge] storage cleanup skipped for project "
              f"{project_id}: {e}", flush=True)
    sb.table("release_trackers").delete().eq("project_id", str(project_id)).execute()
    return len(tracker_ids)
