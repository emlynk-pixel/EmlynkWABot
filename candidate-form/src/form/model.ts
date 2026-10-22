import { OTHER_JOB_CATEGORY } from "./options";
import type { CandidateFormPayload } from "../types/api";

// The Candidate Form's data, grouped as the form is. Every value is a string
// as the form holds it ("" = not answered); choice fields hold their English
// code (options.ts). Nothing here is staff-only: no register number, stages,
// allocation, jobs or documents.
//
// The verified Passport Number, NIC and WhatsApp Number are NOT part of this
// data: they are the candidate's identity from the server (POST /form), are
// shown read-only, and are never sent with the answers; the server knows the
// candidate from the token.

export type BasicInfo = {
    fullName: string;
    surname: string;
    otherNames: string;
    sex: string;
    civilStatus: string;
    birthDate: string;
    birthPlace: string;
};

export type ContactInfo = {
    address: string;
    city: string;
    district: string;
    dsDivision: string;
    gnDivision: string;
    alternativePhone: string;
    email: string;
};

export type PassportInfo = {
    issueDate: string;
    expiryDate: string;
};

export type Qualifications = {
    jobCategory: string;
    jobCategoryOther: string;
    experience: string;
    otherSkills1: string;
    otherSkills2: string;
    englishKnowledge: string;
};

export type Measurements = {
    shirtSize: string;
    waistSize: string;
    shoeSize: string;
};

export type Person = {
    name: string;
    surname: string;
    passportNumber: string;
    birthDate: string;
};

export type Family = {
    father: Person;
    mother: Person;
    spouse: Person;
    child1: string;
    child2: string;
    child3: string;
};

export type Guardian = {
    name: string;
    relationship: string;
    nic: string;
    birthDate: string;
    phone: string;
    address: string;
};

export type CandidateFormData = {
    basic: BasicInfo;
    contact: ContactInfo;
    passport: PassportInfo;
    qualifications: Qualifications;
    measurements: Measurements;
    family: Family;
    guardian: Guardian;
};

export type FormGroup = keyof CandidateFormData;

const emptyPerson = (): Person => ({ name: "", surname: "", passportNumber: "", birthDate: "" });

export const emptyForm = (): CandidateFormData => ({
    basic: { fullName: "", surname: "", otherNames: "", sex: "", civilStatus: "", birthDate: "", birthPlace: "" },
    contact: { address: "", city: "", district: "", dsDivision: "", gnDivision: "", alternativePhone: "", email: "" },
    passport: { issueDate: "", expiryDate: "" },
    qualifications: { jobCategory: "", jobCategoryOther: "", experience: "", otherSkills1: "", otherSkills2: "", englishKnowledge: "" },
    measurements: { shirtSize: "", waistSize: "", shoeSize: "" },
    family: { father: emptyPerson(), mother: emptyPerson(), spouse: emptyPerson(), child1: "", child2: "", child3: "" },
    guardian: { name: "", relationship: "", nic: "", birthDate: "", phone: "", address: "" },
});

// "N/A" is an answer of its own for the fields that allow it (NOT_APPLICABLE_FIELDS); any letter
// case and with or without the slash (n/a, N/A, NA, na, Na) counts there, and it is sent as "N/A".
// Everywhere else only the slash form counts as N/A (and is refused), so a real answer that reads
// "Na" is not mistaken for it. The server keeps the same list and rules
// (candidateFormDataService.js NOT_APPLICABLE_FIELDS, isNotApplicableFor).
export const NOT_APPLICABLE = "N/A";
export const NOT_APPLICABLE_FIELDS: ReadonlySet<string> = new Set([
    "basic.otherNames",
    "contact.city",
    "contact.alternativePhone",
    "qualifications.experience",
    "qualifications.otherSkills1",
    "qualifications.otherSkills2",
    // A parent who does not apply (unknown, not in the candidate's life): "N/A" as the name;
    // then that parent's other answers are not needed. A parent may have no passport.
    "family.father.name",
    "family.father.surname",
    "family.father.passportNumber",
    "family.mother.name",
    "family.mother.surname",
    "family.mother.passportNumber",
    // A married candidate's spouse exists: only the passport may be "N/A".
    "family.spouse.passportNumber",
    "family.child1",
    "family.child2",
    "family.child3",
]);
// The slash form, in any letter case.
export const isNotApplicable = (value: string) => /^n\/a$/i.test(value.trim());
// Whether `value` is an N/A answer for the field at `path`.
export const isNotApplicableFor = (path: string, value: string) => (NOT_APPLICABLE_FIELDS.has(path) ? /^n\/?a$/i : /^n\/a$/i).test(value.trim());
// A trimmed answer, "N/A" in one spelling, or null when blank.
const answer = (path: string, value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return isNotApplicableFor(path, trimmed) ? NOT_APPLICABLE : trimmed;
};

// Spouse details only go with Married.
export const showsSpouse = (data: CandidateFormData) => data.basic.civilStatus === "MARRIED";
// "Other Job Category" only goes with OTHER.
export const showsOtherJobCategory = (data: CandidateFormData) => data.qualifications.jobCategory === OTHER_JOB_CATEGORY;

// The prefill from the server (null = empty) as form values.
export function fromPayload(payload: CandidateFormPayload): CandidateFormData {
    const empty = emptyForm();
    const fill = <T extends Record<string, string>>(base: T, values: Partial<Record<keyof T, string | null>> | undefined): T =>
        Object.fromEntries(Object.keys(base).map((key) => [key, values?.[key as keyof T] ?? ""])) as T;
    return {
        basic: fill(empty.basic, payload.basic),
        contact: fill(empty.contact, payload.contact),
        passport: fill(empty.passport, payload.passport),
        qualifications: fill(empty.qualifications, payload.qualifications),
        measurements: fill(empty.measurements, payload.measurements),
        family: {
            father: fill(empty.family.father, payload.family?.father),
            mother: fill(empty.family.mother, payload.family?.mother),
            spouse: fill(empty.family.spouse, payload.family?.spouse),
            child1: payload.family?.child1 ?? "",
            child2: payload.family?.child2 ?? "",
            child3: payload.family?.child3 ?? "",
        },
        guardian: fill(empty.guardian, payload.guardian),
    };
}

// What is sent on submit (POST /submit). Blanks become null; "n/a" becomes "N/A".
// Hidden entries are kept in the form (switching Civil Status back shows the
// spouse again) but are never sent: no spouse unless Married, no "Other Job
// Category" unless OTHER is chosen.
export function toPayload(data: CandidateFormData): CandidateFormPayload {
    const clean = <T extends Record<string, string>>(prefix: string, group: T) =>
        Object.fromEntries(Object.entries(group).map(([key, value]) => [key, answer(`${prefix}.${key}`, value)])) as { [K in keyof T]: string | null };
    const person = (who: "father" | "mother" | "spouse") => clean(`family.${who}`, data.family[who]);
    const nobody = { name: null, surname: null, passportNumber: null, birthDate: null };
    return {
        basic: clean("basic", data.basic),
        contact: clean("contact", data.contact),
        passport: clean("passport", data.passport),
        qualifications: { ...clean("qualifications", data.qualifications), jobCategoryOther: showsOtherJobCategory(data) ? answer("qualifications.jobCategoryOther", data.qualifications.jobCategoryOther) : null },
        measurements: clean("measurements", data.measurements),
        family: {
            father: person("father"),
            mother: person("mother"),
            spouse: showsSpouse(data) ? person("spouse") : nobody,
            child1: answer("family.child1", data.family.child1),
            child2: answer("family.child2", data.family.child2),
            child3: answer("family.child3", data.family.child3),
        },
        guardian: clean("guardian", data.guardian),
    };
}
