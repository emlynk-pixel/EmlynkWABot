import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCurrentAdmin, login as loginRequest, type Admin } from "../api/auth";
import { clearToken, readToken, saveToken, tokenExpiresAt } from "./tokenStorage";

// "checking": a stored token is being validated with GET /auth/me.
type AuthState =
    | { status: "checking"; admin: null }
    | { status: "authenticated"; admin: Admin }
    | { status: "anonymous"; admin: null };

type AuthContextValue = AuthState & {
    signIn: (email: string, password: string) => Promise<void>;
    signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// A token that is expired or has an unreadable expiry is not worth sending.
function isUsable(token: string | null): token is string {
    if (!token) return false;
    const expiresAt = tokenExpiresAt(token);
    return expiresAt === null || expiresAt > Date.now();
}

export function AuthProvider({ children }: { children: ReactNode }) {
    // A stored token from an earlier load of this tab, if still usable.
    const [token, setToken] = useState<string | null>(() => {
        const stored = readToken();
        if (isUsable(stored)) return stored;
        clearToken();
        return null;
    });
    const [state, setState] = useState<AuthState>(() =>
        token ? { status: "checking", admin: null } : { status: "anonymous", admin: null }
    );
    const expiryTimer = useRef<number | undefined>(undefined);

    const signOut = useCallback(() => {
        clearToken();
        setToken(null);
        setState({ status: "anonymous", admin: null });
    }, []);

    // Validate a token from an earlier page load: the admin may have been
    // deactivated or the token may have expired in the meantime.
    useEffect(() => {
        if (state.status !== "checking" || !token) return;
        const controller = new AbortController();
        fetchCurrentAdmin(token, controller.signal)
            .then((admin) => setState({ status: "authenticated", admin }))
            .catch((error: unknown) => {
                if ((error as Error)?.name === "AbortError") return;
                // 401/404 (token no longer valid) or server unreachable: never
                // leave the app half-authenticated; the admin signs in again.
                signOut();
            });
        return () => controller.abort();
    }, [state.status, token, signOut]);

    // Sign out when the token expires, without waiting for a failed request.
    useEffect(() => {
        window.clearTimeout(expiryTimer.current);
        if (!token || state.status !== "authenticated") return;
        const expiresAt = tokenExpiresAt(token);
        if (expiresAt === null) return;
        const delay = Math.max(0, expiresAt - Date.now());
        // setTimeout overflows above ~24.8 days; tokens here last 1 hour.
        expiryTimer.current = window.setTimeout(signOut, Math.min(delay, 2_147_000_000));
        return () => window.clearTimeout(expiryTimer.current);
    }, [token, state.status, signOut]);

    const signIn = useCallback(async (email: string, password: string) => {
        const newToken = await loginRequest(email, password);
        const admin = await fetchCurrentAdmin(newToken);
        saveToken(newToken);
        setToken(newToken);
        setState({ status: "authenticated", admin });
    }, []);

    const value = useMemo<AuthContextValue>(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
    return context;
}
