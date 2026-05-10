"""
Audit log service. Every meaningful state change goes through here.

Conventions:
  - entity_type matches the table name (singular): 'project', 'pay_app', etc.
  - action is past-tense verb: 'created', 'updated', 'submitted', 'paid', 'deleted'.
  - before_data / after_data are full row snapshots as JSONB
"""

from typing import Optional
from datetime import datetime
from .supabase_client import get_service_client


def log(
    user_id: Optional[str],
    entity_type: str,
    entity_id: str,
    action: str,
    before: Optional[dict] = None,
    after: Optional[dict] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Insert an audit log entry. Failures are logged but never raised
    (we never want audit logging to break a user's request)."""
    sb = get_service_client()
    try:
        sb.table("audit_log").insert({
            "user_id": user_id,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "action": action,
            "before_data": _coerce(before),
            "after_data": _coerce(after),
            "metadata": metadata,
        }).execute()
    except Exception as e:
        import logging
        logging.getLogger(__name__).error("audit_log insert failed: %s", e)


def _coerce(d: Optional[dict]) -> Optional[dict]:
    """Make sure datetimes are JSON-serializable."""
    if d is None:
        return None
    out = {}
    for k, v in d.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out
