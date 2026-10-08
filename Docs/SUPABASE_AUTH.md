# Supabase Auth: authentication, roles and deployment

Supabase Auth (`auth.users`) is the only credential and session authority for
the admin console. The application keeps no passwords, issues no tokens and
sends no account emails of its own.

| Owned by Supabase Auth | Owned by the application (`public."user"`) |
|---|---|
| sign-in, passwords, password policy | profile (name, email) |
| sessions, access/refresh tokens, sign-out | **role** (authorization source of truth) |
| invitation and recovery emails (templates, SMTP) | **status**: `INVITED` / `ACTIVE` / `INACTIVE` |
| auth rate limits (sign-in, recovery, invite) | RBAC on every API route, audit attribution |

`public."user".auth_user_id` = `auth.users.id` (required, unique, UUID; a
foreign key to `auth.users` on Supabase, `ON DELETE RESTRICT`).

## Roles

| Role | Access (enforced by `src/routes/admin.js`) |
|---|---|
| `ADMIN` | everything, including users (`/api/admin/users`) and Settings |
| `MANAGER` | everything except users and Settings |
| `ANALYST` | dashboard reads, review actions, corrections, candidate work; not police-date corrections |
| `REGISTRATION_DESK` | candidate list, lookup, registration and details only |

The role is read from `public."user"` on **every** request; nothing in the
token is trusted for authorization. A role change or deactivation applies to
the user's next request.

## Request authentication

1. The admin app signs in with `supabase.auth.signInWithPassword()` (anon /
   publishable key, in the browser).
2. Every API call carries `Authorization: Bearer <Supabase access token>`.
3. The backend calls `supabase.auth.getUser(token)` (server-side, service-role
   client): this checks signature and expiry **and that the session still
   exists**, so a signed-out or revoked session is refused immediately.
4. `public."user"` is loaded by `auth_user_id`; it must exist and be `ACTIVE`.
5. `req.user` = that row; `requireRole()` checks `req.user.role`.

| Situation | Response |
|---|---|
| no / malformed / expired / signed-out token | 401 |
| valid session, no `public."user"` row, or not `ACTIVE` | 403 `ACCOUNT_NOT_ACTIVE` |
| role not allowed for the route | 403 `Insufficient permissions` |
| Supabase or the database unreachable | 500 (fails closed) |

Code: `src/auth/supabaseIdentity.js`, `src/middleware/requireActiveUser.js`,
`src/middleware/requireRole.js`.

## Flows

**Invite User** (ADMIN only): `POST /api/admin/users/invite {email, name, role}`
→ role validated server-side → `auth.admin.inviteUserByEmail()` (Supabase sends
the email; no role or metadata is sent) → `public."user"` upserted by email,
linked by `auth_user_id`, status `INVITED`. Re-inviting: a pending invitee gets
the invite again; a deactivated user who had set up their account, or a
confirmed Supabase identity without a row, is linked/reactivated (`ACTIVE`); an
`ACTIVE` email is refused (409). One row per email and per identity, so
concurrent invites converge.

**Invitation setup**: the invite link opens `/admin/setup-password` with a
Supabase session → the invitee sets a password (`auth.updateUser`) →
`POST /auth/complete-invite` turns `INVITED` into `ACTIVE`. Deactivating an
`INVITED` user revokes the invitation.

**Password recovery**: `/admin/forgot-password` → `auth.resetPasswordForEmail()`
(same confirmation whether or not the email exists) → recovery link opens
`/admin/reset-password` with a recovery session → `auth.updateUser({ password })`
→ sign-out, sign in again.

**Sign-out**: `auth.signOut()` (global scope: refresh tokens revoked; the access
token stops being accepted by `getUser` because its session is gone). The local
session is cleared even if Supabase can't be reached.

**Bootstrap**: `npm run user:create -- --name "…" --email … [--role ADMIN]`
creates the Supabase identity (password at a hidden prompt, or
`BOOTSTRAP_PASSWORD`) and its `ACTIVE` row; `--link` links an existing Supabase
identity to a new or existing row (no password). Server-only credentials.

## Security decisions

- **Service-role key**: backend only (`src/config/supabase.js`). The browser
  build reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and refuses
  a key that is a secret / service-role key.
- **CSRF: not applicable; middleware removed.** The credential is a bearer token
  that the admin app attaches explicitly from JavaScript. No cookie
  authenticates any request, so a cross-site page cannot make the browser send
  the credential, and the API grants no CORS access for another origin to set
  an `Authorization` header. The previous double-submit-cookie middleware
  (`csrf-csrf`) protected the old httpOnly auth cookie; with no auth cookie it
  had nothing to protect. If cookie-based auth is ever reintroduced, CSRF
  protection must come back with it.
- **Token storage**: Supabase keeps the session in `sessionStorage` (per tab,
  cleared when the tab closes), as the previous token was. As with any
  browser-held bearer token, XSS is the main threat; the strict CSP
  (`script-src 'self'`) is the mitigation.
- **No role from the client**: invitation metadata, request bodies and token
  claims are never read for authorization; `auth_user_id` comes only from the
  verified token.
- **Logging**: tokens, passwords and Supabase errors' raw text are never logged.

## Supabase project configuration (manual, before go-live)

1. **Authentication → URL configuration**: Site URL = the admin site
   (e.g. `https://<host>/admin`); allowed redirect URLs must include
   `https://<host>/admin/setup-password` and `https://<host>/admin/reset-password`
   (and `http://localhost:5173/admin/*` for local development).
2. **Email**: enable the Email provider; disable public sign-ups (users are only
   invited); configure custom SMTP and the Invite / Reset password templates.
3. **Password policy and rate limits**: set the minimum password length (the app
   asks for at least 8) and review the auth rate limits.
4. **Environment variables**
   - Backend (Vercel functions / server): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
     (existing), optional `APP_BASE_URL`. `JWT_SECRET` and `SMTP_*` / `EMAIL_FROM`
     are no longer used.
   - Admin build (Vercel build env): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
5. CSP: `connect-src` already allows `https://*.supabase.co`
   (`src/createApp.js`, `vercel.json`); a custom Supabase domain must be added to both.

## Database deployment order

Migrations `20261008120000_rename_candidate_user_tables` (rename) and
`20261009120000_supabase_auth_cutover` (drop legacy auth tables and
`password_hash`; `auth_user_id` NOT NULL UUID + FK). The cutover **refuses to
run** while any `"user"` row has no `auth_user_id`; it never invents one.

1. `prisma migrate deploy` up to the rename migration (the cutover stops with
   the "Link each one first" error if users exist; nothing is changed).
2. For each existing user: create their Supabase identity (dashboard, or
   `npm run user:create -- --email … --name …`), then
   `npm run user:create -- --email … --link`.
3. If step 1 recorded the cutover as failed:
   `prisma migrate resolve --rolled-back 20261009120000_supabase_auth_cutover`.
4. `prisma migrate deploy` again.

Since all current data is test data, an alternative is to provision fresh
users after the rename migration and link them, then deploy the cutover.
