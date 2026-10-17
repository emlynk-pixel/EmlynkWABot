# Candidate Extra Details form (`candidate-form/`)

Public web form where an **existing** candidate opens the personal link staff sent them, verifies with Passport Number + NIC Number, and submits the Candidate Form **once**. It is not candidate registration.

**Status**
- **Task 1 (done):** app shell, configuration, API client, verification.
- **Task 2 (done, then redesigned):** the candidate-facing UI. The first 19-field Additional Details screen was replaced by the guided Candidate Form below, in English / Sinhala, Light / Dark.
- **Task 3 (done):** share links, Passport + NIC verification, prefill from the candidate's record, single submission. Design: [Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md](../Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md).

## UI flow

0. **Link:** staff create the link in Admin (**Share Form**): `https://<form>/#k=<secret>`, valid 3 days. The form reads the secret from the fragment once, keeps it in memory and removes it from the address bar. Without a well-formed link it shows *Open your link* and offers no verification.
1. **Verify:** Passport Number + NIC Number, then **Verify** (`POST /api/public/candidate-details/verify` with `{ linkSecret, passportNumber, nic }`). Failures show one fixed message per case (details don't match, too many attempts, service unavailable, no connection, invalid input, anything else), never the server's own text. If the form was already submitted (and the details are right): a neutral *already submitted* screen.
2. **Candidate Form** (loaded with `POST /form`): answers already on the candidate's record are filled in and marked *From your record*. One section at a time, with **Next** / **Previous**, a progress bar (*Step 2 of 7*, *12 of 17 required answers completed*) and a section list (numbers on phones, names beside the form from 1024 px). **Next** checks the section first; sections already reached can be reopened from the list.
3. **Review:** every answer by section, with **Edit** to go back, then **Submit**, which asks *Submit your details?* (*You can submit only once*). **Yes, submit** sends `POST /submit` once (the button is locked while sending).
4. **Done:** *Thank you. Your details were submitted.* The session ends. A failed send says so plainly, keeps every answer, and **Try submitting again** resends with the same submission key, so it is never stored twice. A server field error is shown on its field. Leaving or reloading the page before submitting clears the answers (there are no drafts). When the session expires (60 minutes), the candidate is taken back to verification.

## Form sections

| # | Section | Fields (* required) |
|---|---|---|
| 1 | Basic & Identification Information | Full Name\*, Surname\*, Other Names, **NIC (verified, read-only)**, Sex\* (Male / Female / Other), Civil Status\* (Single / Married / Divorced / Widowed), Birth Date\*, Birth Place |
| 2 | Contact & Location Details | Address\*, City, District\*, DS Division\*, GN Division, **WhatsApp Number (verified, read-only)**, Alternative Contact Number, Email\* |
| 3 | Passport & Qualifications | **Passport Number (verified, read-only)**, Passport Issue Date\*, Passport Expiry Date\*, Job Category\* (+ Other Job Category\* when OTHER), Experience, Other Skills 1, Other Skills 2, English Knowledge\* |
| 4 | Physical Measurements | Shirt Size, Hip / Waist Size (inches), Shoe Size (UK list, or Other, e.g. EU 43) |
| 5 | Family Background (marked *Important*) | Father and Mother: Name, Surname, Passport Number, Date of Birth. **Spouse** (same four) only when Civil Status is Married. Child 1-3 names (optional) |
| 6 | Guardian Details | Guardian Name\*, Relationship, NIC\*, Date of Birth, Phone Number\*, Address\* |
| 7 | Review | read-only summary |

- The Passport Number, NIC and WhatsApp Number come from the server (`POST /form`) and are shown read-only. They are never part of the answers sent; the server knows the candidate from the token. There is no register number (staff-only) and nothing else staff-only.
- Hidden entries stay in the form (switching back shows them) but are never sent: spouse details unless Married, Other Job Category unless OTHER.
- Checks (`src/form/validation.ts`): required answers; the guardian's NIC as on the staff form (9 digits + V/X, or 12 digits); email format; phone numbers (`+` optional, 9-15 digits); passport numbers (letters and digits); real dates from 1900, birth and issue dates not in the future, expiry after issue; sizes and lengths. The server checks everything again and refuses unknown fields.

**Choices are English codes.** Every choice is kept as an English code; only its label is translated (Married / විවාහක are both `MARRIED`). The lists live in `src/form/options.ts`:
- **Job Category:** PLASTER, BLOCK MASON, TILER, SHUTTERING CARPENTER, BARBENDER, GYPSUM WORKER, ALUMINIUM WORKER, WELDER TIG, WELDER MIG, WELDER ARC, PLUMBER, ELECTRICIAN, JCB OPERATOR, EXCAVATOR OPERATOR, MOTOR GRADER OPERATOR, BOBCAT OPERATOR, WHEEL LOADER OPERATOR, OTHER. A frontend list for now (no database table). The step reads it through `useJobCategories()`, so it can come from the API later without changing the component. An **Other Job Category** text is never added to the list.
- **English Knowledge:** NO KNOWLEDGE, BASIC, FAIR, GOOD, VERY GOOD, FLUENT, shown as tappable cards.

**Uppercase.** English free text is kept in capitals as it is typed: `shamal sathsara` becomes `SHAMAL SATHSARA` in the value itself, with the cursor left where it was (`src/form/uppercase.ts`). Only the letters a-z change, so Sinhala, digits and punctuation stay exactly as typed. Email, phone numbers, dates and choice lists are never changed. This is for the candidate's benefit only; the server normalises again.

## Date fields

Every date (birth dates, passport dates, parents', spouse's and guardian's birth dates) uses one calendar component, `src/components/DatePicker.tsx` (built on `react-day-picker`; the form's `DateInput` wraps it).

- **Value:** always a date-only string, `YYYY-MM-DD` (or empty): never a locale string or a timestamp. The calendar works on local calendar days, so no day can shift with the time zone.
- **Typing:** one format only, `YYYY-MM-DD` (the placeholder says so). A real date is accepted as soon as it is complete and the form's own rules then judge it (required, not in the future, expiry after issue); anything else is not accepted, is flagged and is cleared when the field loses focus. There is no `DD/MM` or `MM/DD` guessing.
- **Calendar:** opens from the field's calendar button (or Alt+Down), with month and year lists (a birth date is a few taps), Today / Clear / Close, and days outside the field's minimum and maximum disabled. Escape closes only the calendar and returns focus to the field; a click outside closes it. Optional dates can be cleared in the calendar; required ones have no Clear.
- **Language:** the labels follow the language switch. In Sinhala the month list shows numbers (01-12), because the browser's Sinhala month names can be confusing; the stored value is never translated.
- **Look:** colours come from the Light / Dark variables; on phones (up to 520 px wide) the calendar is a bottom sheet, otherwise a popover rendered in `<body>` so no card can clip it.

## Language support (English / සිංහල)

- The switch is in the header on every screen. English is the default; the choice is kept in memory only (a reload starts in English) and sets `<html lang>`.
- Every text the candidate reads is in `src/i18n/translations.ts`, including sections, fields, options, help, validation, review and theme labels. The Sinhala dictionary is typed against the English keys, so a missing translation fails the typecheck; a test also checks that every Sinhala text is actually in Sinhala. Job categories show the Sinhala name with the English trade name.
- `LanguageProvider` / `useLanguage()` give `t(key, params)`. Pages keep **values** and **message keys**, never translated strings, so switching language keeps every answer and validation result and shows them in the new language.
- Sinhala review dates are shown as `1990-05-01`; the browser's Sinhala month names can be the traditional ones (e.g. Vesak for May).

## Light / Dark theme

- A switch beside the language switch (icons only on phones narrower than 480 px). The default is the device's setting; the choice is remembered.
- **Only the theme is stored in the browser** (`localStorage`, key `candidate-form-theme`, value `light` or `dark`). The link secret, the token, the identity and every answer stay in memory only. If storage is blocked, the form still works and follows the device.
- Colours are CSS variables with a light and a dark set (`src/styles.css`). Native controls follow the theme via `color-scheme`. A test checks text contrast is at least 4.5:1 in both. Switching theme changes colours only: answers, validation, language, the step and the session stay.

## Architecture

- Its own Vercel project (**Project B**), built from this folder: set the Vercel **Root Directory to `candidate-form/`**. Never build it from the repository root: the root `vercel.json` deploys the backend.
- It talks only to the backend's public API, `/api/public/candidate-details/*`, on Vercel Project A. It has no database, Supabase, Google Sheets or Meta access, and no secrets.
- The link secret and the candidate token are kept in memory only (the secret is sent only in the verify body) and sent in the `Authorization` header; it is never put in a URL, cookie or `localStorage`. The theme is the only thing the form stores in the browser.

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
