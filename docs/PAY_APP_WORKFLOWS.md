# Ferrocrete Pay App — Workflows Reference

A plain-language guide to everything the app does and who can do it. Written for
accounting and executive users. For a click-by-click walkthrough with
screenshots, see **PAY_APP_SOP.md**.

---

## 1. Who does what (roles)

Every user has one role. Your role decides which buttons you see.

| Role | Typical person | Can do |
|------|----------------|--------|
| **admin** | Owner / CEO / controller | Everything, including **approve** pay apps, **delete** projects, and **delete** release trackers |
| **accountant** | Bookkeeper / AP | Create & edit projects and pay apps, submit for approval, send to GC, mark paid, manage releases |
| **pe** | Project engineer | Create & edit projects and pay apps, manage releases (cannot approve, cannot delete projects/trackers) |
| **viewer** | Read-only stakeholder | View everything, change nothing |

> **Key rule:** only an **admin** can *approve* a pay application. That is the CEO/controller sign-off step. Accountants and PEs prepare and submit; an admin approves.

---

## 2. Getting around (navigation)

The top bar has three destinations:

- **Pay Applications** — the company-wide list of pay apps across all projects.
- **Projects** — the list of projects; drill into a project for its pay apps, subs, and release trackers.
- **Billing Summary** — the monthly roll-up of what was billed and net income.

There is also a light/dark toggle and your name/initials on the right.

**Inside a project** you can reach:
- **Pay Applications** for that project
- **Subs** (subcontractors/vendors)
- **Release Trackers** for that project

---

## 3. The building blocks

| Object | What it is |
|--------|------------|
| **Project** | One construction contract. Holds contract value, retention rate, GC contact. |
| **SOV line** | Schedule-of-Values line item — a row of the contract's breakdown. |
| **Change order** | An approved add/deduct to the contract. Only *approved* COs affect billing. |
| **Sub** | A subcontractor or vendor on the project (used by release trackers). |
| **Pay application** | The monthly AIA-style billing to the GC (G702/G703). |
| **Release tracker** | The monthly log of lien-release / waiver status for each sub. |
| **Waiver** | A signed lien-release PDF (Conditional/Unconditional, Partial/Final). |

---

## 4. Workflow — Set up a project

1. **Projects → New project.** Enter project number, name, contract value, retention rate, GC contact.
   - *Contract value and retention rate are locked after creation* — change the contract only via a **change order**.
2. **Add SOV lines** — the schedule-of-values breakdown the pay apps bill against.
3. **Add change orders** as they're approved (only approved COs roll into billing).
4. **Add Subs** (on the project's **Subs** page) — these feed the release trackers.
   - *Import option:* **Projects → Import** lets you bring a project in from an Excel file instead of typing it.

> **Tip for re-entering old data:** add the project and its **subs first**, then back-enter pay apps / release trackers. Trackers seed empty until subs exist.

---

## 5. Workflow — Create and bill a pay application

This is the monthly core of the app.

1. Open the project → **Pay Applications → New pay app**.
   - Pick the **period** (YY-MM) and **application number**.
   - The app auto-creates a billing row for every SOV line and approved CO, and
     **carries forward** last period's completed work automatically (so the
     G703 math lines up month to month).
   - A **release tracker** for the same period is auto-created at the same time.
2. **Enter this period's work** on each line (work completed, materials stored).
   Totals, retention, and "current payment due" calculate automatically.
3. (Optional) Record **retention billed** on the pay app when you bill retention.
4. Download the **AIA G702/G703 PDF** or **Excel** from the pay app page when ready.

### Pay-app lifecycle (status flow)

```
 draft ──submit for approval──► pending_approval ──approve (admin)──► approved
   ▲            │                      │                                  │
   │            └──recall──────────────┘                                  │
   │                                                                      │
   └──reject (admin) / unapprove (admin)◄──────────────────────  send to GC │
                                                                          ▼
                                                       submitted ──mark paid──► paid
                                                          │
                                                          └──unsend──► approved
```

| Action | From → To | Who |
|--------|-----------|-----|
| Submit for approval | draft → pending_approval | accountant, admin |
| Recall (undo submit) | pending_approval → draft | accountant, admin |
| **Approve** | pending_approval → approved | **admin only** |
| **Reject** (with reason) | pending_approval → draft | **admin only** |
| Unapprove (undo approve) | approved → draft | admin only |
| Send to GC | approved → submitted | accountant, admin |
| Unsend (undo) | submitted → approved | accountant, admin |
| Mark paid | submitted → paid | accountant, admin |
| Delete pay app | any → removed | accountant, admin |

> **Emails:** submitting for approval emails all admins ("needs your approval").
> Approve/reject emails the person who submitted it. Sending to GC emails the GC
> (if a GC email is on the project). The app only sends these at the specific
> steps above — nothing goes out silently.

---

## 6. Workflow — Approvals (the CEO / admin sign-off)

1. An accountant or PE finishes a draft and clicks **Submit for approval**.
2. Every **admin** gets an email and sees the pay app in their "Awaiting your approval" queue on the Pay Applications dashboard.
3. The admin opens it and either:
   - **Approve** → it moves to *approved* and the submitter is notified, or
   - **Reject** → it returns to *draft* with a reason, and the submitter is notified.
4. Made a mistake? An admin can **Unapprove** an approved pay app to send it back to draft.

---

## 7. Workflow — Release trackers (lien waivers)

Each pay-app period has a **release tracker** that logs, per sub, whether the
conditional and unconditional waivers have been requested, received, and sent.

**Creating trackers**
- **Automatic:** one is created whenever you make a pay app for that period.
- **From an existing pay app:** the Release Trackers page shows a "Create missing trackers" list for any pay-app period without one.
- **Back-enter a past period:** use **"＋ Add tracker for a period"** on the Release Trackers list to add a tracker for any YY-MM period, even with no pay app (for historical data). Subs and prior-period lines carry forward; amounts start at zero.

**Working a tracker**
- Each row is a sub. Fill in billed amount, check amount, release type (CP/UP/CF/UF), and per-sub lifecycle status (requested → received → verified → sent to GC). *These details are entered manually each month — they are not auto-filled.*
- Upload a signed **waiver PDF** per line; the app can also generate Ferrocrete's own CP/UP/CF/UF waiver forms.
- Send **waiver-chasing email reminders** to subs from the tracker.
- Export the tracker to **Excel**.

**Deleting**
- An **admin** can delete a single tracker with the **Delete** button on the Release Trackers list (permanent — removes its lines, unbilled entries, and waivers).
- Deleting a **project** automatically purges all of that project's trackers.

---

## 8. Workflow — Billing Summary

**Billing Summary** (top nav) is the monthly, company-wide financial roll-up.

- Pick a **period** at the top right.
- Cards show **Billed this period**, **Net income this period**, **Net income accrued to date**, and **Total billed to date**.
- The table lists every active project with billed amount, potential net, waiver flags, and editable columns (billing due date, contact, payment status).
- **Export Excel** produces the summary sheet.
- Soft-deleted projects are excluded from all totals automatically.

---

## 9. Deleting and cleanup — what happens

| You delete… | Result |
|-------------|--------|
| A **pay app** | Removed (accountant/admin). |
| A **release tracker** | Permanently removed with its lines/waivers (admin). |
| A **project** | *Soft-deleted* (hidden, history retained) **and all its release trackers are purged**. Its pay apps are retained for audit. Admin only. |

> **Project numbers are reusable:** after a project is deleted you can create a
> new project reusing the same project number.

---

## 10. Quick permissions matrix

| Capability | viewer | pe | accountant | admin |
|------------|:-----:|:--:|:----------:|:-----:|
| View everything | ✅ | ✅ | ✅ | ✅ |
| Create/edit project | | ✅ | ✅ | ✅ |
| Create/edit pay app & billings | | ✅ | ✅ | ✅ |
| Submit for approval | | | ✅ | ✅ |
| **Approve / reject pay app** | | | | ✅ |
| Send to GC / mark paid | | | ✅ | ✅ |
| Manage release trackers | | ✅ | ✅ | ✅ |
| Delete pay app | | | ✅ | ✅ |
| Delete release tracker | | | | ✅ |
| Delete project | | | | ✅ |

---

*Questions or a step that doesn't match what you see? Your role may hide some
buttons — check Section 1.*
