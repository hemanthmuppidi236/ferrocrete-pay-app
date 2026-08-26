-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ 006  Release reminders (WI-3: waiver-chasing emails)                   ║
-- ║                                                                        ║
-- ║ Adds optional billing_email / billing_cc to subs (falls back to        ║
-- ║ contact_email when unset) and a per-line reminder log so each sub's    ║
-- ║ "last emailed" is visible on the tracker. Sends themselves still go    ║
-- ║ through the shared email_outbox via core/email.py.                     ║
-- ║                                                                        ║
-- ║ Additive and idempotent. Safe to run more than once.                   ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- ── subs: dedicated billing recipients ──────────────────────────────────
ALTER TABLE subs
  ADD COLUMN IF NOT EXISTS billing_email TEXT,
  ADD COLUMN IF NOT EXISTS billing_cc    TEXT;

-- ── per-line reminder log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS release_line_reminders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    release_line_id     UUID NOT NULL REFERENCES release_lines(id) ON DELETE CASCADE,
    release_tracker_id  UUID NOT NULL REFERENCES release_trackers(id) ON DELETE CASCADE,
    template_key        TEXT NOT NULL,     -- request_bill_cpcf | cpcf_overdue | request_upuf | upuf_overdue
    recipients          TEXT,              -- comma-joined to + cc, for display
    email_outbox_id     UUID,              -- links to the transport log row (nullable)
    sent_by             UUID REFERENCES app_users(id),
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_release_line_reminders_line
    ON release_line_reminders(release_line_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_release_line_reminders_tracker
    ON release_line_reminders(release_tracker_id);

ALTER TABLE release_line_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_read_all" ON release_line_reminders;
CREATE POLICY "authenticated_read_all" ON release_line_reminders
    FOR SELECT TO authenticated USING (true);

-- ── Reload PostgREST schema cache ───────────────────────────────────────
NOTIFY pgrst, 'reload schema';
