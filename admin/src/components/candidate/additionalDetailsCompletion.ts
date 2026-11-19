import type { AdditionalDetails } from "../../api/candidates";

// When the candidate page's "Additional details" step counts as completed: every field the form
// shows is filled (AdditionalDetailsPanel.tsx), not merely that a details row exists. A sheet
// import creates the row as soon as one mapped column has a value (City, Blood Group, ...), and a
// save with a single field does too; neither completes the step.

type Key = keyof AdditionalDetails;

// Always shown on the form, so always required.
const REQUIRED_FIELDS: readonly Key[] = [
    // Passport & personal details
    "nameAsInPassport", "permanentAddress", "birthday",
    // Physical details & skills
    "bloodGroup", "height", "weightKg", "drivingLicence", "canReadDrawings", "teamLeadingSkills", "otherLanguages", "englishKnowledge",
    // Contact & location
    "email", "city", "district", "dsDivision", "gnDivision", "cityInRomania",
    // Clothing & sizes
    "tshirtSize", "pantSize", "shoeSize",
    // Father / mother (the rest of each section is required only when that parent is alive)
    "fatherAlive", "motherAlive",
    // Marital & family details
    "maritalStatus",
    // Employment / skills
    "otherJobSkills", "otherJobSkills2", "otherJobCategory",
    // Guardian details
    "guardianName", "guardianRelationship", "guardianNic", "guardianBirthday", "guardianPhone", "guardianAddress",
];
// Required only when that parent is alive.
const FATHER_FIELDS: readonly Key[] = ["fatherFullName", "fatherBirthday", "fatherPassportNumber"];
const MOTHER_FIELDS: readonly Key[] = ["motherFullName", "motherBirthday", "motherPassportNumber"];
// Shown, and required, only when married.
const SPOUSE_FIELDS: readonly Key[] = ["wifeFullName", "wifeBirthday", "spousePassportNumber"];
// Never required: the child names (a candidate may have none).

// A Yes / No answer counts whichever it is (false is an answer); text must not be blank.
const filled = (value: unknown) => typeof value === "boolean" || (typeof value === "string" && value.trim() !== "");

export function additionalDetailsComplete(details: AdditionalDetails | null | undefined): boolean {
    if (!details) return false;
    const required = [
        ...REQUIRED_FIELDS,
        ...(details.fatherAlive === true ? FATHER_FIELDS : []),
        ...(details.motherAlive === true ? MOTHER_FIELDS : []),
        ...(details.maritalStatus === "MARRIED" ? SPOUSE_FIELDS : []),
    ];
    return required.every((key) => filled(details[key]));
}
