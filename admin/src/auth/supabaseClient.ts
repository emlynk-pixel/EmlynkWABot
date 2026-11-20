// The browser's Supabase client: Supabase Auth sign-in, sessions, password
// recovery and invitation setup. Built from PUBLIC configuration only:
//   VITE_SUPABASE_URL       the project URL
//   VITE_SUPABASE_ANON_KEY  the anon / publishable key (safe in a browser)
// The service-role / secret key is server-only and is refused here even if
// someone puts it in the build configuration by mistake.
//
// Session storage: localStorage, shared by every tab of this browser, so a
// new tab opens signed in. One shared copy matters: Supabase serialises token
// refresh across tabs (navigator.locks) and tells other tabs about sign-out
// and refreshed tokens (BroadcastChannel on the storage key); a separate copy
// per tab would reuse a rotated refresh token and trip reuse detection.
// Sign-out in one tab signs out the others.
//
// "Remember me": localStorage outlives the browser, so on its own every
// session would survive a restart. Unless the user asked to be remembered
// (REMEMBER_KEY, "1"), a session found on startup without the browser-session
// marker cookie (ALIVE_COOKIE) belongs to a browser that has been closed since,
// and is signed out (endSessionIfBrowserWasClosed). A cookie without
// Expires/Max-Age is the only per-browser-session store: sessionStorage is per
// tab, so it would sign out every new tab. The cookie holds no token. A
// remembered session lasts at most 30 days: the backend answers 401 after that.
// Invitation and recovery links carry the session in the URL; it is picked up
// on load (detectSessionInUrl) and the URL fragment is cleared.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { APP_BASE_PATH } from "../basePath";

export type AuthClient = SupabaseClient["auth"];

export class SupabaseConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SupabaseConfigError";
    }
}

export const AUTH_STORAGE_KEY = "emlynk.auth";
export const REMEMBER_KEY = "emlynk.auth.remember";
export const ALIVE_COOKIE = "emlynk.auth.alive";

// A secret key must never reach a browser: sb_secret_… keys, and legacy JWT
// keys whose role claim is service_role.
export function isSecretKey(key: string): boolean {
    if (key.startsWith("sb_secret_")) return true;
    try {
        const payload = key.split(".")[1];
        if (!payload) return false;
        const { role } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
        return role === "service_role";
    } catch {
        return false;
    }
}

// Before this change the session was in sessionStorage: a tab signed in then
// moves it to localStorage on first read instead of being signed out.
function migrateFromSessionStorage(key: string): string | null {
    try {
        const old = window.sessionStorage.getItem(key);
        if (old === null) return null;
        window.localStorage.setItem(key, old);
        window.sessionStorage.removeItem(key);
        return old;
    } catch {
        return null;
    }
}

export const sessionStore = {
    getItem: (key: string) => {
        try {
            return window.localStorage.getItem(key) ?? migrateFromSessionStorage(key);
        } catch {
            return null;
        }
    },
    setItem: (key: string, value: string) => {
        try {
            window.localStorage.setItem(key, value);
        } catch {
            // storage unavailable: the session lasts for this page only
        }
    },
    removeItem: (key: string) => {
        try {
            window.localStorage.removeItem(key);
            window.sessionStorage.removeItem(key);
            // Signed out (here, in another tab, or the session ended): the
            // next sign-in asks again.
            if (key === AUTH_STORAGE_KEY) clearRememberChoice();
        } catch {
            // nothing stored
        }
    },
};

// Supabase announces sign-out to other tabs over BroadcastChannel; where that
// is unavailable, the session being removed from localStorage by another tab
// (a storage event) signs this tab out too. Returns the unsubscribe function.
export function signOutWhenClearedElsewhere(auth: Pick<AuthClient, "signOut">): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key !== AUTH_STORAGE_KEY && event.key !== null) return;
        if (event.newValue !== null || event.storageArea !== window.localStorage) return;
        void auth.signOut({ scope: "local" }).catch(() => {});
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
}

// The login page's "Remember me" choice, kept beside the session (never the
// password: Supabase stores only its own session tokens).
export function setRememberChoice(remember: boolean): void {
    try {
        window.localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
    } catch {
        // storage unavailable: no session survives the page either
    }
}

export function clearRememberChoice(): void {
    try {
        window.localStorage.removeItem(REMEMBER_KEY);
    } catch {
        // nothing stored
    }
}

function browserSessionMarked(): boolean {
    return document.cookie.split(";").some((part) => part.trim() === `${ALIVE_COOKIE}=1`);
}

// No Expires / Max-Age: the browser drops it when it closes.
function markBrowserSession(): void {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${ALIVE_COOKIE}=1; path=/; SameSite=Strict${secure}`;
}

// Run on startup, before the stored session is read. A session that was not
// to be remembered, stored before this browser session began, is ended: local
// sign-out also revokes it on Supabase. If that fails the stored copy is
// removed anyway. A session from an invite / recovery link is stored after
// this check, and the remember flag is cleared for it, so it lasts until the
// browser closes. Call it right after the
// client is created, in the same task: everything up to the sign-out is
// synchronous, so it runs before Supabase reads the stored session or the URL.
export async function endSessionIfBrowserWasClosed(auth: Pick<AuthClient, "signOut">): Promise<void> {
    const browserWasOpen = browserSessionMarked();
    markBrowserSession();
    // An invite / recovery link carries its own session: it lasts until the
    // browser closes, whatever an earlier sign-in chose.
    const linkSession = new URLSearchParams(window.location.hash.replace(/^#/, "")).has("access_token");
    if (linkSession) clearRememberChoice();
    if (browserWasOpen || sessionStore.getItem(AUTH_STORAGE_KEY) === null) return;
    let remembered = false;
    try {
        remembered = window.localStorage.getItem(REMEMBER_KEY) === "1";
    } catch {
        // unreadable: not remembered
    }
    if (remembered) return;
    // An invite / recovery link is being opened: Supabase stores its session
    // once it has read the URL, and a sign-out (which waits for that) would
    // end the new session instead. Drop the old copy now, before then.
    if (linkSession) {
        sessionStore.removeItem(AUTH_STORAGE_KEY);
        return;
    }
    try {
        await auth.signOut({ scope: "local" });
    } catch {
        // removed below
    }
    // Supabase removes the session through sessionStore; make sure it is gone.
    if (sessionStore.getItem(AUTH_STORAGE_KEY) !== null) sessionStore.removeItem(AUTH_STORAGE_KEY);
}

let client: SupabaseClient | null = null;

export function getAuthClient(): AuthClient {
    if (!client) {
        const url = import.meta.env.VITE_SUPABASE_URL;
        const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
        if (!url || !key) throw new SupabaseConfigError("Sign-in is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).");
        if (isSecretKey(key)) throw new SupabaseConfigError("Refusing a Supabase secret key in the browser: use the anon / publishable key.");
        client = createClient(url, key, {
            auth: {
                storage: sessionStore,
                storageKey: AUTH_STORAGE_KEY,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true,
                flowType: "implicit",
            },
        });
        signOutWhenClearedElsewhere(client.auth);
    }
    return client.auth;
}

// Where Supabase sends recovery links: a page of this app (under
// APP_BASE_PATH). Built from this page's own origin, never from user input;
// it must be in the Supabase project's allowed redirect URLs.
export function appUrl(path: string): string {
    return `${window.location.origin}${APP_BASE_PATH}/${path.replace(/^\//, "")}`;
}

// An invite or recovery link Supabase could not honour (expired, already
// used) redirects back with #error=…&error_code=…; returns that code, or null.
// Read before the client consumes the URL fragment.
export function authLinkError(hash: string = window.location.hash): string | null {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    return params.get("error_code") ?? params.get("error");
}
