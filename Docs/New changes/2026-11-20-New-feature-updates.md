# New feature updates

**Date:** 20 November 2026
**Applies to:** the admin dashboard (`admin/`)

This guide explains three improvements to the admin dashboard in plain language: what changed, how to use it, and where the code lives.

| # | Feature | In one sentence |
|---|---|---|
| 1 | Stay signed in across browser tabs | Open a dashboard page in a new tab and you are still logged in. |
| 2 | Back button | One click goes back exactly one page. |
| 3 | Saved filters | Your filters stay after Back, tab changes and reloads, and are cleared when you sign out. |

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
The session now lasts after you close the browser, until it expires or you sign out. Before, closing the tab ended it. On a shared computer, always use **Sign out**.

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

## Checking it yourself

1. Sign in, then open a dashboard page in a new tab. You should not be asked to log in.
2. Sign out in one tab. The other tab should go to the login page.
3. Visit three pages and press **Back** once. You should land on the previous page only.
4. Set filters on **Candidates**, then press Back, switch pages and reload. The filters should stay.
5. Sign in as a different user on the same browser. The first user's filters must not appear.
6. Click **Clear all filters** and reload. They should stay cleared.
7. Sign out and sign in again. Your saved filters should be gone.

## Tests

From the `admin/` folder:

```
npm test          # all admin tests
npm run build     # type check and build
```

New tests: `admin/src/test/sessionAndBack.test.tsx` and `admin/src/test/rememberedFilters.test.tsx`.
