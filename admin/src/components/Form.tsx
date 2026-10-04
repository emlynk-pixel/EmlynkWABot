import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { fieldLabel } from "./ui";

// Small "!" beside a field label. Opens on hover, keyboard focus or a
// click/tap (touch screens have no hover); closes on mouse leave, blur,
// Escape or a tap elsewhere. (A click focuses the button first, so a toggling
// click would close it again at once.) The text is announced as the button's
// description.
export function HelpTip({ label, text }: { label: string; text: string }) {
    const [open, setOpen] = useState(false);
    const tipId = useId();
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <span ref={ref} className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
            <button
                type="button"
                aria-label={`About ${label}`}
                aria-expanded={open}
                aria-describedby={open ? tipId : undefined}
                onClick={() => setOpen(true)}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                className="flex size-[18px] items-center justify-center rounded-full border border-border-strong text-label-caps font-bold leading-none text-ink-muted hover:border-primary hover:text-primary focus:outline-none focus-visible:shadow-focus"
            >
                <span aria-hidden="true">!</span>
            </button>
            {open && (
                <span
                    role="tooltip"
                    id={tipId}
                    className="absolute left-0 top-full z-30 mt-1.5 w-60 max-w-[calc(100vw-3rem)] rounded-md border border-border bg-surface px-3 py-2 text-body-sm font-normal text-ink shadow-popover"
                >
                    {text}
                </span>
            )}
        </span>
    );
}

// Props that tie an input to its FormField error, for assistive technology.
export function fieldA11y(id: string, error: string | null | undefined) {
    return { id, "aria-invalid": Boolean(error) || undefined, "aria-describedby": error ? `${id}-error` : undefined };
}

// Label (+ required mark and optional help) above the input, the error
// message below it. The required mark sits outside <label>, so the field's
// accessible name stays exactly the label text.
export function FormField({
    id,
    label,
    required = false,
    help,
    error,
    action,
    children,
}: {
    id: string;
    label: string;
    required?: boolean;
    help?: string;
    error?: string | null;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                    <label htmlFor={id} className={fieldLabel}>{label}</label>
                    {required && <span aria-hidden="true" className="text-label-md text-critical">*</span>}
                    {help && <HelpTip label={label} text={help} />}
                </div>
                {action}
            </div>
            {children}
            {error && (
                <p id={`${id}-error`} className="text-label-sm text-critical">
                    {error}
                </p>
            )}
        </div>
    );
}
