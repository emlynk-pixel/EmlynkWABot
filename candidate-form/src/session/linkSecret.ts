// The share link's secret ("<form>/#k=<secret>"), kept in memory only.
//
// It travels in the URL FRAGMENT, which browsers never send to a server (so
// it is not in server logs or the Referer). It is read ONCE when the page
// starts and immediately removed from the address bar (history.replaceState),
// so it is not left in the browser's history entry, a bookmark or a
// screenshot of the address bar. Reloading the page therefore needs the
// original link again: that is intended.

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let current: string | null = null;

// Reads "#k=<secret>" from the address, keeps it, and clears the fragment.
export function captureLinkSecret(location: Location = window.location, history: History = window.history): void {
    const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (!hash) return;
    const value = new URLSearchParams(hash).get("k");
    current = value && SECRET_PATTERN.test(value) ? value : null;
    // Always remove the fragment, valid or not.
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}

export const getLinkSecret = (): string | null => current;

// For tests.
export function setLinkSecretForTest(value: string | null): void {
    current = value;
}
