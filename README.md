# Ferrocrete Pay App — Production Build

This is the codebase for the production version of the Ferrocrete pay-app + release-tracker tool, replacing the Excel-only Demo 1 and the localStorage-only Demo 2.

## What's in this zip — Phase 1A

```
ferrocrete_app/
├── backend/              FastAPI Python backend (53 routes, fully working)
│   ├── app/
│   │   ├── core/         config, supabase, auth, audit, math, file gen
│   │   ├── api/          one route module per resource
│   │   ├── schemas/      Pydantic request/response shapes
│   │   └── main.py       FastAPI app composition
│   ├── engines/          Demo 1 engines (release_engine.py + Excel templates)
│   ├── requirements.txt
│   ├── Dockerfile        for Render deployment
│   ├── .env.example
│   └── README.md
├── migrations/
│   └── 001_initial_schema.sql    full Postgres schema (12 tables, RLS, triggers)
└── docs/
    └── DEPLOYMENT_PHASE_1A.md    step-by-step deployment guide
```

## What's NOT in Phase 1A (coming in 1B + 2)

- **Frontend (Phase 1B):** Next.js port of Demo 2's screens, talking to this backend.
- **Email sending (Phase 2):** Right now emails queue to `email_outbox` but don't send. Phase 2 wires SMTP/Resend.
- **Sample data:** No seed script yet — first projects come from importing your existing pay app .xlsx files via the import API.

## Phase plan

- **Phase 1A** (this zip): Backend + DB schema + deployment guide.
- **Phase 1B** (next): Frontend Next.js app, ported from Demo 2.
- **Phase 1C**: End-to-end testing + first user onboarding.
- **Phase 2**: Email-from-app, audit log viewer, polish.

## Getting started

1. Read `docs/DEPLOYMENT_PHASE_1A.md` for the full deployment walk-through.
2. Create cloud accounts: Supabase (database + auth + storage), Render (backend hosting). Both have free tiers.
3. Apply the schema migration to Supabase, configure auth, set env vars on Render.
4. Test the backend by hitting `/health` and `/me`.

## Architecture decisions

- **Frontend never writes directly to Postgres.** All writes go through this backend, which validates input, applies business rules, and writes audit log entries. The frontend uses Supabase only for auth + reading data via RLS-protected SELECTs.
- **Money is `NUMERIC(14,2)`, not float.** Floats lose pennies.
- **Sub-tier subs are modeled with self-referential `parent_sub_id`.** Matches the release tracker structure (Atlas as a top-level sub AND as a sub-tier under Steeltech).
- **Excel + PDF are generated on-demand** from the database state. Files live in Supabase Storage with signed-URL access. Database is the source of truth; Excel is for archival + sharing with GCs.
- **Email outbox pattern.** Emails go to a database table, sent later by a worker (TBD). Makes sends reliable, auditable, and reviewable before sending.

## Roles

- `admin`: full access including deleting projects/users
- `accountant`: write everything except admin
- `pe`: write SOVs/COs/pay-apps/releases, no deletion of finalized records
- `viewer`: read-only

## What to do next

After deploying Phase 1A and confirming the backend works:

1. Tell me "Phase 1A is deployed" and I'll start Phase 1B (the frontend).
2. Or, if anything in the schema or API needs to change, flag it now — the schema is easier to migrate before there's real data.
