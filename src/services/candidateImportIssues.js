// Bulk candidate import: THE readable message and severity of every reason code. One catalog for
// both places an admin reads them, so they can never disagree:
//   the preview's "Rows to review" table (CandidateImportDialog.tsx)
//   the ERRORS / WARNINGS columns of the downloaded validation sheet (validationWorkbook.ts)
// Both get the messages from the preview response (rowIssues / problems), built here.
//
// Severity:
//   ERROR    the row is NOT imported (the candidate can't be identified or registered safely, or
//            the business said so: unknown officer)
//   WARNING  the row is imported; the value named was dropped, ignored or needs a look
// Messages hold no cell value: only the column's header and the reason. "{column}" is the header of
// the field the issue is about.

import { sourceHeaderForField } from "./candidateImportSourceMapping.js";

export const ISSUE_SEVERITY = Object.freeze({ ERROR: "ERROR", WARNING: "WARNING" });
const E = ISSUE_SEVERITY.ERROR;
const W = ISSUE_SEVERITY.WARNING;

export const ISSUE_CATALOG = Object.freeze({
    // Identity and names
    MISSING_PASSPORT: { severity: E, message: "Passport number is missing" },
    INVALID_PASSPORT: { severity: E, message: "Passport number format is invalid (P or N followed by 7 digits)" },
    LEGACY_PASSPORT_FORMAT: { severity: W, message: "Passport number is in the old format (8 digits)" },
    MISSING_SURNAME: { severity: E, message: "Surname is missing" },
    MISSING_OTHER_NAMES: { severity: E, message: "Other name is missing" },
    NAME_TOO_LONG: { severity: E, message: "{column} is longer than 100 characters" },
    OTHER_NAMES_NOT_APPLICABLE: { severity: W, message: "Other name is N/A" },
    MISSING_NIC: { severity: W, message: "NIC number is missing" },
    INVALID_NIC: { severity: W, message: "{column} format is invalid" },
    NIC_CORRUPTED: { severity: W, message: "{column} was changed by Excel into a number (like 1.99E+11); type it as text" },
    MISSING_JOB_ROLE: { severity: E, message: "Job role is missing" },
    UNKNOWN_JOB_TYPE: { severity: W, message: "Job role does not match a job type in Emlynk" },
    TOO_MANY_JOB_TYPES: { severity: W, message: "Job role lists more than 10 job types" },
    // Contact
    MISSING_WHATSAPP: { severity: W, message: "WhatsApp number is missing" },
    INVALID_PHONE: { severity: W, message: "{column} is not a valid phone number" },
    MULTIPLE_PHONE_NUMBERS: { severity: W, message: "{column} has more than one number; only the first is used" },
    FOREIGN_PHONE_UNVERIFIED: { severity: W, message: "{column} is a foreign number that could not be checked" },
    WHATSAPP_CONFLICT: { severity: W, message: "WhatsApp number belongs to another candidate; imported without it" },
    // Values
    TEXT_TOO_LONG: { severity: W, message: "{column} is too long" },
    INVALID_DATE: { severity: W, message: "{column} is not a valid date (use DD.MM.YYYY)" },
    PASSPORT_DATES_INCONSISTENT: { severity: W, message: "Passport issue date is not before the expiry date" },
    INVALID_SEX: { severity: W, message: "Sex is not M or F" },
    INVALID_CIVIL_STATUS: { severity: W, message: "{column} is not a known civil status" },
    CIVIL_STATUS_CONFLICT: { severity: W, message: "Marital status and civil status differ" },
    INVALID_BLOOD_GROUP: { severity: W, message: "Blood group is not valid" },
    INVALID_HEIGHT: { severity: W, message: "Height is not valid" },
    INVALID_WEIGHT: { severity: W, message: "Weight is not valid" },
    INVALID_SIZE: { severity: W, message: "{column} is not valid" },
    INVALID_ENGLISH_LEVEL: { severity: W, message: "English knowledge is not a known level" },
    INVALID_EMAIL: { severity: W, message: "Email is not valid" },
    INVALID_YES_NO: { severity: W, message: "{column} is not Yes or No" },
    FAMILY_PASSPORT_LOOKS_LIKE_NIC: { severity: W, message: "{column} looks like a NIC number, not a passport" },
    INVALID_FAMILY_PASSPORT: { severity: W, message: "{column} is not valid" },
    MARRIED_WITHOUT_SPOUSE_NAME: { severity: W, message: "Married, but Emlynk has no spouse name: marital status not imported" },
    SPOUSE_DETAILS_NOT_MARRIED: { severity: W, message: "Spouse details given, but not married: spouse details not imported" },
    // The file and the database
    DUPLICATE_SOURCE_ROW: { severity: E, message: "Passport number appears on more than one row" },
    NIC_CONFLICT: { severity: E, message: "NIC number belongs to another candidate, or differs from this candidate's NIC" },
    SKIPPED_VERIFIED: { severity: W, message: "Candidate details are verified in Emlynk: details not changed (a visa status is still applied)" },
    // Officer
    OFFICER_MISSING: { severity: W, message: "Officer is missing: the candidate is not assigned" },
    OFFICER_NOT_FOUND: { severity: E, message: "Officer does not match a system user" },
    OFFICER_AMBIGUOUS: { severity: E, message: "Officer matches more than one active user with that first name" },
    OFFICER_NOT_ACTIVE: { severity: E, message: "Officer matches a user who is not active" },
    OFFICER_DIFFERS: { severity: W, message: "Candidate is already assigned to another user: not reassigned" },
    // Visa and Test
    FINAL_STATUS_KEPT: { severity: W, message: "Emlynk already has a different final status (Departed, Visa Not Going, Cancelled or Rejected): not changed" },
    UNKNOWN_VISA_STATUS: { severity: W, message: "Visa status is not one Emlynk maps (Not Submit, Submit, Got Visa, Got Visa Not Going, Departed, Cancelled, Reject): ignored" },
    INVALID_TEST_RESULT: { severity: W, message: "Interview pass/fail is not PASS, FAIL or empty: ignored" },
    TEST_DETAILS_DIFFER: { severity: W, message: "Emlynk already has different test details: not changed" },
    // Client and Agent
    CLIENT_NEEDS_AGENT: { severity: W, message: "Company is new and has no Agent: the Client is not created" },
    AGENT_NEEDS_COMPANY: { severity: W, message: "Agent given without a Company: the Agent is not created" },
    AGENT_AMBIGUOUS: { severity: W, message: "Agent name matches agents in more than one country: not linked" },
    AGENT_INACTIVE: { severity: W, message: "Agent is inactive: not linked to the Client" },
    COMPANY_NUMBER_CONFLICT: { severity: W, message: "Company number differs from the Client's number (in Emlynk or on another row): not changed" },
    COMPANY_NUMBER_WITHOUT_COMPANY: { severity: W, message: "Company number given without a Company: ignored" },
    // Commit failures (a row that could not be saved)
    UNIQUE_ID_COLLISION: { severity: E, message: "Could not be saved (a unique ID was taken at the same time); upload again" },
    PASSPORT_EXISTS: { severity: E, message: "Could not be saved (the passport number was registered at the same time)" },
    DB_ERROR: { severity: E, message: "Could not be saved; upload again" },
});

const UNKNOWN = Object.freeze({ severity: W, message: "Needs a look ({code})" });

// One issue -> { severity, message }.
export function describeIssue({ field = null, code }) {
    const entry = ISSUE_CATALOG[code] ?? UNKNOWN;
    const column = (field && sourceHeaderForField(field)) ?? "Value";
    return { severity: entry.severity, message: entry.message.replace("{column}", column).replace("{code}", code) };
}

export const isErrorCode = (code) => ISSUE_CATALOG[code]?.severity === ISSUE_SEVERITY.ERROR;

// A row's issues -> { errors: [message], warnings: [message] }, each message once, in order.
export function describeIssues(issues) {
    const errors = [];
    const warnings = [];
    for (const issue of issues) {
        const { severity, message } = describeIssue(issue);
        const list = severity === ISSUE_SEVERITY.ERROR ? errors : warnings;
        if (!list.includes(message)) list.push(message);
    }
    return { errors, warnings };
}
