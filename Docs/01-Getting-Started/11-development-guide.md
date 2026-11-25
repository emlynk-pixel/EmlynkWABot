# Development Guide

Local setup, the git workflow this project follows, and where to find the coding standards. Historical setup commands are preserved in `Docs/archive/01-initial-backend-database-setup.md`.

Coding standards (naming, function design, error handling, security, testing, git conventions) are a separate, short, scannable reference: `CODING_STANDARDS.md`, in this same `Docs/` folder. Read it before writing new code; it isn't repeated here.

## Prerequisites

- Node.js `^22.18.0 || >=23.6.0` (the generated Prisma client needs Node's built-in TypeScript type stripping)
- npm
- Docker and Docker Compose (for local PostgreSQL)
- A Meta WhatsApp developer account, only if testing live webhook delivery

## Local Setup

```bash
# 1. Install backend and admin dependencies
npm install
npm run admin:install

# 2. Start local PostgreSQL (Docker Compose: container emlynk-postgres, db emlynk_docs)
docker compose up -d

# 3. Configure environment
cp .env.example .env
# fill in DATABASE_URL, SUPABASE_*, META_APP_SECRET, WHATSAPP_*, OCR_SERVICE_URL, APP_BASE_URL
# APP_BASE_URL is required: http://localhost:5173 locally (the admin dev server)

# 4. Configure the admin frontend (browser-safe values only)
cp admin/.env.example admin/.env.local
# set VITE_SUPABASE_URL=<project URL> and VITE_SUPABASE_ANON_KEY=<browser-safe anon key>
# (Supabase dashboard > Project Settings > API). admin/.env.local is never committed.

# 5. Apply migrations and generate the Prisma client
npx prisma migrate dev

# 6. (optional) seed sample data
npx prisma db seed

# 7. Create the first user (ADMIN): a Supabase Auth identity plus the application record
npm run user:create -- --email admin@example.com --name "..." --role ADMIN
```

Sign-in, invitations and password recovery are Supabase Auth's (`SUPABASE_AUTH.md`); the application has no `JWT_SECRET` or SMTP settings. Outgoing auth email is configured in the Supabase dashboard, and the local URLs (`http://localhost:5173/admin/setup-password` and `/admin/reset-password`) must be in its allowed redirect URLs. Without `admin/.env.local`, sign-in fails with "Sign-in is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)".

## Running It

```bash
npm start                 # Express backend + submission worker, one process (http://localhost:3000)
npm run admin:dev         # Admin frontend dev server (Vite, http://localhost:5173, proxies /auth and /api)
```

Or the production-like path, serving the built admin SPA from Express itself:

```bash
npm run admin:build       # builds admin/dist
npm start                 # serves it under http://localhost:3000/admin
```

Running only the submission worker, separately from the API (matching the Cloud Run split — see `08-cloud-deployment.md`):

```bash
npm run worker
```

## OCR Service (Local)

The OCR service is a separate package (`ocr-worker/`) with its own dependencies — install them once with `npm run ocr:install` (also required for the backend's own tests, which start it in-process). Run it locally with `npm run ocr:start` (`http://127.0.0.1:8080`), and point the backend at it in `.env`:

```
OCR_SERVICE_URL=http://127.0.0.1:8080
```

A loopback URL is the only case the backend accepts plain `http://` for `OCR_SERVICE_URL` — see `05-ocr-document-processing.md` and `ocr-worker/README.md`.

## Testing Real Webhooks Locally

```bash
ngrok http 3000
```

In the Meta App Dashboard (WhatsApp → Configuration): set the callback URL to `https://<ngrok-subdomain>.ngrok-free.app/whatsapp/webhook`, set the verify token to match `WHATSAPP_VERIFY_TOKEN`, verify and save, then subscribe to the `messages` field.

## Git Workflow

A checkpoint-based workflow: complete one process, test/verify it, update documentation, commit, then move to the next. Changes are not accumulated until the end of a large phase.

Commit message prefixes (Conventional Commits):

| Prefix | Purpose |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `chore:` | Setup, tooling, configuration, maintenance |
| `docs:` | Documentation |
| `test:` | Tests |
| `refactor:` | Restructuring without changing behavior |

**Definition of done** (from `CODING_STANDARDS.md`): code written, tests passing, documentation updated, security review verified.

## See Also

- `03-database-design.md` — schema and migration history
- `12-testing-and-quality.md` — running the test suites
- `08-cloud-deployment.md` — how this same code runs in production
