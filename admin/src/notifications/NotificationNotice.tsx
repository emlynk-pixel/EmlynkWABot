import { useState } from "react";
import { useLocation } from "react-router";
import type { NotificationNavState } from "./targets";

// The message a notification click left for the page it ended on (e.g. "This candidate is no longer
// available" after a record's page sent the user on to its section). It belongs to that history entry:
// the next navigation drops it.
export function NotificationNotice() {
    const location = useLocation();
    const text = (location.state as NotificationNavState | null)?.notificationNotice;
    const [dismissed, setDismissed] = useState<string | null>(null);
    if (!text || dismissed === location.key) return null;
    return (
        <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-body-sm text-ink">
            <span>{text}</span>
            <button type="button" onClick={() => setDismissed(location.key)} className="shrink-0 text-label-sm text-primary hover:underline">
                Dismiss
            </button>
        </div>
    );
}
