import { OTHER_JOB_CATEGORY } from "./options";
import type { CandidateFormPayload } from "../types/api";

// The Candidate Form's data, grouped as the form is. Every value is a string
// as the form holds it ("" = not answered); choice fields hold their English
// code (options.ts). Nothing here is staff-only: no register number, stages,
// allocation, jobs or documents.
//
// The verified Passport Number and WhatsApp Number are NOT part of this
// data: they come from the verification (session/tokenStore.ts), are shown
// read-only, and are never sent with the details; the server knows the
// candidate from the token.

export type BasicInfo = {
    fullName: string;
    surname: string;
    otherNames: string;
    nic: string;
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
    basic: { fullName: "", surname: "", otherNames: "", nic: "", sex: "", civilStatus: "", birthDate: "", birthPlace: "" },
    contact: { address: "", city: "", district: "", dsDivision: "", gnDivision: "", alternativePhone: "", email: "" },
    passport: { issueDate: "", expiryDate: "" },
    qualifications: { jobCategory: "", jobCategoryOther: "", experience: "", otherSkills1: "", otherSkills2: "", englishKnowledge: "" },
    measurements: { shirtSize: "", waistSize: "", shoeSize: "" },
    family: { father: emptyPerson(), mother: emptyPerson(), spouse: emptyPerson(), child1: "", child2: "", child3: "" },
    guardian: { name: "", relationship: "", nic: "", birthDate: "", phone: "", address: "" },
});

// Spouse details only go with Married.
export const showsSpouse = (data: CandidateFormData) => data.basic.civilStatus === "MARRIED";
// "Other Job Category" only goes with OTHER.
export const showsOtherJobCategory = (data: CandidateFormData) => data.qualifications.jobCategory === OTHER_JOB_CATEGORY;

// What would be sent when saving is connected (Task 3). Blanks become null.
// Hidden entries are kept in the form (switching Civil Status back shows the
// spouse again) but are never sent: no spouse unless Married, no "Other Job
// Category" unless OTHER is chosen.
export function toPayload(data: CandidateFormData): CandidateFormPayload {
    const clean = <T extends Record<string, string>>(group: T) =>
        Object.fromEntries(Object.entries(group).map(([key, value]) => [key, value.trim() || null])) as { [K in keyof T]: string | null };
    const person = (value: Person) => clean(value);
    const nobody = { name: null, surname: null, passportNumber: null, birthDate: null };
    return {
        basic: clean(data.basic),
        contact: clean(data.contact),
        passport: clean(data.passport),
        qualifications: { ...clean(data.qualifications), jobCategoryOther: showsOtherJobCategory(data) ? data.qualifications.jobCategoryOther.trim() || null : null },
        measurements: clean(data.measurements),
        family: {
            father: person(data.family.father),
            mother: person(data.family.mother),
            spouse: showsSpouse(data) ? person(data.family.spouse) : nobody,
            child1: data.family.child1.trim() || null,
            child2: data.family.child2.trim() || null,
            child3: data.family.child3.trim() || null,
        },
        guardian: clean(data.guardian),
    };
}
