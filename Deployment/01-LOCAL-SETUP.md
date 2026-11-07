# 01. Local Setup

Goal: a working local copy that runs the backend, the Admin console, the OCR service and the test suites, from a clean machine.

## 1. Install the tools

| Tool | Check | Notes |
|---|---|---|
| Git | `git --version` | Needs access to the GitHub repository (ask the owner to add your GitHub account) |
| Node.js `^22.18.0 \|\| >=23.6.0` | `node --version` | Older versions are rejected at startup by `src/config/runtime.js`. Use `nvm`/`fnm`/the installer to get 22.18+ |
| npm | `npm --version` | Comes with Node |
| Docker Desktop | `docker --version` | Only for local PostgreSQL (`docker compose`) and for testing container images. Not needed to run the tests (they use an in-process PGlite database) |
| Google Cloud CLI | `gcloud --version` | Install from Google's official instructions. Needed only for cloud deployment ([05](05-GOOGLE-CLOUD-SETUP.md)) |
| Accounts | | Supabase, Vercel and Google Cloud access: ask the project owner to invite you (see [README](README.md#required-external-accounts)) |

## 2. Clone and install

The repository has **four separate `package.json` files**. Each has its own dependencies; the root has helper scripts for two of them.

```bash
git clone https://github.com/emlynk-pixel/EmlynkWABot.git
cd EmlynkWABot

# Root: backend (Express API, workers, Prisma). postinstall runs `prisma generate`
npm install

# Admin console (React + Vite)
npm run admin:install        # = npm --prefix admin install

# OCR service (needed to run it AND for the backend's own tests)
npm run ocr:install          # = npm --prefix ocr-worker ci

# Candidate Form (React + Vite): no root helper script exists
npm --prefix candidate-form ci
```

| Package | Folder | Install | Notes |
|---|---|---|---|
| Backend + workers | repo root | `npm install` | Generates the Prisma client into `generated/prisma` (git-ignored). If it is missing, run `npx prisma generate` |
| Admin console | `admin/` | `npm run admin:install` | `vercel.json` uses `npm --prefix admin install` too |
| OCR service | `ocr-worker/` | `npm run ocr:install` | Brings the English Tesseract model (`@tesseract.js-data/eng`) |
| Candidate Form | `candidate-form/` | `npm --prefix candidate-form ci` | Separate Vercel project |

If the clone URL differs (fork, SSH), use yours: the `repository.url` in `package.json` is `https://github.com/emlynk-pixel/EmlynkWABot.git`.

## 3. Choose where local data lives

The backend needs **PostgreSQL, Supabase Auth and Supabase Storage**. Local Docker gives you only PostgreSQL.

| Option | DB | Auth + Storage | Use when |
|---|---|---|---|
| **A (recommended)** | a **dedicated development Supabase project** | same project | You want local to behave like production |
| **B** | local Docker Postgres | still a Supabase project (for `SUPABASE_URL`, service-role key, bucket and sign-in) | You want a disposable database. `auth_user_id` has no foreign key on plain Postgres (the migration adds it only where the `auth` schema exists) |

> Never point local `.env` at the **production** or shared **stage** project. Create a separate Supabase project for development ([03](03-SUPABASE-SETUP.md)).

For option B:

```bash
docker compose up -d          # container emlynk-postgres, database emlynk_docs, port 5432
```

`docker-compose.yml` sets throwaway local credentials (user/password/database `emlynk_user` / `emlynk_password` / `emlynk_docs`). They are for this container only. The matching local connection string is `postgresql://emlynk_user:emlynk_password@localhost:5432/emlynk_docs`.

## 4. Configure the environment files

```bash
cp .env.example .env                   # backend (Windows PowerShell: Copy-Item .env.example .env)
cp admin/.env.example admin/.env.local
# candidate-form/.env.local only if you run the Candidate Form locally:
cp candidate-form/.env.example candidate-form/.env.local
```

Fill them using [02-ENVIRONMENT-VARIABLES.md](02-ENVIRONMENT-VARIABLES.md). Minimum for a local backend (the server refuses to start if any is missing):

```
DATABASE_URL=postgresql://...            # your DEV database
SUPABASE_URL=https://<dev-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<dev project service-role key>
SUPABASE_BUCKET=<dev bucket name>
META_APP_SECRET=<any placeholder locally, real value only to test webhooks>
WHATSAPP_VERIFY_TOKEN=<any random string>
WHATSAPP_ACCESS_TOKEN=<placeholder unless testing media download>
WHATSAPP_API_VERSION=v21.0
OCR_SERVICE_URL=http://127.0.0.1:8080
APP_BASE_URL=http://localhost:5173
```

and in `admin/.env.local`:

```
VITE_SUPABASE_URL=https://<dev-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<dev project anon/publishable key>
```

`.env`, `.env.*` and `admin/.env.local` are git-ignored. Check with `git status` that none is staged before every commit.

## 5. Prepare the database

Apply the checked-in migrations to your **dev** database, forward only:

```bash
npx prisma validate
npx prisma migrate status
npx prisma migrate deploy
npm run db:check              # prints only "Database connection successful." or a failure type
```

`Docs/11-development-guide.md` shows `npx prisma migrate dev` for the local Docker database. `migrate dev` is interactive and can reset schemas; **never run it against a Supabase project or any shared database**. `migrate deploy` is safe everywhere because it only applies pending migrations. Details in [03](03-SUPABASE-SETUP.md#schema-and-migrations).

There is no seed step to follow: `package.json` has no `prisma.seed` entry and `prisma/seed.js` is git-ignored.

## 6. Create the first user

```bash
npm run user:create -- --name "Your Name" --email you@example.com --role OWNER
```

Details and precautions in [10](10-ADMIN-AND-OPTIONAL-COMPONENTS.md#first-system-administrator).

## 7. Run it

Three terminals:

```bash
# 1. OCR service on http://127.0.0.1:8080 (loopback only, no credentials needed)
npm run ocr:start

# 2. Backend on http://localhost:3000: API + webhook + the submission worker in one process
npm start

# 3. Admin console dev server on http://localhost:5173 (proxies /auth, /api, /health to :3000)
npm run admin:dev
```

Open `http://localhost:5173/admin`. The Admin dev server uses port 5173 with `strictPort`; if it is taken, the command fails instead of picking another port (the Supabase redirect URLs and `APP_BASE_URL` assume 5173).

Production-like alternative (Express serves the built admin SPA):

```bash
npm run admin:build            # builds admin/dist
npm start                      # http://localhost:3000/admin
```

Other local processes:

| Command | What it runs |
|---|---|
| `npm run worker` | The submission worker only (what Cloud Run runs). `npm start` already includes a worker; do not need both |
| `npm run sheet:check` | One-off **read-only** Google Sheet connection check |
| `npm run sheet:worker` | The Sheet Sync worker (only with Google ADC set up; see [08](08-GOOGLE-SHEET-SYNC-DEPLOYMENT.md)) |
| `npm run db:check` | Database connectivity check |
| `npm --prefix candidate-form run dev` | Candidate Form dev server on `http://localhost:5174` (needs `CANDIDATE_FORM_ORIGIN=http://localhost:5174` on the backend and `VITE_API_BASE_URL=http://localhost:3000`) |

## 8. Verify the local setup

```bash
curl -s http://localhost:3000/health          # {"status":"OK","message":"Emlynk backend is running..!"}
curl -s http://127.0.0.1:8080/health          # {"status":"OK"}
npm test                                       # see 09 for what it covers
```

Then continue with [09-TESTING-AND-VERIFICATION.md](09-TESTING-AND-VERIFICATION.md).

## Common local problems

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment configuration:` + variable names | A required variable is missing or malformed | Compare `.env` with the table in [02](02-ENVIRONMENT-VARIABLES.md) |
| `ERR_MODULE_NOT_FOUND` / syntax error from `generated/prisma` | Prisma client not generated, or Node too old | `node --version`, then `npx prisma generate` |
| Sign-in page says sign-in is not configured | `admin/.env.local` missing or empty | Fill `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, restart `admin:dev` |
| `EPERM` renaming `query_engine-windows.dll.node` (Windows) | A running Node process locks the Prisma engine | Stop Node processes, rerun `npx prisma generate` |
| Backend tests fail on OCR | OCR dependencies not installed | `npm run ocr:install` |

More in [11-TROUBLESHOOTING.md](11-TROUBLESHOOTING.md).
