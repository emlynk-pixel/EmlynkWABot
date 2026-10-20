import { ChoiceCards, DateInput, SelectInput, TextArea, TextInput, VerifiedValue } from "../../components/inputs";
import { FormSection } from "../../components/FormSection";
import type { MessageKey } from "../../i18n/translations";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { showsOtherJobCategory } from "../model";
import { ENGLISH_LEVELS, useJobCategories } from "../options";
import { EARLIEST_DATE, LATEST_EXPIRY_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

// Passport & Qualifications. The passport number is the verified one, shown
// read-only. Job categories come from useJobCategories (a local list today,
// the API later); "OTHER" opens a free-text category of the candidate's own.
export function PassportStep(props: StepProps & { passportNumber: string }) {
    const { t } = useLanguage();
    const today = todayInSriLanka();
    const categories = useJobCategories();
    const codes = categories.status === "ready" ? categories.codes : [];
    return (
        <>
            <div className="field-grid">
                <div className="span-2">
                    <VerifiedValue id="passport-number" label={t("f.passportNumber")} value={props.passportNumber} />
                </div>
                <DateInput {...bind(props, "passport.issueDate")} label={t("f.passportIssueDate")} min={EARLIEST_DATE} max={today} />
                <DateInput {...bind(props, "passport.expiryDate")} label={t("f.passportExpiryDate")} min={EARLIEST_DATE} max={LATEST_EXPIRY_DATE} />
            </div>
            <FormSection title={t("section.work")}>
                <div className="field-grid">
                    <SelectInput
                        {...bind(props, "qualifications.jobCategory")}
                        label={t("f.jobCategory")}
                        help={t("help.jobCategory")}
                        options={codes.map((code) => ({ value: code, label: t(`job.${code}` as MessageKey) }))}
                    />
                    {showsOtherJobCategory(props.data) && (
                        <TextInput {...bind(props, "qualifications.jobCategoryOther")} label={t("f.jobCategoryOther")} uppercase maxLength={MAX_LENGTH.text} />
                    )}
                    <div className="span-2">
                        <TextArea {...bind(props, "qualifications.experience")} label={t("f.experience")} hint={t("hint.na")} uppercase maxLength={MAX_LENGTH.long} rows={3} />
                    </div>
                    <TextInput {...bind(props, "qualifications.otherSkills1")} label={t("f.otherSkills1")} hint={t("hint.na")} uppercase maxLength={MAX_LENGTH.text} />
                    <TextInput {...bind(props, "qualifications.otherSkills2")} label={t("f.otherSkills2")} hint={t("hint.na")} uppercase maxLength={MAX_LENGTH.text} />
                </div>
                <ChoiceCards
                    {...bind(props, "qualifications.englishKnowledge")}
                    label={t("f.englishKnowledge")}
                    help={t("help.englishKnowledge")}
                    options={ENGLISH_LEVELS.map((code) => ({ value: code, label: t(`english.${code}`) }))}
                />
            </FormSection>
        </>
    );
}
