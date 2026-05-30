-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  MIGRATION 003: PAY APP APPROVAL WORKFLOW                             ║
-- ║                                                                       ║
-- ║  Extends the pay-app lifecycle from                                   ║
-- ║      draft → submitted → paid → void                                  ║
-- ║  to                                                                   ║
-- ║      draft → pending_approval → approved → submitted → paid → void    ║
-- ║                                                                       ║
-- ║  - draft           : accountant/PE editing                            ║
-- ║  - pending_approval: accountant sent for Raz's approval               ║
-- ║  - approved        : Raz approved; accountant ready to send to GC     ║
-- ║  - submitted       : sent to GC (via email or marked-manual)          ║
-- ║  - paid            : payment received                                 ║
-- ║                                                                       ║
-- ║  Rejection sends the pay app back to 'draft' with a stored reason.    ║
-- ║                                                                       ║
-- ║  Pre-existing rows with status='submitted' are left untouched —       ║
-- ║  they bypassed the new workflow and remain in that state.             ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ─── 1. Replace the status CHECK constraint ────────────────────────────
-- Postgres doesn't let us alter a CHECK in place; drop + add.
ALTER TABLE pay_apps DROP CONSTRAINT IF EXISTS pay_apps_status_check;
ALTER TABLE pay_apps ADD CONSTRAINT pay_apps_status_check
    CHECK (status IN (
        'draft',
        'pending_approval',
        'approved',
        'submitted',
        'paid',
        'void'
    ));


-- ─── 2. Workflow timestamps & actors ───────────────────────────────────
ALTER TABLE pay_apps
    ADD COLUMN IF NOT EXISTS submitted_for_approval_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS submitted_for_approval_by  UUID REFERENCES app_users(id),

    ADD COLUMN IF NOT EXISTS approved_at                TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approved_by                UUID REFERENCES app_users(id),

    ADD COLUMN IF NOT EXISTS rejected_at                TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejected_by                UUID REFERENCES app_users(id),
    ADD COLUMN IF NOT EXISTS rejection_reason           TEXT,

    -- "Sent to GC" is recorded even if the email wasn't actually sent
    -- (manual-portal case). sent_to_gc_email stores the address used; for
    -- manual submissions it's NULL.
    ADD COLUMN IF NOT EXISTS sent_to_gc_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sent_to_gc_by              UUID REFERENCES app_users(id),
    ADD COLUMN IF NOT EXISTS sent_to_gc_email           TEXT;


-- ─── 3. Index the "needs admin attention" queue ────────────────────────
-- The Raz dashboard query is "all pay_apps where status='pending_approval'"
-- plus a sort by submitted_for_approval_at. Tiny dataset today, but cheap.
CREATE INDEX IF NOT EXISTS idx_pay_apps_pending_approval
    ON pay_apps(submitted_for_approval_at DESC)
    WHERE status = 'pending_approval';


-- ─── 4. Comment for documentation ──────────────────────────────────────
COMMENT ON COLUMN pay_apps.rejection_reason IS
    'Free-text reason captured when Raz rejects a submission. Cleared (or '
    'left as historical context) when the pay app is resubmitted.';
