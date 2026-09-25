import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Icon } from "../components/Icon";
import { useAuth } from "./AuthProvider";

// Everything except /login is behind this guard. The page the admin asked
// for is passed along so login can return there.
export function RequireAuth({ children }: { children: ReactNode }) {
    const { status } = useAuth();
    const location = useLocation();

    if (status === "checking") {
        return (
            <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
                <Icon name="progress_activity" className="size-6 animate-spin text-primary" />
                <span className="ml-3 text-body-sm text-ink-muted">Checking your session…</span>
            </div>
        );
    }

    if (status === "anonymous") {
        return <Navigate to="/login" replace state={{ from: location }} />;
    }

    return children;
}
