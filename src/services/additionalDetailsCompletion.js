// When a candidate's Additional details count as collected: every field the Additional Details form
// shows is filled, not merely that a details row exists (a sheet import creates the row as soon as one
// mapped column has a value). The backend port of admin/src/components/candidate/additionalDetailsCompletion.ts;
// test/additionalDetailsCompletion.test.js keeps the two in step. This one reads the Prisma row (Date
// for dates, Decimal for the weight), the frontend reads the API's serialized copy of the same row.

// Always shown on the form, so always required.
const REQUIRED_FIELDS = Object.freeze([
    "nameAsInPassport", "permanentAddress", "birthday",
    "bloodGroup", "height", "weightKg", "drivingLicence", "canReadDrawings", "teamLeadingSkills", "otherLanguages", "englishKnowledge",
    "email", "city", "district", "dsDivision", "gnDivision", "cityInRomania",
    "tshirtSize", "pantSize", "shoeSize",
    "fatherAlive", "motherAlive",
    "maritalStatus",
    "otherJobSkills", "otherJobSkills2", "otherJobCategory",
    "guardianName", "guardianRelationship", "guardianNic", "guardianBirthday", "guardianPhone", "guardianAddress",
]);
// Required only when that parent is alive.
const FATHER_FIELDS = Object.freeze(["fatherFullName", "fatherBirthday", "fatherPassportNumber"]);
const MOTHER_FIELDS = Object.freeze(["motherFullName", "motherBirthday", "motherPassportNumber"]);
// Required only when married. The child names are never required.
const SPOUSE_FIELDS = Object.freeze(["wifeFullName", "wifeBirthday", "spousePassportNumber"]);

// Every column the rule reads, as a Prisma select (WORKFLOW_STATUS_SELECT loads it for the Status).
export const ADDITIONAL_DETAILS_COMPLETION_SELECT = Object.freeze(
    Object.fromEntries([...REQUIRED_FIELDS, ...FATHER_FIELDS, ...MOTHER_FIELDS, ...SPOUSE_FIELDS].map((field) => [field, true])),
);

// A Yes / No answer counts whichever it is (false is an answer); text must not be blank; a date or a
// Decimal weight counts when present (the API sends them as non-empty strings).
function filled(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    return true;
}

export function additionalDetailsComplete(details) {
    if (!details) return false;
    const required = [
        ...REQUIRED_FIELDS,
        ...(details.fatherAlive === true ? FATHER_FIELDS : []),
        ...(details.motherAlive === true ? MOTHER_FIELDS : []),
        ...(details.maritalStatus === "MARRIED" ? SPOUSE_FIELDS : []),
    ];
    return required.every((field) => filled(details[field]));
}
