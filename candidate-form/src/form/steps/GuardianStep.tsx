import { DateInput, TextArea, TextInput } from "../../components/inputs";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { EARLIEST_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

// Guardian Details: every answer is required; none takes "N/A" (a guardian is a real person).
export function GuardianStep(props: StepProps) {
    const { t } = useLanguage();
    return (
        <div className="field-grid">
            <TextInput {...bind(props, "guardian.name")} label={t("f.guardianName")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "guardian.relationship")} label={t("f.guardianRelationship")} help={t("help.guardianRelationship")} uppercase maxLength={MAX_LENGTH.text} />
            <TextInput {...bind(props, "guardian.nic")} label={t("f.guardianNic")} hint={t("hint.nic")} uppercase maxLength={20} />
            <DateInput {...bind(props, "guardian.birthDate")} label={t("f.guardianBirthDate")} min={EARLIEST_DATE} max={todayInSriLanka()} />
            <TextInput {...bind(props, "guardian.phone")} label={t("f.guardianPhone")} hint={t("hint.phone")} type="tel" inputMode="tel" maxLength={20} />
            <div className="span-2">
                <TextArea {...bind(props, "guardian.address")} label={t("f.guardianAddress")} uppercase maxLength={MAX_LENGTH.address} rows={2} />
            </div>
        </div>
    );
}
