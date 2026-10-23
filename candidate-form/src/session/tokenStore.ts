// The candidate session token, kept in memory only: never in localStorage,
// cookies or a URL. Closing or reloading the page ends it; the candidate
// opens their link and verifies again. The server also ends it when the link
// is revoked or replaced, or the form is submitted.

type Session = { token: string; expiresAt: number };

let current: Session | null = null;

export function setSession(token: string, expiresAt: string): void {
    const expires = Date.parse(expiresAt);
    current = Number.isFinite(expires) ? { token, expiresAt: expires } : null;
}

export function getSession(): Session | null {
    if (current && current.expiresAt <= Date.now()) current = null;
    return current;
}

export function clearSession(): void {
    current = null;
}
