import { DateInput, SelectInput, TextInput, VerifiedValue } from "../../components/inputs";
import { FormSection } from "../../components/FormSection";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { formatCm, formatKg, isBareNumber, isGrams, MAX_MEASUREMENT_LENGTH, parseHeight, parseWeight } from "../measurements";
import { BLOOD_GROUPS, CIVIL_STATUS_OPTIONS, SEX_OPTIONS, YES_NO } from "../options";
import { EARLIEST_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

// Basic & Identification Information. (The register number is staff-only and
// is not part of this form.) Then the physical details and skills: Blood
// Group, Height and Weight (a number alone is cm / kg; the unit is shown in the
// box and any other unit is shown converted under it), and three Yes / No
// answers. All required; only Other Languages takes "N/A".
export function BasicStep(props: StepProps & { nic: string }) {
    const { t } = useLanguage();
    const today = todayInSriLanka();
    const { height, weight } = props.data.basic;
    const parsedHeight = parseHeight(height);
    const parsedWeight = parseWeight(weight);
    const yesNo = YES_NO.map((code) => ({ value: code, label: t(`yesNo.${code}`) }));
    return (
        <>
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
            <FormSection title={t("section.physical")}>
                <div className="field-grid">
                    <SelectInput {...bind(props, "basic.bloodGroup")} label={t("f.bloodGroup")} placeholder={t("option.selectBloodGroup")} options={BLOOD_GROUPS.map((group) => ({ value: group, label: group }))} />
                    <TextInput
                        {...bind(props, "basic.height")}
                        label={t("f.height")}
                        help={t("help.height")}
                        placeholder={t("placeholder.height")}
                        maxLength={MAX_MEASUREMENT_LENGTH}
                        suffix={isBareNumber(height) || !height.trim() ? "cm" : ""}
                        note={parsedHeight && parsedHeight.unit !== "cm" ? t("note.heightCm", { cm: formatCm(parsedHeight.cm) }) : undefined}
                    />
                    <TextInput
                        {...bind(props, "basic.weight")}
                        label={t("f.weight")}
                        help={t("help.weight")}
                        placeholder={t("placeholder.weight")}
                        inputMode="decimal"
                        maxLength={MAX_MEASUREMENT_LENGTH}
                        suffix={isBareNumber(weight) || !weight.trim() ? "kg" : ""}
                        note={parsedWeight !== null && isGrams(weight) ? t("note.weightKg", { kg: formatKg(parsedWeight) }) : undefined}
                    />
                    <SelectInput {...bind(props, "basic.drivingLicence")} label={t("f.drivingLicence")} options={yesNo} />
                    <SelectInput {...bind(props, "basic.canReadDrawings")} label={t("f.canReadDrawings")} options={yesNo} />
                    <SelectInput {...bind(props, "basic.teamLeadingSkills")} label={t("f.teamLeadingSkills")} options={yesNo} />
                    <div className="span-2">
                        <TextInput {...bind(props, "basic.otherLanguages")} label={t("f.otherLanguages")} hint={t("hint.na")} placeholder={t("placeholder.otherLanguages")} uppercase maxLength={MAX_LENGTH.text} />
                    </div>
                </div>
            </FormSection>
        </>
    );
}
