// Bulk candidate import: THE mapping of the legacy candidate sheet's columns
// (Settings > Google Sheet Sync > Update Sheet). The one place a legacy header
// is named; nothing else in the importer hard-codes one.
//
// Every legacy column is one of:
//   IMPORT            a value stored as it is (trimmed, spaces collapsed, length-checked)
//   TRANSFORM         normalized first (candidateImportNormalizers.js), then stored
//   IGNORE            not needed by Emlynk, or UNRESOLVED (`unresolved` says why): never stored
//   SYSTEM_GENERATED  Emlynk owns the value (identity, record / stage / document status,
//                     registration metadata): never accepted from a file
// Only IMPORT / TRANSFORM columns ever leave the browser (sourceColumnsForClient); the
// server drops any other column it receives.
//
// `field` is the importer's own name for the value; `target` documents where it is stored.
// Name semantics (the candidate table's column names are historical): the SURNAME is
// candidate.other_name, the OTHER NAME (given names) candidate.first_name (see
// candidateService.js parseCandidateBody, sheetSchema.js).
//
// Headers match after trimming, collapsing spaces and upper-casing ("Job Role" = "JOB ROLE").

export const SOURCE_CLASSIFICATION = Object.freeze({
    IMPORT: "IMPORT",
    TRANSFORM: "TRANSFORM",
    IGNORE: "IGNORE",
    SYSTEM_GENERATED: "SYSTEM_GENERATED",
});
const { IMPORT, TRANSFORM, IGNORE, SYSTEM_GENERATED } = SOURCE_CLASSIFICATION;

// Columns that are supported, with their business meaning, target and rule.
const SUPPORTED = [
    // Identity
    { header: "PASSPORT NUMBER", classification: TRANSFORM, field: "passport", target: "candidate.passport_id", meaning: "Passport number (the identity key)", transform: "passport", required: true },
    { header: "NIC NUMBER", classification: TRANSFORM, field: "nic", target: "candidate.nic", meaning: "National identity card number", transform: "nic" },
    { header: "WHATSAPP NUMBER", classification: TRANSFORM, field: "whatsapp", target: "candidate.whatsapp_number", meaning: "WhatsApp number", transform: "phone" },
    // Names
    { header: "SURNAME", classification: IMPORT, field: "surname", target: "candidate.other_name", meaning: "Surname / family name", transform: "name", required: true },
    { header: "OTHER NAME", classification: IMPORT, field: "otherNames", target: "candidate.first_name", meaning: "Other / given names", transform: "name", required: true },
    { header: "FULL NAME", classification: IMPORT, field: "fullName", target: "candidate_additional_details.name_as_in_passport", meaning: "Full name / name as in passport", transform: "text" },
    // Candidate details
    { header: "CONTACT NUMBER", classification: TRANSFORM, field: "contact", target: "candidate.contact_number", meaning: "Alternative contact number", transform: "phone" },
    { header: "ADDRESS", classification: IMPORT, field: "address", target: "candidate.address", meaning: "Address", transform: "text" },
    { header: "BIRTH DATE", classification: TRANSFORM, field: "dateOfBirth", target: "candidate.date_of_birth", meaning: "Date of birth", transform: "date" },
    { header: "BIRTH PLACE", classification: IMPORT, field: "placeOfBirth", target: "candidate.place_of_birth", meaning: "Place of birth", transform: "text" },
    { header: "PASSPORT ISSUE DATE", classification: TRANSFORM, field: "passportIssueDate", target: "candidate.passport_issue_date", meaning: "Passport issue date", transform: "date" },
    { header: "PASSPORT EXPIRE DATE", classification: TRANSFORM, field: "passportExpiryDate", target: "candidate.passport_expiry_date", meaning: "Passport expiry date", transform: "date" },
    { header: "SEX", classification: TRANSFORM, field: "sex", target: "candidate.sex", meaning: "Sex (M / F)", transform: "sex" },
    { header: "JOB ROLE", classification: TRANSFORM, field: "jobRole", target: "candidate.job", meaning: "Preferred job type(s)", transform: "jobRole" },
    { header: "EXPERIENCE", classification: IMPORT, field: "jobExperience", target: "candidate.job_experience", meaning: "Job experience", transform: "text" },
    // Additional details
    { header: "MARITAL STATUS", classification: TRANSFORM, field: "maritalStatus", target: "candidate_additional_details.marital_status", meaning: "Civil / marital status", transform: "maritalStatus" },
    { header: "CIVIL STATUS", classification: TRANSFORM, field: "civilStatus", target: "candidate_additional_details.marital_status", meaning: "Civil / marital status (same value as MARITAL STATUS)", transform: "maritalStatus" },
    { header: "BLOOD GROUP", classification: TRANSFORM, field: "bloodGroup", target: "candidate_additional_details.blood_group", meaning: "Blood group", transform: "bloodGroup" },
    { header: "HEIGHT", classification: TRANSFORM, field: "height", target: "candidate_additional_details.height", meaning: "Height", transform: "height" },
    { header: "WEIGHT", classification: TRANSFORM, field: "weight", target: "candidate_additional_details.weight_kg", meaning: "Weight (kg)", transform: "weight" },
    { header: "SHIRT SIZE", classification: TRANSFORM, field: "shirtSize", target: "candidate_additional_details.tshirt_size", meaning: "Shirt size", transform: "shirtSize" },
    { header: "HIP SIZE", classification: TRANSFORM, field: "waistSize", target: "candidate_additional_details.pant_size", meaning: "Waist size in inches (legacy values are W-prefixed waist sizes)", transform: "waistSize" },
    { header: "SHOE SIZE", classification: TRANSFORM, field: "shoeSize", target: "candidate_additional_details.shoe_size", meaning: "Shoe size (UK)", transform: "shoeSize" },
    { header: "ENGLISH KNOWLEDGE", classification: TRANSFORM, field: "englishKnowledge", target: "candidate_additional_details.english_knowledge", meaning: "English knowledge level", transform: "englishKnowledge" },
    { header: "EMAIL", classification: TRANSFORM, field: "email", target: "candidate_additional_details.email", meaning: "Email address", transform: "email" },
    { header: "CITY", classification: IMPORT, field: "city", target: "candidate_additional_details.city", meaning: "City", transform: "text" },
    { header: "DISTRICT", classification: IMPORT, field: "district", target: "candidate_additional_details.district", meaning: "District", transform: "text" },
    { header: "DS DIVISION", classification: IMPORT, field: "dsDivision", target: "candidate_additional_details.ds_division", meaning: "DS division", transform: "text" },
    { header: "GN DIVISION", classification: IMPORT, field: "gnDivision", target: "candidate_additional_details.gn_division", meaning: "GN division", transform: "text" },
    { header: "OTHER SKILLS 1", classification: IMPORT, field: "otherSkills1", target: "candidate_additional_details.other_job_skills", meaning: "Other skills 1", transform: "text" },
    { header: "OTHER SKILLS 2", classification: IMPORT, field: "otherSkills2", target: "candidate_additional_details.other_job_skills_2", meaning: "Other skills 2", transform: "text" },
    // Family: birth dates, passports and alive answers only (the names are UNRESOLVED, below)
    { header: "FATHER DOB", classification: TRANSFORM, field: "fatherBirthday", target: "candidate_additional_details.father_birthday", meaning: "Father's birth date", transform: "date" },
    { header: "FATHER PASSPORT", classification: TRANSFORM, field: "fatherPassportNumber", target: "candidate_additional_details.father_passport_number", meaning: "Father's passport number", transform: "familyPassport" },
    { header: "FATHER ALIVE", classification: TRANSFORM, field: "fatherAlive", target: "candidate_additional_details.father_alive", meaning: "Father alive (Yes / No)", transform: "yesNo" },
    { header: "MOTHER DOB", classification: TRANSFORM, field: "motherBirthday", target: "candidate_additional_details.mother_birthday", meaning: "Mother's birth date", transform: "date" },
    { header: "MOTHER PASSPORT", classification: TRANSFORM, field: "motherPassportNumber", target: "candidate_additional_details.mother_passport_number", meaning: "Mother's passport number", transform: "familyPassport" },
    { header: "MOTHER ALIVE", classification: TRANSFORM, field: "motherAlive", target: "candidate_additional_details.mother_alive", meaning: "Mother alive (Yes / No)", transform: "yesNo" },
    { header: "SPOUSE DOB", classification: TRANSFORM, field: "spouseBirthday", target: "candidate_additional_details.wife_birthday", meaning: "Spouse's birth date (kept only when Married)", transform: "date" },
    { header: "SPOUSE PASSPORT", classification: TRANSFORM, field: "spousePassportNumber", target: "candidate_additional_details.spouse_passport_number", meaning: "Spouse's passport number (kept only when Married)", transform: "familyPassport" },
    // Guardian
    { header: "GUARDIAN NAME", classification: IMPORT, field: "guardianName", target: "candidate_additional_details.guardian_name", meaning: "Guardian's name", transform: "text" },
    { header: "GUARDIAN RELATION", classification: IMPORT, field: "guardianRelationship", target: "candidate_additional_details.guardian_relationship", meaning: "Guardian's relationship", transform: "text" },
    { header: "GUARDIAN NIC", classification: TRANSFORM, field: "guardianNic", target: "candidate_additional_details.guardian_nic", meaning: "Guardian's NIC", transform: "nic" },
    { header: "GUARDIAN DOB", classification: TRANSFORM, field: "guardianBirthday", target: "candidate_additional_details.guardian_birthday", meaning: "Guardian's birth date", transform: "date" },
    { header: "GUARDIAN PHONE", classification: TRANSFORM, field: "guardianPhone", target: "candidate_additional_details.guardian_phone", meaning: "Guardian's phone", transform: "phone" },
    { header: "GUARDIAN ADDRESS", classification: IMPORT, field: "guardianAddress", target: "candidate_additional_details.guardian_address", meaning: "Guardian's address", transform: "text" },
];

// Ambiguous columns: not imported until the business confirms their meaning.
const FAMILY_NAME = "The legacy NAME column usually already contains the surname, so NAME + SURNAME would repeat it and NAME alone is sometimes incomplete; the record keeps ONE full name.";
const CHILD_NAME = "The record keeps each child as ONE full name; how the legacy NAME and SURNAME combine is not confirmed.";
const UNRESOLVED = [
    ["FATHER NAME", FAMILY_NAME], ["FATHER SURNAME", FAMILY_NAME],
    ["MOTHER NAME", FAMILY_NAME], ["MOTHER SURNAME", FAMILY_NAME],
    ["SPOUSE NAME", FAMILY_NAME], ["SPOUSE SURNAME", FAMILY_NAME],
    ["CHILD1 NAME", CHILD_NAME], ["CHILD1 SURNAME", CHILD_NAME],
    ["CHILD2 NAME", CHILD_NAME], ["CHILD2 SURNAME", CHILD_NAME],
    ["CHILD3 NAME", CHILD_NAME], ["CHILD3 SURNAME", CHILD_NAME],
    ["REMARK", "Not confirmed to mean the Candidate Details note (it may hold visa or process remarks)."],
    ["OTHER SKILLS DESCRIPTION", "No confirmed home: other_job_skills is OTHER SKILLS 1."],
    ["INTERVIEW DATE", "Not confirmed to be the Test date; test details are entered in the Test details stage."],
];

// Emlynk owns these values: never taken from a file.
const SYSTEM = [
    ["UNIQUE NUMBER", "Legacy ID; the Emlynk unique ID is generated"],
    ["REGISTER NUMBER", "Legacy registration number"],
    ["REGISTER DATE", "The registration date is when the record is created in Emlynk"],
    ["ACTIVE STATUS", "Record status is system-owned"],
    ["VISA STATUS", "Stage status (Visa submission / approval) is set in Emlynk"],
    ["INTERVIEW PASS FAIL", "The test result is set in the Test details stage"],
    ["DOCUMENT CREATED STATUS", "Document status comes from documents in Emlynk"],
    ["PASSPORT", "Document status comes from documents in Emlynk"],
    ["MEDICAL", "Document status comes from documents in Emlynk"],
    ["SCAN", "Document status comes from documents in Emlynk"],
    ["NIC COPY", "Document status comes from documents in Emlynk"],
    ["POLICE REPORT", "Document status comes from documents in Emlynk"],
    ["POLICE REPORT FM CERTIFIED", "Document status comes from documents in Emlynk"],
    ["ROMANIA POLICE REPORT", "Document status comes from documents in Emlynk"],
    ["ROMANIA POLICE REPORT CERTIFIED", "Document status comes from documents in Emlynk"],
    ["DRIVING LICENSE", "Document status comes from documents in Emlynk"],
    ["DRIVING LICENSE FM CERTIFIED", "Document status comes from documents in Emlynk"],
    ["VIDEO", "Document status comes from documents in Emlynk"],
    ["VISA COPY", "Document status comes from documents in Emlynk"],
    ["ROMANIA ID", "Document status comes from documents in Emlynk"],
];

// Not needed by Emlynk (operational, payment, travel, company and agent tracking).
const IGNORED = [
    "OFFICER", "JOB SECTOR", "COMPANY", "MERGED", "AIR TICKET", "ARRIVAL CONFIRMATION", "DEPARTURE PHOTO", "CV",
    "OTHER COUNT", "OTHER DETAILS", "REPEAT COUNT", "REPEAT DETAILS", "APPLY COUNTRY", "REGISTRATION CATEGORY",
    "CONTACT PERSON", "BRANCH", "APPLIED FROM", "PREVIOUS COMPANY AFFIDAVITS CONTRACTS SIGNED DATE (2)", "CONTRACT RECEIVED",
    "COMPANY NUMBER", "PREVIOUS COMPANY (1)", "PREVIOUS COMPANY (2)", "AGENT", "VISA PROCESSING CATEGORY",
    "DOCUMENTS LAWYER PAYMENT", "AFFIDAVITS CONTRACTS SIGNED DATE", "PREVIOUS COMPANY AFFIDAVITS CONTRACTS SIGNED DATE (1)",
    "CHILD1 DOB", "CHILD1 PASSPORT", "CHILD2 DOB", "CHILD2 PASSPORT", "CHILD3 DOB", "CHILD3 PASSPORT",
    "CASH PAYMENT 1 DATE", "CASH PAYMENT 2 DATE", "CASH PAYMENT 3 DATE", "CASH PAYMENT 4 DATE", "BUREAU READY",
    "CLIENT SUBMIT DATE", "VISA RECIVED DATE", "AIR TICKET BOOKED DATE", "LOAN CONFIRMATION RECEIVED", "LOAN APPROVED AMOUNT",
    "LOAN APPLY AMOUNT", "LOAN APPLIED BANK", "CHEQUE REMARK", "CHEQUE DATE", "CHEQUE PAYMENT",
    "DEPARTURE FAIL RE APPLY TICKET DATE", "ARRIVAL TIME", "DEPARTURE TIME", "ACTUAL DEPARTURE DATE", "PLANNING DEPARTURE DATE",
    "RE APPLY TICKET PRICE", "TICKET PRICE", "AIR LINE", "ISRAEL PROBLEMS", "PASSPORT WITH DOCUMENTS HAND OVER",
    "FINAL AFFIDAVIT BOND", "CHECKED DATE", "DEPATURE CONFIRMATION CHECKED OFFICER NAME", "OFFICER UPDATE",
    "CLIENT UPDATED COMPANY", "SUBMITTED COMPANY", "AGGREEMENT CREATED FOR", "AGENT ASKED FOR A COMPANY", "VISA FILE CREATION",
    "REMAINING DOCUMENTS", "DOCUMENTS UPDATE", "SUBMITTED GROUP", "WITHDRAW DATE", "REASON TO REJECT", "REASON FOR CANCELED",
];

// "  Job   role " -> "JOB ROLE"
export const sourceHeaderKey = (header) => (typeof header === "string" ? header.trim().replace(/\s+/g, " ").toUpperCase() : "");

export const LEGACY_SOURCE_COLUMNS = Object.freeze([
    ...SUPPORTED.map((c) => Object.freeze({ ...c, header: sourceHeaderKey(c.header) })),
    ...UNRESOLVED.map(([header, unresolved]) => Object.freeze({ header, classification: IGNORE, unresolved })),
    ...SYSTEM.map(([header, notes]) => Object.freeze({ header, classification: SYSTEM_GENERATED, notes })),
    ...IGNORED.map((header) => Object.freeze({ header, classification: IGNORE })),
]);

const BY_HEADER = new Map(LEGACY_SOURCE_COLUMNS.map((c) => [c.header, c]));

export const SUPPORTED_SOURCE_COLUMNS = Object.freeze(LEGACY_SOURCE_COLUMNS.filter((c) => c.classification === IMPORT || c.classification === TRANSFORM));
export const REQUIRED_SOURCE_HEADERS = Object.freeze(SUPPORTED_SOURCE_COLUMNS.filter((c) => c.required).map((c) => c.header));

// A column's mapping by its header (any case / spacing), or null for a header the mapping doesn't know.
export const sourceColumnFor = (header) => BY_HEADER.get(sourceHeaderKey(header)) ?? null;

// What the browser needs to extract a workbook: the headers to send, and the required ones.
export function sourceColumnsForClient() {
    return {
        allowed: SUPPORTED_SOURCE_COLUMNS.map((c) => c.header),
        required: [...REQUIRED_SOURCE_HEADERS],
    };
}

// The header row of an uploaded sheet (header text only, never a value) ->
// { missingRequired, supported, ignored, systemGenerated, unresolved, unknown }.
export function analyzeSourceHeaders(headers) {
    const seen = new Set();
    const result = { missingRequired: [], supported: [], ignored: [], systemGenerated: [], unresolved: [], unknown: [] };
    for (const raw of Array.isArray(headers) ? headers : []) {
        const key = sourceHeaderKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const column = BY_HEADER.get(key);
        if (!column) result.unknown.push(key);
        else if (column.classification === SYSTEM_GENERATED) result.systemGenerated.push(key);
        else if (column.unresolved) result.unresolved.push(key);
        else if (column.classification === IGNORE) result.ignored.push(key);
        else result.supported.push(key);
    }
    result.missingRequired = REQUIRED_SOURCE_HEADERS.filter((header) => !seen.has(header));
    return result;
}

// Job role aliases: a legacy role name -> an Emlynk job type name, used ONLY for
// business-confirmed mappings. A legacy role equal to an active job type's name
// (case-insensitive) needs no alias. Never guessed: a generic "Welder" is not
// mapped to a specific TIG / MIG / ARC type. Empty until mappings are confirmed.
export const JOB_ROLE_ALIASES = Object.freeze({});
