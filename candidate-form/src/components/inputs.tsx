import { useLanguage, type Message } from "../i18n/useLanguage";
import { describedBy, Field, type FieldProps } from "./Field";

// The form's controls. Each takes its label and messages already chosen by
// the page (translated text; errors as message keys) and keeps nothing of
// its own except the help toggle: the value always comes from the page.

type Common = FieldProps & { value: string; onChange: (value: string) => void; disabled?: boolean };

const invalid = (error?: Message) => (error ? true : undefined);

export function TextInput({ id, value, onChange, disabled, maxLength, inputMode = "text", placeholder, autoCapitalize = "sentences", autoComplete = "off", ...field }: Common & {
    maxLength?: number;
    inputMode?: "text" | "tel";
    placeholder?: string;
    autoCapitalize?: "sentences" | "words" | "characters" | "off";
    autoComplete?: string;
}) {
    return (
        <Field id={id} {...field}>
            {(helpOpen) => (
                <input
                    id={id}
                    name={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    disabled={disabled}
                    inputMode={inputMode}
                    placeholder={placeholder}
                    maxLength={maxLength}
                    autoComplete={autoComplete}
                    autoCapitalize={autoCapitalize}
                    spellCheck={false}
                    required={field.required}
                    aria-invalid={invalid(field.error)}
                    aria-describedby={describedBy(id, field, helpOpen)}
                />
            )}
        </Field>
    );
}

export function TextArea({ id, value, onChange, disabled, maxLength, rows = 3, ...field }: Common & { maxLength?: number; rows?: number }) {
    return (
        <Field id={id} {...field}>
            {(helpOpen) => (
                <textarea
                    id={id}
                    name={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    disabled={disabled}
                    maxLength={maxLength}
                    rows={rows}
                    required={field.required}
                    aria-invalid={invalid(field.error)}
                    aria-describedby={describedBy(id, field, helpOpen)}
                />
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

// Yes / No as two large radio buttons in a fieldset (the question is its
// legend). "" means not answered.
export function YesNo({ id, label, value, onChange, disabled, error }: Pick<Common, "id" | "label" | "value" | "onChange" | "disabled" | "error">) {
    const { t } = useLanguage();
    return (
        <fieldset className={`field choice${error ? " field-invalid" : ""}`} aria-describedby={error ? `${id}-error` : undefined}>
            <legend>{label}</legend>
            <div className="choice-row">
                {(["yes", "no"] as const).map((choice) => (
                    <label key={choice} className="choice-option">
                        <input
                            type="radio"
                            name={id}
                            id={`${id}-${choice}`}
                            value={choice}
                            checked={value === choice}
                            onChange={() => onChange(choice)}
                            disabled={disabled}
                        />
                        <span>{t(choice === "yes" ? "option.yes" : "option.no")}</span>
                    </label>
                ))}
            </div>
            {error && <p id={`${id}-error`} className="error" role="alert"><span aria-hidden="true">! </span>{t(error.key, error.params)}</p>}
        </fieldset>
    );
}
