// Where useRememberedSearchParams keeps a user's list filters: one localStorage entry per user and page.
export const STORAGE_KEY_PREFIX = "emlynk.admin.filters.";

// Forgets every page's saved filters of one user (their session ended: sign-out here or in another
// tab, or an expired session). A reload keeps the session, so it keeps the filters too.
export function clearRememberedFilters(userId: string): void {
    try {
        const prefix = `${STORAGE_KEY_PREFIX}${userId}.`;
        const keys: string[] = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
            const key = window.localStorage.key(i);
            if (key?.startsWith(prefix)) keys.push(key);
        }
        for (const key of keys) window.localStorage.removeItem(key);
    } catch {
        // storage unavailable: nothing was saved
    }
}
