-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ 008  Retention billed (manager feedback #6)                           ║
-- ║                                                                        ║
-- ║ Lets a pay app record that retention was billed in this period, and    ║
-- ║ how much. Surfaced as its own Billing Summary column (and in totals),  ║
-- ║ and shown as a provision on the release tracker.                       ║
-- ║                                                                        ║
-- ║ Additive and idempotent. Safe to run more than once.                   ║
-- ╚══════════════════════════════════════════════════════════════════════╝

ALTER TABLE pay_apps
  ADD COLUMN IF NOT EXISTS retention_billed        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_billed_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
