# Phase 1B-α — Frontend Deployment to Vercel

The frontend is a standard Next.js 14 app. Vercel deploys these natively — no Dockerfile or custom build commands needed.

**Time required:** ~15 minutes assuming Phase 1A is already deployed.

---

## Pre-flight checks

Before deploying, confirm:

- ✅ Phase 1A backend is live at <https://ferrocrete-pay-app.onrender.com>
- ✅ `curl https://ferrocrete-pay-app.onrender.com/health` returns `{"status":"ok"}`
- ✅ Supabase is configured with Google OAuth and the email-domain restriction

---

## Step 1: Push the frontend to GitHub

The frontend is a new folder (`frontend/`) inside your existing `ferrocrete-pay-app` repo. From your local copy:

```bash
cd ~/path/to/ferrocrete-pay-app
git add frontend/
git commit -m "Phase 1B-α: Next.js frontend scaffold"
git push origin main
```

Refresh your GitHub repo page — you should now see the `frontend/` folder.

## Step 2: Sign up for Vercel

1. Open <https://vercel.com> in a new tab
2. Click **Sign Up**
3. Sign up with **GitHub** (uses the same GitHub account that owns the repo)
4. Authorize Vercel to access your repos. You can grant **all** or **only `ferrocrete-pay-app`** (more secure).

## Step 3: Import the project

1. On the Vercel dashboard, click **Add New** → **Project**
2. Find `ferrocrete-pay-app` in the list. Click **Import**.

## Step 4: Configure the build

Vercel auto-detects Next.js, but our frontend lives in a subdirectory of the repo, so we have to tell it that.

Configure:

| Field | Value |
|---|---|
| **Project Name** | `ferrocrete-frontend` (or whatever) |
| **Framework Preset** | **Next.js** (auto-detected) |
| **Root Directory** | Click **Edit** → choose `frontend` |
| **Build Command** | leave default (`next build`) |
| **Output Directory** | leave default |
| **Install Command** | leave default (`npm install`) |
| **Development Command** | leave default |

## Step 5: Add environment variables

In the **Environment Variables** section, add:

| Name | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` | from Supabase Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` | the anon/public key (NOT the service_role key) |
| `NEXT_PUBLIC_API_URL` | `https://ferrocrete-pay-app.onrender.com` | your Render backend URL |

⚠ Important: **don't paste the service_role key here.** That belongs only on the backend (Render). The frontend only needs the anon key.

Make sure all three variables are checked for **Production**, **Preview**, and **Development** environments.

## Step 6: Deploy

1. Click **Deploy**
2. Wait ~2-3 minutes for the build
3. When successful, Vercel gives you a URL like `https://ferrocrete-frontend.vercel.app`. **Copy it.**

## Step 7: Wire up the URLs in Supabase + Render

The deployment URL needs to be added in two places before login will work:

### 7a. Supabase

1. Go to Supabase dashboard → **Authentication** → **URL Configuration**
2. Update **Site URL** to your Vercel URL: `https://ferrocrete-frontend.vercel.app`
3. Under **Redirect URLs**, add:
   - `https://ferrocrete-frontend.vercel.app/**`
   - Keep `http://localhost:3000/**` for local dev
4. **Save**

### 7b. Google OAuth

1. Go to <https://console.cloud.google.com> → your project → **APIs & Services** → **Credentials**
2. Click your OAuth client ID
3. Under **Authorized redirect URIs**, the Supabase callback should already be there (`https://YOUR-PROJECT.supabase.co/auth/v1/callback`). Don't change it.
4. (Optional but recommended) Under **Authorized JavaScript origins**, add `https://ferrocrete-frontend.vercel.app`
5. **Save**

### 7c. Render (CORS)

1. Go to Render dashboard → your `ferrocrete-pay-app` service → **Environment**
2. Find `CORS_ORIGINS` and update to: `http://localhost:3000,https://ferrocrete-frontend.vercel.app` (comma-separated, no spaces)
3. Render will auto-redeploy when env vars change. Wait ~1 minute.

## Step 8: Test the full flow

1. Visit `https://ferrocrete-frontend.vercel.app`
2. You should be redirected to `/login`
3. Click **Continue with Google**
4. Sign in with your `@ferrocretebuilders.com` account
5. You should land on `/projects` with an empty list (or "No projects yet" if you haven't imported any)

🎉 Phase 1B-α is live.

---

## Importing your first project

From the empty projects page, click **Import from Excel**, upload one of your existing pay app `.xlsx` files (e.g., `25-05_Seagaze_-_26-04.xlsx`). You should see "Imported successfully" and be able to click through to view the project.

If anything errors, the most common causes:

- **401 Unauthorized**: your access token isn't being attached. Sign out, sign back in.
- **CORS error**: you forgot to update `CORS_ORIGINS` on Render (Step 7c). Refresh after Render redeploys.
- **422 Validation Error**: the .xlsx isn't AIA G702/G703 format (missing the `702` or `G703` sheet).

---

## Phase 1B-β preview

Once Phase 1B-α is verified working:

- Pay App Draft screen with the live G702 sidebar (from Demo 2)
- SOV Editor (add/edit/delete lines, drag to reorder)
- Change Order management
- Release Tracker UI (sub list, billed/check amounts, exception column)
- Waiver upload UI per release line
- Settings panels (project metadata, sub list editor)
