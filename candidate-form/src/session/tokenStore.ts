// The candidate session, kept in memory only: never in localStorage, cookies
// or a URL. Closing or reloading the page ends it; the candidate simply
// verifies again. The token expires on the server after a few minutes anyway.
//
// It also holds the Passport Number and WhatsApp Number the candidate was
// verified with, so the form can show them read-only. They are what the
// candidate typed (in the server's normalised form), are never sent with the
// form answers, and go when the session goes.

export type VerifiedIdentity = { passportNumber: string; whatsappNumber: string };

type Session = { token: string; expiresAt: number; identity: VerifiedIdentity };

let current: Session | null = null;

export function setSession(token: string, expiresAt: string, identity: VerifiedIdentity): void {
    const expires = Date.parse(expiresAt);
    current = Number.isFinite(expires) ? { token, expiresAt: expires, identity } : null;
}

export function getSession(): Session | null {
    if (current && current.expiresAt <= Date.now()) current = null;
    return current;
}

export function clearSession(): void {
    current = null;
}
