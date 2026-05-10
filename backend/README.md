# Ferrocrete Backend

FastAPI + Supabase. Wraps the existing pay-app and release-tracker engines
as REST endpoints.

## Local Development

```bash
cd backend
python -m venv venv
source venv/bin/activate    # or venv\Scripts\activate on Windows
pip install -r requirements.txt

cp .env.example .env
# Fill in Supabase credentials in .env

uvicorn app.main:app --reload --port 8000
```

Then open http://localhost:8000/docs for the interactive API docs.

## Project Layout

```
backend/
├── app/
│   ├── core/          # config, supabase clients, auth, audit, math, file gen
│   ├── api/           # route modules (one file per resource)
│   ├── schemas/       # Pydantic request/response shapes
│   └── main.py        # FastAPI app composition
├── engines/           # Original Python engines from Demo 1 (read-only)
│   ├── release_engine.py
│   └── templates/
│       ├── PayApp_Template.xlsx
│       └── ReleaseTracker_Template.xlsx
├── migrations/        # SQL migrations (apply to Supabase)
├── requirements.txt
├── Dockerfile         # for Render deployment
└── .env.example
```

## Auth Model

- Frontend uses Supabase Auth (Google OAuth).
- Frontend sends `Authorization: Bearer <access_token>` on every request.
- Backend validates the JWT against Supabase's JWT secret.
- Backend looks up `app_users` row to get the user's role.
- All writes go through this backend (frontend uses Supabase client only for
  auth + reads via RLS-protected SELECTs).

## Roles

- `admin`: full access
- `accountant`: read all, write everything except user management
- `pe`: read all, write SOVs/COs/pay-apps/releases (no admin)
- `viewer`: read-only

## API Conventions

- All money fields use string-encoded Decimals (frontend sends `"123.45"`,
  backend stores NUMERIC(14,2)).
- Dates are ISO 8601 (`"2026-04-30"`).
- Datetimes are RFC 3339 with timezone (`"2026-04-30T15:30:00Z"`).
- Periods are `"YY-MM"` strings (e.g., `"26-05"`).

## Deployment to Render

See `docs/DEPLOYMENT.md` for the full step-by-step.
