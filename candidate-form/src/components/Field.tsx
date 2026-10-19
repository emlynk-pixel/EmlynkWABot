import { useState, type ReactNode } from "react";
import { useLanguage, type Message } from "../i18n/useLanguage";
import { FieldHelp } from "./FieldHelp";

export type FieldProps = {
    id: string;
    label: string;
    required?: boolean;
    // A tip behind the "i" button (shown on demand).
    help?: string;
    // A short line always shown under the label.
    hint?: string;
    error?: Message;
    // Filled in from the candidate's existing record (a small note says so).
    prefilled?: boolean;
};

// The ids a control should list in aria-describedby.
export function describedBy(id: string, { hint, error, prefilled }: Pick<FieldProps, "hint" | "error" | "prefilled">, helpOpen: boolean): string | undefined {
    return [hint ? `${id}-hint` : null, prefilled ? `${id}-prefilled` : null, helpOpen ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

// Label (with the required marker and the optional help button), hint, the
// control itself, and the error. The error is text with a mark, never colour
// alone, and is announced when it appears.
export function Field({ id, label, required, help, hint, error, prefilled, children }: FieldProps & { children: (helpOpen: boolean) => ReactNode }) {
    const { t } = useLanguage();
    const [helpOpen, setHelpOpen] = useState(false);
    return (
        <div className={`field${error ? " field-invalid" : ""}`}>
            <div className="label-row">
                <label htmlFor={id}>
                    {label}
                    {required && (
                        <>
                            <span className="required-mark" aria-hidden="true"> *</span>
                            <span className="visually-hidden"> ({t("required")})</span>
                        </>
                    )}
                </label>
                {help && <FieldHelp id={`${id}-help`} label={label} text={help} open={helpOpen} onToggle={() => setHelpOpen((open) => !open)} />}
            </div>
            {hint && <p id={`${id}-hint`} className="hint">{hint}</p>}
            {prefilled && <p id={`${id}-prefilled`} className="prefilled-note">{t("form.prefilledNote")}</p>}
            {children(helpOpen)}
            {error && (
                <p id={`${id}-error`} className="error" role="alert">
                    <span aria-hidden="true">! </span>
                    {t(error.key, error.params)}
                </p>
            )}
        </div>
    );
}
