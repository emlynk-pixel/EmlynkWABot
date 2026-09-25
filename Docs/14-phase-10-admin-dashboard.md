# Phase 10 — Admin Dashboard

Status: **Checkpoint 1 done** — frontend scaffold, admin login, route guard and dashboard shell. No dashboard data or admin actions yet.

Visual source of truth: Stitch project **EmlynkWABot Admin Dashboard UI** (`13688778730186190970`), design system **Precision Enterprise Console**. The Stitch project is read-only for development; nothing is generated or changed there from the code.

## 1. Structure

The dashboard is a separate frontend in `admin/` with its own `package.json`. The backend serves its build under `/admin` (same origin as the API).

```text
admin/
├── index.html                # App entry (base path /admin/)
├── vite.config.ts            # Vite + React + Tailwind; dev proxy; Vitest config
├── tsconfig.json
├── public/favicon.svg
└── src/
    ├── main.tsx              # BrowserRouter (basename /admin) + AuthProvider
    ├── App.tsx               # Routes
    ├── index.css             # Tailwind + Stitch design tokens (@theme)
    ├── api/
    │   ├── client.ts         # fetch wrapper, ApiError, safe error messages
    │   └── auth.ts           # POST /auth/login, GET /auth/me
    ├── auth/
    │   ├── AuthProvider.tsx  # session state, sign in/out, expiry timer
    │   ├── RequireAuth.tsx   # route guard
    │   └── tokenStorage.ts   # JWT in sessionStorage (+ memory fallback)
    ├── layout/
    │   ├── AdminLayout.tsx   # shell: sidebar + header + content
    │   ├── Sidebar.tsx       # dark sidebar, 240px, collapsible to 64px rail, mobile drawer
    │   ├── Header.tsx        # 56px utility bar: breadcrumb, admin, sign out
    │   └── navigation.ts     # sidebar entries
    ├── components/Icon.tsx   # Material Symbols as individual SVGs
    ├── pages/                # Login, Overview, section placeholders, not found
    └── test/                 # Vitest + Testing Library tests
```

Backend changes: `src/adminFrontend.js` (serves `admin/dist`) and `src/createApp.js` (mounts it at `/admin`; accepts `adminDistDir` / `authRouter` options for tests). No other backend behaviour changed.

## 2. Routes

| Route | Page | Stitch screen | Checkpoint 1 |
|---|---|---|---|
| `/admin/login` | Sign in | — (built from the design system) | Working |
| `/admin/` | Overview | Overview Dashboard | Shell only |
| `/admin/documents` | Documents | Documents Directory | Shell only |
| `/admin/review` | Review Queue | Review Queue (+ Document Review Detail later) | Shell only |
| `/admin/clients` | Clients | Client Details | Shell only |
| `/admin/police` | Police Workflow | Police Workflow | Shell only |

Every route except `/admin/login` is behind the route guard. Settings, global search, Sync and Export from the design are not built yet.

## 3. Authentication flow

Uses the existing backend endpoints unchanged (`src/routes/auth.js`).

1. **Sign in:** the login form sends `POST /auth/login` `{ email, password }`. On success the backend returns a JWT (HS256, 1 hour).
2. **Validate:** the app immediately calls `GET /auth/me` with `Authorization: Bearer <token>`. Only then is the admin signed in; the token is stored and the admin's name and role are shown in the header.
3. **Reload / new visit in the same tab:** a stored token is checked again with `GET /auth/me`. If the backend rejects it (expired, admin deactivated, bad token) or cannot be reached, the token is removed and the login page is shown.
4. **Expiry:** the app reads the token's `exp` and signs out when it passes. An already-expired stored token is dropped without calling the backend.
5. **Sign out:** removes the token and returns to the login page. (The backend has no logout endpoint; the token simply expires.)
6. **Route guard:** while a stored token is being checked, a "Checking your session" screen is shown; without a valid session every protected route redirects to `/admin/login`, which returns to the requested page after sign-in (only paths inside the app are followed).

Error messages: the backend's own short messages are shown for 4xx responses ("Invalid email or password", the rate-limit message); 5xx and network errors show a fixed generic text, never backend details.

**Token storage (this checkpoint):** `sessionStorage` — survives reloads of the tab, is removed when the tab closes, is not shared between tabs and is never sent automatically. If storage is blocked, an in-memory copy keeps the current tab working. Because JavaScript can read it, it relies on the Content Security Policy (scripts from the same origin only) against XSS. Moving to an httpOnly cookie is planned for **Phase 12**.

The first admin account is created with `npm run admin:create` (see `Docs/13-security-overview.md`).

## 4. Design system

`admin/src/index.css` defines the Stitch tokens as a Tailwind v4 `@theme`:

- **Colours:** primary `#2563eb` (hover `#1d4ed8`, active `#1e40af`); canvas `#f8fafc`; surfaces `#ffffff` with `#e2e8f0` borders; dark sidebar `#0f172a` / `#1e293b`; status sets for verified, review, pending, critical and duplicate (text / background / border).
- **Typography:** Inter (self-hosted via `@fontsource-variable/inter`) with tabular figures; scale `headline-xl` … `label-sm` as in Stitch.
- **Shapes and depth:** radius 2 / 4 / 6 / 8 / 12 px; hairline borders with very light shadows; focus ring `0 0 0 3px rgba(37,99,235,.15)`.
- **Layout:** sidebar 240px (rail 64px), header 56px, content max 1600px.
- **Icons:** Material Symbols Outlined, imported one SVG at a time from `@material-symbols/svg-400` (a few hundred bytes each instead of a 1–1.5 MB icon font).

No external CDN or Google Fonts request is made, so the backend's Content Security Policy (`script-src 'self'`) applies unchanged.

## 5. Running it

```bash
npm run admin:install      # once: install the admin app's dependencies

# Development (two terminals)
npm start                  # backend on http://localhost:3000
npm run admin:dev          # dashboard on http://localhost:5173/admin/
                           # (Vite proxies /auth and /health to the backend;
                           #  another backend: ADMIN_API_PROXY_TARGET=http://host:port)

# Production
npm run admin:build        # type-check + build into admin/dist (git-ignored)
npm start                  # dashboard at http://localhost:3000/admin/
```

If the dashboard is not built, `/admin` answers `404 {"message":"Admin dashboard is not built. Run: npm run admin:build"}`; the API works either way.

Serving rules (`src/adminFrontend.js`): hashed files under `/admin/assets/` are cached for a year and a missing one is a plain 404; any other GET under `/admin` returns `index.html` with `Cache-Control: no-cache`, so deep links such as `/admin/review` work on reload.

## 6. Tests

| Suite | Command | Covers |
|---|---|---|
| Frontend (Vitest, jsdom) | `npm run admin:test` | redirect when signed out, login success/failure/rate limit/5xx, return to the requested page, session restore, rejected/expired token, backend unreachable, sign out, navigation, collapsible sidebar, token storage |
| Backend (`node:test`) | `npm test` (`test/adminFrontend.test.js`) | `/admin` serving, SPA fallback, asset caching and 404s, path traversal, security headers, other methods, "not built" message, same-origin login + `/auth/me` against the real auth routes |

Checked manually for this checkpoint: the production build served by Express in headless Chrome (redirect to login, wrong and correct password, dashboard shell, deep-link reload, sign out, no CSP violations), and the Vite dev proxy against the real backend.

## 7. Next checkpoints

2. Read-only admin API (`/api/admin/...`, shared active-admin check) and the Overview, Documents and Client Details screens.
3. Saved processing summary on `temporary_data` (migration), Review Queue and read-only Review Detail with a secure file preview.
4. Review actions (approve / reject / keep pending) with an audit log.
5. Police Workflow (full version depends on Phase 9 data).
