import { DateInput, SelectInput, TextInput } from "../../components/inputs";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { CIVIL_STATUS_OPTIONS, SEX_OPTIONS } from "../options";
import { EARLIEST_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

// Basic & Identification Information. (The register number is staff-only and
// is not part of this form.)
export function BasicStep(props: StepProps) {
    const { t } = useLanguage();
    const today = todayInSriLanka();
    return (
        <div className="field-grid">
            <TextInput {...bind(props, "basic.fullName")} label={t("f.fullName")} help={t("help.fullName")} required uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "basic.surname")} label={t("f.surname")} required uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "basic.otherNames")} label={t("f.otherNames")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "basic.nic")} label={t("f.nic")} hint={t("hint.nic")} required uppercase maxLength={20} />
            <SelectInput {...bind(props, "basic.sex")} label={t("f.sex")} required options={SEX_OPTIONS.map((code) => ({ value: code, label: t(`sex.${code}`) }))} />
            <SelectInput {...bind(props, "basic.civilStatus")} label={t("f.civilStatus")} required options={CIVIL_STATUS_OPTIONS.map((code) => ({ value: code, label: t(`civil.${code}`) }))} />
            <DateInput {...bind(props, "basic.birthDate")} label={t("f.birthDate")} required min={EARLIEST_DATE} max={today} />
            <TextInput {...bind(props, "basic.birthPlace")} label={t("f.birthPlace")} uppercase maxLength={MAX_LENGTH.text} />
        </div>
    );
}
