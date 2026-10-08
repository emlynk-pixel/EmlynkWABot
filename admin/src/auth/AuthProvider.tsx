import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { fetchCurrentUser, type AppUser } from "../api/auth";
import { ApiError, setApiAccessToken } from "../api/client";
import { getAuthClient, SupabaseConfigError } from "./supabaseClient";

export { canCorrectPoliceDates, canReview, canViewDashboard, isAdmin } from "./roles";

// Supabase Auth owns the session; the backend owns the application user.
//   checking       the stored Supabase session (if any) is being checked
//   authenticated  a Supabase session whose application user is ACTIVE
//   anonymous      no usable session; `notice` says why when it isn't obvious
type AuthState =
    | { status: "checking"; user: null; token: null; notice: null }
    | { status: "authenticated"; user: AppUser; token: string; notice: null }
    | { status: "anonymous"; user: null; token: null; notice: string | null };

type AuthContextValue = AuthState & {
    signIn: (email: string, password: string) => Promise<void>;
    signOut: () => Promise<void>;
    // Re-reads the application profile for the current session (after
    // completing an invitation, or a role change).
    refreshUser: () => Promise<void>;
};

export const ACCOUNT_NOT_ACTIVE_MESSAGE = "Your account is not active. Contact an administrator.";
const INVALID_LOGIN_MESSAGE = "Invalid email or password";
const RATE_LIMITED_MESSAGE = "Too many sign-in attempts. Please try again later.";
const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

const CHECKING: AuthState = { status: "checking", user: null, token: null, notice: null };
const anonymous = (notice: string | null = null): AuthState => ({ status: "anonymous", user: null, token: null, notice });

const AuthContext = createContext<AuthContextValue | null>(null);

// A Supabase sign-in error as the message the login page shows. Supabase
// answers invalid credentials and unknown emails alike, so nothing tells
// which one it was.
function signInError(error: { status?: number; code?: string }): ApiError {
    if (error.status === 429 || error.code === "over_request_rate_limit") return new ApiError(429, RATE_LIMITED_MESSAGE);
    if (error.status === 400 || error.code === "invalid_credentials") return new ApiError(401, INVALID_LOGIN_MESSAGE);
    return new ApiError(error.status ?? 0, FALLBACK_MESSAGE);
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>(CHECKING);
    const stateRef = useRef(state);
    stateRef.current = state;

    const apply = useCallback((next: AuthState) => {
        setApiAccessToken(next.token);
        setState(next);
    }, []);

    // The application user behind a Supabase session. 401: Supabase no longer
    // accepts the session -> drop it here too. 403: a genuine session without
    // an ACTIVE application user (e.g. an invitation not completed yet) ->
    // not signed in to the app; the Supabase session is kept for the setup
    // page. Anything else (backend unreachable): not signed in, try again.
    const loadUser = useCallback(async (session: Session | null, signal?: AbortSignal): Promise<AuthState> => {
        if (!session) return anonymous();
        try {
            const user = await fetchCurrentUser(session.access_token, signal);
            return { status: "authenticated", user, token: session.access_token, notice: null };
        } catch (error) {
            if ((error as Error)?.name === "AbortError") throw error;
            if (error instanceof ApiError && error.status === 401) {
                await getAuthClient().signOut({ scope: "local" }).catch(() => {});
                return anonymous();
            }
            if (error instanceof ApiError && error.status === 403) return anonymous(ACCOUNT_NOT_ACTIVE_MESSAGE);
            return anonymous(error instanceof ApiError ? error.message : FALLBACK_MESSAGE);
        }
    }, []);

    // Restore the session on load (also one set up from an invite or recovery
    // link), and follow Supabase's session events afterwards.
    useEffect(() => {
        let auth;
        try {
            auth = getAuthClient();
        } catch (error) {
            apply(anonymous(error instanceof SupabaseConfigError ? error.message : FALLBACK_MESSAGE));
            return;
        }
        const controller = new AbortController();
        auth.getSession()
            .then(({ data }) => loadUser(data.session, controller.signal))
            .then((next) => { if (!controller.signal.aborted) apply(next); })
            .catch((error: unknown) => { if ((error as Error)?.name !== "AbortError") apply(anonymous(FALLBACK_MESSAGE)); });

        const { data } = auth.onAuthStateChange((event, session) => {
            if (event === "SIGNED_OUT" || !session) {
                if (stateRef.current.status === "authenticated") apply(anonymous());
                return;
            }
            // A refreshed access token: same user, new token for API calls.
            const current = stateRef.current;
            if ((event === "TOKEN_REFRESHED" || event === "USER_UPDATED") && current.status === "authenticated") {
                apply({ ...current, token: session.access_token });
            }
        });
        return () => {
            controller.abort();
            data.subscription.unsubscribe();
        };
    }, [apply, loadUser]);

    const signIn = useCallback(async (email: string, password: string) => {
        const auth = getAuthClient();
        const { data, error } = await auth.signInWithPassword({ email, password });
        if (error || !data.session) throw signInError(error ?? {});
        const next = await loadUser(data.session);
        if (next.status !== "authenticated") {
            // Valid credentials but no usable application account: sign the
            // Supabase session out again and say why.
            await auth.signOut({ scope: "local" }).catch(() => {});
            apply(anonymous());
            throw new ApiError(403, next.notice ?? ACCOUNT_NOT_ACTIVE_MESSAGE);
        }
        apply(next);
    }, [apply, loadUser]);

    // Ends the Supabase session everywhere (refresh tokens revoked); the
    // local session is always cleared, even if Supabase can't be reached.
    const signOut = useCallback(async () => {
        try {
            const auth = getAuthClient();
            const { error } = await auth.signOut();
            if (error) await auth.signOut({ scope: "local" });
        } catch {
            // best-effort: the local state is cleared below regardless
        }
        apply(anonymous());
    }, [apply]);

    const refreshUser = useCallback(async () => {
        const { data } = await getAuthClient().getSession();
        apply(await loadUser(data.session));
    }, [apply, loadUser]);

    const value = useMemo<AuthContextValue>(() => ({ ...state, signIn, signOut, refreshUser }), [state, signIn, signOut, refreshUser]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
    return context;
}
