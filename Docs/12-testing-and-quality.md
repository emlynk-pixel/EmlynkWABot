# Testing and Quality

How this project's test suites are organized and run. Three earlier point-in-time audit reports (a bug list, an optimization review, and a full code audit) are preserved in `Docs/archive/` (`08-code-quality-and-bug-report.md`, `09-code-optimization-review.md`, `17-full-code-audit-report.md`, `phase-7-issues-and-fixes.md`) — they're dated snapshots of findings at a point in time, not a standing process, so they aren't a substitute for this document and aren't merged into it.

## Backend Tests

Node's built-in test runner (`node:test`, `node:assert/strict`) — no separate test framework dependency.

```bash
npm test                          # runs every test, OCR-real-image tests skipped by default
RUN_OCR_TESTS=1 npm test          # also runs tests against real Tesseract OCR (slower, downloads/uses real language data)
```

On Windows PowerShell: `$env:RUN_OCR_TESTS="1"; npm test`.

The OCR-service package (`ocr-worker/`) has its own dependencies and its own test suite:

```bash
npm run ocr:install    # once — also required before the backend's own OCR-gated tests can run
npm run ocr:test
RUN_OCR_TESTS=1 npm run ocr:test
```

Backend tests that exercise real text extraction start the OCR service in-process on a loopback port (`test/helpers/localOcrService.js`); tests that inject a fake `extractText` never touch it.

### Test Doubles

Nearly every test runs against fakes, never live infrastructure:

| Helper | Stands in for |
|---|---|
| `test/helpers/fakePrisma.js` | An in-memory Prisma client |
| `test/helpers/fakeAdminDb.js`, `fakeReviewDb.js` | Purpose-built fakes for admin/review-specific query shapes |
| `test/helpers/fakeStorage.js` | The Supabase Storage bucket client |
| `test/helpers/fixtures.js` | Shared test fixture builders |

`test/fixtures/files/` holds synthetic generated PDFs and images (including passport fixtures with correct MRZ check digits); `test/fixtures/documents/*.txt` holds sample OCR text. **No real client data is ever used in a test.**

### Testing Against a Real Database

Some tests need a real PostgreSQL to verify things a fake genuinely can't — concurrency behavior, actual SQL semantics, migration application. These follow one consistent pattern: a **throwaway** container, never the project's real development database (`emlynk-postgres`) and never production.

```bash
docker run -d --name <throwaway-name> -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=<throwaway-db> postgres:16
# create the anon/authenticated/service_role roles Supabase provides, then:
npx prisma migrate deploy   # against the throwaway container's DATABASE_URL
```

`test/postgresRateLimitStore.test.js` is the current example: its real-database tests run only when `RATE_LIMIT_TEST_DATABASE_URL` is set, exactly parallel to the `RUN_OCR_TESTS` pattern above, and skip entirely otherwise.

Nothing in the standing test suite or in local development is ever run against production Supabase or the throwaway container's real-money equivalents. Any check that must run against actual production infrastructure (a deployment verification, a migration confirmation) is a one-off, manual, logged action — not part of `npm test` — and always ends by removing anything it created there.

## Admin Frontend Tests

```bash
npm run admin:test         # Vitest + JSDOM + @testing-library/react
npm run admin:typecheck    # tsc --noEmit
npm run admin:build        # typecheck + production Vite build
```

## What's Covered

Test files exist per service/module throughout `test/` (currently 60+ files) and `admin/src/**/*.test.tsx`, covering: OCR/classification/confidence (`05-ocr-document-processing.md`), identity/reconciliation, storage placement and checksum handling (`06-storage-management.md`), authentication/RBAC/rate limiting (`10-security.md`), the WhatsApp webhook (`04-whatsapp-integration.md`), the submission queue's lease/claim/retry logic, admin review actions and audit logging, the worker's Cloud Run lifecycle, and Vercel routing configuration (`08-cloud-deployment.md`). Security-sensitive behavior — no PII in logs, safe error messages, timing-attack resistance — has its own explicit test coverage rather than being incidental.

## Manual/Operational Checks

Some things are checked manually rather than by an automated test, because they require real infrastructure a test shouldn't depend on:

- End-to-end WhatsApp delivery through a real Meta webhook (`ngrok`, see `11-development-guide.md`).
- A production deployment's health, logs and a real (then cleaned-up) test submission — done as part of each deployment step; see `08-cloud-deployment.md` for the verification performed at each stage.

## Before Considering Something Done

Per `CODING_STANDARDS.md`'s definition of done: new code has accompanying tests, `npm test` (and `npm run admin:test`/`admin:build` if frontend code changed) passes, documentation is updated, and a security review has been considered — not just "it works on my machine."
