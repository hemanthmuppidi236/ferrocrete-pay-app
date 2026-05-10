# Ferrocrete Frontend

Next.js 14 + TypeScript + Tailwind. Talks to the FastAPI backend on Render.

## Local Development

```bash
cd frontend
npm install
cp .env.example .env.local
# Edit .env.local with your Supabase values + Render API URL
npm run dev
```

Open <http://localhost:3000>.

## Project Structure

```
frontend/
├── src/
│   ├── app/
│   │   ├── (app)/          Protected app routes (require login)
│   │   │   ├── layout.tsx       Top bar + nav
│   │   │   └── projects/
│   │   │       ├── page.tsx           Project list
│   │   │       ├── new/page.tsx       New project (stub)
│   │   │       ├── import/page.tsx    Excel import flow
│   │   │       └── [id]/page.tsx      Project detail
│   │   ├── auth/
│   │   │   ├── callback/route.ts      OAuth callback handler
│   │   │   └── error/page.tsx         Auth error page
│   │   ├── login/page.tsx             Google sign-in
│   │   ├── globals.css                Design tokens (CHAD)
│   │   ├── layout.tsx                 Root layout
│   │   └── page.tsx                   Redirects to /projects
│   ├── components/                    Shared client components
│   ├── lib/
│   │   ├── api.ts                     Backend API client
│   │   ├── types.ts                   TS types matching backend
│   │   └── supabase/                  Supabase clients (server + browser)
│   └── middleware.ts                  Auth gate
└── ...config files
```

## Routes

| Path | Public? | Notes |
|---|---|---|
| `/login` | yes | Google sign-in only |
| `/auth/callback` | yes | OAuth handler |
| `/auth/error` | yes | Friendly auth error page |
| `/projects` | no | Project list |
| `/projects/new` | no | Stub for now |
| `/projects/import` | no | Excel upload flow |
| `/projects/[id]` | no | Project detail |

All non-public routes redirect to `/login` if no session.

## Auth Flow

1. User hits a protected route → middleware redirects to `/login?next=...`
2. User clicks "Continue with Google" → Supabase OAuth flow
3. Google returns user to `/auth/callback?code=...`
4. Callback exchanges code for session, redirects to original `next` path
5. On every API call, the api client attaches `Authorization: Bearer <access_token>`

## API Client

```typescript
import { api, ApiError } from "@/lib/api";

const projects = await api.get<Project[]>("/projects");

try {
  await api.post("/projects", { name, project_no });
} catch (e) {
  if (e instanceof ApiError) {
    console.error(e.status, e.detail);
  }
}

// File upload
const fd = new FormData();
fd.append("file", file);
await api.post("/import/pay-app-excel", undefined, { formData: fd });
```

## What's Done (Phase 1B-α)

- Next.js + TypeScript + Tailwind scaffold
- CHAD design system ported from Demo 2 v5 (light + dark, Garamond + Plex Mono + Playfair)
- Supabase Auth (Google OAuth)
- Protected routes via middleware
- Project list page (live data from Render backend)
- Project detail page (basic — name, contract, SOV table)
- Excel import flow
- Sign-out + theme toggle

## What's Next (Phase 1B-β)

- Pay App Draft screen (with the live G702 sidebar from Demo 2)
- SOV Editor
- Change Order management
- Release Tracker UI
- Waiver upload UI
- Settings panels
