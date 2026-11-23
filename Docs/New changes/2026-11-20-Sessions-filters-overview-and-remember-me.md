# New feature updates

**Date:** 20 November 2026
**Applies to:** the admin dashboard (`admin/`) and the backend (`src/`)

This guide explains the changes made on 20 November 2026 in plain language: what changed, how to use it, and where the code lives.

| # | Feature | In one sentence |
|---|---|---|
| 1 | Stay signed in across browser tabs | Open a dashboard page in a new tab and you are still logged in. |
| 2 | Back button | One click goes back exactly one page. |
| 3 | Saved filters | Your filters stay after Back, tab changes and reloads, and are cleared when you sign out. |
| 4 | Role change returns candidates | When a user becomes Registration Desk or Job Handler, their active candidates go back to Unallocated. |
| 5 | Role-based Overview | Each user sees their own Overview, based on their role. |
| 6 | Remember me | An optional login checkbox: stay signed in for up to 30 days. |

---

## 1. Stay signed in across browser tabs

### What you will notice
Before, if you opened a dashboard page in a new browser tab (for example with a middle-click or Ctrl+click), you had to log in again. Now the new tab opens already signed in.

### Why it happened
The login session was kept in `sessionStorage`. Every browser tab has its own private `sessionStorage`, so a new tab started with nothing.

### What we changed
The session is now kept in `localStorage`, which all tabs of the same browser share. The sign-in system (Supabase) is unchanged.

Why this is safe: Supabase refreshes tokens carefully so only one tab does it at a time, and it tells the other tabs about refreshes and sign-outs. That only works when the tabs share one copy of the session.

### What still works the same
- **Logout:** signing out ends the session on the server, and every other open tab goes back to the login page. If a browser cannot send that message, the tabs also notice when the session is removed from storage.
- **Session expiry:** an expired session still sends you to the login page, in every tab.
- **Roles and permissions:** unchanged.
- **People already signed in** when this was released are moved to the new storage automatically and are not logged out.

### Good to know
The session now lasts after you close the browser, until it expires or you sign out. Before, closing the tab ended it. On a shared computer, always use **Sign out**. (Feature 6, **Remember me**, later made this optional: without it, the session ends when the browser is closed.)

### Where the code is
[admin/src/auth/supabaseClient.ts](../admin/src/auth/supabaseClient.ts)

---

## 2. Back button

### What you will notice
A **Back** button (left arrow) sits at the top of every dashboard page, right next to the button that opens and closes the side panel.

### How to use it
- Click it once to go to the previous page. It moves exactly one step, never to the first page.
- It is greyed out when there is no previous page in this tab, for example in a newly opened tab. This keeps you from leaving the dashboard by accident.

### Where the code is
- [admin/src/layout/Header.tsx](../admin/src/layout/Header.tsx) (the button)
- [admin/src/components/Icon.tsx](../admin/src/components/Icon.tsx) (the arrow icon)

---

## 3. Saved filters

### What you will notice
On list pages with filters (for example **Candidates**), the filters you set are remembered. You do not have to enter them again.

### Filters stay when you
- go **Back**,
- move to another tab or page and return (including through the side menu),
- reload the browser.

### Filters are cleared when
- you click **Clear all filters** (or **Clear filters**). Clearing also deletes the saved copy, so they stay cleared after a reload.
- you **sign out**, you sign out in another tab, or your session expires.

### Rules
- **Per user:** filters are saved for the signed-in user. Another user on the same browser never sees them.
- **Per page:** each page keeps its own filters. Candidates filters do not affect Agents, and so on.
- **Old or invalid values are ignored:** if a saved option no longer exists (for example an officer who was removed), the page loads without it instead of showing an error.
- **The page number is not saved,** because it may not exist for the saved filters.
- **Work Allocation** also remembers which view you were on (its allocation view), because its officer filter depends on it.

### Pages that remember filters
Candidates, Work Allocation, Agents, Client Management, Clients, Documents, Missing Documents, Police Workflow, Review Queue and Audit Logs.

Not included: Jobs, Daily Report, Priority Follow-ups and Candidate Deployment. Their address holds tabs, report dates or a single record rather than list filters.

### How it works (for developers)
1. Filters already live in the page address (`?sex=F&search=kamal`), which is why Back and reload worked before.
2. When a page opens with **no** filters in the address, the saved ones are copied back into the address (using `replace`, so the Back button is not affected).
3. Whenever the filters change, they are saved in `localStorage` under `emlynk.admin.filters.<userId>.<pageKey>`. No filters means the entry is deleted.
4. When the user's session ends, [AuthProvider.tsx](../admin/src/auth/AuthProvider.tsx) deletes all of that user's saved filters.
5. If the server rejects restored filters (HTTP 400), they are forgotten and the page loads unfiltered.

To add this to another page, use the hook in place of `useSearchParams`:

```ts
const REMEMBERED_KEYS = ["search", "status"]; // the page's filter keys
const [searchParams, setSearchParams, remembered] = useRememberedSearchParams("my-page", REMEMBERED_KEYS);
```

### Where the code is
- [admin/src/hooks/useRememberedSearchParams.ts](../admin/src/hooks/useRememberedSearchParams.ts) (the hook)
- [admin/src/hooks/rememberedFiltersStorage.ts](../admin/src/hooks/rememberedFiltersStorage.ts) (clearing on sign-out)
- [admin/src/api/candidateFilters.ts](../admin/src/api/candidateFilters.ts) (`validFilters`, which drops invalid saved values)

---

## 4. Role change returns candidates to Unallocated

### What you will notice
When an Admin changes a user's role to **Registration Desk** or **Job Handler**, that user can no longer hold candidates. Their active candidates are returned to **Unallocated** straight away, so they can be allocated again in **Work Allocation**.

### Rules
- It happens in the same step as the role change (role change, re-invite, and conversion of the retired Manager role).
- Each returned candidate gets one `UNASSIGN_CANDIDATE` entry in the Audit Logs.
- **Completed placements** (Departed, Cancelled, Rejected) keep their holder.
- In Work Allocation an active Admin holder is no longer shown as inactive: "active" now reflects the account status only.

### Where the code is
- [src/services/workAllocationService.js](../../src/services/workAllocationService.js)
- [src/services/userAccountService.js](../../src/services/userAccountService.js)
- [src/services/retiredRoleService.js](../../src/services/retiredRoleService.js)
- Test: `test/roleChangeAllocation.test.js`

---

## 5. Role-based Overview

### What you will notice
The **Overview** tab now shows each user their own figures instead of the same page for everyone. The layout is the same for all roles; only the data changes. Team Leads and Analysts can now open the Overview and land on it after signing in. Registration Desk and Job Handler are unchanged.

### What it shows
**Overview** (two rows of cards):
- Row 1: **Active Allocated Candidates** and **Job Allocated Candidates**.
- Row 2: **Police reports** yet to receive (Romania and SL Verified), **Agreements** yet to receive (job-allocated candidates only), **Candidate details** not completed, **Newly allocated** (allocated, with no action taken yet) and **Visa submission completed**.

**Daily Overview** (today, Sri Lanka time): form submissions, new allocated candidates and calls taken.

### Who sees what
| Role | Sees |
|---|---|
| Admin / Owner | Everything in the system |
| Team Lead | **My Overview** (own allocated candidates) or **Full Overview** (all allocated candidates), with a switch at the top |
| Analyst | Only their own candidates |

The server decides the scope from the signed-in user, so an Analyst cannot see other users' numbers, even by calling the API directly (`view=full` is refused).

### What was removed
The old cards (totals, Client documents, police due dates, the two document charts, Recent documents, Review queue) and the Monthly overview, with its `/reports/monthly` endpoint. The Missing Documents page and the other pages still work. "Client" wording on this tab now says "Candidate".

### Where the code is
- [src/services/overviewService.js](../../src/services/overviewService.js) (the counts)
- [src/routes/admin.js](../../src/routes/admin.js) (`GET /api/admin/overview`)
- [admin/src/pages/OverviewPage.tsx](../../admin/src/pages/OverviewPage.tsx)
- Tests: `test/overviewRoles.test.js` and `admin/src/test/dashboard.test.tsx`
- API details: `Docs/09a-admin-dashboard-api.md`

---

## 6. Remember me

### What you will notice
The login page has a **Remember me** checkbox between the Password field and the **Sign in** button. It is unchecked by default.

### How it behaves
- **Checked:** you stay signed in after closing and reopening the browser, for up to **30 days**. After that you must sign in again.
- **Unchecked:** the session ends when the browser is closed. New tabs of the same browser stay signed in (feature 1 still works).

### How the 30 days are enforced
By our own server, not by Supabase. On every request the server reads the sign-in time inside the verified token and refuses a session older than 30 days. Refreshing the token, or adding a second factor, does not restart the clock; only a real sign-in does. Supabase also has a "Time-box user sessions" setting that can enforce the same limit on its side; it is not switched on yet.

### What stays the same
- No password is ever stored in the browser.
- **Sign out** ends the session on the server and in every open tab, and clears the choice.
- A deactivated user is blocked at once, and a role change applies on the next request.
- "Forgot password?", error messages and role-based redirects are unchanged.

### Good to know
- On the first start after release, a session saved without a choice counts as "not remembered", so users sign in once more after closing their browser.
- With the Chrome/Edge "Continue where you left off" setting, an unchecked session can survive a restart.
- A session opened from an invitation or recovery email link always ends when the browser is closed.

### Where the code is
- [admin/src/pages/LoginPage.tsx](../../admin/src/pages/LoginPage.tsx) (the checkbox)
- [admin/src/auth/AuthProvider.tsx](../../admin/src/auth/AuthProvider.tsx) and [admin/src/auth/supabaseClient.ts](../../admin/src/auth/supabaseClient.ts) (the choice and ending the session when the browser closes)
- [src/auth/supabaseIdentity.js](../../src/auth/supabaseIdentity.js) (the 30-day limit)
- Tests: `admin/src/test/rememberMe.test.tsx` and `test/sessionMaxAge.test.js`
- Details: `Docs/SUPABASE_AUTH.md`

---

## Checking it yourself

1. Sign in, then open a dashboard page in a new tab. You should not be asked to log in.
2. Sign out in one tab. The other tab should go to the login page.
3. Visit three pages and press **Back** once. You should land on the previous page only.
4. Set filters on **Candidates**, then press Back, switch pages and reload. The filters should stay.
5. Sign in as a different user on the same browser. The first user's filters must not appear.
6. Click **Clear all filters** and reload. They should stay cleared.
7. Sign out and sign in again. Your saved filters should be gone.
8. Change an Analyst who holds candidates to Job Handler. Their candidates should appear under Unallocated in Work Allocation.
9. Open the Overview as an Admin, a Team Lead (try both views) and an Analyst. The numbers should differ by scope, and the Analyst should have no switch.
10. Sign in with **Remember me** checked, close and reopen the browser: you should still be signed in. Repeat unchecked: you should be asked to sign in.

## Tests

From the `admin/` folder:

```
npm test          # all admin tests
npm run build     # type check and build
```

From the project root: `npm test` (backend tests).

New tests: `admin/src/test/sessionAndBack.test.tsx`, `admin/src/test/rememberedFilters.test.tsx`, `admin/src/test/rememberMe.test.tsx`, `test/roleChangeAllocation.test.js`, `test/overviewRoles.test.js` and `test/sessionMaxAge.test.js`.
