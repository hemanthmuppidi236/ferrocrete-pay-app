-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  Migration 004: Billing Period Summary — manual override columns      ║
-- ║                                                                       ║
-- ║  The Billing Summary is an INTERNAL monthly roll-up. Most columns are ║
-- ║  auto-derived (pay app + release tracker). This table holds only the  ║
-- ║  free-text / manual columns the accountant edits per (project, period)║
-- ║  and that don't live in either source model:                          ║
-- ║    Billing Due Date, BT note, Rebar, CMU, CP/CF + UP/UF sent flags,   ║
-- ║    Billing Contact, Payment Status.                                   ║
-- ║                                                                       ║
-- ║  Auto columns (contract, completed, retention, billed, potential net) ║
-- ║  are NEVER stored here — they always recompute from source so the     ║
-- ║  summary can't drift out of sync.                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS billing_summary_overrides (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period              TEXT NOT NULL,               -- "26-06" (YY-MM), matches pay_apps/release_trackers

    billing_due_date    TEXT,                        -- free text: "25th", "EOM", "Skip"
    bt_note             TEXT,                         -- Buildertrend / status note
    rebar               NUMERIC(14,2),
    cmu                 NUMERIC(14,2),
    cpcf_sent           TEXT,                         -- "Yes" / free text (overrides waiver auto-suggest)
    upuf_sent           TEXT,
    billing_contact     TEXT,                         -- overrides project GC contact
    payment_status      TEXT,                         -- overrides pay-app status label

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (project_id, period)
);

CREATE INDEX IF NOT EXISTS idx_billing_summary_overrides_period
    ON billing_summary_overrides(period);

-- keep updated_at fresh (reuses the trigger function from migration 001)
DROP TRIGGER IF EXISTS set_updated_at ON billing_summary_overrides;
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON billing_summary_overrides
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- RLS: read-only from the browser, like the rest of the schema.
ALTER TABLE billing_summary_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_all" ON billing_summary_overrides
    FOR SELECT TO authenticated USING (true);
