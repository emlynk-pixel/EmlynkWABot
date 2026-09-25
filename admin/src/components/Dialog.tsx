import { useEffect, useId, type ReactNode } from "react";

// A small modal in the page's card style. Escape or Cancel closes it,
// except while the request is running.
export function ActionDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
    const titleId = useId();
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !busy) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-modal">
                <h2 id={titleId} className="text-headline-sm text-ink">{title}</h2>
                <div className="mt-3">{children}</div>
            </div>
        </div>
    );
}

export const buttonBase = "h-9 rounded px-4 text-label-md disabled:cursor-not-allowed disabled:opacity-60";
export const primaryButton = `${buttonBase} bg-primary text-on-primary hover:opacity-90`;
export const secondaryButton = `${buttonBase} border border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas`;
export const dangerButton = `${buttonBase} border border-critical-border bg-surface text-critical hover:bg-critical-bg`;
export const dangerSolidButton = `${buttonBase} bg-critical text-on-critical hover:opacity-90`;

export function DialogError({ message }: { message: string | null }) {
    return message ? <p role="alert" className="mt-3 rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">{message}</p> : null;
}
