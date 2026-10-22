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

export { buttonBase, primaryButton, secondaryButton, dangerButton, dangerSolidButton, DialogError } from "./dialogParts";

export { ConfirmDialog, warningSolidButton, type ConfirmDialogProps, type ConfirmVariant } from "./ConfirmDialog";
