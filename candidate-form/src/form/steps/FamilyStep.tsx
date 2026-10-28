import { DateInput, SelectInput, TextInput } from "../../components/inputs";
import { FormSection } from "../../components/FormSection";
import type { MessageKey } from "../../i18n/translations";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { showsSpouse } from "../model";
import { YES_NO } from "../options";
import { EARLIEST_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

type Who = "father" | "mother" | "spouse";

// Family Background: father, mother, spouse (only when Civil Status is
// Married; entries typed before are kept while hidden, never sent), and up to
// three children. Every shown answer is required (validation.ts requiredPaths):
// "N/A" as a parent's name when that parent does not apply (their other
// answers are then not needed), "N/A" as Child 1 for no children. Each parent
// also has a required Yes / No "Father / Mother Alive" (never "N/A").
export function FamilyStep(props: StepProps) {
    const { t } = useLanguage();
    const today = todayInSriLanka();
    const person = (who: Who) => {
        const label = (field: "Name" | "Surname" | "Passport" | "BirthDate") => t(`f.${who}${field}` as MessageKey);
        const parent = who !== "spouse";
        return (
            <FormSection title={t(`family.${who}`)}>
                <div className="field-grid">
                    <TextInput {...bind(props, `family.${who}.name`)} label={label("Name")} hint={parent ? t("hint.parentNa") : undefined} uppercase maxLength={MAX_LENGTH.text} />
                    <TextInput {...bind(props, `family.${who}.surname`)} label={label("Surname")} hint={parent ? t("hint.na") : undefined} uppercase maxLength={MAX_LENGTH.text} />
                    <TextInput {...bind(props, `family.${who}.passportNumber`)} label={label("Passport")} hint={t("hint.na")} uppercase maxLength={30} />
                    <DateInput {...bind(props, `family.${who}.birthDate`)} label={label("BirthDate")} min={EARLIEST_DATE} max={today} />
                    {parent && (
                        <SelectInput {...bind(props, `family.${who}Alive`)} label={t(`f.${who}Alive` as MessageKey)} options={YES_NO.map((code) => ({ value: code, label: t(`yesNo.${code}`) }))} />
                    )}
                </div>
            </FormSection>
        );
    };
    return (
        <>
            <p className="important-note"><span className="badge">{t("form.important")}</span> {t("family.importantNote")}</p>
            {person("father")}
            {person("mother")}
            {showsSpouse(props.data) && person("spouse")}
            <FormSection title={t("family.children")} note={t("family.childrenNote")}>
                <div className="field-grid">
                    {(["child1", "child2", "child3"] as const).map((child) => (
                        <TextInput key={child} {...bind(props, `family.${child}`)} label={t(`f.${child}`)} hint={child === "child1" ? t("hint.childNa") : t("hint.na")} uppercase maxLength={MAX_LENGTH.text} />
                    ))}
                </div>
            </FormSection>
        </>
    );
}
