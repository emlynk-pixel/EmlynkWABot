import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Sync = reload the dashboard data shown on screen from the backend, on
// request. Nothing else: no WhatsApp, external system or background sync.
//
// sync() bumps `version`; every useAdminResource on the page reloads with
// its current key (filters, page and search are kept) and reports its
// request here. When all of them have settled, the header shows the time or
// an error. While a sync runs, another one is not started.
export type SyncResult = { status: "success"; at: Date } | { status: "error"; at: Date } | null;

type SyncContextValue = {
    version: number;
    syncing: boolean;
    result: SyncResult;
    sync: () => void;
    track: (request: Promise<unknown>) => void;
};

const noop = () => {};
const SyncContext = createContext<SyncContextValue>({ version: 0, syncing: false, result: null, sync: noop, track: noop });

export function SyncProvider({ children }: { children: ReactNode }) {
    const [version, setVersion] = useState(0);
    const [syncing, setSyncing] = useState(false);
    const [result, setResult] = useState<SyncResult>(null);
    const syncingRef = useRef(false);
    const requests = useRef<Promise<unknown>[]>([]);

    const sync = useCallback(() => {
        if (syncingRef.current) return; // one sync at a time
        syncingRef.current = true;
        requests.current = [];
        setSyncing(true);
        setVersion((v) => v + 1);
    }, []);

    const track = useCallback((request: Promise<unknown>) => {
        if (syncingRef.current) requests.current.push(request);
    }, []);

    // Runs after the pages' effects for the new version (child effects run
    // first), so every reload of this sync has been tracked by now.
    useEffect(() => {
        if (version === 0) return;
        let active = true;
        Promise.allSettled(requests.current).then((outcomes) => {
            if (!active) return;
            const failed = outcomes.some((o) => o.status === "rejected" && (o.reason as Error)?.name !== "AbortError");
            syncingRef.current = false;
            setSyncing(false);
            setResult({ status: failed ? "error" : "success", at: new Date() });
        });
        return () => {
            active = false;
        };
    }, [version]);

    // If the provider unmounts mid-sync (sign out), a later mount starts clean.
    useEffect(() => () => {
        syncingRef.current = false;
    }, []);

    const value = useMemo(() => ({ version, syncing, result, sync, track }), [version, syncing, result, sync, track]);
    return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
    return useContext(SyncContext);
}
