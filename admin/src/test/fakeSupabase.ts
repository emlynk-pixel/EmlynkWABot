// In-memory stand-in for the Supabase Auth client (auth/supabaseClient.ts is
// mocked to return it in setup.ts): no test contacts Supabase. Synthetic
// accounts and tokens only.
import type { Session } from "@supabase/supabase-js";

type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | "USER_UPDATED" | "PASSWORD_RECOVERY" | "INITIAL_SESSION";
type Listener = (event: AuthEvent, session: Session | null) => void;
type FakeError = { status?: number; code?: string; message?: string };
type Call = { method: string; args: unknown[] };

export function makeSession(accessToken: string, email = "admin@example.invalid"): Session {
    return {
        access_token: accessToken,
        refresh_token: `refresh-${accessToken}`,
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "bearer",
        user: { id: "00000000-0000-4000-8000-0000000000aa", email, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" },
    } as Session;
}

function createFakeAuth() {
    let session: Session | null = null;
    const listeners = new Set<Listener>();
    const accounts = new Map<string, { password: string; token: string }>();
    const calls: Call[] = [];
    const failures: Partial<Record<"signIn" | "signOut" | "reset" | "update", FakeError>> = {};
    const emit = (event: AuthEvent) => listeners.forEach((listener) => listener(event, session));

    const auth = {
        calls,
        failures,
        get currentSession() {
            return session;
        },
        reset() {
            session = null;
            listeners.clear();
            accounts.clear();
            calls.length = 0;
            for (const key of Object.keys(failures)) delete failures[key as keyof typeof failures];
        },
        // A session already in storage (page reload) or set from an invite / recovery link.
        setSession(accessToken: string | null, email?: string) {
            session = accessToken ? makeSession(accessToken, email) : null;
        },
        addAccount(email: string, password: string, token: string) {
            accounts.set(email, { password, token });
        },
        refreshToken(newToken: string) {
            if (!session) return;
            session = { ...session, access_token: newToken };
            emit("TOKEN_REFRESHED");
        },
        expireSession() {
            session = null;
            emit("SIGNED_OUT");
        },

        async getSession() {
            calls.push({ method: "getSession", args: [] });
            return { data: { session }, error: null };
        },
        onAuthStateChange(callback: Listener) {
            listeners.add(callback);
            return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
        },
        async signInWithPassword(credentials: { email: string; password: string }) {
            calls.push({ method: "signInWithPassword", args: [credentials] });
            if (failures.signIn) return { data: { session: null, user: null }, error: failures.signIn };
            const account = accounts.get(credentials.email);
            if (!account || account.password !== credentials.password) {
                return { data: { session: null, user: null }, error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
            }
            session = makeSession(account.token, credentials.email);
            emit("SIGNED_IN");
            return { data: { session, user: session.user }, error: null };
        },
        async signOut(options?: { scope?: "global" | "local" | "others" }) {
            calls.push({ method: "signOut", args: [options] });
            session = null;
            emit("SIGNED_OUT");
            return { error: failures.signOut ?? null };
        },
        async resetPasswordForEmail(email: string, options?: { redirectTo?: string }) {
            calls.push({ method: "resetPasswordForEmail", args: [email, options] });
            return { data: {}, error: failures.reset ?? null };
        },
        async updateUser(attributes: { password?: string }) {
            calls.push({ method: "updateUser", args: [attributes] });
            if (!session) return { data: { user: null }, error: { status: 401, code: "no_session" } };
            if (failures.update) return { data: { user: null }, error: failures.update };
            emit("USER_UPDATED");
            return { data: { user: session.user }, error: null };
        },
    };
    return auth;
}

export const fakeAuth = createFakeAuth();
