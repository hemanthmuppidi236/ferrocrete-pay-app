-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ 009  Ferrocrete's own CP/UP/CF/UF waivers (WI-5)                       ║
-- ║                                                                        ║
-- ║ Adds the project Owner fields the statutory forms require (Claimant is  ║
-- ║ Ferrocrete itself, Customer is the GC already on the project), and the  ║
-- ║ pay-app "waiver sent" date stamps.                                      ║
-- ║                                                                        ║
-- ║ Additive and idempotent. Safe to run more than once.                   ║
-- ╚══════════════════════════════════════════════════════════════════════╝

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_name    TEXT,
  ADD COLUMN IF NOT EXISTS owner_address TEXT;

ALTER TABLE pay_apps
  ADD COLUMN IF NOT EXISTS cpcf_sent_at DATE,   -- Ferrocrete's own CP/CF sent
  ADD COLUMN IF NOT EXISTS upuf_sent_at DATE;   -- Ferrocrete's own UP/UF sent

NOTIFY pgrst, 'reload schema';
