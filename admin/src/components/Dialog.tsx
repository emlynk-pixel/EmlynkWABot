import { useEffect, useId, type ReactNode } from "react";

// A small modal in the page's card style. Escape or Cancel closes it,
// except while the request is running. size "lg" is for a dialog that holds a list to pick from.
const DIALOG_WIDTH = { md: "max-w-md", lg: "max-w-3xl" } as const;
export function ActionDialog({ title, busy, onClose, children, size = "md" }: { title: string; busy: boolean; onClose: () => void; children: ReactNode; size?: keyof typeof DIALOG_WIDTH }) {
    const titleId = useId();
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !busy) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-xs">
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`max-h-[90vh] w-full ${DIALOG_WIDTH[size]} overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-modal`}>
                <h2 id={titleId} className="text-headline-sm text-ink">{title}</h2>
                <div className="mt-3">{children}</div>
            </div>
        </div>
    );
}

export { buttonBase, primaryButton, secondaryButton, dangerButton, dangerSolidButton, DialogError } from "./dialogParts";

export { ConfirmDialog, warningSolidButton, type ConfirmDialogProps, type ConfirmVariant } from "./ConfirmDialog";
