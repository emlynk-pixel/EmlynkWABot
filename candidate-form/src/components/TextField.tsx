type Props = {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    hint?: string;
    error?: string;
    disabled?: boolean;
    inputMode?: "text" | "tel";
    placeholder?: string;
    maxLength?: number;
};

export function TextField({ id, label, value, onChange, hint, error, disabled, inputMode = "text", placeholder, maxLength }: Props) {
    const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            {hint && <p id={`${id}-hint`} className="hint">{hint}</p>}
            <input
                id={id}
                name={id}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                disabled={disabled}
                inputMode={inputMode}
                placeholder={placeholder}
                maxLength={maxLength}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy}
            />
            {error && <p id={`${id}-error`} className="error" role="alert">{error}</p>}
        </div>
    );
}
