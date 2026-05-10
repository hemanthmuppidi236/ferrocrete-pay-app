-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  FERROCRETE PAY APP — DATABASE SCHEMA                                 ║
-- ║  Migration 001: Initial schema                                        ║
-- ║                                                                       ║
-- ║  Run against: Supabase Postgres                                       ║
-- ║  Conventions:                                                         ║
-- ║    - All ids are UUIDs                                                ║
-- ║    - All money in NUMERIC(14,2) (no floats for currency)              ║
-- ║    - All timestamps in TIMESTAMPTZ                                    ║
-- ║    - Soft-delete via deleted_at (where applicable)                    ║
-- ║    - audit_log captures every meaningful state change                 ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ─── USERS ─────────────────────────────────────────────────────────────
-- Mirrors auth.users (Supabase) with app-specific role + profile data.
-- A trigger keeps this in sync with auth.users on signup.

CREATE TABLE app_users (
    id              UUID PRIMARY KEY,        -- matches auth.users.id
    email           TEXT NOT NULL UNIQUE,
    full_name       TEXT,
    role            TEXT NOT NULL DEFAULT 'pe'
                    CHECK (role IN ('admin', 'accountant', 'pe', 'viewer')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    deactivated_at  TIMESTAMPTZ
);

CREATE INDEX idx_app_users_email ON app_users(email);


-- ─── PROJECTS ──────────────────────────────────────────────────────────

CREATE TABLE projects (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_no                  TEXT NOT NULL UNIQUE,    -- e.g., "25-05"
    name                        TEXT NOT NULL,           -- e.g., "712 Seagaze Dr"
    address                     TEXT,
    gc_company                  TEXT,
    gc_contact_name             TEXT,
    gc_contact_email            TEXT,
    gc_contact_phone            TEXT,
    contract_value              NUMERIC(14,2) NOT NULL DEFAULT 0,
    retention_rate              NUMERIC(5,4) NOT NULL DEFAULT 0.10,    -- 10% = 0.10
    retention_drops_at_50_pct   BOOLEAN NOT NULL DEFAULT FALSE,
    retention_rate_after_50     NUMERIC(5,4),
    status                      TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'closed', 'on_hold')),
    started_at                  DATE,
    substantial_completion_at   DATE,
    notes                       TEXT,

    created_by                  UUID REFERENCES app_users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at                  TIMESTAMPTZ
);

CREATE INDEX idx_projects_status ON projects(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_project_no ON projects(project_no);


-- ─── SOV LINES (Schedule of Values) ────────────────────────────────────
-- Each project has many SOV lines. The pay app's G703 sheet is built from these.

CREATE TABLE sov_lines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item_no             TEXT,                     -- "1", "2", "L1", etc. — user-facing
    description         TEXT NOT NULL,
    scheduled_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
    sort_order          INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sov_lines_project ON sov_lines(project_id, sort_order);


-- ─── CHANGE ORDERS ─────────────────────────────────────────────────────

CREATE TABLE change_orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    co_no               TEXT NOT NULL,              -- "CO-001"
    description         TEXT NOT NULL,
    amount              NUMERIC(14,2) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'void')),
    has_retention       BOOLEAN NOT NULL DEFAULT TRUE,    -- some COs (bond fees) have no retention
    submitted_at        DATE,
    approved_at         DATE,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, co_no)
);

CREATE INDEX idx_change_orders_project ON change_orders(project_id, status);


-- ─── PAY APPLICATIONS ──────────────────────────────────────────────────
-- One row per project per draw period.

CREATE TABLE pay_apps (
    id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id                      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period                          TEXT NOT NULL,       -- "26-05" (YY-MM)
    app_no                          INTEGER NOT NULL,    -- AIA application number, sequential per project
    period_to                       DATE NOT NULL,       -- last day of period
    due_date                        DATE,
    status                          TEXT NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'submitted', 'paid', 'void')),

    -- Computed totals (denormalized for fast list views; recalc'd on save)
    original_contract               NUMERIC(14,2) DEFAULT 0,
    approved_co_total               NUMERIC(14,2) DEFAULT 0,
    revised_contract                NUMERIC(14,2) DEFAULT 0,
    total_completed_to_date         NUMERIC(14,2) DEFAULT 0,    -- G702 line 4 / G26
    retention_held                  NUMERIC(14,2) DEFAULT 0,    -- G702 line 5
    earned_less_retention           NUMERIC(14,2) DEFAULT 0,    -- G702 line 6
    previous_certificates           NUMERIC(14,2) DEFAULT 0,    -- G702 line 7
    current_payment_due             NUMERIC(14,2) DEFAULT 0,    -- G702 line 8
    balance_to_finish               NUMERIC(14,2) DEFAULT 0,    -- G702 line 9

    -- Workflow timestamps
    submitted_at                    TIMESTAMPTZ,
    submitted_by                    UUID REFERENCES app_users(id),
    paid_at                         TIMESTAMPTZ,
    paid_amount                     NUMERIC(14,2),

    -- Generated artifacts (Supabase Storage object IDs)
    excel_file_path                 TEXT,    -- path in storage bucket
    pdf_file_path                   TEXT,
    excel_generated_at              TIMESTAMPTZ,
    pdf_generated_at                TIMESTAMPTZ,

    notes                           TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (project_id, period)
);

CREATE INDEX idx_pay_apps_project ON pay_apps(project_id, period);
CREATE INDEX idx_pay_apps_status ON pay_apps(status);
CREATE INDEX idx_pay_apps_period ON pay_apps(period);


-- ─── PAY APP BILLINGS (per-line periodic billings) ─────────────────────
-- For each SOV line or CO, record the cumulative billed-this-period values.
-- This is the data behind G703's columns D, E, F, G.

CREATE TABLE pay_app_billings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pay_app_id          UUID NOT NULL REFERENCES pay_apps(id) ON DELETE CASCADE,

    -- One of these will be set:
    sov_line_id         UUID REFERENCES sov_lines(id) ON DELETE CASCADE,
    change_order_id     UUID REFERENCES change_orders(id) ON DELETE CASCADE,

    -- G703 columns (cumulative through this period):
    previous_work       NUMERIC(14,2) NOT NULL DEFAULT 0,    -- D: from prior periods
    this_period_work    NUMERIC(14,2) NOT NULL DEFAULT 0,    -- E: billed this period
    materials_stored    NUMERIC(14,2) NOT NULL DEFAULT 0,    -- F: stored materials
    -- Total completed (G) = previous + this_period + materials_stored (computed)
    -- Retention (J) = G * project.retention_rate (computed)

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Exactly one of sov_line_id or change_order_id must be set
    CHECK (
        (sov_line_id IS NOT NULL AND change_order_id IS NULL) OR
        (sov_line_id IS NULL AND change_order_id IS NOT NULL)
    ),

    UNIQUE (pay_app_id, sov_line_id),
    UNIQUE (pay_app_id, change_order_id)
);

CREATE INDEX idx_pay_app_billings_pay_app ON pay_app_billings(pay_app_id);


-- ─── SUBS (Master sub list per project, used for releases) ─────────────

CREATE TABLE subs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    parent_sub_id       UUID REFERENCES subs(id) ON DELETE CASCADE,    -- NULL = top-level; set = sub-tier
    default_release_type TEXT CHECK (default_release_type IN ('CP', 'UP', 'CF', 'UF')),
    contact_name        TEXT,
    contact_email       TEXT,
    contact_phone       TEXT,
    is_non_prelimed     BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (project_id, name, parent_sub_id)
);

CREATE INDEX idx_subs_project ON subs(project_id, sort_order);
CREATE INDEX idx_subs_parent ON subs(parent_sub_id) WHERE parent_sub_id IS NOT NULL;


-- ─── RELEASE TRACKERS (one per project per draw) ───────────────────────

CREATE TABLE release_trackers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pay_app_id          UUID REFERENCES pay_apps(id) ON DELETE SET NULL,
    period              TEXT NOT NULL,
    invoice_amount      NUMERIC(14,2),                    -- Pulled from pay_apps.current_payment_due
    invoice_amount_overridden BOOLEAN NOT NULL DEFAULT FALSE,
    conditional_through_date DATE,

    -- Workflow checkboxes (top of sheet)
    requested_releases  BOOLEAN NOT NULL DEFAULT FALSE,
    verified_releases   BOOLEAN NOT NULL DEFAULT FALSE,
    approved            BOOLEAN NOT NULL DEFAULT FALSE,
    sent_to_gc          BOOLEAN NOT NULL DEFAULT FALSE,

    -- Buildertrend reconciliation
    buildertrend_total          NUMERIC(14,2),
    less_misc_field_expenses    NUMERIC(14,2) DEFAULT 0,

    -- Generated artifacts
    excel_file_path             TEXT,
    excel_generated_at          TIMESTAMPTZ,

    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (project_id, period)
);

CREATE INDEX idx_release_trackers_project ON release_trackers(project_id, period);


-- ─── RELEASE LINES (one per sub per release tracker) ───────────────────

CREATE TABLE release_lines (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    release_tracker_id          UUID NOT NULL REFERENCES release_trackers(id) ON DELETE CASCADE,
    sub_id                      UUID NOT NULL REFERENCES subs(id) ON DELETE CASCADE,

    billed_amount               NUMERIC(14,2) NOT NULL DEFAULT 0,
    check_amount                NUMERIC(14,2) NOT NULL DEFAULT 0,
    release_type                TEXT CHECK (release_type IN ('CP', 'UP', 'CF', 'UF')),
    exception                   TEXT,                                  -- "N", "Y", "N/A"
    prev_month_status           TEXT,                                  -- "Received", "Requested", "Pending"

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (release_tracker_id, sub_id)
);

CREATE INDEX idx_release_lines_tracker ON release_lines(release_tracker_id);


-- ─── PREVIOUS UNBILLED ENTRIES (per-tracker, per-row) ──────────────────
-- The 5-row "Previous Month(s) Unbilled Balance Due" section.

CREATE TABLE release_unbilled_entries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    release_tracker_id  UUID NOT NULL REFERENCES release_trackers(id) ON DELETE CASCADE,
    description         TEXT,
    amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
    sort_order          INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (release_tracker_id, sort_order)
);


-- ─── WAIVERS (uploaded signed waiver documents) ────────────────────────
-- One waiver doc per (release_line, waiver_type) — corresponds to a file
-- dropped in the CP/UP/CF/UF folder for that draw.

CREATE TABLE waivers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    release_line_id     UUID NOT NULL REFERENCES release_lines(id) ON DELETE CASCADE,
    waiver_type         TEXT NOT NULL CHECK (waiver_type IN ('CP', 'UP', 'CF', 'UF')),

    file_path           TEXT NOT NULL,           -- path in Supabase Storage
    file_name           TEXT NOT NULL,           -- original filename uploaded by user
    file_size_bytes     BIGINT,
    mime_type           TEXT,

    received_at         DATE,                    -- when waiver was received from sub
    uploaded_by         UUID REFERENCES app_users(id),
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    notes               TEXT,
    UNIQUE (release_line_id, waiver_type)
);

CREATE INDEX idx_waivers_release_line ON waivers(release_line_id);


-- ─── AUDIT LOG ─────────────────────────────────────────────────────────
-- Captures every meaningful change for compliance + debugging.
-- Records: who did what, when, before, and after.

CREATE TABLE audit_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID REFERENCES app_users(id),
    entity_type         TEXT NOT NULL,    -- 'project', 'pay_app', 'change_order', etc.
    entity_id           UUID NOT NULL,
    action              TEXT NOT NULL,    -- 'created', 'updated', 'submitted', 'paid', 'deleted'
    before_data         JSONB,
    after_data          JSONB,
    metadata            JSONB,            -- free-form extras (IP, user-agent, etc.)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);


-- ─── EMAIL NOTIFICATIONS ───────────────────────────────────────────────
-- Outbox pattern: queue notifications, send via background worker.

CREATE TABLE email_outbox (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    to_email            TEXT NOT NULL,
    cc_emails           TEXT[],
    bcc_emails          TEXT[],
    subject             TEXT NOT NULL,
    body_html           TEXT NOT NULL,
    body_text           TEXT,
    attachments         JSONB,            -- [{path, name, mime_type}]

    related_entity_type TEXT,
    related_entity_id   UUID,

    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    sent_at             TIMESTAMPTZ,
    failed_at           TIMESTAMPTZ,
    failure_reason      TEXT,
    retries             INTEGER NOT NULL DEFAULT 0,

    created_by          UUID REFERENCES app_users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_outbox_status ON email_outbox(status, created_at) WHERE status IN ('pending', 'failed');


-- ─── TRIGGERS ──────────────────────────────────────────────────────────

-- Auto-update updated_at on any row update
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'projects', 'sov_lines', 'change_orders', 'pay_apps',
            'pay_app_billings', 'subs', 'release_trackers',
            'release_lines'
        ])
    LOOP
        EXECUTE format('
            CREATE TRIGGER set_updated_at
            BEFORE UPDATE ON %I
            FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
        ', t);
    END LOOP;
END $$;


-- Sync auth.users → app_users on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.app_users (id, email, full_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ─── ROW LEVEL SECURITY (RLS) ──────────────────────────────────────────
-- Default: deny everything. Authenticated users see/edit per role.
-- Backend uses service-role key to bypass RLS for engine operations.

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sov_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_app_billings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subs ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_trackers ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_unbilled_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read everything (Ferrocrete is small + trusted internally).
-- Future: tighten to per-role policies if needed.
CREATE POLICY "authenticated_read_all" ON projects
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON sov_lines
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON change_orders
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON pay_apps
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON pay_app_billings
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON subs
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON release_trackers
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON release_lines
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON release_unbilled_entries
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_all" ON waivers
    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_self" ON app_users
    FOR SELECT TO authenticated USING (auth.uid() = id);

-- Writes happen through the backend (which uses service role) — frontend never writes directly.
-- That keeps RLS simple: read-only from the browser.


COMMENT ON SCHEMA public IS 'Ferrocrete Pay App + Release Tracker — initial schema, migration 001';
