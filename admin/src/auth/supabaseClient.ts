// The browser's Supabase client: Supabase Auth sign-in, sessions, password
// recovery and invitation setup. Built from PUBLIC configuration only:
//   VITE_SUPABASE_URL       the project URL
//   VITE_SUPABASE_ANON_KEY  the anon / publishable key (safe in a browser)
// The service-role / secret key is server-only and is refused here even if
// someone puts it in the build configuration by mistake.
//
// Session storage: sessionStorage (kept across reloads of this tab, gone
// when the tab closes, never shared with other tabs), as before the cutover.
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

const sessionStore = {
    getItem: (key: string) => {
        try {
            return window.sessionStorage.getItem(key);
        } catch {
            return null;
        }
    },
    setItem: (key: string, value: string) => {
        try {
            window.sessionStorage.setItem(key, value);
        } catch {
            // storage unavailable: the session lasts for this page only
        }
    },
    removeItem: (key: string) => {
        try {
            window.sessionStorage.removeItem(key);
        } catch {
            // nothing stored
        }
    },
};

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
