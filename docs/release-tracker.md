# Release Tracker — Infrastructure Summary

_Internal tool. **Never shared with the GC** — the "Sent to GC" checkbox is only a step in Ferrocrete's own waiver workflow._

**Purpose:** Per project, per month, track sub-tier **CP / UP / CF / UF** releases, reconcile **invoice vs. checks received**, and compute **Ferrocrete's net income** for the period. It is the single source of truth that feeds the cross-project **Billing Summary** (its "Potential Net" column = the tracker's `ferrocrete_net`).

- **CP** = Conditional Progress, **UP** = Unconditional Progress, **CF** = Conditional Final, **UF** = Unconditional Final (lien-release waiver classes).

---

## 1. Screens (UI)

Two pages, both under `frontend/src/app/(app)/projects/[id]/releases/`.

### A. Tracker list — `releases/page.tsx`
Route: `/projects/{id}/releases`

| UI element | Behavior |
|---|---|
| **Page header** | Eyebrow `PROJECT {no}`, title "Release Trackers", links: ← back to project · Manage subs |
| **No-subs notice** | Amber info card shown when the project has zero subs ("trackers will be empty…") with a link to add subs |
| **"Create missing trackers" card** | *(editors only)* Lists pay apps that have no tracker yet; each row shows period, `App #`, amount due, and a **Create tracker** button → `POST /release-trackers` then routes into the new tracker |
| **"All release trackers" list** | One `pay-app-row` per tracker, sorted newest period first. Left: period + **WorkflowDots**. Right: invoice amount (or "—") + **WorkflowStatus** pill |
| **WorkflowDots** | 4 inline dots — Requested / Verified / Approved / Sent — filled green (●) when the stage is done, faint (○) otherwise |
| **WorkflowStatus pill** | Highest reached stage: Draft (amber) → Requested (amber) → Verified (blue) → Approved (blue) → Sent (green) |
| **ErrorBanner** | Dismissible red banner on load/API errors |

### B. Tracker detail — `releases/[period]/page.tsx`
Route: `/projects/{id}/releases/{period}`

Loads tracker (by project+period → detail), project, subs (incl. inactive), and waivers in parallel. A single **Save changes** button (editors only) persists everything; workflow checkboxes save immediately on toggle.

**Sections, top to bottom:**

1. **Header** — eyebrow `PROJECT · RELEASE TRACKER · PERIOD {period}`, project name, links (← all trackers · view pay app · manage subs), and the **Save changes** button (shows "Saving…" / "✓ Saved" flash).

2. **Workflow + Invoice card** (two columns):
   - **Workflow** — 4 checkboxes: Requested releases, Verified releases, Approved, Sent to GC. Each toggles instantly via `PATCH`. Shows `CONDITIONAL THROUGH: {date}` when set.
   - **Invoice** — numeric `Invoice amount` input. Editing sets an **overridden** flag; if the tracker is linked to a pay app, a "Manually overridden — reset to pay app" link re-pulls `current_payment_due`.

3. **Sub releases table** (horizontally scrollable, min-width 1000):
   - Columns: **Sub · Billed · Check · Type · Exception · Prev month · Waivers**
   - **Rows are tree-grouped** — child subs (those with a `parent_sub_id` that also has a line here) render indented under their parent with a `↳`.
   - Inline editors: Billed/Check (number), **Type** select (—/CP/UP/CF/UF), **Exception** select (—/N/Y/N/A), **Prev month** select (—/Received/Requested/Pending).
   - **Waivers cell** — 4 slots (CP/UP/CF/UF) per line, each an upload/view/remove control (see §3).
   - **Totals row** — sums Billed and Check.
   - **Mismatch warning** — amber banner when `billed total ≠ invoice amount` (shows the difference).

4. **Previous month(s) unbilled balance** — 5 fixed row slots, each `Description` + `Amount`, with an **Unbilled total**. These represent prior-period amounts not yet billed; they subtract from net.

5. **Buildertrend reconciliation** — `Buildertrend total` and `Less misc field expenses` inputs, then a live computed line: **`BT − Misc − Checks`**. Renders green "✓ reconciled" when ≈ 0, red otherwise.

**Role gating:** editing is enabled only for roles `admin`, `accountant`, `pe` (`canEdit`). Everyone else sees read-only fields and waiver badges without upload/remove.

---

## 2. Data model

| Table | Key fields |
|---|---|
| `release_trackers` | `project_id`, `pay_app_id?`, `period` (YY-MM), `invoice_amount?`, `invoice_amount_overridden`, `conditional_through_date`, workflow flags (`requested_releases`, `verified_releases`, `approved`, `sent_to_gc`), `buildertrend_total?`, `less_misc_field_expenses?`, `notes?`. Unique per (project, period). |
| `release_lines` | One per sub on the tracker: `sub_id`, `billed_amount`, `check_amount`, `release_type` (CP/UP/CF/UF), `exception`, `prev_month_status`. Joined with `subs(name, parent_sub_id)` for display/grouping. |
| `release_unbilled_entries` | `description?`, `amount`, `sort_order` (seeded with 5 empty rows). |
| `waivers` | `release_line_id`, `waiver_type` (CP/UP/CF/UF), stored file (`file_path`, `file_name`, size, mime), `received_at?`, `uploaded_by/at`. One per (line, type). |
| `subs` | Project subcontractors: `name`, `parent_sub_id?` (tiering), `default_release_type?`, contact info, `is_non_prelimed`, `active`. |

**Derived / computed:**
- **Ferrocrete Net** (`ferrocrete_net` on `ReleaseTrackerDetail`) = `invoice_amount − Σ(line.check_amount) − Σ(unbilled.amount)`. Returns `null` when there's no invoice. Computed server-side in `get_release_tracker`; consumed by the Billing Summary.

---

## 3. Functionality by feature

**Auto-create & carry-forward** (`POST /release-trackers`):
- Pulls `invoice_amount` from the linked pay app's `current_payment_due` when not supplied.
- Sets `conditional_through_date` = last day of the period month.
- **Carry-forward:** copies the sub list (and `release_type`/`exception`) from the most recent prior tracker with **amounts zeroed**; `prev_month_status` reset to null. If no prior tracker exists, seeds lines from all **active** subs using each sub's `default_release_type`.
- Always seeds **5 empty** unbilled-entry rows.

**Editing / saving:**
- Detail page holds all edits in local state; **Save changes** fires three calls in sequence: `PATCH` metadata → `PUT …/lines` (full replace, upsert by `sub_id`, deletes removed subs) → `PUT …/unbilled-entries` (delete-all + reinsert), then refetches to sync server-coerced values and new line IDs.
- Workflow checkboxes bypass the batch and `PATCH` immediately.

**Waivers** (per line × 4 types):
- Upload: `POST /release-lines/{lineId}/waivers` (multipart, PDF/image). Three visual states — **uploaded** (green ✓), **uploading** (amber …), **empty** (gray dashed).
- View: `GET /waivers/{id}/download-url` → opens signed URL in a new tab.
- Remove: `DELETE /waivers/{id}` (editors only).

**Reconciliation checks (advisory, non-blocking):**
- Billed total vs. invoice amount mismatch banner.
- Buildertrend: `BT − Misc − Checks` should net to zero.

---

## 4. API surface (`/release-trackers`)

| Method | Path | Purpose | Role |
|---|---|---|---|
| GET | `/release-trackers?project_id=&period=` | List (newest period first) | any authed |
| GET | `/release-trackers/{id}` | Full detail: lines (+ sub names) + unbilled entries + `ferrocrete_net` | any authed |
| POST | `/release-trackers` | Create + carry-forward + seed | admin/accountant/pe |
| PATCH | `/release-trackers/{id}` | Update metadata / workflow flags | admin/accountant/pe |
| PUT | `/release-trackers/{id}/lines` | Replace all release lines | admin/accountant/pe |
| PUT | `/release-trackers/{id}/unbilled-entries` | Replace unbilled entries | admin/accountant/pe |
| GET | `/release-trackers/{id}/waivers` | List waivers for the tracker | any authed |
| POST | `/release-lines/{lineId}/waivers` | Upload a waiver (multipart) | editors |
| GET | `/waivers/{id}/download-url` | Signed download URL | any authed |
| DELETE | `/waivers/{id}` | Remove a waiver | editors |

All create/update ops write an **audit log** entry (`audit.log`).

---

## 5. Key files

| Layer | File |
|---|---|
| List UI | `frontend/src/app/(app)/projects/[id]/releases/page.tsx` |
| Detail UI | `frontend/src/app/(app)/projects/[id]/releases/[period]/page.tsx` |
| API router | `backend/app/api/release_trackers.py` |
| Schemas | `backend/app/schemas/releases.py` |
| Net math | `backend/app/core/billing_math.py` (`ferrocrete_net`) |
| Engine | `backend/engines/release_engine.py` |

---

## 6. Notes & known gaps

- **Excel export scaffolding exists but is unused** — `release_trackers` carries `excel_file_path` / `excel_generated_at` columns, but no export endpoint is wired up yet.
- `prev_month_status` is **not auto-tracked** across periods (reset to null on carry-forward) — it's a manual field per spec.
- `less_misc_field_expenses` defaults to `"0"` (not null) on save.
- Net income **accrued-to-date** is rolled up in the Billing Summary, not on the tracker page itself.
