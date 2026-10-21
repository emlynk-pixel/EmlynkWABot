import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DialogError, buttonBase, dangerSolidButton, primaryButton, secondaryButton } from "./Dialog";
import { Icon } from "./Icon";

export type ConfirmVariant = "normal" | "info" | "warning" | "destructive" | "danger";

export const warningSolidButton = `${buttonBase} bg-review text-on-primary hover:opacity-90`;

export interface ConfirmDialogProps {
    open?: boolean;
    title: string;
    message?: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    busyLabel?: string;
    variant?: ConfirmVariant;
    loading?: boolean;
    busy?: boolean;
    error?: string | null;
    initialFocus?: "confirm" | "cancel";
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
}

export function ConfirmDialog({
    open = true,
    title,
    message,
    description,
    children,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    busyLabel = "Working…",
    variant = "normal",
    loading,
    busy,
    error,
    initialFocus = "cancel",
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const titleId = useId();
    const descriptionId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const confirmButtonRef = useRef<HTMLButtonElement>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    const [internalBusy, setInternalBusy] = useState(false);
    const [internalError, setInternalError] = useState<string | null>(null);

    const isBusy = Boolean(loading ?? busy ?? internalBusy);
    const currentError = error !== undefined ? error : internalError;
    const bodyContent = message ?? description ?? children;

    // Track active element before modal opens and return focus on close
    useEffect(() => {
        if (!open) return;
        triggerRef.current = (document.activeElement as HTMLElement) ?? null;
        return () => {
            triggerRef.current?.focus?.();
        };
    }, [open]);

    // Handle initial focus
    useEffect(() => {
        if (!open) return;
        const target = initialFocus === "confirm" ? confirmButtonRef.current : cancelButtonRef.current;
        target?.focus();
    }, [open, initialFocus]);

    // Escape key handling
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !isBusy) {
                onCancel();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, isBusy, onCancel]);

    if (!open) return null;

    // Tab key focus trap
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Tab" || !dialogRef.current) return;
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleConfirm = async () => {
        if (isBusy) return;
        setInternalError(null);
        try {
            const res = onConfirm();
            if (res && typeof (res as Promise<void>).then === "function") {
                setInternalBusy(true);
                await res;
            }
        } catch (caught) {
            setInternalError(caught instanceof Error ? caught.message : "Action failed. Please try again.");
        } finally {
            setInternalBusy(false);
        }
    };

    const handleCancel = () => {
        if (isBusy) return;
        onCancel();
    };

    const isDestructive = variant === "destructive" || variant === "danger";
    const isWarning = variant === "warning";

    const confirmButtonClass = isDestructive
        ? dangerSolidButton
        : isWarning
        ? warningSolidButton
        : primaryButton;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={bodyContent ? descriptionId : undefined}
                onKeyDown={handleKeyDown}
                className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-modal"
            >
                <div className="flex items-start gap-3">
                    {isDestructive && (
                        <div
                            aria-hidden="true"
                            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-critical-bg text-critical"
                        >
                            <Icon name="error" className="size-5" />
                        </div>
                    )}
                    {isWarning && (
                        <div
                            aria-hidden="true"
                            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-review-bg text-review"
                        >
                            <Icon name="assignment_late" className="size-5" />
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-headline-sm font-semibold text-ink">
                            {title}
                        </h2>
                        {bodyContent && (
                            <div id={descriptionId} className="mt-2 text-body-sm text-ink-soft">
                                {bodyContent}
                            </div>
                        )}
                    </div>
                </div>

                <DialogError message={currentError} />

                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button
                        ref={cancelButtonRef}
                        type="button"
                        disabled={isBusy}
                        onClick={handleCancel}
                        className={secondaryButton}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        ref={confirmButtonRef}
                        type="button"
                        disabled={isBusy}
                        onClick={handleConfirm}
                        className={confirmButtonClass}
                    >
                        {isBusy ? busyLabel : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
