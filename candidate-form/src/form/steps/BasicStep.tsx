import { DateInput, SelectInput, TextInput, VerifiedValue } from "../../components/inputs";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { CIVIL_STATUS_OPTIONS, SEX_OPTIONS } from "../options";
import { EARLIEST_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

// Basic & Identification Information. (The register number is staff-only and
// is not part of this form.)
export function BasicStep(props: StepProps & { nic: string }) {
    const { t } = useLanguage();
    const today = todayInSriLanka();
    return (
        <div className="field-grid">
            <TextInput {...bind(props, "basic.fullName")} label={t("f.fullName")} help={t("help.fullName")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "basic.surname")} label={t("f.surname")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "basic.otherNames")} label={t("f.otherNames")} hint={t("hint.na")} uppercase maxLength={MAX_LENGTH.text} />
            <VerifiedValue id="basic-nic" label={t("f.nic")} value={props.nic} />
            <SelectInput {...bind(props, "basic.sex")} label={t("f.sex")} options={SEX_OPTIONS.map((code) => ({ value: code, label: t(`sex.${code}`) }))} />
            <SelectInput {...bind(props, "basic.civilStatus")} label={t("f.civilStatus")} options={CIVIL_STATUS_OPTIONS.map((code) => ({ value: code, label: t(`civil.${code}`) }))} />
            <DateInput {...bind(props, "basic.birthDate")} label={t("f.birthDate")} min={EARLIEST_DATE} max={today} />
            <TextInput {...bind(props, "basic.birthPlace")} label={t("f.birthPlace")} uppercase maxLength={MAX_LENGTH.text} />
        </div>
    );
}
