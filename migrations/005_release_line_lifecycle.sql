-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ 005  Release line lifecycle (WI-2: per-sub status workflow)            ║
-- ║                                                                        ║
-- ║ Adds a per-line lifecycle to release_lines so each sub is tracked      ║
-- ║ individually through: bill -> conditional (CP/CF) -> GC payment ->     ║
-- ║ check release -> unconditional (UP/UF) -> complete. The existing       ║
-- ║ release_type / exception / prev_month_status columns are kept for      ║
-- ║ backward compatibility. Tracker-level workflow flags become derived    ║
-- ║ in the API (they are no longer written by the frontend).               ║
-- ║                                                                        ║
-- ║ Adds projects.grace_days (default 14) used to compute a bill's         ║
-- ║ bill_due_at = bill_requested_at + grace_days.                          ║
-- ║                                                                        ║
-- ║ Additive and idempotent. Safe to run more than once.                   ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- ── projects: grace period for bill/CP-CF follow-up ─────────────────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS grace_days INTEGER NOT NULL DEFAULT 14;

-- ── release_lines: per-line lifecycle columns ───────────────────────────
ALTER TABLE release_lines
  ADD COLUMN IF NOT EXISTS bill_status TEXT NOT NULL DEFAULT 'not_requested'
      CHECK (bill_status IN ('not_requested','requested','received','not_applicable')),
  ADD COLUMN IF NOT EXISTS bill_requested_at DATE,
  ADD COLUMN IF NOT EXISTS bill_received_at DATE,
  ADD COLUMN IF NOT EXISTS bill_due_at DATE,

  ADD COLUMN IF NOT EXISTS conditional_status TEXT NOT NULL DEFAULT 'not_requested'
      CHECK (conditional_status IN ('not_requested','requested','received','verified','sent_to_gc','not_applicable')),
  ADD COLUMN IF NOT EXISTS conditional_received_at DATE,
  ADD COLUMN IF NOT EXISTS conditional_sent_at DATE,

  ADD COLUMN IF NOT EXISTS check_type TEXT
      CHECK (check_type IS NULL OR check_type IN ('joint','individual','none')),
  ADD COLUMN IF NOT EXISTS check_received_at DATE,
  ADD COLUMN IF NOT EXISTS check_sent_to_sub_at DATE,

  ADD COLUMN IF NOT EXISTS unconditional_status TEXT NOT NULL DEFAULT 'not_requested'
      CHECK (unconditional_status IN ('not_requested','requested','received','verified','sent_to_gc','not_applicable')),
  ADD COLUMN IF NOT EXISTS unconditional_requested_at DATE,
  ADD COLUMN IF NOT EXISTS unconditional_received_at DATE,
  ADD COLUMN IF NOT EXISTS unconditional_sent_at DATE,

  ADD COLUMN IF NOT EXISTS difference_note TEXT;

-- ── Backfill from existing data (release_type + amounts + waivers) ───────
-- Any line with billed or check activity has, by definition, had its bill.
UPDATE release_lines
   SET bill_status = 'received'
 WHERE bill_status = 'not_requested'
   AND (billed_amount > 0 OR check_amount > 0);

-- A CP or CF waiver on file means the conditional was received.
UPDATE release_lines rl
   SET conditional_status = 'received',
       conditional_received_at = COALESCE(w.received_at, w.uploaded_at::date)
  FROM waivers w
 WHERE w.release_line_id = rl.id
   AND w.waiver_type IN ('CP','CF')
   AND rl.conditional_status = 'not_requested';

-- A UP or UF waiver on file means the unconditional was received.
UPDATE release_lines rl
   SET unconditional_status = 'received',
       unconditional_received_at = COALESCE(w.received_at, w.uploaded_at::date)
  FROM waivers w
 WHERE w.release_line_id = rl.id
   AND w.waiver_type IN ('UP','UF')
   AND rl.unconditional_status = 'not_requested';

-- Non-prelimed subs skip the conditional and unconditional stages entirely.
UPDATE release_lines rl
   SET conditional_status = 'not_applicable',
       unconditional_status = 'not_applicable'
  FROM subs s
 WHERE s.id = rl.sub_id
   AND s.is_non_prelimed = true;

-- ── Reload PostgREST schema cache so the new columns are visible ─────────
NOTIFY pgrst, 'reload schema';
