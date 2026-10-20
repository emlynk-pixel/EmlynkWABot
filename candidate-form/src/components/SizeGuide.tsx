import { useRef, useState, type ReactNode } from "react";
import { useLanguage } from "../i18n/useLanguage";

// A small "Size guide" link under a size field that opens a compact panel
// below it (inline, so it never covers the field, and fits a phone). It is a
// reference only: it never sets or changes the answer. Enter / Space toggles
// it; Escape or "Close size guide" closes it and returns to the link.
export function SizeGuide({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const toggle = useRef<HTMLButtonElement>(null);
    const close = () => {
        setOpen(false);
        toggle.current?.focus();
    };
    return (
        <div className="size-guide">
            <button ref={toggle} type="button" className="link-button size-guide-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
                {t("guide.open")}
            </button>
            {open && (
                <div
                    id={id}
                    className="size-guide-panel"
                    role="region"
                    aria-label={title}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.stopPropagation();
                            close();
                        }
                    }}
                >
                    <p className="size-guide-title">{title}</p>
                    {children}
                    <button type="button" className="link-button" onClick={close}>{t("guide.close")}</button>
                </div>
            )}
        </div>
    );
}
