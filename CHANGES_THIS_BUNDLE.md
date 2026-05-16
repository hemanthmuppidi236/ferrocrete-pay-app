# What's in this bundle vs. your previous repo state

This folder is a complete drop-in replacement for `~/Downloads/ferrocrete_app/`.
It contains every file from your original repo, with **14 files modified or
added** for Phase 1B-β:

## New files (3)
- `frontend/src/lib/useCurrentUser.ts` — React hook for fetching /me with cache
- `frontend/src/lib/periodFilters.ts` — Month/Quarter/Half/Year/Custom utility
- `frontend/src/app/(app)/pay-apps/page.tsx` — the new dashboard

## Modified files (11)

**Backend (2):**
- `backend/app/api/import_excel.py` — flexible SOV parser, GC extraction, PE role permission
- `backend/app/api/pay_apps.py` — adds new GET /pay-apps/dashboard endpoint

**Frontend (9):**
- `frontend/src/lib/types.ts` — adds `gc_address` field to Project
- `frontend/src/middleware.ts` — redirect to /pay-apps after login
- `frontend/src/components/topbar.tsx` — adds "Pay Applications" pill, breadcrumb updates
- `frontend/src/app/globals.css` — drops Playfair imports, adds .dash-* dashboard rules
- `frontend/src/app/page.tsx` — root redirects to /pay-apps
- `frontend/src/app/login/page.tsx` — post-auth default next = /pay-apps
- `frontend/src/app/auth/callback/route.ts` — post-auth default next = /pay-apps
- `frontend/src/app/(app)/projects/page.tsx` — title renamed "Pay Applications" → "Projects"
- `frontend/src/app/(app)/projects/[id]/page.tsx` — admin "Delete project" button

## How to use this folder

**Option A — wholesale replace** (cleanest):
```bash
# Back up your current state first
mv ~/Downloads/ferrocrete_app ~/Downloads/ferrocrete_app.backup

# Copy this folder in
cp -R /path/to/this/ferrocrete_app ~/Downloads/ferrocrete_app

# Restore your .git directory (this bundle doesn't include it)
cp -R ~/Downloads/ferrocrete_app.backup/.git ~/Downloads/ferrocrete_app/

# Push
cd ~/Downloads/ferrocrete_app
git add -A
git status   # confirm 14 changed files
git commit -m "Flexible SOV parser, admin delete, pay apps dashboard, two-font cleanup"
git push origin main
```

**Option B — rsync overlay** (keeps your existing .git in place):
```bash
rsync -av --exclude='.git' /path/to/this/ferrocrete_app/ ~/Downloads/ferrocrete_app/
cd ~/Downloads/ferrocrete_app
git add -A
git status
git commit -m "Flexible SOV parser, admin delete, pay apps dashboard, two-font cleanup"
git push origin main
```

## Smoke test after deploy

1. Hard-refresh `https://ferrocrete-pay-app.vercel.app` (Cmd-Shift-R)
2. Sign in → lands on `/pay-apps`, not `/projects`
3. Top nav shows two pills: **Pay Applications** (active) and **Projects**
4. Dashboard renders 4 stat cards. "Billed this month" has red→amber gradient
5. **Table renders as 7-column grid** (this was broken before — should now work):
   `Period | Project / GC | App | Status | Current due | % Complete | Open →`
6. Column headers render in small uppercase IBM Plex Mono caps
7. Row hover changes background to warm accent dim
8. Period chips (Month/Quarter/Half/Year/Custom) change the dropdown + re-fetch
9. Open drafts / Submitted counts stay STABLE when period changes (company-wide by design)
10. Open → link navigates to existing pay-app draft page
11. Projects pill goes to /projects, now titled "Projects" (not "Pay Applications")
12. Admin sees red "Delete project" button on project detail with two-click confirm
13. PE accounts (Raz, Shant) can now import .xlsx files
14. Theme toggle (◐/☾) — dashboard works in both light and dark modes
15. Login screen title "Pay Applications" renders in EB Garamond (not Playfair italic)

## What's NOT in this bundle

- `.git/` directory (you keep yours)
- `node_modules/` (run `npm install` if needed)
- `.next/` build artifacts
- `__pycache__/` Python caches
- macOS `.DS_Store` files
- `.env` / `.env.local` (your secrets stay local)
