# Ferrocrete Pay App — Knowledge Transfer

_Last updated: 2026-08-26_

A single reference for the Ferrocrete Builders internal app that manages **pay
applications (AIA G702/G703)**, **subcontractor release trackers**, and the
cross-project **billing summary**. Read this top-to-bottom once; after that use
the section index and the file map at the end.

---

## 1. What the app does

Ferrocrete Builders is a concrete subcontractor. Each project, each month
("period", `YY-MM`), the team:

1. Builds a **pay application** against the Schedule of Values (SOV) and sends
   the AIA **G702/G703** to the GC/owner.
2. Requests bills + conditional lien releases (**CP/CF**) from its own subs.
3. Tracks each sub through a **release tracker**: bill → CP/CF → GC payment →
   paid sub → UP/UF, reconciling invoice vs. checks vs. Buildertrend and
   computing **Ferrocrete's net income** for the period.
4. Rolls everything up into an internal **Billing Summary** (one row per
   project per period) with net-income-to-date.

Three user-facing modules: **Pay Applications**, **Release Trackers** (under a
project), and **Billing Summary**. All internal; nothing here is shared with the
GC except the pay app itself and Ferrocrete's own waivers.

---

## 2. Architecture & stack

| Layer | Tech | Host |
|---|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript, plain CSS design system | **Vercel** (auto-deploys `frontend/` on push to `main`) |
| Backend | FastAPI (Python), Pydantic v2, Decimal money | **Render** (auto-deploys on push to `main`) — https://ferrocrete-pay-app.onrender.com |
| Database / Auth / Storage | **Supabase** (Postgres + Auth + Storage) | Supabase cloud |
| Email | **Gmail HTTP API** (OAuth single-user; SMTP is blocked on Render) | — |
| Repo | `hemanthmuppidi236/ferrocrete-pay-app` (public GitHub) | — |

- **Live site:** `ferrocrete-pay-app.vercel.app`
- **Local working clone (this machine):** `C:\Users\heman\ferro-ui-work`
- Backend Python venv: `backend/.venv` — run tests with
  `./.venv/Scripts/python.exe -m pytest` from `backend/`.

### Design system
- Fonts: **EB Garamond** (content/headings), **IBM Plex Mono** (labels, data,
  metadata).
- Brand: red `#E72227`, near-black `#1A1A1A`, cream `#FDF6E9`, plus a gold
  accent. Semantic status tokens `--status-green/amber/red/blue`.
- Light/dark theme via `data-theme` on the root; the topbar owns the toggle and
  a pre-paint script in `layout.tsx` avoids a dark-mode flash on load.
- **House rule: no em dashes anywhere** (code, UI copy, emails, PDFs, Excel).

---

## 3. Auth & roles

- Sign-in is **Google OAuth via Supabase**, restricted to
  **@ferrocretebuilders.com** Google Workspace accounts. A personal Gmail is
  rejected — this is the usual cause of "sign-in failing" reports.
- The frontend attaches the Supabase access token as a Bearer header (see
  `frontend/src/lib/api.ts`); the backend validates the JWT (`core/auth.py`).
- Roles: **admin**, **accountant**, **pe**, **viewer**. Editing across the app
  is gated to `admin` / `accountant` / `pe` (`require_role(...)` on the backend,
  a `canEdit` check on the frontend). `viewer` is read-only.
- Every create/update writes an **audit log** row (`core/audit.py`).

---

## 4. Deployment & dev workflow

- **`main` is production.** Merging to `main` triggers Vercel (frontend) and
  Render (backend) auto-deploys. Vercel is typically faster; Render can cold
  start.
- **Workflow per change:** feature branch → verify locally (`tsc --noEmit`,
  `next build`, `pytest`) → open PR → (run any migration in Supabase) → merge to
  `main` → verify on the live site.
- **Migrations are applied by hand** in the Supabase SQL editor. They are
  additive and idempotent; endpoints that read new columns generally degrade
  gracefully if a migration has not been applied yet, but writes need it.
  Always run the migration **before** merging a PR that depends on it.
- Git identity for commits in the clone:
  `user.email hemanthmuppidi.r@gmail.com`, `user.name hemanthmuppidi236`.

---

## 5. Data model & migrations

Migrations live in `migrations/` and are numbered. Apply in order.

| # | File | Adds |
|---|---|---|
| 001 | `001_initial_schema.sql` | Core: `app_users`, `projects`, `sov_lines`, `change_orders`, `pay_apps`, `pay_app_billings`, `subs`, `release_trackers`, `release_lines`, `release_unbilled_entries`, `waivers`, `email_outbox`, `audit_log`; `trigger_set_updated_at()`; RLS read-only policies |
| 002 | `002_add_gc_address.sql` | `projects.gc_address` |
| 003 | `003_pay_app_approval_workflow.sql` | Pay-app approval workflow timestamps/actors |
| 004 | `004_billing_summary.sql` | `billing_summary_overrides` (per project+period manual columns) |
| 005 | `005_release_line_lifecycle.sql` | ~15 `release_lines` lifecycle columns (bill/conditional/check/unconditional statuses + dates, `check_type`, `difference_note`); `projects.grace_days` (default 14); backfill from amounts + waivers |
| 006 | `006_release_reminders.sql` | `subs.billing_email` / `billing_cc`; `release_line_reminders` log |
| 007 | `007_billing_summary_extend.sql` | `projects.billing_due_rule` / `billing_contact`; `billing_period_meta` (per-period Quickbooks total) |
| 008 | `008_retention_billed.sql` | `pay_apps.retention_billed` / `retention_billed_amount` |
| 009 | `009_waivers_owner.sql` | `projects.owner_name` / `owner_address`; `pay_apps.cpcf_sent_at` / `upuf_sent_at` |

Conventions in migrations: `CREATE TABLE IF NOT EXISTS`, `NUMERIC(14,2)` money,
`NUMERIC(5,4)` rates, text-as-enum via `CHECK (col IN (...))`, `TIMESTAMPTZ`,
RLS enabled with an `authenticated_read_all` SELECT policy (all writes go
through the service-role backend), and a trailing `NOTIFY pgrst, 'reload schema'`.

### Key tables at a glance
- **projects** — project_no, name, address (job location), gc_company /
  gc_address / gc_contact_*, contract_value, retention_rate, `grace_days`,
  `billing_due_rule`, `billing_contact`, `owner_name`, `owner_address`, status.
- **pay_apps** — one per project+period; computed AIA totals (revised_contract,
  total_completed_to_date, retention_held, current_payment_due, etc.), workflow
  status, `retention_billed(_amount)`, `cpcf_sent_at` / `upuf_sent_at`.
- **pay_app_billings** — per SOV line / change order: previous_work,
  this_period_work, materials_stored.
- **subs** — project subcontractors; `is_non_prelimed`, `parent_sub_id` (tier),
  `default_release_type`, contact_email, `billing_email` / `billing_cc`.
- **release_trackers** — one per project+period; invoice_amount,
  conditional_through_date, buildertrend_total, less_misc_field_expenses. The
  four workflow flags are stored but treated as **derived** in the API.
- **release_lines** — one per sub on a tracker; billed/check amounts + the WI-2
  lifecycle columns. `UNIQUE(release_tracker_id, sub_id)`.
- **release_unbilled_entries**, **waivers**, **release_line_reminders**,
  **billing_summary_overrides**, **billing_period_meta**, **email_outbox**.

---

## 6. Core domains & business logic

### 6.1 Pay applications (AIA G702/G703)
- SOV entry lives on the pay-app detail page; the G702 sidebar recalculates on
  every keystroke (`lib/payAppMath.ts` mirrors the backend `core/pay_app_math.py`).
- Approval workflow states: `draft → pending_approval → approved → submitted →
  paid` (plus `void`), with revert transitions (recall/unapprove/unsend).
  Billings are only editable while `draft`.
- **G702 line 8 = current payment due** is the canonical "billed amount" used
  downstream (invoice on the tracker, Billed on the Billing Summary).
- **SOV table** matches the AIA G703 columns exactly: Level, Description of
  Work, Scheduled Value, Work Completed From Previous Application, This Period,
  Materials Presently Stored, Total Completed and Stored to Date, % (G/C),
  Balance to Finish (C-G), Retention — with a bold Totals row.
- **Retention billed:** a "Was retention billed this period?" toggle + amount
  (`pay_apps.retention_billed*`). Surfaces as its own Billing Summary column
  (with footer "billed/net incl. retention") and as a provision line on the
  linked release tracker. Row-level Billed/Net are unchanged.
- **G702 PDF / G703 Excel** are generated on demand (`core/pdf_pay_app.py`,
  `core/excel_pay_app.py`) and stored in Supabase Storage; the client gets a
  signed URL.
- **Ferrocrete's own waivers (CP/UP/CF/UF):** downloadable statutory PDFs
  (`core/waiver_forms.py` = verbatim CA Civil Code 8132/8134/8136/8138 text +
  field mapping; `core/pdf_waivers.py` = ReportLab renderer matching the native
  AIA boxed-table layout). Claimant is Ferrocrete (constant), Customer is the
  project GC, Owner is the project field, Job Location is the project address,
  Amount of Check is G702 line 8, Through Date is period_to (progress forms
  only). Signature line is left blank (signed by hand). Filename:
  `{project_no}_{project_name}_App{app_no}_Ferrocrete_{CP|UP|CF|UF}.pdf`.
  Plus "CP/CF sent" / "UP/UF sent" date toggles on the pay app.

### 6.2 Subs (subcontractors)
- Prelimed subs are tracked individually with the full CP/UP/CF/UF waiver
  workflow.
- **Non-prelim payments** are captured by a single auto-created catch-all sub
  per project named **"Non-Prelim Payments"** (`is_non_prelimed = true`); the
  itemized detail is tracked in a separate app. `ensure_default_nonprelim_sub`
  creates it on tracker creation, and `get_release_tracker` also adds it to
  older trackers if missing (`core/release_carry_forward.py`).
- Sub tiers: a sub can have `parent_sub_id`; the tracker UI indents children.

### 6.3 Release trackers — per-sub lifecycle (WI-2, the heart of the app)
Each sub line moves through a derived **stage**
(`backend/app/core/release_stage.py`, mirrored client-side in
`frontend/src/lib/releaseStage.ts`):

```
awaiting_bill → awaiting_conditional → awaiting_gc_payment
             → awaiting_check_release → awaiting_unconditional → complete
```
Non-prelim subs skip the conditional/unconditional stages
(`awaiting_bill → awaiting_check_release → complete`). Lines with zero
billed+check, or marked not_applicable, are `n/a`.

- Per-line fields: `bill_status`, `conditional_status`, `unconditional_status`
  (each an enum), their dates, `check_type`, `check_received_at`,
  `check_sent_to_sub_at`, `difference_note`. `bill_due_at = bill_requested_at +
  project.grace_days`.
- **Tracker-level workflow flags are derived, not stored** — `requested_releases`
  (all bills requested), `verified_releases` (all conditionals verified/sent),
  `sent_to_gc` (all unconditionals sent). `approved` stays the one manual flag.
  The UI labels them **Bills received / CP/CF sent to GC / GC approved /
  payment received (manual) / UP/UF received**.
- **UI:** each row shows a **stepper** (Bill · CP/CF · GC pays · Paid Sub ·
  UP/UF) colored by state (green done, blue/amber current, red overdue), and
  clicking expands a stage strip of uniform cards with dated "mark as…" actions
  and inline waiver upload. Uploading a CP/CF or UP/UF auto-advances the
  matching status to `received`.
- **Reconciliation math** (shown on the tracker and in the export):
  - Subs/Vendors Total = Σ checks on prelimed lines
  - Ferrocrete Total = Invoice − Subs/Vendors Total
  - Non-Prelimed Total = Σ checks on non-prelim lines
  - **Ferrocrete Net = Ferrocrete Total − Non-Prelim Total − Unbilled Total**
    (equivalently `invoice − Σ(all checks) − Σ(prev-month unbilled)`) — this is
    the **Potential Net** consumed by the Billing Summary.
  - Buildertrend side = BT Total + Unbilled − Misc; Spreadsheet side = Subs +
    Non-Prelim + Unbilled; **Discrepancy** = the two sides' difference.
- **Excel export:** `core/tracker_export.py` → `GET /release-trackers/{id}/export.xlsx`
  builds the reference `26-06` layout with **live formula totals**.

### 6.4 Email reminders (WI-3)
- Reuses the pay-app Gmail sender (`core/email.py::send_email` → `email_outbox`
  log). Four templates in `core/reminder_templates.py` (request bill+CP/CF,
  CP/CF overdue, request UP/UF, UP/UF overdue), plain text, `{sub}` token for
  bulk personalization, no em dashes.
- `core/api/reminders.py`: `POST .../reminders/preview` and `.../reminders/send`.
  Resolves each sub's `billing_email` (falls back to `contact_email`), skips
  subs with none, logs `release_line_reminders`, and auto-advances status to
  `requested` for the two "request" templates.
- UI: per-line + bulk "Email subs" buttons with a preview-and-edit modal, a
  "Last emailed" note, and a no-email warning.
- **No scheduler exists** in the app (no cron/APScheduler). The daily overdue
  sweep is a **documented follow-up**; all reminders work today as manual sends.

### 6.5 Billing Summary
- One row per project per period, matching reference sheet `26-08` (columns
  A–T minus the manager-removed ones). Auto columns come from pay apps
  (`core/billing_math.py`), Potential Net from the release tracker.
- Columns on screen: Job, Billing Due Date, Revised Contract, Total Completed &
  Stored, Retention, Balance to Finish (E−F), Bal. W/Ret (E−F+G), Gross
  Billing, Retention %, Billed Amount, Potential Net, Retention Billed, BT,
  Billing Contact, Payment/Billing Status. (Rebar/CMU and CP/CF-Sent/UP/UF-Sent
  columns were removed per manager feedback.)
- Manual columns stored in `billing_summary_overrides` (per project+period);
  `billing_due_rule` / `billing_contact` default from the project.
- Footer: Net as % of Billed, editable **Quickbooks total** (per period, in
  `billing_period_meta`) with the diff vs. Billed, Running total for the year,
  and Billed/Net incl. retention.
- **Accrued** figures: net income and total billed to date (Σ over all periods
  ≤ selected).
- **Excel export:** `GET /billing-summary/export.xlsx` (openpyxl).

---

## 7. Shared infrastructure

- **Email** — `core/email.py`. `send_email(to, subject, body_html, body_text,
  cc, attachments, related_entity_type, related_entity_id, created_by)` records
  to `email_outbox` first, then sends via Gmail API if `settings.email_enabled`
  (all four `gmail_*` env vars set), else queues as `pending`. The canonical
  "generate files + email" flow is `pay_apps.py::send-to-gc`.
- **PDF** — `core/pdf_pay_app.py` (G702/G703), `core/pdf_waivers.py` (waivers);
  ReportLab.
- **Excel** — `core/excel_pay_app.py`, `core/excel_release_tracker.py` (legacy,
  template-based via `engines/`), `core/tracker_export.py` (self-contained),
  `core/billing_summary.py` export; openpyxl.
- **Storage** — `core/storage.py`; Supabase buckets `pay-apps`,
  `release-trackers`, `waivers`. Files returned as ~1h signed URLs.
- **Frontend API client** — `lib/api.ts`: `api.get/post/patch/put/delete`,
  `api.getBlob` (authenticated binary download for exports), typed `ApiError` /
  `NetworkError`, and `formatApiError()` for consistent messages.

---

## 8. API surface (by router)

Registered in `backend/app/main.py`. Notable endpoints:

- **projects** — CRUD; `PATCH` accepts the settings fields (grace_days,
  billing_due_rule, billing_contact, owner_name/address).
- **sov_lines**, **change_orders**, **subs** (`.../subs`), **me** (current user).
- **pay_apps** (`/pay-apps`) — list, dashboard, get, create (auto-creates a
  release tracker), `PUT /billings`, and the workflow transitions
  (`submit-for-approval`, `approve`, `reject`, `recall`, `unapprove`,
  `send-to-gc`, `unsend`, `mark-paid`), plus `PATCH` (metadata incl. retention
  billed).
- **release_trackers** (`/release-trackers`) — list, get (returns derived
  stages/flags + reminders + retention provision), create, `PATCH`,
  `PUT /lines`, `PUT /unbilled-entries`.
- **waivers** — upload/list/download/delete sub waivers (auto-advances line
  status).
- **reminders** — `POST /release-trackers/{id}/reminders/preview` and `/send`.
- **billing_summary** — `GET /billing-summary`, `PATCH /override`,
  `PATCH /quickbooks`, `GET /export.xlsx`.
- **artifacts** — pay-app Excel/PDF generate + signed URL; release-tracker Excel;
  `GET /release-trackers/{id}/export.xlsx`; `GET /pay-apps/{id}/waiver/{type}.pdf`;
  `POST /pay-apps/{id}/mark-waiver-sent`.
- **email_outbox**, **import_excel**, **admin**.

---

## 9. Frontend map

Routes under `frontend/src/app/(app)/`:
- `pay-apps/page.tsx` — pay-app dashboard.
- `billing-summary/page.tsx` — the Billing Summary.
- `projects/page.tsx`, `projects/new`, `projects/import`.
- `projects/[id]/page.tsx` — project detail + **ProjectEditPanel** (all settings
  fields live here).
- `projects/[id]/subs/page.tsx` — Manage Subs.
- `projects/[id]/pay-apps/[period]/page.tsx` — pay-app detail (SOV, G702
  sidebar, workflow actions, retention-billed card, Ferrocrete-waivers panel).
- `projects/[id]/releases/page.tsx` — tracker list (stage summary + status pill).
- `projects/[id]/releases/[period]/page.tsx` — **tracker detail** (the biggest
  file: stepper, stage strip, reminders, reconciliation, unbilled, Excel export).

Shared libs (`frontend/src/lib/`): `api.ts`, `types.ts` (mirror backend
schemas), `payAppMath.ts`, `releaseStage.ts` (stage labels/colors + client
stage derivation), `useCurrentUser.ts`, `periodFilters.ts`, `supabase/`.
Components (`frontend/src/components/`): `topbar.tsx` (nav + theme toggle),
`ErrorBanner.tsx` (shared).

---

## 10. Testing

- Backend: `pytest` from `backend/` (currently ~75 tests). No `pytest.ini`;
  `tests/conftest.py` puts the backend on `sys.path` and stubs the four Supabase
  env vars so `Settings()` instantiates. Endpoint tests use a hand-rolled fake
  Supabase client (a fluent `_Query`/`_Client` seeded from a dict) — see
  `tests/test_billing_summary_endpoint.py` and `tests/test_tracker_export.py`.
  Pure-function tests cover the money/stage/waiver/reminder logic.
- Frontend: `npx tsc --noEmit` and `npx next build` are the gates (no unit-test
  runner configured).

---

## 11. Conventions & gotchas

- **No em dashes** anywhere (enforced by a test on the waiver/reminder text).
- Money is **Decimal** on the backend, strings on the wire (`Money = string` in
  `types.ts`); never float.
- Periods are `YY-MM`. Filenames and labels derive the calendar month from that.
- Every write hits the **audit log**; keep that pattern when adding endpoints.
- Use `ApiError`/`NetworkError` + `formatApiError()` on the frontend; do not
  introduce a parallel error pattern.
- Two project schema files existed historically; the **active** one is
  `backend/app/schemas/projects.py` (`projects_schema.py` was dead code).
- `engines/release_engine.py` is the **legacy** filesystem/Excel engine — it is
  NOT the live carry-forward. Live tracker seeding is in
  `core/release_carry_forward.py` + the two API creation paths.

---

## 12. Open follow-ups / backlog

- **Scheduled reminder sweep** — no cron infra; the daily CP/CF and UP/UF
  overdue sweep is manual today. Would need a Render Cron Job or APScheduler
  calling the existing send logic.
- The legacy `excel_release_tracker.py` (template-based) still exists alongside
  the newer `tracker_export.py`; the newer one is what the tracker "Export
  Excel" button uses.
- Signature date on waivers is left blank (hand-dated); there is no stored
  "application date" field to auto-fill it.

---

## 13. File map (where to find what)

Backend (`backend/app/`):
- `main.py` — app + router registration + CORS.
- `core/config.py` — settings/env (Supabase, Gmail, buckets, CORS).
- `core/auth.py`, `core/audit.py`, `core/supabase_client.py`, `core/storage.py`.
- `core/pay_app_math.py`, `core/billing_math.py`, `core/release_stage.py`,
  `core/release_carry_forward.py` — the money/lifecycle logic.
- `core/email.py`, `core/reminder_templates.py` — email.
- `core/pdf_pay_app.py`, `core/pdf_waivers.py`, `core/waiver_forms.py` — PDFs.
- `core/excel_pay_app.py`, `core/excel_release_tracker.py`,
  `core/tracker_export.py` — Excel.
- `api/*.py` — routers (§8). `schemas/*.py` — Pydantic models. `tests/*.py`.

Frontend: see §9. Migrations: `migrations/` (§5).

Related docs in `docs/`:
- `release-tracker.md` — release-tracker infrastructure summary.
- `release-tracker-work-order-plan.md` — the WI-1…WI-6 work-order plan.
- this file.
