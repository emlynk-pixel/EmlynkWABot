# Candidate Extra Details form (`candidate-form/`)

Public web form where an **existing** candidate verifies with Passport Number + WhatsApp Number and (from Task 2) updates their own Candidate Additional Details. It is not candidate registration.

**Status**
- **Task 1 (done):** app shell, configuration, API client, verification.
- **Task 2 (done):** the candidate-facing UI: the verification and Additional Details screens, English / Sinhala, validation messages, mobile layout and tests.
- **Task 3 (next):** the secure read and save of the details. **Until then the form cannot load or save anything:** it starts empty, says that saving is not available yet, and *Save details* only checks the entries (it sends nothing and never claims to have saved).

## UI flow

1. **Verify:** Passport Number + WhatsApp Number, then **Verify** (`POST /api/public/candidate-details/verify`). Failures show one fixed message per case (details don't match, too many attempts, service unavailable, no connection, invalid input, anything else), never the server's own text.
2. **Additional details:** the 19 fields in six sections: personal details, clothing and shoe sizes, father, mother, marital status and family, other job skills. Nothing else about the candidate is shown (no NIC, nationality, passport dates, stages, allocation, jobs, documents or IDs).
3. **Finish** (or leaving or reloading the page) ends the session. When the session expires, the candidate is taken back to verification with a short message.

Conditional fields follow the server's rules (`src/services/candidateAdditionalDetailsService.js`), checked again in `src/details/model.ts`:
- The parents' name and date of birth are always available; the name is required only when that parent is alive.
- The wife's name and date of birth show only for **Married** (the name is then required).
- Child names are hidden for **Single**, optional otherwise, and entered in order (no second without a first).
- Dates: real dates from 1900 to today (Sri Lanka). Sizes: a listed size or **Other** with a short size of the candidate's own.
- Hidden entries stay in the form (switching back shows them) but are never part of what would be sent.

## Language support (English / සිංහල)

- The switch is in the header on every screen. English is the default; the choice is kept in memory only (a reload starts in English) and sets `<html lang>`.
- Every text the candidate reads is in `src/i18n/translations.ts`. The Sinhala dictionary is typed against the English keys, so a missing translation fails the typecheck; a test also checks that every Sinhala text is actually in Sinhala.
- `LanguageProvider` / `useLanguage()` give `t(key, params)`. Pages keep **values** and **message keys**, never translated strings, so switching language keeps everything typed, keeps validation results, and shows them in the new language. Field values and anything sent to the server are the same in both languages.
- No i18n library: one typed dictionary is enough for two languages.

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
npm test           # component tests (Vitest + Testing Library, jsdom; no network)
npm run typecheck
npm run build      # dist/, no source maps, CSP meta pinned to VITE_API_BASE_URL
```

Security headers for the deployed site are in `vercel.json` (CSP, frame denial, no referrer, HSTS, `noindex`).
