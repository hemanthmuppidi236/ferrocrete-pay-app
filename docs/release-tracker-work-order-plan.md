# Release Tracker Work Order — Implementation Plan

Prepared before coding, per the work order's Process step 1. Covers the files each work item touches, where the **actual codebase differs from the work order's assumptions**, the reconciliation math I verified against the spreadsheets, and open questions.

---

## 0. What I verified against the reference files

- **Billing Summary target = sheet `26-08`** (columns A–T). Older sheets (24-xx) use a simpler A–M layout; `26-08` is the current one. Note `26-08` has **two** balance columns: `H = Balance to Finish (E−F)` and `I = Balance to Finish W/Ret (E−F+G)`. `26-07` has only one. The work order's A–T table matches `26-08`.
- **WI-4 acceptance row (25-20, period 26-07, sheet `26-07` row 41)** checks out exactly: E 6,817,800.00 · F 2,690,156.60 · G 269,015.66 · Gross 844,265.60 · Ret 10% · Billed 759,839.04 · Potential Net 178,150.16. `Billed = Gross × (1 − Ret)`.
- **Footer metrics (`26-08`):** row 50 = totals of E,F,G,H,J,L,M (+O,P). `Net % of Billed = M50/L50`. `Quickbook` is a manual per-period cell (J57) with `diff = Quickbook − Billed total`. `Running Total to Date` = sum of billed across the year's sheets.
- **Waiver tabs (`25-20` CP/UP/CF/UF):** extracted the full CA statutory text (Civ. Code 8132/8134/8136/8138) and every formula ref. Confirmed: Amount of Check = `702!G30` (= 759,839.04), Through Date = `G703!I5` (7/31/2026), Signature date = `G703!I4`, Title default "Project Executive". Claimant/Customer/Owner/Job come from `Prelim Sheet` F19/F14/F9/F30-31.
- **Tracker reconciliation (`2935` sheet `26-06`):** confirmed the Excel order — Subs/Vendors Total → Ferrocrete Total (Invoice − Subs) → Non-Prelimed section+total → Prev-Month Unbilled section+total → Ferrocrete Net (Ferro Total − Non-Prelim − Unbilled) → Buildertrend reconciliation → Spreadsheet Total → Discrepancy. Column I holds the per-line Difference (D−E) and the free-text note ("Amount to be deposited to Ferrocrete account").

---

## 1. Divergences from the work order (read before starting)

1. **Carry-forward is NOT in `release_engine.py`.** That file is the legacy filesystem/Excel engine and is not what runs on `POST /release-trackers`. The live DB carry-forward is in **`backend/app/api/release_trackers.py::create_release_tracker`**, and pay-app creation calls a second path, **`backend/app/api/pay_apps.py::_autocreate_release_tracker` (pay_apps.py:399)**. WI-1 must fix (or unify) **both** paths, not `release_engine.py`.

2. **WI-6 is largely already built.** `backend/app/core/excel_release_tracker.py` (`generate_and_store_release_tracker_excel`) exists, and `artifacts.py` already exposes `POST /release-trackers/{id}/generate-excel` + `GET /release-trackers/{id}/excel-url`. WI-6 becomes "verify/upgrade the existing export to the `26-06` layout," not "build from scratch."

3. **Billing Summary already exists** (`api/billing_summary.py`, `core/billing_math.py`, `schemas/billing.py`, table `billing_summary_overrides` from migration 004). It already returns revised_contract/completed/retention/balance/gross/billed/potential-net + the manual override columns. WI-4 is an **extension**, and two of its fields (`billing_due_rule`, `billing_contact`) are specified at **project** level, whereas today `billing_due_date`/`billing_contact` live **per-period** on the override table. Also today's `balance_to_finish = E−F+G` must be **split** into `H=E−F` and a new `I=E−F+G`.

4. **No scheduler/cron exists** (no APScheduler/Celery/render.yaml/Procfile). Per the work order's own allowance, WI-3's daily overdue sweep becomes a `POST /release-trackers/{id}/send-reminders` endpoint + a documented follow-up; the manual send buttons work now by reusing `email.send_email`.

5. **Missing project fields for WI-4/WI-5.** Projects have `gc_company`, `gc_contact_email`, `address`, `retention_rate`, `contract_value`. They **lack** owner name/address, lender, job-location, `billing_due_rule`, `billing_contact`. WI-5's waiver forms need owner/GC/job-location, so those become new project-settings fields + a migration. (Also: `schemas/projects.py` is active; `schemas/projects_schema.py` is dead code — ignore it.)

6. **Subs lack `billing_email`/`billing_cc`** (only `contact_email` exists). WI-3 adds them.

7. **Reusable infra confirmed:** email = `app/core/email.py::send_email(...)` (Gmail API, logs to `email_outbox`); PDF = `app/core/pdf_pay_app.py` (ReportLab) with `app/core/storage.py` buckets `pay-apps`/`release-trackers`/`waivers`; the canonical "generate files + email" flow to copy is `pay_apps.py::send-to-gc` (pay_apps.py:796).

---

## 2. Files touched per work item

### WI-1 — Subs appear on future trackers (union carry-forward)
- `backend/app/api/release_trackers.py` — rewrite carry-forward in `create_release_tracker` to **union** (prior lines, zeroed) + (active subs not already present); keep inactive carried lines only if nonzero amount or unresolved UP/UF. Allow new `sub_id`s in `PUT /{id}/lines` (already upserts — verify). Add `POST /{id}/lines/add` (or extend PUT) + line-remove guard (zero amounts, no waivers).
- `backend/app/api/pay_apps.py` — align `_autocreate_release_tracker` with the same union logic (or have it call the shared helper).
- New shared helper (e.g. `backend/app/core/release_carry_forward.py`) to avoid duplicating the union in two places.
- `frontend/.../releases/[period]/page.tsx` — "Add sub to this tracker" control + remove-line affordance.
- Tests: `backend/tests/test_release_carry_forward.py`.

### WI-2 — Per-sub status workflow (largest item)
- Migration `005_release_line_lifecycle.sql` — add the ~15 new `release_lines` columns (bill/conditional/check/unconditional statuses + dates, `check_type`, `difference_note`), project-level `grace_days` default 14; backfill from existing `release_type` + waiver presence.
- `backend/app/schemas/releases.py` — new enums/fields on `ReleaseLine`/`ReleaseLineUpdate`; derived `stage` on the detail payload.
- `backend/app/api/release_trackers.py` — compute derived per-line `stage` and derived tracker flags (`requested_releases`/`verified_releases`/`sent_to_gc`); keep accepting the old manual flags for one release with a deprecation log; waiver upload auto-advances status (see waivers router).
- `backend/app/api/waivers` (waiver upload endpoint) — on upload set matching status→received + stamp date; on delete revert.
- `frontend/.../releases/[period]/page.tsx` — `Stage` pill column, expandable stage strip with "mark as…" actions, `Check type` select, `Difference` column + inline `difference_note`, split into "Subs / Vendors" and "Non-Prelimed Bills" sections with subtotals.
- `frontend/.../releases/page.tsx` — replace WorkflowDots with an "N of M awaiting UP/UF" count summary; derive the status pill.
- Tests: stage-derivation unit tests + backfill test.

### WI-3 — Email reminders (reuse pay-app email)
- Migration `006_sub_billing_email.sql` — `subs.billing_email`, `subs.billing_cc`.
- `backend/app/core/email.py` — add 4 plain-text templates (request bill+CP/CF, CP/CF overdue, request UP/UF, UP/UF overdue); reuse `send_email` + `email_outbox`. No em dashes.
- `backend/app/api/release_trackers.py` — `POST /release-trackers/{id}/send-reminders` (single + bulk); auto-advance status→requested on send; write log rows with `release_line_id`.
- `frontend/.../releases/[period]/page.tsx` — per-line + bulk send buttons, preview modal (editable subject/body), "Last emailed: … (template)" note, missing-email warning icon.
- Follow-up (documented): scheduled daily sweep (needs new cron infra).
- Tests: template rendering + status advance.

### WI-4 — Billing Summary matches Excel columns
- Migration `007_billing_summary_extend.sql` — `projects.billing_due_rule`, `projects.billing_contact`; add `quickbooks_total` (period-level) — either as new columns on `billing_summary_overrides` or a new `billing_summary_entries` table per the work order (see Q3).
- `backend/app/core/billing_math.py` — split `H=E−F` and new `I=E−F+G`; Gross Billing from G703 (this-period E+F) with Billed = Gross×(1−Ret) [today it derives gross from billed — numerically equal, will reconcile]; Q/R (CP/CF, UP/UF sent) from WI-5's pay-app "mark sent" flags.
- `backend/app/api/billing_summary.py` — totals row, Net%-of-Billed, Quickbooks diff, Running-total-to-date; projects with no pay app show zeros not blanks; `Skip` sorts last; openpyxl export with the 18 headers, `$#,##0.00`, percent for K, bold header/totals, freeze panes.
- `backend/app/schemas/billing.py` — new fields.
- `frontend/.../billing-summary/page.tsx` — add columns D,H,I,N,O,P,Q,R + footer metrics.
- Tests: column math against the acceptance numbers.

### WI-5 — Generate Ferrocrete's own CP/UP/CF/UF from the pay-app page
- Migration `008_payapp_waiver_sent.sql` — `pay_apps.cpcf_sent_at`, `pay_apps.upuf_sent_at`; new project prelim fields if missing (owner name/address, lender, job-location) — reconcile with WI-4's project migration.
- `backend/app/core/pdf_waivers.py` (new, ReportLab, mirrors `pdf_pay_app.py`) — 4 forms with **verbatim** statutory text (I have it extracted); field mapping from Prelim Sheet / 702 / G703; filename `{project_no}_{period}_Ferrocrete_{CP|UP|CF|UF}.pdf`; store via `storage.py`.
- `backend/app/api/artifacts.py` — `GET /pay-apps/{id}/waiver/{type}.pdf` (or generate+signed-url like the others); `POST /pay-apps/{id}/mark-waiver-sent {kind}`.
- `frontend/.../pay-apps/[period]/page.tsx` — 4 Download buttons + Mark CP/CF sent, Mark UP/UF sent toggles.
- Tests: field-mapping unit tests.

### WI-6 — Tracker Excel export (mostly exists)
- Verify/upgrade `backend/app/core/excel_release_tracker.py` to the `26-06` layout with **formula** totals (not hardcoded), Difference column, both sections, Ferrocrete Net, Buildertrend block, Discrepancy. Endpoints already in `artifacts.py`.

---

## 3. Conventions I will follow
No em dashes anywhere (code/UI/email/PDF/Excel). No font changes. Brand red #E72227, near-black #1A1A1A, cream #FDF6E9. Role gating admin/accountant/pe edits. Audit log on every write. `ApiError`/`NetworkError`/`formatApiError` on the frontend. Additive, nullable/default-only migrations with backfills; house style = ASCII banner, `CREATE TABLE IF NOT EXISTS`, `NUMERIC(14,2)`, text-enums via CHECK, RLS `authenticated_read_all`, `set_updated_at` trigger, `NOTIFY pgrst`.

---

## 4. Open questions (need answers before coding)
1. **Sequencing / scope for this round** — all of WI-1→WI-6, or checkpoint after each?
2. **Migrations + verification** — these are additive migrations against the single **production** Supabase (WI-2 is a large live-schema change). Is there a dev/staging Supabase I can run a local backend against to verify end-to-end, or do I deliver migration files for you to apply on prod (as with 004) and verify via tests + deployed endpoints?
3. **WI-4 storage shape** — extend the existing `billing_summary_overrides` table (add `quickbooks_total`, move due-rule/contact to projects), or introduce the separately-named `billing_summary_entries` table as the work order writes it? (Recommend extending existing to avoid a parallel table.)
