# 09. Testing and Verification

Two parts: automated checks you run on your machine, and a manual smoke test after each deployment. Background on how the suites are organised: [`Docs/12-testing-and-quality.md`](../Docs/12-testing-and-quality.md).

> **Rules.** Automated suites use in-memory fakes and an in-process PGlite database, so they never touch a real environment. The commands marked **REAL** below do touch real infrastructure. Run them only against a development or stage environment, never production. Never use real candidate data (passports, NICs, medical or police records) in any test. Use synthetic data.

## Part 1: automated checks

Run these from the repository root before every merge or deployment. All must pass.

```bash
npm install && npm run admin:install && npm run ocr:install && npm --prefix candidate-form ci   # once

# Backend
npx prisma validate
npm test

# Admin console
npm --prefix admin run typecheck          # tsc --noEmit
npm run admin:test                        # vitest
npm run admin:build                       # typecheck + production build into admin/dist

# Candidate Form
npm --prefix candidate-form run typecheck
npm --prefix candidate-form test
npm --prefix candidate-form run build

# OCR service
npm run ocr:test
```

| Command | What it covers | Needs |
|---|---|---|
| `npx prisma validate` | `schema.prisma` syntax and relations | `DATABASE_URL` defined (a placeholder `postgresql://` value is enough; it validates the schema file and does not connect) |
| `npm test` | All backend tests (`node --test "test/**/*.test.js"`): API, RBAC, services, queue, storage, WhatsApp, Sheet Sync, tests that run against an in-process PGlite database | OCR dependencies installed (`npm run ocr:install`): tests that use real text extraction start the OCR service in-process on a loopback port. No network, no real DB |
| `npm --prefix admin run typecheck` | TypeScript types of the Admin app | |
| `npm run admin:test` | Admin component/unit tests (Vitest + jsdom) | |
| `npm run admin:build` | Typecheck + Vite build. Same step Vercel runs | `VITE_*` not required to compile |
| `npm --prefix candidate-form run typecheck / test / build` | The Candidate Form | `build` needs a valid `VITE_API_BASE_URL` for the CSP (unset is accepted for local builds; an invalid value fails) |
| `npm run ocr:test` | OCR service unit tests | `ocr-worker` dependencies |

### Opt-in and real-infrastructure checks

| Command | Type | Notes |
|---|---|---|
| `RUN_OCR_TESTS=1 npm run ocr:test` | opt-in, slow (minutes) | Runs real Tesseract on fixtures. PowerShell: `$env:RUN_OCR_TESTS="1"; npm run ocr:test` |
| `RUN_OCR_TESTS=1 npm test` | opt-in, slow | Backend pipeline on real OCR over HTTP |
| `npx prisma migrate status` | **REAL** (read-only) | Compares migrations with the database in `DATABASE_URL`. Safe, but read the target first |
| `npm run db:check` | **REAL** (read-only) | `SELECT 1` only |
| `node scripts/e2e-supabase-storage.mjs` | **REAL, writes** | Creates and cleans up test objects in the bucket from `.env`. **Dev project only** |
| `npm run sheet:check` | **REAL** (read-only) | Reads row 1 of the Sheet in `.env`. Never writes |
| `npm run sheet:demo` | local demo | `scripts/sheetSyncLocalDemo.mjs`; no Google call |
| `npm run user:migrate-manager` | **REAL** | Without `--apply` it only lists accounts still holding the retired `MANAGER` role (read-only); `--apply --owner <admin_id>` **converts** them and is a deliberate release step, per environment |
| `npm run diagnose:document -- path/to/file.jpg` | local, or **REAL** with `--storage-path` | Sanitized OCR diagnostics for one file; with `--storage-path` it downloads that object from the bucket in `.env`. Use a local synthetic file |

There is no load-test tooling in the current repository. The checked-in `.env.loadtest` naming and a `hotfix/loadtest-production-fixes` branch indicate load testing was done earlier, but no script is documented. Treat load testing as not part of the base deployment.

### What a failing suite usually means

| Failure | Likely cause |
|---|---|
| Backend OCR-gated tests fail to start | `npm run ocr:install` was not run |
| `Invalid environment configuration` in a test | A test is reading your real `.env`; unset conflicting variables or run from a clean shell |
| Prisma engine `EPERM` on Windows | A Node process locks the engine file; stop it, rerun `npx prisma generate` |
| Admin build type error | Run `npm --prefix admin run typecheck` for the exact file |

## Part 2: post-deployment smoke tests

Run on **stage** before promoting, and a reduced version on production after release. Use test candidates with fake identifiers only. Tick each box; record failures with the URL and role.

### A. Platform health

- [ ] `GET https://<DOMAIN>/health` returns 200 with `status: OK`
- [ ] `https://<DOMAIN>/admin` loads the sign-in page (not a 404)
- [ ] Unauthenticated `GET /api/admin/candidates` returns 401
- [ ] Cloud Run: submission worker, OCR worker, Sheet Sync worker revisions are Ready; their `/health` returns 403 without a token
- [ ] Submission worker log shows "Submission worker running"
- [ ] Sheet Sync worker log shows `writeGate: DISABLED` (until activation is approved)

### B. Sign-in and roles

One account per role. Create them by invitation from the Admin console (OWNER/ADMIN), not by SQL. Role rules: [`Docs/ROLES_AND_PERMISSIONS.md`](../Docs/ROLES_AND_PERMISSIONS.md).

| Role | Sign in | Should see | Should be refused (URL typed directly gives 403 or redirect) |
|---|---|---|---|
| OWNER | [ ] | Everything ADMIN sees, plus managing ADMIN accounts | n/a |
| ADMIN | [ ] | Overview, Candidates, Review queue, Police, Documents, Jobs, Agents, Clients, Work Allocation, Settings (incl. Google Sheet Sync), Audit Logs, user management below ADMIN | Managing the OWNER or other ADMINs |
| TEAM_LEAD | [ ] | Candidates (all), Need Attention, Work Allocation, Jobs, Agents, Clients, Daily Report (standard) | `/admin/audit-logs`, `/admin/review`, `/admin/police`, `/admin/settings`, user management |
| ANALYST | [ ] | Only **their allocated** candidates and Need Attention | Other analysts' candidates, `/admin/jobs`, `/admin/review`, `/admin/audit-logs`, `/admin/settings` |
| REGISTRATION_DESK | [ ] | Add Candidate (registration), view Need Attention | Editing Need Attention items, `/admin/review`, `/admin/jobs`, `/admin/settings` |
| JOB_HANDLER | [ ] | Jobs, Agents, Clients; view-only candidates | Changing a candidate record, `/admin/review`, `/admin/settings` |

Also check: an `INACTIVE` or `INVITED` account cannot use the console; the invitation e-mail link opens `/admin/setup-password` on **this** environment's domain.

### C. Core functions (as the appropriate role)

- [ ] **Candidate registration** (Add Candidate): register a test candidate with a fake passport ID
- [ ] **Candidate lookup**: search by passport ID/name; pagination works
- [ ] **File upload**: upload a synthetic PDF/JPEG to the candidate (direct-to-storage via signed URL, then finalize); wrong type and over-size files are rejected with a clear message
- [ ] **Document preview**: open the uploaded document in the preview; it streams through the API (no public storage URL anywhere in the network tab)
- [ ] **WhatsApp intake + OCR integration**: send a synthetic image from a Meta test number; the submission appears, the worker processes it (log: `Submission processed in background`), and the result lands in the candidate folder or the review queue
- [ ] **Review queue** (ADMIN): approve / keep pending / remove an item
- [ ] **Work Allocation**: allocate test candidates among Analysts; each Analyst then sees only theirs
- [ ] **Jobs**: create a job; add a candidate; Agents and Clients pages open
- [ ] **Need Attention**: items appear and are actionable only for roles allowed to act
- [ ] **Audit Logs** (ADMIN): the actions above are recorded, with no tokens or passwords visible

### D. Candidate Form

- [ ] **Share Form** on a test candidate produces a link of the form `https://<form-domain>/#k=<secret>` on the **form's** domain (not localhost, not the Admin domain)
- [ ] Opening the form root without `#k=` shows "Open your link" (expected)
- [ ] Correct Passport + NIC unlocks and pre-fills; wrong values give a generic error
- [ ] Submit once; reopening shows already-submitted; a revoked link is refused
- [ ] Checked on a ~375 px wide screen: no horizontal scroll

### E. Google Sheet Sync (stage Sheet only)

- [ ] Settings → Google Sheet Sync → **Test Connection** = `SUCCEEDED`
- [ ] **Sync Now** completes as a dry run (gate disabled); counts look right
- [ ] Cloud Scheduler job exists; `gcloud scheduler jobs run …` creates a run that completes
- [ ] No writes occurred to the Sheet (check its version history) while `SHEET_SYNC_ENABLED=false`

### F. Security spot checks

- [ ] No `SUPABASE_SERVICE_ROLE_KEY` or other secret in the Admin or Candidate Form JavaScript bundles (search the built `dist` for `service_role` and for your project's secret prefix)
- [ ] The storage bucket is private: an anonymous request to an object URL fails
- [ ] OCR, submission and Sheet Sync services reject unauthenticated calls (403)
- [ ] Rate limiting engages (repeated bad requests eventually return 429); two clients on different networks do not share one allowance (`TRUST_PROXY_HOPS`)
- [ ] Browser console shows no CSP violations on `/admin` or the form

### G. Rollback readiness

- [ ] You know the previous good Vercel deployment and Cloud Run revision names
- [ ] A database backup/snapshot exists for production before migrating
