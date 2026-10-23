import type { MessageKey, MessageParams } from "../i18n/translations";
import { NOT_APPLICABLE_FIELDS, isNotApplicable, isNotApplicableFor, showsOtherJobCategory, showsSpouse, type CandidateFormData, type FormGroup } from "./model";
import { CIVIL_STATUS_OPTIONS, ENGLISH_LEVELS, JOB_CATEGORIES, SEX_OPTIONS, SHIRT_SIZES, jobCategoryChoices } from "./options";

// The form's checks, done before the candidate moves on (Next) and again for
// the whole form before Submit. The server checks the same rules again and
// stays the authority (candidateFormDataService.js parseSubmission).
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

// "N/A" (model.ts: NOT_APPLICABLE_FIELDS, isNotApplicableFor): the answer for a field that does
// not apply to the candidate (no other names, no second phone, no children, ...). Only those
// fields take it; everywhere else (names, addresses, sizes, the guardian, dates, ...) a real
// answer is needed and "N/A" is refused. The server keeps the same list and rules.
export { NOT_APPLICABLE_FIELDS };
const naAllowed = (path: string, value: string) => NOT_APPLICABLE_FIELDS.has(path) && isNotApplicableFor(path, value);

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
// `jobCategories`: the choices offered (jobCategoryChoices of the server's list);
// by default the original trades, for callers without a server list.
export function validateForm(data: CandidateFormData, today = todayInSriLanka(), jobCategories: readonly string[] = jobCategoryChoices(JOB_CATEGORIES)): FormErrors {
    const errors: FormErrors = {};
    const add = (path: string, key: MessageKey, params?: MessageParams) => {
        if (!errors[path]) errors[path] = params ? { key, params } : { key };
    };
    // Every required answer must be there, then "N/A" only where it is allowed (hidden
    // answers are never checked: they are not sent). These come first, so a missing or
    // misplaced "N/A" is the message shown rather than a format problem.
    for (const path of requiredPaths(data)) {
        if (!valueAt(data, path).trim()) add(path, "v.required");
    }
    for (const path of visiblePaths(data)) {
        if (isNotApplicable(valueAt(data, path)) && !NOT_APPLICABLE_FIELDS.has(path)) add(path, "v.notApplicableRefused");
    }
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
        if (value.trim() && !naAllowed(path, value) && !PHONE_PATTERN.test(value.trim().replace(/[\s-]/g, ""))) add(path, "v.phoneInvalid");
    };
    const passportNumber = (path: string, value: string) => {
        if (value.trim() && !naAllowed(path, value) && !PASSPORT_PATTERN.test(compact(value))) add(path, "v.passportInvalid");
    };
    const size = (path: string, value: string) => {
        if (value.trim() && !SIZE_PATTERN.test(value.trim())) add(path, "v.sizeInvalid");
    };

    // Basic & identification
    const { basic } = data;
    for (const field of ["fullName", "surname", "otherNames", "birthPlace"] as const) length(`basic.${field}`, basic[field], MAX_LENGTH.text);
    oneOf("basic.sex", basic.sex, SEX_OPTIONS);
    oneOf("basic.civilStatus", basic.civilStatus, CIVIL_STATUS_OPTIONS);
    date("basic.birthDate", basic.birthDate, true);

    // Contact & location
    const { contact } = data;
    length("contact.address", contact.address, MAX_LENGTH.address);
    for (const field of ["city", "district", "dsDivision", "gnDivision"] as const) length(`contact.${field}`, contact[field], MAX_LENGTH.text);
    phone("contact.alternativePhone", contact.alternativePhone);
    if (contact.email.trim() && (!EMAIL_PATTERN.test(contact.email.trim()) || contact.email.trim().length > 254)) add("contact.email", "v.emailInvalid");

    // Passport & qualifications
    const { passport, qualifications } = data;
    date("passport.issueDate", passport.issueDate, true);
    date("passport.expiryDate", passport.expiryDate, false);
    if (!errors["passport.issueDate"] && !errors["passport.expiryDate"] && passport.issueDate && passport.expiryDate && passport.expiryDate <= passport.issueDate) {
        add("passport.expiryDate", "v.expiryBeforeIssue");
    }
    oneOf("qualifications.jobCategory", qualifications.jobCategory, jobCategories);
    if (showsOtherJobCategory(data)) {
        length("qualifications.jobCategoryOther", qualifications.jobCategoryOther, MAX_LENGTH.text);
    }
    length("qualifications.experience", qualifications.experience, MAX_LENGTH.long);
    length("qualifications.otherSkills1", qualifications.otherSkills1, MAX_LENGTH.text);
    length("qualifications.otherSkills2", qualifications.otherSkills2, MAX_LENGTH.text);
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

// Whether a parent applies: "N/A" as the name says they do not.
export const parentApplies = (data: CandidateFormData, who: "father" | "mother") => !isNotApplicableFor(`family.${who}.name`, data.family[who].name);

const PERSON_FIELDS = ["name", "surname", "passportNumber", "birthDate"] as const;
const CHILDREN = ["child1", "child2", "child3"] as const;

// Every answer the candidate can currently see and edit (hidden ones are not
// sent: the spouse unless Married, "Other Job Category" unless OTHER).
export function visiblePaths(data: CandidateFormData): string[] {
    const paths: string[] = [];
    for (const group of ["basic", "contact", "passport", "qualifications", "measurements", "guardian"] as const) {
        for (const key of Object.keys(data[group])) {
            if (key === "jobCategoryOther" && !showsOtherJobCategory(data)) continue;
            paths.push(`${group}.${key}`);
        }
    }
    for (const who of showsSpouse(data) ? (["father", "mother", "spouse"] as const) : (["father", "mother"] as const)) {
        for (const field of PERSON_FIELDS) paths.push(`family.${who}.${field}`);
    }
    for (const child of CHILDREN) paths.push(`family.${child}`);
    return paths;
}

// The required answers: EVERY visible answer, except where the candidate has
// said a person does not apply. This one list drives the "required" marks,
// the checks before Next and Submit, and the progress line ("12 of 40 done").
//   - a parent named "N/A": that parent's surname, passport and birth date are not needed;
//   - children: Child 1 always ("N/A" for none); Child 2 only after a real Child 1,
//     Child 3 only after a real Child 2;
//   - the spouse (when Married) and "Other Job Category" (with OTHER) only while shown.
export function requiredPaths(data: CandidateFormData): string[] {
    const skip = new Set<string>();
    for (const who of ["father", "mother"] as const) {
        if (!parentApplies(data, who)) for (const field of PERSON_FIELDS.slice(1)) skip.add(`family.${who}.${field}`);
    }
    for (let i = 1; i < CHILDREN.length; i += 1) {
        const before = data.family[CHILDREN[i - 1]];
        if (!before.trim() || isNotApplicableFor(`family.${CHILDREN[i - 1]}`, before)) for (const later of CHILDREN.slice(i)) skip.add(`family.${later}`);
    }
    return visiblePaths(data).filter((path) => !skip.has(path));
}

export function valueAt(data: CandidateFormData, path: string): string {
    return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], data) as string ?? "";
}
