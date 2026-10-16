import { DateInput, TextInput } from "../../components/inputs";
import { FormSection } from "../../components/FormSection";
import type { MessageKey } from "../../i18n/translations";
import { useLanguage } from "../../i18n/useLanguage";
import { bind, type StepProps } from "../binding";
import { showsSpouse } from "../model";
import { EARLIEST_DATE, MAX_LENGTH, todayInSriLanka } from "../validation";

type Who = "father" | "mother" | "spouse";

// Family Background: father, mother, spouse (only when Civil Status is
// Married; entries typed before are kept while hidden, never sent), and up to
// three children (optional).
export function FamilyStep(props: StepProps) {
    const { t } = useLanguage();
    const today = todayInSriLanka();
    const person = (who: Who) => {
        const label = (field: "Name" | "Surname" | "Passport" | "BirthDate") => t(`f.${who}${field}` as MessageKey);
        return (
            <FormSection title={t(`family.${who}`)}>
                <div className="field-grid">
                    <TextInput {...bind(props, `family.${who}.name`)} label={label("Name")} uppercase maxLength={MAX_LENGTH.text} />
                    <TextInput {...bind(props, `family.${who}.surname`)} label={label("Surname")} uppercase maxLength={MAX_LENGTH.text} />
                    <TextInput {...bind(props, `family.${who}.passportNumber`)} label={label("Passport")} uppercase maxLength={30} />
                    <DateInput {...bind(props, `family.${who}.birthDate`)} label={label("BirthDate")} min={EARLIEST_DATE} max={today} />
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
                        <TextInput key={child} {...bind(props, `family.${child}`)} label={t(`f.${child}`)} uppercase maxLength={MAX_LENGTH.text} />
                    ))}
                </div>
            </FormSection>
        </>
    );
}
