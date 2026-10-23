import { TRANSLATIONS, type Language, type MessageKey } from "../../i18n/translations";
import { useLanguage } from "../../i18n/useLanguage";
import type { FormLoadResponse } from "../../types/api";
import { showsOtherJobCategory, showsSpouse, type CandidateFormData } from "../model";
import { jobCategoryLabel } from "../options";
import { SECTIONS, type SectionId } from "../steps";
import { valueAt } from "../validation";

// What the candidate entered, by section, before saving. Only the
// candidate's own answers and their verified identity (from the record) are
// shown: never the token or anything staff-only.

// kind "jobCategory": a job type name or code, shown with jobCategoryLabel.
type Row = { label: MessageKey; path: string; kind?: "date" | "code" | "jobCategory"; codePrefix?: string };

function rowsFor(section: SectionId, data: CandidateFormData): Row[] {
    switch (section) {
        case "basic":
            return [
                { label: "f.fullName", path: "basic.fullName" },
                { label: "f.surname", path: "basic.surname" },
                { label: "f.otherNames", path: "basic.otherNames" },
                { label: "f.sex", path: "basic.sex", kind: "code", codePrefix: "sex." },
                { label: "f.civilStatus", path: "basic.civilStatus", kind: "code", codePrefix: "civil." },
                { label: "f.birthDate", path: "basic.birthDate", kind: "date" },
                { label: "f.birthPlace", path: "basic.birthPlace" },
            ];
        case "contact":
            return [
                { label: "f.address", path: "contact.address" },
                { label: "f.city", path: "contact.city" },
                { label: "f.district", path: "contact.district" },
                { label: "f.dsDivision", path: "contact.dsDivision" },
                { label: "f.gnDivision", path: "contact.gnDivision" },
                { label: "f.alternativePhone", path: "contact.alternativePhone" },
                { label: "f.email", path: "contact.email" },
            ];
        case "passport":
            return [
                { label: "f.passportIssueDate", path: "passport.issueDate", kind: "date" },
                { label: "f.passportExpiryDate", path: "passport.expiryDate", kind: "date" },
                { label: "f.jobCategory", path: "qualifications.jobCategory", kind: "jobCategory" },
                ...(showsOtherJobCategory(data) ? [{ label: "f.jobCategoryOther" as const, path: "qualifications.jobCategoryOther" }] : []),
                { label: "f.experience", path: "qualifications.experience" },
                { label: "f.otherSkills1", path: "qualifications.otherSkills1" },
                { label: "f.otherSkills2", path: "qualifications.otherSkills2" },
                { label: "f.englishKnowledge", path: "qualifications.englishKnowledge", kind: "code", codePrefix: "english." },
            ];
        case "measurements":
            return [
                { label: "f.shirtSize", path: "measurements.shirtSize" },
                { label: "f.waistSize", path: "measurements.waistSize" },
                { label: "f.shoeSize", path: "measurements.shoeSize" },
            ];
        case "family": {
            const person = (who: "father" | "mother" | "spouse"): Row[] => [
                { label: `f.${who}Name`, path: `family.${who}.name` },
                { label: `f.${who}Surname`, path: `family.${who}.surname` },
                { label: `f.${who}Passport`, path: `family.${who}.passportNumber` },
                { label: `f.${who}BirthDate`, path: `family.${who}.birthDate`, kind: "date" },
            ];
            return [
                ...person("father"),
                ...person("mother"),
                ...(showsSpouse(data) ? person("spouse") : []),
                { label: "f.child1", path: "family.child1" },
                { label: "f.child2", path: "family.child2" },
                { label: "f.child3", path: "family.child3" },
            ];
        }
        case "guardian":
            return [
                { label: "f.guardianName", path: "guardian.name" },
                { label: "f.guardianRelationship", path: "guardian.relationship" },
                { label: "f.guardianNic", path: "guardian.nic" },
                { label: "f.guardianBirthDate", path: "guardian.birthDate", kind: "date" },
                { label: "f.guardianPhone", path: "guardian.phone" },
                { label: "f.guardianAddress", path: "guardian.address" },
            ];
        default:
            return [];
    }
}

// English: "1 May 1990". Sinhala: "1990-05-01" (the browser's Sinhala month
// names can be the traditional ones, e.g. Vesak for May, which a candidate
// could misread; the numbers are unambiguous).
export function formatDate(value: string, language: Language): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || language === "si") return value;
    return date.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}

export function ReviewStep({ data, identity, onEdit }: { data: CandidateFormData; identity: FormLoadResponse["identity"]; onEdit: (section: SectionId) => void }) {
    const { t, language } = useLanguage();
    const display = (row: Row) => {
        const value = valueAt(data, row.path).trim();
        if (!value) return <span className="review-empty">{t("review.empty")}</span>;
        if (row.kind === "date") return formatDate(value, language);
        if (row.kind === "code") return t(`${row.codePrefix}${value}` as MessageKey);
        if (row.kind === "jobCategory") return jobCategoryLabel(value, TRANSLATIONS[language]);
        return value;
    };
    return (
        <div className="review">
            <section className="review-card" aria-labelledby="review-identity">
                <h3 id="review-identity">{t("review.verifiedIdentity")}</h3>
                <dl>
                    <div><dt>{t("f.passportNumber")}</dt><dd>{identity.passportNumber}</dd></div>
                    <div><dt>{t("f.nic")}</dt><dd>{identity.nic}</dd></div>
                    <div><dt>{t("f.whatsapp")}</dt><dd>{identity.whatsappNumber || "—"}</dd></div>
                </dl>
            </section>
            {SECTIONS.map((step) => (
                <section key={step.id} className="review-card" aria-labelledby={`review-${step.id}`}>
                    <div className="review-card-head">
                        <h3 id={`review-${step.id}`}>{t(step.title)}</h3>
                        <button type="button" className="link-button" aria-label={t("review.editSection", { section: t(step.title) })} onClick={() => onEdit(step.id)}>
                            {t("review.edit")}
                        </button>
                    </div>
                    <dl>
                        {rowsFor(step.id, data).map((row) => (
                            <div key={row.path}>
                                <dt>{t(row.label)}</dt>
                                <dd>{display(row)}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
            ))}
        </div>
    );
}
