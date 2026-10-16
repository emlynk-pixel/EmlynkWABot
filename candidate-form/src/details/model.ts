import type { MessageKey, MessageParams } from "../i18n/translations";
import type { AdditionalDetailsPayload } from "../types/api";

// The candidate's Additional Details: the 19 fields the public form may
// show and (from Task 3) save. Nothing else about the candidate is part of
// this form: no NIC, nationality, passport dates, stages, allocation, jobs,
// documents or internal IDs.
//
// The rules below are the server's own (src/services/
// candidateAdditionalDetailsService.js, parseAdditionalDetailsBody), checked
// here first so the candidate sees the right field marked. The server stays
// the authority; this file adds no rule of its own.

export const DETAIL_FIELDS = [
    "nameAsInPassport",
    "permanentAddress",
    "birthday",
    "tshirtSize",
    "pantSize",
    "shoeSize",
    "fatherAlive",
    "fatherFullName",
    "fatherBirthday",
    "motherAlive",
    "motherFullName",
    "motherBirthday",
    "maritalStatus",
    "wifeFullName",
    "wifeBirthday",
    "child1Name",
    "child2Name",
    "child3Name",
    "otherJobSkills",
] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];

// Every value as the form holds it: text; "yes" / "no" / "" for the two
// alive questions; "" for "not answered".
export type DetailsForm = Record<DetailField, string>;

export const emptyDetails = (): DetailsForm => Object.fromEntries(DETAIL_FIELDS.map((field) => [field, ""])) as DetailsForm;

export const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export const PANT_SIZE_PRESETS = ["28", "30", "32", "34", "36", "38", "40", "42", "44", "46"] as const;
export const SHOE_SIZE_PRESETS = ["5", "6", "7", "8", "9", "10", "11", "12", "13"] as const;
export const MARITAL_STATUSES = ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "SEPARATED"] as const;

export const MAX_LENGTH = { name: 150, address: 500, skills: 1000 } as const;
const NAME_FIELDS: readonly DetailField[] = ["nameAsInPassport", "fatherFullName", "motherFullName", "wifeFullName", "child1Name", "child2Name", "child3Name"];
const DATE_FIELDS: readonly DetailField[] = ["birthday", "fatherBirthday", "motherBirthday", "wifeBirthday"];
const CUSTOM_SIZE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const EARLIEST_DATE = "1900-01-01";

// Wife details only go with Married; child names never go with Single.
export const showsWife = (form: DetailsForm) => form.maritalStatus === "MARRIED";
export const showsChildren = (form: DetailsForm) => form.maritalStatus !== "SINGLE";

// Today in Sri Lanka (YYYY-MM-DD), the server's "today" for dates.
export function todayInSriLanka(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type FieldMessage = { key: MessageKey; params?: MessageParams };
export type DetailErrors = Partial<Record<DetailField, FieldMessage>>;

function dateError(value: string, today: string): FieldMessage | undefined {
    if (!DATE_PATTERN.test(value)) return { key: "v.dateInvalid" };
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return { key: "v.dateInvalid" };
    if (value < EARLIEST_DATE) return { key: "v.dateTooEarly" };
    if (value > today) return { key: "v.dateFuture" };
    return undefined;
}

// Field -> message key for every problem. Hidden fields (wife details when
// not married, children when single) are not checked: they are not sent.
export function validateDetails(form: DetailsForm, today = todayInSriLanka()): DetailErrors {
    const errors: DetailErrors = {};
    const value = (field: DetailField) => form[field].trim();
    const visible = (field: DetailField) =>
        (!["wifeFullName", "wifeBirthday"].includes(field) || showsWife(form)) && (!["child1Name", "child2Name", "child3Name"].includes(field) || showsChildren(form));

    for (const field of NAME_FIELDS) {
        if (visible(field) && value(field).length > MAX_LENGTH.name) errors[field] = { key: "v.tooLong", params: { max: MAX_LENGTH.name } };
    }
    if (value("permanentAddress").length > MAX_LENGTH.address) errors.permanentAddress = { key: "v.tooLong", params: { max: MAX_LENGTH.address } };
    if (value("otherJobSkills").length > MAX_LENGTH.skills) errors.otherJobSkills = { key: "v.tooLong", params: { max: MAX_LENGTH.skills } };
    for (const field of DATE_FIELDS) {
        if (visible(field) && value(field)) {
            const problem = dateError(value(field), today);
            if (problem) errors[field] = problem;
        }
    }
    for (const field of ["pantSize", "shoeSize"] as const) {
        if (value(field) && !CUSTOM_SIZE.test(value(field))) errors[field] = { key: "v.sizeInvalid" };
    }
    // A parent's name is required only when the parent is alive.
    if (form.fatherAlive === "yes" && !value("fatherFullName")) errors.fatherFullName = { key: "v.required" };
    if (form.motherAlive === "yes" && !value("motherFullName")) errors.motherFullName = { key: "v.required" };
    if (showsWife(form) && !value("wifeFullName")) errors.wifeFullName = { key: "v.required" };
    // Children in order: no 2nd without a 1st, no 3rd without a 2nd.
    if (showsChildren(form)) {
        if (value("child2Name") && !value("child1Name")) errors.child2Name = { key: "v.child2Order" };
        if (value("child3Name") && !value("child2Name")) errors.child3Name = { key: "v.child3Order" };
    }
    return errors;
}

// What would be sent to the server (Task 3): blanks as null, booleans for the
// alive questions, and the values of hidden fields left out (null) rather
// than sent. The values stay in the form, so switching the marital status
// back shows them again; they are only never submitted while hidden.
export function toPayload(form: DetailsForm): AdditionalDetailsPayload {
    const text = (field: DetailField) => form[field].trim() || null;
    const yesNo = (field: DetailField) => (form[field] === "yes" ? true : form[field] === "no" ? false : null);
    const wife = showsWife(form);
    const children = showsChildren(form);
    return {
        nameAsInPassport: text("nameAsInPassport"),
        permanentAddress: text("permanentAddress"),
        birthday: text("birthday"),
        tshirtSize: text("tshirtSize"),
        pantSize: text("pantSize"),
        shoeSize: text("shoeSize"),
        fatherAlive: yesNo("fatherAlive"),
        fatherFullName: text("fatherFullName"),
        fatherBirthday: text("fatherBirthday"),
        motherAlive: yesNo("motherAlive"),
        motherFullName: text("motherFullName"),
        motherBirthday: text("motherBirthday"),
        maritalStatus: text("maritalStatus"),
        wifeFullName: wife ? text("wifeFullName") : null,
        wifeBirthday: wife ? text("wifeBirthday") : null,
        child1Name: children ? text("child1Name") : null,
        child2Name: children ? text("child2Name") : null,
        child3Name: children ? text("child3Name") : null,
        otherJobSkills: text("otherJobSkills"),
    };
}
