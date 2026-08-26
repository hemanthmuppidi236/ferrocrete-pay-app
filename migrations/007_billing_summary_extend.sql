-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ 007  Billing Summary, full Excel column set (WI-4)                     ║
-- ║                                                                        ║
-- ║ Adds the project-level billing settings (Billing Due Date rule and     ║
-- ║ Billing Contact) and a per-period Quickbooks total for the footer      ║
-- ║ reconciliation. The per-(project, period) manual columns already live  ║
-- ║ in billing_summary_overrides (migration 004) and are unchanged.        ║
-- ║                                                                        ║
-- ║ Additive and idempotent. Safe to run more than once.                   ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- ── projects: billing settings (col D default, col S default) ───────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS billing_due_rule TEXT,   -- "25th", "EOM", "20th", "Skip"
  ADD COLUMN IF NOT EXISTS billing_contact  TEXT;   -- email or "Submitted through GCPay"

-- ── per-period Quickbooks total (footer reconciliation) ─────────────────
CREATE TABLE IF NOT EXISTS billing_period_meta (
    period            TEXT PRIMARY KEY,            -- "26-08" (YY-MM)
    quickbooks_total  NUMERIC(14,2),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_updated_at ON billing_period_meta;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing_period_meta
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE billing_period_meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_read_all" ON billing_period_meta;
CREATE POLICY "authenticated_read_all" ON billing_period_meta
    FOR SELECT TO authenticated USING (true);

-- ── Reload PostgREST schema cache ───────────────────────────────────────
NOTIFY pgrst, 'reload schema';
