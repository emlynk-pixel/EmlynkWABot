import type { MessageKey, MessageParams } from "../i18n/translations";
import { showsOtherJobCategory, showsSpouse, type CandidateFormData, type FormGroup } from "./model";
import { CIVIL_STATUS_OPTIONS, ENGLISH_LEVELS, JOB_CATEGORIES, SEX_OPTIONS, SHIRT_SIZES } from "./options";

// The form's checks, done before the candidate moves on. The server will
// check again when saving is connected (Task 3) and stays the authority.
// Errors are kept as message keys, so they follow the language switch.

export type FieldMessage = { key: MessageKey; params?: MessageParams };
// "basic.fullName" -> message.
export type FormErrors = Record<string, FieldMessage>;

export const MAX_LENGTH = { text: 150, address: 500, long: 1000 } as const;
export const EARLIEST_DATE = "1900-01-01";
export const LATEST_EXPIRY_DATE = "2100-12-31";

// Sri Lankan NIC: 9 digits and V or X, or 12 digits (the staff form's rule).
const NIC_PATTERN = /^(\d{9}[VX]|\d{12})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A phone number: an optional + and 9 to 15 digits (spaces and dashes ignored).
const PHONE_PATTERN = /^\+?\d{9,15}$/;
const PASSPORT_PATTERN = /^[A-Z0-9]{1,20}$/;
const SIZE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Today in Sri Lanka (YYYY-MM-DD).
export function todayInSriLanka(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const compact = (value: string) => value.trim().replace(/[\s-]/g, "").toUpperCase();

function dateProblem(value: string, { notFuture, today, latest = LATEST_EXPIRY_DATE }: { notFuture: boolean; today: string; latest?: string }): FieldMessage | undefined {
    if (!DATE_PATTERN.test(value)) return { key: "v.dateInvalid" };
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return { key: "v.dateInvalid" };
    if (value < EARLIEST_DATE) return { key: "v.dateTooEarly" };
    if (notFuture && value > today) return { key: "v.dateFuture" };
    if (value > latest) return { key: "v.dateInvalid" };
    return undefined;
}

// Every problem in the whole form.
export function validateForm(data: CandidateFormData, today = todayInSriLanka()): FormErrors {
    const errors: FormErrors = {};
    const add = (path: string, key: MessageKey, params?: MessageParams) => {
        if (!errors[path]) errors[path] = params ? { key, params } : { key };
    };
    const required = (path: string, value: string) => {
        if (!value.trim()) add(path, "v.required");
    };
    const length = (path: string, value: string, max: number) => {
        if (value.trim().length > max) add(path, "v.tooLong", { max });
    };
    const oneOf = (path: string, value: string, options: readonly string[]) => {
        if (value && !options.includes(value)) add(path, "v.required");
    };
    const date = (path: string, value: string, notFuture: boolean) => {
        if (!value) return;
        const problem = dateProblem(value, { notFuture, today });
        if (problem) add(path, problem.key, problem.params);
    };
    const nic = (path: string, value: string) => {
        if (value.trim() && !NIC_PATTERN.test(compact(value))) add(path, "v.nicInvalid");
    };
    const phone = (path: string, value: string) => {
        if (value.trim() && !PHONE_PATTERN.test(value.trim().replace(/[\s-]/g, ""))) add(path, "v.phoneInvalid");
    };
    const passportNumber = (path: string, value: string) => {
        if (value.trim() && !PASSPORT_PATTERN.test(compact(value))) add(path, "v.passportInvalid");
    };
    const size = (path: string, value: string) => {
        if (value.trim() && !SIZE_PATTERN.test(value.trim())) add(path, "v.sizeInvalid");
    };

    // Basic & identification
    const { basic } = data;
    required("basic.fullName", basic.fullName);
    required("basic.surname", basic.surname);
    required("basic.sex", basic.sex);
    required("basic.civilStatus", basic.civilStatus);
    required("basic.birthDate", basic.birthDate);
    for (const field of ["fullName", "surname", "otherNames", "birthPlace"] as const) length(`basic.${field}`, basic[field], MAX_LENGTH.text);
    oneOf("basic.sex", basic.sex, SEX_OPTIONS);
    oneOf("basic.civilStatus", basic.civilStatus, CIVIL_STATUS_OPTIONS);
    date("basic.birthDate", basic.birthDate, true);

    // Contact & location
    const { contact } = data;
    required("contact.address", contact.address);
    required("contact.district", contact.district);
    required("contact.dsDivision", contact.dsDivision);
    required("contact.email", contact.email);
    length("contact.address", contact.address, MAX_LENGTH.address);
    for (const field of ["city", "district", "dsDivision", "gnDivision"] as const) length(`contact.${field}`, contact[field], MAX_LENGTH.text);
    phone("contact.alternativePhone", contact.alternativePhone);
    if (contact.email.trim() && (!EMAIL_PATTERN.test(contact.email.trim()) || contact.email.trim().length > 254)) add("contact.email", "v.emailInvalid");

    // Passport & qualifications
    const { passport, qualifications } = data;
    required("passport.issueDate", passport.issueDate);
    required("passport.expiryDate", passport.expiryDate);
    date("passport.issueDate", passport.issueDate, true);
    date("passport.expiryDate", passport.expiryDate, false);
    if (!errors["passport.issueDate"] && !errors["passport.expiryDate"] && passport.issueDate && passport.expiryDate && passport.expiryDate <= passport.issueDate) {
        add("passport.expiryDate", "v.expiryBeforeIssue");
    }
    required("qualifications.jobCategory", qualifications.jobCategory);
    oneOf("qualifications.jobCategory", qualifications.jobCategory, JOB_CATEGORIES);
    if (showsOtherJobCategory(data)) {
        required("qualifications.jobCategoryOther", qualifications.jobCategoryOther);
        length("qualifications.jobCategoryOther", qualifications.jobCategoryOther, MAX_LENGTH.text);
    }
    length("qualifications.experience", qualifications.experience, MAX_LENGTH.long);
    length("qualifications.otherSkills1", qualifications.otherSkills1, MAX_LENGTH.text);
    length("qualifications.otherSkills2", qualifications.otherSkills2, MAX_LENGTH.text);
    required("qualifications.englishKnowledge", qualifications.englishKnowledge);
    oneOf("qualifications.englishKnowledge", qualifications.englishKnowledge, ENGLISH_LEVELS);

    // Measurements
    oneOf("measurements.shirtSize", data.measurements.shirtSize, SHIRT_SIZES);
    size("measurements.waistSize", data.measurements.waistSize);
    size("measurements.shoeSize", data.measurements.shoeSize);

    // Family (spouse only when married: hidden entries are not checked)
    const people = showsSpouse(data) ? (["father", "mother", "spouse"] as const) : (["father", "mother"] as const);
    for (const who of people) {
        const person = data.family[who];
        length(`family.${who}.name`, person.name, MAX_LENGTH.text);
        length(`family.${who}.surname`, person.surname, MAX_LENGTH.text);
        passportNumber(`family.${who}.passportNumber`, person.passportNumber);
        date(`family.${who}.birthDate`, person.birthDate, true);
    }
    for (const child of ["child1", "child2", "child3"] as const) length(`family.${child}`, data.family[child], MAX_LENGTH.text);

    // Guardian
    const { guardian } = data;
    required("guardian.name", guardian.name);
    required("guardian.nic", guardian.nic);
    required("guardian.phone", guardian.phone);
    required("guardian.address", guardian.address);
    length("guardian.name", guardian.name, MAX_LENGTH.text);
    length("guardian.relationship", guardian.relationship, MAX_LENGTH.text);
    length("guardian.address", guardian.address, MAX_LENGTH.address);
    nic("guardian.nic", guardian.nic);
    phone("guardian.phone", guardian.phone);
    date("guardian.birthDate", guardian.birthDate, true);

    return errors;
}

// The problems that belong to the given groups (one step of the form).
export function errorsIn(errors: FormErrors, groups: readonly FormGroup[]): FormErrors {
    return Object.fromEntries(Object.entries(errors).filter(([path]) => groups.some((group) => path.startsWith(`${group}.`))));
}

// The required answers, for the progress line ("12 of 20 done").
export function requiredPaths(data: CandidateFormData): string[] {
    const paths = [
        "basic.fullName", "basic.surname", "basic.sex", "basic.civilStatus", "basic.birthDate",
        "contact.address", "contact.district", "contact.dsDivision", "contact.email",
        "passport.issueDate", "passport.expiryDate", "qualifications.jobCategory", "qualifications.englishKnowledge",
        "guardian.name", "guardian.nic", "guardian.phone", "guardian.address",
    ];
    return showsOtherJobCategory(data) ? [...paths, "qualifications.jobCategoryOther"] : paths;
}

export function valueAt(data: CandidateFormData, path: string): string {
    return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], data) as string ?? "";
}
