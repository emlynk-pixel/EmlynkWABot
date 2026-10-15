# Candidate Extra Details form (`candidate-form/`)

Public web form where an **existing** candidate verifies with Passport Number + WhatsApp Number and (from Task 2) updates their own Candidate Additional Details. It is not candidate registration.

**Task 1 scope:** app shell, configuration, API client and the verification page only.

## Architecture

- Its own Vercel project (**Project B**), built from this folder: set the Vercel **Root Directory to `candidate-form/`**. Never build it from the repository root: the root `vercel.json` deploys the backend.
- It talks only to the backend's public API, `/api/public/candidate-details/*`, on Vercel Project A. It has no database, Supabase, Google Sheets or Meta access, and no secrets.
- The candidate token is kept in memory only and sent in the `Authorization` header; it is never put in a URL, cookie or `localStorage`.

## Configuration

One public, build-time value (see `.env.example`):

| Variable | Meaning |
|---|---|
| `VITE_API_BASE_URL` | The backend's public origin (Project A), e.g. `https://<project-a-domain>`. Empty = same origin |

`vite.config.ts` sets `envPrefix` to `VITE_API_`, so no other variable can reach the bundle. Do not add any other variable to Project B; backend secrets stay in the backend project. The backend must list this site's exact origin in its CORS setting (`CANDIDATE_FORM_ORIGIN`).

## Commands

```bash
npm install        # once
npm run dev        # http://localhost:5174 (backend on http://localhost:3000)
npm run typecheck
npm run build      # dist/, no source maps, CSP meta pinned to VITE_API_BASE_URL
```

Security headers for the deployed site are in `vercel.json` (CSP, frame denial, no referrer, HSTS, `noindex`).
