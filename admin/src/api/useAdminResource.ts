import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useSync } from "../sync/SyncProvider";
import { ApiError } from "./client";

export type Resource<T> =
    | { status: "loading"; data: T | null; error: null }
    | { status: "success"; data: T; error: null }
    | { status: "error"; data: T | null; error: ApiError };

// Loads one admin API resource for the signed-in admin. `key` identifies the
// request (e.g. the query string); a new key reloads, and an older request
// still in flight is aborted. A 401 means the session ended (expired or
// admin deactivated), so the admin is signed out and sent to the login page.
// Sync (header) reloads it with the same key; the data on screen stays
// visible while it reloads.
export function useAdminResource<T>(key: string, load: (token: string, signal: AbortSignal) => Promise<T>) {
    const { token, signOut } = useAuth();
    const [state, setState] = useState<Resource<T>>({ status: "loading", data: null, error: null });
    const [attempt, setAttempt] = useState(0);
    const { version: syncVersion, track } = useSync();

    useEffect(() => {
        if (!token) return;
        const controller = new AbortController();
        setState((previous) => ({ status: "loading", data: previous.data, error: null }));
        const request = load(token, controller.signal);
        track(request);
        request
            .then((data) => setState({ status: "success", data, error: null }))
            .catch((error: unknown) => {
                if ((error as Error)?.name === "AbortError") return;
                const apiError = error instanceof ApiError ? error : new ApiError(0, "Something went wrong. Please try again.");
                if (apiError.status === 401) {
                    signOut();
                    return;
                }
                setState((previous) => ({ status: "error", data: previous.data, error: apiError }));
            });
        return () => controller.abort();
        // `load` is recreated on every render; `key` identifies the request.
    }, [key, token, attempt, syncVersion, signOut]);

    const reload = useCallback(() => setAttempt((n) => n + 1), []);
    return { ...state, reload };
}
