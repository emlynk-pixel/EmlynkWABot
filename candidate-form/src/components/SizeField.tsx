import { useLanguage, type Message } from "../i18n/useLanguage";
import { SelectInput, TextInput } from "./inputs";

const OTHER = "__other";

// A pant or shoe size: one of the listed sizes, or "Other" and a short size
// of the candidate's own (e.g. "31", "9.5", "EU 43"). `other` is whether
// "Other" is chosen; the size itself is always `value`.
export function SizeField({ id, label, otherLabel, help, presets, value, other, onChange, onOtherChange, error, disabled }: {
    id: string;
    label: string;
    otherLabel: string;
    help: string;
    presets: readonly string[];
    value: string;
    other: boolean;
    onChange: (value: string) => void;
    onOtherChange: (other: boolean) => void;
    error?: Message;
    disabled?: boolean;
}) {
    const { t } = useLanguage();
    const custom = other || (value !== "" && !presets.includes(value));
    return (
        <div className="size-field">
            <SelectInput
                id={id}
                label={label}
                help={help}
                value={custom ? OTHER : value}
                onChange={(choice) => {
                    if (choice === OTHER) {
                        onOtherChange(true);
                        onChange("");
                    } else {
                        onOtherChange(false);
                        onChange(choice);
                    }
                }}
                options={[...presets.map((size) => ({ value: size, label: size })), { value: OTHER, label: t("option.other") }]}
                error={custom ? undefined : error}
                disabled={disabled}
            />
            {custom && (
                <TextInput id={`${id}Other`} label={otherLabel} value={value} onChange={onChange} error={error} disabled={disabled} maxLength={10} uppercase />
            )}
        </div>
    );
}
