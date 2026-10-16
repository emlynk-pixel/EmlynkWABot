# Candidate Extra Details form (`candidate-form/`)

Public web form where an **existing** candidate verifies with Passport Number + WhatsApp Number and then fills in the Candidate Form. It is not candidate registration.

**Status**
- **Task 1 (done):** app shell, configuration, API client, verification.
- **Task 2 (done, then redesigned):** the candidate-facing UI. The first 19-field Additional Details screen was replaced by the guided Candidate Form below, in English / Sinhala, Light / Dark.
- **Task 3 (next):** the secure read and save. **Until then the form cannot load or save anything.** It starts empty, and **Save Details** checks the answers, then says *"Saving will be enabled when the secure database integration is connected."* It sends no request and never claims to have saved.

## UI flow

1. **Verify:** Passport Number + WhatsApp Number, then **Verify** (`POST /api/public/candidate-details/verify`). Failures show one fixed message per case (details don't match, too many attempts, service unavailable, no connection, invalid input, anything else), never the server's own text.
2. **Candidate Form**, one section at a time, with **Next** / **Previous**, a progress bar (*Step 2 of 7*, *12 of 18 required answers completed*) and a section list (numbers on phones, names beside the form from 1024 px). **Next** checks the section first; sections already reached can be reopened from the list.
3. **Review:** every answer by section, with **Edit** to go back, then **Save Details** (see Status).
4. **Finish** (or leaving or reloading the page) ends the session. When the session expires, the candidate is taken back to verification with a short message.

## Form sections

| # | Section | Fields (* required) |
|---|---|---|
| 1 | Basic & Identification Information | Full Name\*, Surname\*, Other Names, ID Number / NIC\*, Sex\* (Male / Female / Other), Civil Status\* (Single / Married / Divorced / Widowed), Birth Date\*, Birth Place |
| 2 | Contact & Location Details | Address\*, City, District\*, DS Division\*, GN Division, **WhatsApp Number (verified, read-only)**, Alternative Contact Number, Email\* |
| 3 | Passport & Qualifications | **Passport Number (verified, read-only)**, Passport Issue Date\*, Passport Expiry Date\*, Job Category\* (+ Other Job Category\* when OTHER), Experience, Other Skills 1, Other Skills 2, English Knowledge\* |
| 4 | Physical Measurements | Shirt Size, Hip / Waist Size (inches), Shoe Size (UK list, or Other, e.g. EU 43) |
| 5 | Family Background (marked *Important*) | Father and Mother: Name, Surname, Passport Number, Date of Birth. **Spouse** (same four) only when Civil Status is Married. Child 1-3 names (optional) |
| 6 | Guardian Details | Guardian Name\*, Relationship, NIC\*, Date of Birth, Phone Number\*, Address\* |
| 7 | Review | read-only summary |

- The Passport Number and WhatsApp Number are the ones the candidate verified with, kept in memory with the token and shown read-only. They are never part of the answers sent; the server knows the candidate from the token. There is no register number (staff-only) and nothing else staff-only.
- Hidden entries stay in the form (switching back shows them) but are never sent: spouse details unless Married, Other Job Category unless OTHER.
- Checks (`src/form/validation.ts`): required answers; NIC as on the staff form (9 digits + V/X, or 12 digits); email format; phone numbers (`+` optional, 9-15 digits); passport numbers (letters and digits); real dates from 1900, birth and issue dates not in the future, expiry after issue; sizes and lengths. The server will check again in Task 3.

**Choices are English codes.** Every choice is kept as an English code; only its label is translated (Married / විවාහක are both `MARRIED`). The lists live in `src/form/options.ts`:
- **Job Category:** PLASTER, BLOCK MASON, TILER, SHUTTERING CARPENTER, BARBENDER, GYPSUM WORKER, ALUMINIUM WORKER, WELDER TIG, WELDER MIG, WELDER ARC, PLUMBER, ELECTRICIAN, JCB OPERATOR, EXCAVATOR OPERATOR, MOTOR GRADER OPERATOR, BOBCAT OPERATOR, WHEEL LOADER OPERATOR, OTHER. A frontend list for now (no database table). The step reads it through `useJobCategories()`, so it can come from the API later without changing the component. An **Other Job Category** text is never added to the list.
- **English Knowledge:** NO KNOWLEDGE, BASIC, FAIR, GOOD, VERY GOOD, FLUENT, shown as tappable cards.

**Uppercase.** English free text is kept in capitals as it is typed: `shamal sathsara` becomes `SHAMAL SATHSARA` in the value itself, with the cursor left where it was (`src/form/uppercase.ts`). Only the letters a-z change, so Sinhala, digits and punctuation stay exactly as typed. Email, phone numbers, dates and choice lists are never changed. This is for the candidate's benefit only; the server will normalise again.

## Language support (English / සිංහල)

- The switch is in the header on every screen. English is the default; the choice is kept in memory only (a reload starts in English) and sets `<html lang>`.
- Every text the candidate reads is in `src/i18n/translations.ts`, including sections, fields, options, help, validation, review and theme labels. The Sinhala dictionary is typed against the English keys, so a missing translation fails the typecheck; a test also checks that every Sinhala text is actually in Sinhala. Job categories show the Sinhala name with the English trade name.
- `LanguageProvider` / `useLanguage()` give `t(key, params)`. Pages keep **values** and **message keys**, never translated strings, so switching language keeps every answer and validation result and shows them in the new language.
- Sinhala review dates are shown as `1990-05-01`; the browser's Sinhala month names can be the traditional ones (e.g. Vesak for May).

## Light / Dark theme

- A switch beside the language switch (icons only on phones narrower than 480 px). The default is the device's setting; the choice is remembered.
- **Only the theme is stored in the browser** (`localStorage`, key `candidate-form-theme`, value `light` or `dark`). The token, the passport and WhatsApp numbers and every answer stay in memory only. If storage is blocked, the form still works and follows the device.
- Colours are CSS variables with a light and a dark set (`src/styles.css`). Native controls follow the theme via `color-scheme`. A test checks text contrast is at least 4.5:1 in both. Switching theme changes colours only: answers, validation, language, the step and the session stay.

## Architecture

- Its own Vercel project (**Project B**), built from this folder: set the Vercel **Root Directory to `candidate-form/`**. Never build it from the repository root: the root `vercel.json` deploys the backend.
- It talks only to the backend's public API, `/api/public/candidate-details/*`, on Vercel Project A. It has no database, Supabase, Google Sheets or Meta access, and no secrets.
- The candidate token (and the verified identity) is kept in memory only and sent in the `Authorization` header; it is never put in a URL, cookie or `localStorage`. The theme is the only thing the form stores in the browser.

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
