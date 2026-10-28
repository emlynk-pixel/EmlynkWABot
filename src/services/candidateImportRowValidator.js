// Bulk candidate import: one legacy row -> normalized values + safe issue codes.
// Pure. The row's cells come from the browser, which is never trusted: every value
// is normalized and validated again here (candidateImportNormalizers.js), whatever the
// browser did.
//
// Row status (before the database is looked at, candidateImportClassifier.js):
//   INVALID  the candidate can't be identified or registered safely: no usable passport
//            number, no surname, no other names (the record requires both names)
//   WARNING  usable, but a value was in a legacy format, dropped or not recognized
//   VALID    everything given was usable
// A dropped field never invents a value: it is simply not stored.

import { JOB_ROLE_ALIASES, sourceColumnFor } from "./candidateImportSourceMapping.js";
import {
    clean, isNotApplicable, maskIdentifier, normalizeBloodGroup, normalizeDate, normalizeEmail, normalizeEnglishKnowledge,
    normalizeFamilyPassport, normalizeHeight, normalizeJobRoles, normalizeMaritalStatus, normalizeNic, normalizePassport,
    normalizePhones, normalizeSex, normalizeShirtSize, normalizeShoeSize, normalizeText, normalizeWaistSize, normalizeWeight, normalizeYesNo,
} from "./candidateImportNormalizers.js";

export const ROW_STATUS = Object.freeze({ VALID: "VALID", WARNING: "WARNING", INVALID: "INVALID", CONFLICT: "CONFLICT", DUPLICATE: "DUPLICATE" });

// The record's limits (candidateService.js, candidateFormFieldConfirmService.js).
const MAX_NAME = 100;
const TEXT_LIMITS = Object.freeze({
    address: 500, placeOfBirth: 100, jobExperience: 2000, fullName: 200, city: 150, district: 150, dsDivision: 150, gnDivision: 150,
    otherSkills1: 1000, otherSkills2: 150, guardianName: 150, guardianRelationship: 150, guardianAddress: 500,
});

// importer field -> [table, Prisma column]. The ONLY place a source value meets a column.
export const FIELD_TARGETS = Object.freeze({
    surname: ["candidate", "otherName"],
    otherNames: ["candidate", "firstName"],
    nic: ["candidate", "nic"],
    whatsapp: ["candidate", "whatsappNumber"],
    contact: ["candidate", "contactNumber"],
    address: ["candidate", "address"],
    dateOfBirth: ["candidate", "dateOfBirth"],
    placeOfBirth: ["candidate", "placeOfBirth"],
    passportIssueDate: ["candidate", "passportIssueDate"],
    passportExpiryDate: ["candidate", "passportExpiryDate"],
    sex: ["candidate", "sex"],
    jobRole: ["candidate", "job"],
    jobExperience: ["candidate", "jobExperience"],
    fullName: ["details", "nameAsInPassport"],
    maritalStatus: ["details", "maritalStatus"],
    bloodGroup: ["details", "bloodGroup"],
    height: ["details", "height"],
    weight: ["details", "weightKg"],
    shirtSize: ["details", "tshirtSize"],
    waistSize: ["details", "pantSize"],
    shoeSize: ["details", "shoeSize"],
    englishKnowledge: ["details", "englishKnowledge"],
    email: ["details", "email"],
    city: ["details", "city"],
    district: ["details", "district"],
    dsDivision: ["details", "dsDivision"],
    gnDivision: ["details", "gnDivision"],
    otherSkills1: ["details", "otherJobSkills"],
    otherSkills2: ["details", "otherJobSkills2"],
    fatherBirthday: ["details", "fatherBirthday"],
    fatherPassportNumber: ["details", "fatherPassportNumber"],
    fatherAlive: ["details", "fatherAlive"],
    motherBirthday: ["details", "motherBirthday"],
    motherPassportNumber: ["details", "motherPassportNumber"],
    motherAlive: ["details", "motherAlive"],
    spouseBirthday: ["details", "wifeBirthday"],
    spousePassportNumber: ["details", "spousePassportNumber"],
    guardianName: ["details", "guardianName"],
    guardianRelationship: ["details", "guardianRelationship"],
    guardianNic: ["details", "guardianNic"],
    guardianBirthday: ["details", "guardianBirthday"],
    guardianPhone: ["details", "guardianPhone"],
    guardianAddress: ["details", "guardianAddress"],
});

// The cells of a source row by importer field (header matched through the mapping; anything
// that is not an IMPORT / TRANSFORM column is dropped here, whatever the browser sent).
export function sourceCells(values) {
    const cells = {};
    for (const [header, value] of Object.entries(values ?? {})) {
        const column = sourceColumnFor(header);
        if (!column?.field) continue;
        cells[column.field] = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
    }
    return cells;
}

// { rowNumber, passport, maskedPassport, status, issues: [{ field, code }], values: { field: value } }
// `values` holds only usable values, keyed by importer field (FIELD_TARGETS).
export function validateLegacyRow({ rowNumber, values }, { activeJobTypes, aliases = JOB_ROLE_ALIASES, today = new Date() }) {
    const cells = sourceCells(values);
    const issues = [];
    const out = {};
    const errors = [];
    const note = (field, code) => { if (code && !issues.some((i) => i.field === field && i.code === code)) issues.push({ field, code }); };
    const take = (field, result) => {
        if (result.error) { errors.push(result.error); note(field, result.error); return; }
        if (result.warning) note(field, result.warning);
        if (result.value !== null && result.value !== undefined) out[field] = result.value;
    };

    // Identity: the passport number.
    const passport = normalizePassport(cells.passport);
    take("passport", passport);

    // Names: both required (candidate.first_name is NOT NULL; registration requires both). A literal
    // N/A for the other names is the Candidate Form's own "not applicable" answer and is kept as N/A.
    if (clean(cells.surname) === "" || isNotApplicable(cells.surname)) take("surname", { value: null, error: "MISSING_SURNAME" });
    else if (clean(cells.surname).length > MAX_NAME) take("surname", { value: null, error: "NAME_TOO_LONG" });
    else out.surname = clean(cells.surname);
    if (clean(cells.otherNames) === "") take("otherNames", { value: null, error: "MISSING_OTHER_NAMES" });
    else if (isNotApplicable(cells.otherNames)) take("otherNames", { value: "N/A", warning: "OTHER_NAMES_NOT_APPLICABLE" });
    else if (clean(cells.otherNames).length > MAX_NAME) take("otherNames", { value: null, error: "NAME_TOO_LONG" });
    else out.otherNames = clean(cells.otherNames);

    take("nic", normalizeNic(cells.nic));

    // Phones: the first WhatsApp number is the WhatsApp number; a second one becomes the contact
    // number when the row has none. Every extra number is reported.
    const whatsapp = normalizePhones(cells.whatsapp);
    whatsapp.warnings.forEach((code) => note("whatsapp", code));
    if (whatsapp.numbers[0]) out.whatsapp = whatsapp.numbers[0];
    else if (!whatsapp.warnings.includes("INVALID_PHONE")) note("whatsapp", "MISSING_WHATSAPP");
    const contact = normalizePhones(cells.contact);
    contact.warnings.forEach((code) => note("contact", code));
    if (contact.numbers[0]) out.contact = contact.numbers[0];
    else if (whatsapp.numbers[1]) out.contact = whatsapp.numbers[1];

    for (const field of ["address", "placeOfBirth", "jobExperience", "fullName", "city", "district", "dsDivision", "gnDivision", "otherSkills1", "otherSkills2", "guardianName", "guardianRelationship", "guardianAddress"]) {
        take(field, normalizeText(cells[field], { max: TEXT_LIMITS[field] }));
    }

    take("dateOfBirth", normalizeDate(cells.dateOfBirth, { notFuture: true, today }));
    take("passportIssueDate", normalizeDate(cells.passportIssueDate, { notFuture: true, today }));
    take("passportExpiryDate", normalizeDate(cells.passportExpiryDate));
    if (out.passportIssueDate && out.passportExpiryDate && out.passportIssueDate >= out.passportExpiryDate) {
        delete out.passportIssueDate;
        note("passportIssueDate", "PASSPORT_DATES_INCONSISTENT");
    }
    for (const field of ["fatherBirthday", "motherBirthday", "spouseBirthday", "guardianBirthday"]) take(field, normalizeDate(cells[field], { notFuture: true, today }));

    take("sex", normalizeSex(cells.sex));
    // MARITAL STATUS and CIVIL STATUS are the same answer; two different ones are not guessed between.
    const marital = normalizeMaritalStatus(cells.maritalStatus);
    const civil = normalizeMaritalStatus(cells.civilStatus);
    if (marital.value && civil.value && marital.value !== civil.value) note("maritalStatus", "CIVIL_STATUS_CONFLICT");
    else take("maritalStatus", marital.value ? marital : civil.value ? civil : (marital.warning ? marital : civil));

    take("bloodGroup", normalizeBloodGroup(cells.bloodGroup));
    take("height", normalizeHeight(cells.height));
    take("weight", normalizeWeight(cells.weight));
    take("shirtSize", normalizeShirtSize(cells.shirtSize));
    take("waistSize", normalizeWaistSize(cells.waistSize));
    take("shoeSize", normalizeShoeSize(cells.shoeSize));
    take("englishKnowledge", normalizeEnglishKnowledge(cells.englishKnowledge));
    take("email", normalizeEmail(cells.email));
    take("fatherAlive", normalizeYesNo(cells.fatherAlive));
    take("motherAlive", normalizeYesNo(cells.motherAlive));
    for (const field of ["fatherPassportNumber", "motherPassportNumber", "spousePassportNumber"]) take(field, normalizeFamilyPassport(cells[field]));
    take("guardianNic", normalizeNic(cells.guardianNic, { missing: null }));
    const guardianPhone = normalizePhones(cells.guardianPhone);
    guardianPhone.warnings.forEach((code) => note("guardianPhone", code));
    if (guardianPhone.numbers[0]) out.guardianPhone = guardianPhone.numbers[0];

    const jobs = normalizeJobRoles(cells.jobRole, { activeJobTypes, aliases });
    if (jobs.warning) note("jobRole", jobs.warning);
    if (jobs.value) out.jobRole = jobs.value.join(", ");

    const status = errors.length ? ROW_STATUS.INVALID : issues.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;
    return {
        rowNumber,
        passport: passport.value ?? null,
        maskedPassport: maskIdentifier(passport.value ?? cells.passport ?? ""),
        status,
        issues,
        values: out,
    };
}

// The importer field -> column split of a row's values: { candidate: {...}, details: {...} }.
export function toColumns(values) {
    const candidate = {};
    const details = {};
    for (const [field, value] of Object.entries(values)) {
        const target = FIELD_TARGETS[field];
        if (!target) continue;
        (target[0] === "candidate" ? candidate : details)[target[1]] = value;
    }
    return { candidate, details };
}
