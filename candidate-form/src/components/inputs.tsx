import type { ChangeEvent } from "react";
import { toUpperEnglish } from "../form/uppercase";
import { useLanguage, type Message } from "../i18n/useLanguage";
import { describedBy, Field, type FieldProps } from "./Field";

// The form's controls. Each takes its label and messages already chosen by
// the page (translated text; errors as message keys) and keeps nothing of
// its own except the help toggle: the value always comes from the page.

type Common = FieldProps & { value: string; onChange: (value: string) => void; disabled?: boolean };

const invalid = (error?: Message) => (error ? true : undefined);

// With `uppercase`, English letters become capitals in the value itself as
// they are typed (Sinhala and everything else unchanged). The same-length
// text is written back into the box with the cursor where it was, so React
// sees no difference and the cursor does not jump to the end.
function readValue(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>, uppercase: boolean): string {
    const element = event.target;
    if (!uppercase) return element.value;
    const next = toUpperEnglish(element.value);
    if (next !== element.value) {
        const { selectionStart, selectionEnd } = element;
        element.value = next;
        if (selectionStart !== null && selectionEnd !== null) element.setSelectionRange(selectionStart, selectionEnd);
    }
    return next;
}

export function TextInput({ id, value, onChange, disabled, maxLength, type = "text", inputMode, placeholder, uppercase = false, autoComplete = "off", ...field }: Common & {
    maxLength?: number;
    type?: "text" | "email" | "tel";
    inputMode?: "text" | "tel" | "email";
    placeholder?: string;
    uppercase?: boolean;
    autoComplete?: string;
}) {
    return (
        <Field id={id} {...field}>
            {(helpOpen) => (
                <input
                    id={id}
                    name={id}
                    type={type}
                    value={value}
                    onChange={(event) => onChange(readValue(event, uppercase))}
                    disabled={disabled}
                    inputMode={inputMode}
                    placeholder={placeholder}
                    maxLength={maxLength}
                    autoComplete={autoComplete}
                    autoCapitalize={uppercase ? "characters" : "off"}
                    spellCheck={false}
                    required={field.required}
                    aria-invalid={invalid(field.error)}
                    aria-describedby={describedBy(id, field, helpOpen)}
                />
            )}
        </Field>
    );
}

export function TextArea({ id, value, onChange, disabled, maxLength, rows = 3, uppercase = false, ...field }: Common & { maxLength?: number; rows?: number; uppercase?: boolean }) {
    return (
        <Field id={id} {...field}>
            {(helpOpen) => (
                <textarea
                    id={id}
                    name={id}
                    value={value}
                    onChange={(event) => onChange(readValue(event, uppercase))}
                    disabled={disabled}
                    maxLength={maxLength}
                    rows={rows}
                    autoCapitalize={uppercase ? "characters" : "sentences"}
                    required={field.required}
                    aria-invalid={invalid(field.error)}
                    aria-describedby={describedBy(id, field, helpOpen)}
                />
            )}
        </Field>
    );
}

// A value the candidate can see but not change (the verified Passport and
// WhatsApp numbers): a read-only box with a "Verified" mark and a hint.
export function VerifiedValue({ id, label, value }: { id: string; label: string; value: string }) {
    const { t } = useLanguage();
    return (
        <Field id={id} label={label} hint={t("form.verifiedHint")}>
            {() => (
                <div className="verified-value">
                    <input id={id} name={id} value={value} readOnly aria-readonly="true" aria-describedby={`${id}-hint ${id}-badge`} />
                    <span id={`${id}-badge`} className="verified-badge"><span aria-hidden="true">✓ </span>{t("form.verified")}</span>
                </div>
            )}
        </Field>
    );
}

// The browser's own date picker (YYYY-MM-DD), between min and max.
export function DateInput({ id, value, onChange, disabled, min, max, ...field }: Common & { min?: string; max?: string }) {
    return (
        <Field id={id} {...field}>
            {(helpOpen) => (
                <input
                    id={id}
                    name={id}
                    type="date"
                    value={value}
                    min={min}
                    max={max}
                    onChange={(event) => onChange(event.target.value)}
                    disabled={disabled}
                    required={field.required}
                    aria-invalid={invalid(field.error)}
                    aria-describedby={describedBy(id, field, helpOpen)}
                />
            )}
        </Field>
    );
}

export type Option = { value: string; label: string };

// A list with an empty first choice ("Select…"), so nothing is picked for
// the candidate.
export function SelectInput({ id, value, onChange, disabled, options, ...field }: Common & { options: Option[] }) {
    const { t } = useLanguage();
    return (
        <Field id={id} {...field}>
            {(helpOpen) => (
                <select
                    id={id}
                    name={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    disabled={disabled}
                    required={field.required}
                    aria-invalid={invalid(field.error)}
                    aria-describedby={describedBy(id, field, helpOpen)}
                >
                    <option value="">{t("option.select")}</option>
                    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
            )}
        </Field>
    );
}

// One choice from a short list, as large tappable cards (radio buttons in a
// fieldset whose legend is the question). Arrow keys move between choices.
export function ChoiceCards({ id, label, value, onChange, options, required, help, error }: Pick<Common, "id" | "label" | "value" | "onChange" | "required" | "help" | "error"> & { options: Option[] }) {
    const { t } = useLanguage();
    return (
        <fieldset id={id} tabIndex={-1} className={`field choice${error ? " field-invalid" : ""}`} aria-describedby={[help ? `${id}-note` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined}>
            <legend>
                {label}
                {required && (
                    <>
                        <span className="required-mark" aria-hidden="true"> *</span>
                        <span className="visually-hidden"> ({t("required")})</span>
                    </>
                )}
            </legend>
            {help && <p id={`${id}-note`} className="hint">{help}</p>}
            <div className="choice-grid">
                {options.map((option) => (
                    <label key={option.value} className="choice-option">
                        <input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
                        <span>{option.label}</span>
                    </label>
                ))}
            </div>
            {error && <p id={`${id}-error`} className="error" role="alert"><span aria-hidden="true">! </span>{t(error.key, error.params)}</p>}
        </fieldset>
    );
}
