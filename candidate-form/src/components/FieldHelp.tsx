import { useLanguage } from "../i18n/useLanguage";

// A small "i" button beside a label that shows or hides a short tip. Tap or
// click (and Enter / Space from the keyboard) toggles it; the tip is linked
// to the field (aria-describedby) while it is shown.
export function FieldHelp({ id, label, text, open, onToggle }: { id: string; label: string; text: string; open: boolean; onToggle: () => void }) {
    const { t } = useLanguage();
    return (
        <>
            <button
                type="button"
                className="help-toggle"
                aria-expanded={open}
                aria-controls={id}
                aria-label={t("help.button", { field: label })}
                onClick={onToggle}
            >
                <span aria-hidden="true">i</span>
            </button>
            {open && <p id={id} className="help-text">{text}</p>}
        </>
    );
}
