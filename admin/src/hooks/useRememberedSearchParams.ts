import { useCallback, useEffect, useRef } from "react";
import { useSearchParams, type SetURLSearchParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { STORAGE_KEY_PREFIX } from "./rememberedFiltersStorage";

// A list page's filters, remembered per user and per page in this browser, so coming back to the page
// (the sidebar's bare URL) shows them again. The URL stays the source of truth: a saved value is only
// copied into a URL that carries none of the page's keys, and the URL's keys are saved whenever they
// change (none set removes the entry, so cleared filters stay cleared). Never the page number: it may
// be out of range for the restored filters. They are forgotten when the user's session ends
// (AuthProvider), not on a reload.

export type RememberedFilters = {
    // The URL's keys are the ones restored from storage (the user has not changed them since).
    restored: boolean;
    // Drops the saved entry and the restored keys from the URL; a no-op unless `restored`.
    discardRestored: () => void;
};

// The listed keys with a value, in the order of `keys` (so equal sets compare equal as strings).
function pick(params: URLSearchParams, keys: readonly string[]): URLSearchParams {
    const picked = new URLSearchParams();
    for (const key of keys) {
        const value = params.get(key);
        if (value) picked.set(key, value);
    }
    return picked;
}

function readSaved(storageKey: string, keys: readonly string[], validate?: (params: URLSearchParams) => URLSearchParams): URLSearchParams {
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return new URLSearchParams();
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new URLSearchParams();
        const params = new URLSearchParams();
        for (const key of keys) {
            const value = (parsed as Record<string, unknown>)[key];
            if (typeof value === "string" && value.trim()) params.set(key, value);
        }
        return pick(validate ? validate(params) : params, keys);
    } catch {
        // malformed or unavailable storage: nothing to restore
        return new URLSearchParams();
    }
}

function writeSaved(storageKey: string, params: URLSearchParams) {
    try {
        if (params.toString()) window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(params)));
        else window.localStorage.removeItem(storageKey);
    } catch {
        // not remembered
    }
}

// useSearchParams() plus a third element. `keys`: the page's filter keys (and "search"); a module
// constant. `validate`: what is kept of a saved value (old or invalid values must not reach the server).
export function useRememberedSearchParams(
    pageKey: string,
    keys: readonly string[],
    validate?: (params: URLSearchParams) => URLSearchParams,
): [URLSearchParams, SetURLSearchParams, RememberedFilters] {
    const { user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const storageKey = user?.userId ? `${STORAGE_KEY_PREFIX}${user.userId}.${pageKey}` : null;
    const listed = pick(searchParams, keys).toString();

    // The storage key whose saved value was already considered for a restore (a new user checks again).
    const checkedRef = useRef<string | null>(null);
    // The listed keys set by the restore, until the user changes them.
    const restoredRef = useRef<string | null>(null);
    // A restore was requested and the URL does not show it yet: the empty URL must not be saved
    // (that would remove the entry being restored).
    const pendingRef = useRef(false);
    const latest = useRef({ searchParams, setSearchParams });
    latest.current = { searchParams, setSearchParams };

    useEffect(() => {
        if (!storageKey) return;
        if (checkedRef.current !== storageKey) {
            checkedRef.current = storageKey;
            restoredRef.current = null;
            pendingRef.current = false;
            if (!listed) {
                const saved = readSaved(storageKey, keys, validate);
                if (saved.toString()) {
                    const next = new URLSearchParams(latest.current.searchParams);
                    // The page number was the unfiltered list's.
                    next.delete("page");
                    for (const [key, value] of saved) next.set(key, value);
                    restoredRef.current = saved.toString();
                    pendingRef.current = true;
                    // Replace: Back still goes to the page before, not to the unfiltered URL.
                    latest.current.setSearchParams(next, { replace: true });
                    return;
                }
            }
        }
        if (pendingRef.current && !listed) return;
        pendingRef.current = false;
        if (restoredRef.current !== null && listed !== restoredRef.current) restoredRef.current = null;
        writeSaved(storageKey, new URLSearchParams(listed));
        // keys and validate are constants of the page.
    }, [storageKey, listed]);

    const restored = Boolean(storageKey) && restoredRef.current !== null && listed === restoredRef.current;
    const discardRestored = useCallback(() => {
        if (!storageKey || restoredRef.current === null || pick(latest.current.searchParams, keys).toString() !== restoredRef.current) return;
        restoredRef.current = null;
        writeSaved(storageKey, new URLSearchParams());
        const next = new URLSearchParams(latest.current.searchParams);
        for (const key of keys) next.delete(key);
        next.delete("page");
        latest.current.setSearchParams(next, { replace: true });
    }, [storageKey, keys]);

    return [searchParams, setSearchParams, { restored, discardRestored }];
}

// A list request refused with 400 while its filters came from storage (an officer, client or job type
// since removed, a value an older version saved): forget them and load the page unfiltered instead of
// showing the error.
export function useDiscardRestoredOnBadRequest(resource: { status: string; error: { status: number } | null }, remembered: RememberedFilters) {
    const badRequest = resource.status === "error" && resource.error?.status === 400;
    const { restored, discardRestored } = remembered;
    useEffect(() => {
        if (badRequest && restored) discardRestored();
    }, [badRequest, restored, discardRestored]);
}
