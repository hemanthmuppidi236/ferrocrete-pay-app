# Ferrocrete Pay App — Phase 1A Deployment Guide

This guide walks through deploying the backend + database. Frontend is a separate phase (Phase 1B).

**Time required:** ~30 minutes if cloud accounts are ready, ~60 minutes if creating from scratch.

---

## Step 1: Create a Supabase project

1. Go to <https://supabase.com> and sign up with your Google Workspace account.
2. Click **New project**:
   - **Name:** `ferrocrete-payapp` (or whatever)
   - **Database password:** generate a strong one and save it in your password manager
   - **Region:** pick the one closest to your team (West US for California)
   - **Plan:** Free tier is fine
3. Wait ~2 minutes for the project to provision.

## Step 2: Run the database migration

1. In your Supabase dashboard, open **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `migrations/001_initial_schema.sql` from the codebase, copy the entire contents, paste into the SQL editor.
4. Click **Run**. Should complete with no errors. Verify by going to **Table Editor** — you should see ~13 tables (`projects`, `pay_apps`, etc.).

## Step 3: Configure Supabase Auth

1. **Authentication** → **Providers**:
   - Disable **Email** provider (we want Google-only)
   - Enable **Google** provider
   - Follow the wizard to set up Google OAuth credentials. You'll need to:
     - Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/)
     - Add the Supabase callback URL as an authorized redirect URI
     - Paste the Client ID + Client Secret back into Supabase
2. **Authentication** → **URL Configuration**:
   - **Site URL:** `http://localhost:3000` for now (we'll update after frontend deploy)
   - **Redirect URLs:** add `http://localhost:3000/**`
3. **Authentication** → **Email Auth** settings (even though we're using Google):
   - If you want to lock signups to your Workspace domain only, see "Domain Restriction" below

### Optional: Restrict signups to your domain

Run this in the SQL Editor (replace `ferrocretebuilders.com` with your actual domain):

```sql
CREATE OR REPLACE FUNCTION public.restrict_email_domain()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.email NOT LIKE '%@ferrocretebuilders.com' THEN
        RAISE EXCEPTION 'Signups restricted to @ferrocretebuilders.com addresses';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER restrict_email_domain_trigger
    BEFORE INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.restrict_email_domain();
```

## Step 4: Create storage buckets

In Supabase dashboard → **Storage** → **New bucket**, create three buckets:

| Bucket name | Public? |
|---|---|
| `pay-apps` | Private |
| `release-trackers` | Private |
| `waivers` | Private |

All should be **Private** (signed URLs only — never public). You don't need any RLS policies on the buckets themselves; the backend uses the service role key.

## Step 5: Create an admin user

1. Go to **Authentication** → **Users** → **Add user** → **Create new user**.
2. Use your email + a temporary password (or send a magic link).
3. Once the user appears in the list, copy their UUID.
4. Run this SQL to promote them to admin (replace the UUID):

```sql
UPDATE app_users
SET role = 'admin'
WHERE id = 'paste-uuid-here';
```

## Step 6: Collect credentials

You need these values for the backend `.env`:

1. **Project Settings** → **API**:
   - `Project URL` → `SUPABASE_URL`
   - `anon` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` ⚠ keep this secret
2. **Project Settings** → **API** → **JWT Settings**:
   - `JWT Secret` → `SUPABASE_JWT_SECRET`

## Step 7: Deploy backend to Render

1. Sign up at <https://render.com> with GitHub or email.
2. Push the backend code to a GitHub repo (private), or use Render's manual deploy.
3. **New +** → **Web Service** → connect your repo or upload code.
4. Configure:
   - **Name:** `ferrocrete-api`
   - **Region:** same as your Supabase region (or close)
   - **Branch:** `main`
   - **Root Directory:** `backend`
   - **Runtime:** **Docker**  (uses `backend/Dockerfile`)
   - **Plan:** Free tier or Starter ($7/mo recommended for always-on)
5. **Environment variables:** add all the values from Step 6, plus:
   - `APP_ENV=production`
   - `CORS_ORIGINS=https://your-app.vercel.app` (we'll update this after frontend deploy)
6. Click **Create Web Service**. Wait ~3-5 minutes for the build + first deploy.
7. Visit `https://ferrocrete-api.onrender.com/health` — should return `{"status":"ok"}`.
8. Visit `https://ferrocrete-api.onrender.com/docs` — interactive API docs.

## Step 8: Verify with a test API call

Get an access token by logging in via Supabase's UI (Authentication → Users → impersonate, or use the JS client). Then:

```bash
curl https://ferrocrete-api.onrender.com/me \
    -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

Should return your user profile.

## Step 9: Import existing pay app data (optional)

If you have existing pay app .xlsx files, you can import them via the API:

```bash
curl -X POST https://ferrocrete-api.onrender.com/import/pay-app-excel \
    -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
    -F "file=@path/to/25-05_Seagaze_-_26-04.xlsx" \
    -F "create_pay_app=true"
```

This creates the project + SOV + COs + the pay app row with billings.

You can also do this through the API docs UI at `/docs` after Phase 1B (frontend) is deployed.

---

## What's NOT yet deployed

- **Frontend:** Phase 1B will deliver the Next.js app and a Vercel deployment guide.
- **Email sending:** Phase 1A queues emails to the database `email_outbox` table but doesn't actually send. Phase 2 wires this to Resend or SendGrid.
- **Background workers:** None yet. All operations are synchronous request/response.

## Troubleshooting

**Issue: Migration fails with "permission denied for schema auth"**
Cause: The `on_auth_user_created` trigger needs `SECURITY DEFINER` privileges. Re-run just that trigger block as the postgres superuser via Supabase's SQL Editor (which runs with elevated privileges).

**Issue: "User not found in app_users" on every request**
Cause: The `handle_new_user` trigger didn't fire on signup. Solution: manually insert the row:
```sql
INSERT INTO app_users (id, email) VALUES ('user-uuid', 'user@email.com');
```

**Issue: Render build times out**
Render's free tier can be slow. The Docker build needs to compile reportlab/openpyxl. First build takes 4-6 minutes; subsequent builds are faster (cached).
