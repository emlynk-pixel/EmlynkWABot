import { businessDateOf } from "../utils/businessDay.js";
import { CandidateError } from "./candidateService.js";
import { FORM_ACCESS_STATUS } from "./candidateFormShareService.js";

// The Candidate Form's data on the server: the field list, the prefill from
// the existing records, the immutable prefill snapshot, and the one-time
// submission. Docs/CANDIDATE_EXTRA_DETAILS_FORM_SHARE_LINKS_DESIGN.md.
//
// The public form NEVER writes the main candidate tables (candidate,
// candidate_additional_details, candidate_stages). It reads them once, to
// prefill, and writes only candidate_form_prefill_snapshot (the original
// values, once) and candidate_form_response (the answers, once).

export const SEX_CODES = Object.freeze(["MALE", "FEMALE", "OTHER"]);
export const CIVIL_STATUS_CODES = Object.freeze(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"]);
export const ENGLISH_LEVELS = Object.freeze(["NO KNOWLEDGE", "BASIC", "FAIR", "GOOD", "VERY GOOD", "FLUENT"]);
export const OTHER_JOB_CATEGORY = "OTHER";
export const JOB_CATEGORIES = Object.freeze([
    "PLASTER", "BLOCK MASON", "TILER", "SHUTTERING CARPENTER", "BARBENDER", "GYPSUM WORKER", "ALUMINIUM WORKER",
    "WELDER TIG", "WELDER MIG", "WELDER ARC", "PLUMBER", "ELECTRICIAN", "JCB OPERATOR", "EXCAVATOR OPERATOR",
    "MOTOR GRADER OPERATOR", "BOBCAT OPERATOR", "WHEEL LOADER OPERATOR", OTHER_JOB_CATEGORY,
]);
export const SHIRT_SIZES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL"]);

const MAX = { text: 150, address: 500, long: 1000, email: 254, phone: 20, size: 10, passport: 30 };
const EARLIEST_DATE = "1900-01-01";
const LATEST_EXPIRY_DATE = "2100-12-31";

// "N/A": the answer for a field that does not apply to the candidate. Accepted
// (in any letter case, stored as "N/A") ONLY for these fields; anywhere else it
// is refused. The form keeps the same list (candidate-form/src/form/validation.ts).
export const NOT_APPLICABLE = "N/A";
export const isNotApplicable = (value) => typeof value === "string" && /^n\/a$/i.test(value.trim());
export const NOT_APPLICABLE_FIELDS = Object.freeze(new Set([
    "basic.otherNames",
    "contact.city",
    "contact.alternativePhone",
    "qualifications.experience",
    "qualifications.otherSkills1",
    "qualifications.otherSkills2",
    "family.father.name",
    "family.father.surname",
    "family.father.passportNumber",
    "family.mother.name",
    "family.mother.surname",
    "family.mother.passportNumber",
    "family.spouse.passportNumber",
    "family.child1",
    "family.child2",
    "family.child3",
]));

// Every answer: [group path, key, column, kind, options]. kind:
//   text   English letters capitalised; max length
//   email / phone  kept as typed
//   date   YYYY-MM-DD; notFuture for birth and issue dates
//   code   one of a fixed list
//   size   a short size ("34", "EU 43")
//   passport  letters and digits
//   nic    a Sri Lankan NIC
// The verified Passport Number and NIC are NOT answers: they come from the
// candidate's record and cannot be changed through the form.
//
// Required: every answer the candidate can see. `required: true` is checked
// for each field; the conditional ones are checked after all the fields
// (parseSubmission): a parent's surname, passport and birth date unless the
// parent's name is "N/A"; the spouse only when Married; Child 2 / Child 3
// only after a real Child 1 / Child 2; "Other Job Category" only with OTHER.
const person = (who) => [
    [`family.${who}`, "name", `${who}Name`, "text", { required: who !== "spouse", max: MAX.text }],
    [`family.${who}`, "surname", `${who}Surname`, "text", { max: MAX.text }],
    [`family.${who}`, "passportNumber", `${who}PassportNumber`, "passport", {}],
    [`family.${who}`, "birthDate", `${who}BirthDate`, "date", { notFuture: true }],
];
export const ANSWER_FIELDS = Object.freeze([
    ["basic", "fullName", "fullName", "text", { required: true, max: MAX.text }],
    ["basic", "surname", "surname", "text", { required: true, max: MAX.text }],
    ["basic", "otherNames", "otherNames", "text", { required: true, max: MAX.text }],
    ["basic", "sex", "sex", "code", { required: true, codes: SEX_CODES }],
    ["basic", "civilStatus", "civilStatus", "code", { required: true, codes: CIVIL_STATUS_CODES }],
    ["basic", "birthDate", "birthDate", "date", { required: true, notFuture: true }],
    ["basic", "birthPlace", "birthPlace", "text", { required: true, max: MAX.text }],
    ["contact", "address", "address", "text", { required: true, max: MAX.address }],
    ["contact", "city", "city", "text", { required: true, max: MAX.text }],
    ["contact", "district", "district", "text", { required: true, max: MAX.text }],
    ["contact", "dsDivision", "dsDivision", "text", { required: true, max: MAX.text }],
    ["contact", "gnDivision", "gnDivision", "text", { required: true, max: MAX.text }],
    ["contact", "alternativePhone", "alternativePhone", "phone", { required: true }],
    ["contact", "email", "email", "email", { required: true }],
    ["passport", "issueDate", "passportIssueDate", "date", { required: true, notFuture: true }],
    ["passport", "expiryDate", "passportExpiryDate", "date", { required: true }],
    ["qualifications", "jobCategory", "jobCategory", "code", { required: true, codes: JOB_CATEGORIES }],
    ["qualifications", "jobCategoryOther", "jobCategoryOther", "text", { max: MAX.text }],
    ["qualifications", "experience", "experience", "text", { required: true, max: MAX.long }],
    ["qualifications", "otherSkills1", "otherSkills1", "text", { required: true, max: MAX.text }],
    ["qualifications", "otherSkills2", "otherSkills2", "text", { required: true, max: MAX.text }],
    ["qualifications", "englishKnowledge", "englishKnowledge", "code", { required: true, codes: ENGLISH_LEVELS }],
    ["measurements", "shirtSize", "shirtSize", "code", { required: true, codes: SHIRT_SIZES }],
    ["measurements", "waistSize", "waistSize", "size", { required: true }],
    ["measurements", "shoeSize", "shoeSize", "size", { required: true }],
    ...person("father"),
    ...person("mother"),
    ...person("spouse"),
    ["family", "child1", "child1Name", "text", { required: true, max: MAX.text }],
    ["family", "child2", "child2Name", "text", { max: MAX.text }],
    ["family", "child3", "child3Name", "text", { max: MAX.text }],
    ["guardian", "name", "guardianName", "text", { required: true, max: MAX.text }],
    ["guardian", "relationship", "guardianRelationship", "text", { required: true, max: MAX.text }],
    ["guardian", "nic", "guardianNic", "nic", { required: true }],
    ["guardian", "birthDate", "guardianBirthDate", "date", { required: true, notFuture: true }],
    ["guardian", "phone", "guardianPhone", "phone", { required: true }],
    ["guardian", "address", "guardianAddress", "text", { required: true, max: MAX.address }],
]);
const DATE_COLUMNS = new Set(ANSWER_FIELDS.filter((f) => f[3] === "date").map((f) => f[2]));
// The shape of `answers`: group -> allowed keys (family has three nested people).
const SHAPE = (() => {
    const shape = {};
    for (const [group, key] of ANSWER_FIELDS) {
        const [top, sub] = group.split(".");
        shape[top] ??= {};
        if (sub) (shape[top][sub] ??= {})[key] = true;
        else shape[top][key] = true;
    }
    return shape;
})();

// English letters to capitals; Sinhala and everything else unchanged.
export const toUpperEnglish = (value) => value.replace(/[a-z]+/g, (letters) => letters.toUpperCase());

const isoDay = (date) => (date ? date.toISOString().slice(0, 10) : null);
const textOrNull = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

// ---------------------------------------------------------------- prefill

const SEX_FROM_RECORD = Object.freeze({ M: "MALE", F: "FEMALE", X: "OTHER" });

// The form's values from the existing records, as snapshot columns. Only
// what is on record is filled; everything else stays null. Mapping (design
// doc, "Field mapping"): note that the core candidate's other_name is the
// SURNAME and first_name the OTHER NAMES (candidateService.js).
export function prefillFromRecords(candidate, details) {
    const job = textOrNull(candidate.job)?.toUpperCase();
    const marital = details?.maritalStatus;
    const skills = textOrNull(details?.otherJobSkills);
    return {
        fullName: textOrNull(details?.nameAsInPassport),
        surname: textOrNull(candidate.otherName),
        otherNames: textOrNull(candidate.firstName),
        nic: textOrNull(candidate.nic),
        sex: SEX_FROM_RECORD[candidate.sex] ?? null,
        civilStatus: CIVIL_STATUS_CODES.includes(marital) ? marital : null,
        birthDate: details?.birthday ?? candidate.dateOfBirth ?? null,
        birthPlace: textOrNull(candidate.placeOfBirth),
        address: textOrNull(details?.permanentAddress) ?? textOrNull(candidate.address),
        alternativePhone: textOrNull(candidate.contactNumber),
        passportIssueDate: candidate.passportIssueDate ?? null,
        passportExpiryDate: candidate.passportExpiryDate ?? null,
        jobCategory: job && JOB_CATEGORIES.includes(job) ? job : null,
        experience: textOrNull(candidate.jobExperience),
        otherSkills1: skills && skills.length <= MAX.text ? skills : null,
        shirtSize: SHIRT_SIZES.includes(details?.tshirtSize) ? details.tshirtSize : null,
        waistSize: textOrNull(details?.pantSize),
        shoeSize: textOrNull(details?.shoeSize),
        fatherName: textOrNull(details?.fatherFullName),
        fatherBirthDate: details?.fatherBirthday ?? null,
        motherName: textOrNull(details?.motherFullName),
        motherBirthDate: details?.motherBirthday ?? null,
        spouseName: textOrNull(details?.wifeFullName),
        spouseBirthDate: details?.wifeBirthday ?? null,
        child1Name: textOrNull(details?.child1Name),
        child2Name: textOrNull(details?.child2Name),
        child3Name: textOrNull(details?.child3Name),
    };
}

const SNAPSHOT_SELECT = Object.fromEntries([...ANSWER_FIELDS.map((f) => [f[2], true]), ["nic", true]]);

// The grouped prefill the form receives (null for empty), and the paths that
// were prefilled.
function groupedFrom(row) {
    const answers = {};
    const prefilled = [];
    for (const [group, key, column] of ANSWER_FIELDS) {
        const raw = row?.[column] ?? null;
        const value = DATE_COLUMNS.has(column) ? isoDay(raw) : raw;
        let target = answers;
        for (const part of group.split(".")) target = target[part] ??= {};
        target[key] = value;
        if (value !== null) prefilled.push(`${group}.${key}`);
    }
    return { answers, prefilled };
}

// POST /api/public/candidate-details/form. The candidate's identity (read
// only) and the prefill. The prefill is taken from the records ONCE, into the
// snapshot (the original values, kept for comparison); every later visit
// shows the same snapshot. Only the form's fields: never stages, documents,
// allocation, job assignment, IDs or anything staff-only.
export async function loadCandidateForm({ db, passportId, linkId, now = new Date() }) {
    return db.$transaction(async (tx) => {
        const candidate = await tx.candidate.findUnique({
            where: { passportId },
            select: {
                passportId: true, nic: true, whatsappNumber: true, firstName: true, otherName: true, sex: true, dateOfBirth: true, placeOfBirth: true,
                address: true, contactNumber: true, passportIssueDate: true, passportExpiryDate: true, job: true, jobExperience: true,
                additionalDetails: true,
            },
        });
        if (!candidate) throw new CandidateError(401, "VERIFICATION_REQUIRED", "Please verify your details again.");
        let snapshot = await tx.candidateFormPrefillSnapshot.findUnique({ where: { passportId }, select: SNAPSHOT_SELECT });
        if (!snapshot) {
            snapshot = prefillFromRecords(candidate, candidate.additionalDetails);
            await tx.candidateFormPrefillSnapshot.create({ data: { passportId, ...snapshot, capturedAt: now, capturedViaLinkId: linkId } });
        }
        const { answers, prefilled } = groupedFrom(snapshot);
        return {
            identity: { passportNumber: candidate.passportId, nic: candidate.nic, whatsappNumber: candidate.whatsappNumber ?? null },
            answers,
            prefilled,
        };
    });
}

// ---------------------------------------------------------------- submission

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const NIC_PATTERN = /^(\d{9}[VX]|\d{12})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?\d{9,15}$/;
const PASSPORT_PATTERN = /^[A-Z0-9]{1,20}$/;
const SIZE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Unknown keys anywhere in `answers` (or values of the wrong kind of shape).
function shapeErrors(answers) {
    const errors = [];
    if (!isObject(answers)) return [{ field: "answers", code: "invalid", message: "must be an object" }];
    const walk = (value, shape, path) => {
        for (const key of Object.keys(value)) {
            const at = path ? `${path}.${key}` : key;
            if (!(key in shape)) errors.push({ field: at, code: "unknown", message: "is not a form field" });
            else if (shape[key] !== true) {
                if (!isObject(value[key])) errors.push({ field: at, code: "invalid", message: "must be an object" });
                else walk(value[key], shape[key], at);
            }
        }
    };
    walk(answers, SHAPE, "");
    return errors;
}

// { values (snapshot/response columns), idempotencyKey } or { errors }.
// The server's own rules; the form checks the same before sending.
export function parseSubmission(body, { now = new Date() } = {}) {
    if (!isObject(body)) return { errors: [{ field: "body", code: "invalid", message: "must be a JSON object" }] };
    const errors = [];
    for (const key of Object.keys(body)) {
        if (key !== "answers" && key !== "idempotencyKey") errors.push({ field: key, code: "unknown", message: "is not accepted" });
    }
    if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)) {
        errors.push({ field: "idempotencyKey", code: "invalid", message: "must be 16 to 64 letters, digits, - or _" });
    }
    errors.push(...shapeErrors(body.answers));
    if (errors.length) return { errors };

    const today = businessDateOf(now);
    const read = (group, key) => group.split(".").reduce((value, part) => value?.[part], body.answers)?.[key];
    const values = {};
    const fail = (path, code, message) => {
        errors.push({ field: path, code, message });
        return null;
    };
    for (const [group, key, column, kind, options] of ANSWER_FIELDS) {
        const path = `${group}.${key}`;
        const raw = read(group, key);
        if (raw !== undefined && raw !== null && typeof raw !== "string") {
            values[column] = fail(path, "invalid", "must be text");
            continue;
        }
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value) {
            values[column] = options.required ? fail(path, "required", "is required") : null;
            continue;
        }
        // "N/A" is an answer only where it is allowed; it never reaches a format check.
        if (isNotApplicable(value)) {
            values[column] = NOT_APPLICABLE_FIELDS.has(path) ? NOT_APPLICABLE : fail(path, "invalid", "N/A is not accepted for this field");
            continue;
        }
        switch (kind) {
            case "text":
                values[column] = value.length > options.max ? fail(path, "tooLong", `must be at most ${options.max} characters`) : toUpperEnglish(value);
                break;
            case "email":
                values[column] = value.length <= MAX.email && EMAIL_PATTERN.test(value) ? value : fail(path, "invalid", "must be an email address");
                break;
            case "phone":
                values[column] = value.length <= MAX.phone && PHONE_PATTERN.test(value.replace(/[\s-]/g, "")) ? value : fail(path, "invalid", "must be a phone number");
                break;
            case "code":
                values[column] = options.codes.includes(value) ? value : fail(path, "invalid", "is not one of the choices");
                break;
            case "size":
                values[column] = SIZE_PATTERN.test(value) ? toUpperEnglish(value) : fail(path, "invalid", "must be a short size");
                break;
            case "passport": {
                const compact = value.replace(/[\s-]/g, "").toUpperCase();
                values[column] = value.length <= MAX.passport && PASSPORT_PATTERN.test(compact) ? compact : fail(path, "invalid", "must be letters and digits");
                break;
            }
            case "nic": {
                const compact = value.replace(/\s/g, "").toUpperCase();
                values[column] = NIC_PATTERN.test(compact) ? compact : fail(path, "invalid", "must be a Sri Lankan NIC");
                break;
            }
            case "date": {
                const parsed = new Date(`${value}T00:00:00.000Z`);
                if (!DATE_PATTERN.test(value) || Number.isNaN(parsed.getTime()) || isoDay(parsed) !== value || value < EARLIEST_DATE || value > LATEST_EXPIRY_DATE) {
                    values[column] = fail(path, "invalid", "must be a real date");
                } else if (options.notFuture && value > today) {
                    values[column] = fail(path, "invalid", "must not be in the future");
                } else {
                    values[column] = parsed;
                }
                break;
            }
            default:
                values[column] = fail(path, "invalid", "is not valid");
        }
    }

    // Hidden answers are never stored: spouse only when married, the other
    // category only with OTHER (which then requires it).
    if (values.civilStatus !== "MARRIED") {
        for (const column of ["spouseName", "spouseSurname", "spousePassportNumber", "spouseBirthDate"]) values[column] = null;
        for (let i = errors.length - 1; i >= 0; i--) if (errors[i].field.startsWith("family.spouse.")) errors.splice(i, 1);
    }
    if (values.jobCategory === OTHER_JOB_CATEGORY) {
        if (!values.jobCategoryOther && !errors.some((e) => e.field === "qualifications.jobCategoryOther")) {
            errors.push({ field: "qualifications.jobCategoryOther", code: "required", message: "is required" });
        }
    } else {
        values.jobCategoryOther = null;
        for (let i = errors.length - 1; i >= 0; i--) if (errors[i].field === "qualifications.jobCategoryOther") errors.splice(i, 1);
    }
    // The conditionally required answers (see ANSWER_FIELDS). A field that already has
    // a problem keeps that one message.
    const requireAnswer = (path, column) => {
        if ((values[column] === null || values[column] === undefined) && !errors.some((e) => e.field === path)) {
            errors.push({ field: path, code: "required", message: "is required" });
        }
    };
    const real = (value) => value !== null && value !== undefined && value !== NOT_APPLICABLE;
    for (const who of ["father", "mother"]) {
        if (values[`${who}Name`] === NOT_APPLICABLE) continue;
        requireAnswer(`family.${who}.surname`, `${who}Surname`);
        requireAnswer(`family.${who}.passportNumber`, `${who}PassportNumber`);
        requireAnswer(`family.${who}.birthDate`, `${who}BirthDate`);
    }
    if (values.civilStatus === "MARRIED") {
        requireAnswer("family.spouse.name", "spouseName");
        requireAnswer("family.spouse.surname", "spouseSurname");
        requireAnswer("family.spouse.passportNumber", "spousePassportNumber");
        requireAnswer("family.spouse.birthDate", "spouseBirthDate");
    }
    if (real(values.child1Name)) requireAnswer("family.child2", "child2Name");
    if (real(values.child1Name) && real(values.child2Name)) requireAnswer("family.child3", "child3Name");

    if (values.passportIssueDate && values.passportExpiryDate && values.passportExpiryDate <= values.passportIssueDate) {
        errors.push({ field: "passport.expiryDate", code: "invalid", message: "must be after the issue date" });
    }

    return errors.length ? { errors } : { values, idempotencyKey: body.idempotencyKey };
}

// POST /api/public/candidate-details/submit. All or nothing, once:
//   1. compare-and-set the lock UNLOCKED -> SUBMITTED for exactly the
//      session's version (a second submit, a newer link or a revoke all make
//      this match zero rows);
//   2. store the answers (with the verified NIC from the record) and make
//      sure the original-values snapshot exists.
// A retry of the winning request (same idempotency key) gets the same success;
// anything else after submission is 409 with a neutral body.
export async function submitCandidateForm({ db, passportId, linkId, version, kind = "SINGLE", jobId = null, values, idempotencyKey, now = new Date() }) {
    return db.$transaction(async (tx) => {
        if (kind === "JOB_GROUP") {
            // The job must still be PROCESSING and the candidate still on it, now (FOR SHARE
            // keeps a completion from slipping in between this check and the write).
            const [job] = await tx.$queryRaw`SELECT "status" FROM "job" WHERE "id" = ${jobId}::uuid FOR SHARE`;
            const member = job?.status === "PROCESSING" && (await tx.jobCandidate.findFirst({ where: { jobId, passportId, isActive: true }, select: { jobId: true } }));
            if (!member) throw new CandidateError(401, "VERIFICATION_REQUIRED", "Please verify your details again.");
        }
        const { count } = await tx.candidateFormAccess.updateMany({
            where: { passportId, status: FORM_ACCESS_STATUS.UNLOCKED, version },
            data: { status: FORM_ACCESS_STATUS.SUBMITTED, version: version + 1, submittedAt: now, submittedViaLinkId: linkId, submitKey: idempotencyKey, updatedAt: now },
        });
        if (count !== 1) {
            const access = await tx.candidateFormAccess.findUnique({ where: { passportId }, select: { status: true, submitKey: true, submittedAt: true } });
            if (access?.status === FORM_ACCESS_STATUS.SUBMITTED && access.submitKey === idempotencyKey) {
                return { submittedAt: access.submittedAt.toISOString() };
            }
            throw new CandidateError(409, "ALREADY_SUBMITTED", "This form has already been submitted.");
        }
        const candidate = await tx.candidate.findUnique({
            where: { passportId },
            select: {
                nic: true, firstName: true, otherName: true, sex: true, dateOfBirth: true, placeOfBirth: true, address: true, contactNumber: true,
                passportIssueDate: true, passportExpiryDate: true, job: true, jobExperience: true, additionalDetails: true,
            },
        });
        const snapshot = await tx.candidateFormPrefillSnapshot.findUnique({ where: { passportId }, select: { passportId: true } });
        if (!snapshot) {
            await tx.candidateFormPrefillSnapshot.create({
                data: { passportId, ...prefillFromRecords(candidate, candidate.additionalDetails), capturedAt: now, capturedViaLinkId: linkId },
            });
        }
        await tx.candidateFormResponse.create({ data: { passportId, ...values, nic: candidate.nic, submittedAt: now, submittedViaLinkId: linkId } });
        return { submittedAt: now.toISOString() };
    });
}
