# OWNER role (system owner)

`OWNER` is the highest application role. It exists so that user management has a top: before it,
any ADMIN could change or deactivate any other ADMIN. There is **one OWNER**, and it is set **in the
database only**: the application never gives the OWNER role, and never changes or deactivates an
OWNER account, whoever asks (the OWNER included).

```
OWNER > ADMIN > MANAGER > ANALYST > REGISTRATION_DESK      (JOB_HANDLER: below ADMIN, managed like the others)
```

The role is stored like every other role: `public."user".role` is plain `TEXT`, validated by the
application (`src/middleware/requireRole.js`). There is no database CHECK on it, so **no migration**
was needed and no existing row was changed. Existing ADMIN accounts stay ADMIN.

## Permission model

| | OWNER | ADMIN | MANAGER | ANALYST / REGISTRATION_DESK / JOB_HANDLER |
|---|---|---|---|---|
| Every ADMIN page and API route (Settings, Audit Logs, Job Types, Sheet Sync, …) | ✅ | ✅ | as before | as before |
| List users | ✅ | ✅ | ❌ | ❌ |
| Change the role of / deactivate an OWNER account | ❌ 403 `OWNER_LOCKED` (database only) | ❌ 403 `OWNER_LOCKED` | ❌ | ❌ |
| Change the role of / deactivate an ADMIN account | ✅ | ❌ 403 `OWNER_REQUIRED` | ❌ | ❌ |
| Change the role of / deactivate a MANAGER, ANALYST, REGISTRATION_DESK, JOB_HANDLER | ✅ | ✅ | ❌ | ❌ |
| Give the OWNER role | ❌ 403 `OWNER_LOCKED` (database only) | ❌ 403 `OWNER_LOCKED` | ❌ | ❌ |
| Give the ADMIN role (Change Roles) | ✅ | ❌ 403 | ❌ | ❌ |
| Give a role below ADMIN | ✅ | ✅ | ❌ | ❌ |
| Invite ADMIN | ✅ | ❌ 403 | ❌ | ❌ |
| Invite MANAGER / ANALYST / REGISTRATION_DESK / JOB_HANDLER | ✅ | ✅ | JOB_HANDLER only (new accounts only) | ❌ |
| Invite OWNER | ❌ | ❌ | ❌ | ❌ |
| Re-invite / reactivate an existing account | any account but an OWNER's | accounts below ADMIN | a pending Job Handler invitation only | ❌ |
| Change or deactivate your own account | ❌ 400 `SELF_CHANGE` | ❌ 400 | – | – |

Rules that always hold:

- **OWNER inherits ADMIN.** `hasRole()` (backend `requireRole.js`, frontend `admin/src/auth/roles.ts`)
  treats OWNER as a member of every tier that names ADMIN, and of no other tier.
- **The server decides, on the database rows.** Role change, deactivation and invitation re-read the
  actor and the target inside their transaction, with those rows and every ACTIVE OWNER row locked
  (`SELECT … FOR UPDATE`, `lockUserRows` in `src/services/userAccountService.js`). Nothing in the request
  body is trusted, and a requested role the actor may not give is refused (403), never replaced by a
  lesser one.
- **The OWNER is out of the application's reach.** Giving the OWNER role, and changing, deactivating
  or re-inviting an OWNER account, are refused for everyone (403 `OWNER_LOCKED`), so the application
  can never add, remove or lose the OWNER. Making or changing the OWNER is a database operation (below).
- **There is no delete.** Users are deactivated, never deleted (audit history references them).

The admin app mirrors these rules (role lists never offer Owner; the Owner's row has no controls,
and an ADMIN gets none on Admin rows either; the Owner carries an "Owner" badge), but it is not the
boundary.

## Making the first OWNER

The OWNER is made once per environment by an operator with database access. Until then the system
works as before, except that no one can manage ADMIN accounts or invite ADMINs.

### New environment (no users yet)

Create the owner directly with the bootstrap script (server credentials, no HTTP endpoint):

```
npm run user:create -- --name "Full Name" --email owner@example.com --role OWNER
```

### Existing environment: promote one existing ADMIN

Run this **once, after the deployment**, in the Supabase SQL editor (or `psql`) of the target
environment. Replace the email. It changes exactly one row, and only if that account is an ACTIVE ADMIN
and no ACTIVE OWNER exists yet; it writes the same audit entry the application writes for a role change.

```sql
-- 1. Look first: who are the admins, and is there already an owner?
SELECT admin_id, name, email, role, status
FROM public."user"
WHERE role IN ('OWNER', 'ADMIN')
ORDER BY created_date;

-- 2. Promote ONE account (replace the email).
BEGIN;

WITH promoted AS (
    UPDATE public."user"
       SET role = 'OWNER', updated_date = now()
     WHERE email = lower('owner@example.com')
       AND role = 'ADMIN'
       AND status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM public."user" WHERE role = 'OWNER' AND status = 'ACTIVE')
    RETURNING admin_id
)
INSERT INTO public.audit_logs (audit_id, admin_id, action, previous_status, new_status, reason, previous_value, new_value, created_date)
SELECT gen_random_uuid()::text, admin_id, 'UPDATE_USER_ROLE', 'ADMIN', 'OWNER',
       'Initial system owner (manual promotion, Docs/OWNER_ROLE.md)', 'ADMIN', 'OWNER', now()
FROM promoted
RETURNING admin_id;

-- Exactly ONE row returned: COMMIT;
-- Zero rows (wrong email, not an ACTIVE ADMIN, or an OWNER already exists): ROLLBACK;
COMMIT;
```

The new role applies on that user's next request (roles are read from the database every time); they
see "Owner" in the header after a page reload.

## Changing the OWNER

Also in the database only, in one transaction: the current OWNER becomes an ADMIN and one ACTIVE ADMIN
becomes the OWNER, both audited. Replace the email.

```sql
BEGIN;

WITH demoted AS (
    UPDATE public."user"
       SET role = 'ADMIN', updated_date = now()
     WHERE role = 'OWNER'
    RETURNING admin_id
), promoted AS (
    UPDATE public."user"
       SET role = 'OWNER', updated_date = now()
     WHERE email = lower('new-owner@example.com')
       AND role = 'ADMIN'
       AND status = 'ACTIVE'
    RETURNING admin_id
)
INSERT INTO public.audit_logs (audit_id, admin_id, action, previous_status, new_status, reason, previous_value, new_value, created_date)
SELECT gen_random_uuid()::text, admin_id, 'UPDATE_USER_ROLE', 'OWNER', 'ADMIN',
       'Owner changed (manual, Docs/OWNER_ROLE.md)', 'OWNER', 'ADMIN', now() FROM demoted
UNION ALL
SELECT gen_random_uuid()::text, admin_id, 'UPDATE_USER_ROLE', 'ADMIN', 'OWNER',
       'Owner changed (manual, Docs/OWNER_ROLE.md)', 'ADMIN', 'OWNER', now() FROM promoted
RETURNING admin_id, new_value;

-- Exactly TWO rows returned (one ADMIN, one OWNER): COMMIT;
-- Anything else (wrong email, not an ACTIVE ADMIN, no current OWNER): ROLLBACK;
COMMIT;
```

To demote the OWNER without a successor, run only the first `UPDATE` (with its audit row); the system
then has no OWNER until one is made as in *Making the first OWNER*.
