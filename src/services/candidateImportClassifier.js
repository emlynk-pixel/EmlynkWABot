// Bulk candidate import: rows (validated, candidateImportRowValidator.js) + the database -> a plan per row.
//
// Identity is the normalized passport number. NIC and WhatsApp support it; a name never does.
//   passport not in the database, identifiers free                  -> NEW (CREATE)
//   passport in the database, NIC compatible (equal or one blank)    -> EXISTING (FILL / NO_CHANGE / SKIP_VERIFIED)
//   passport in the database with another NIC                        -> CONFLICT NIC_CONFLICT
//   the NIC belongs to another passport (database or this file)     -> CONFLICT NIC_CONFLICT
//   the passport appears more than once in the file                  -> DUPLICATE_SOURCE_ROW (every occurrence; none imported)
//   the WhatsApp number belongs to another candidate / passport     -> the row goes on WITHOUT it (WHATSAPP_CONFLICT)
//
// Existing candidates: FILL BLANKS ONLY. A field is written only when the record's value is empty
// and the imported value is valid; a non-empty field is never overwritten (a different value is only
// counted). A record whose details are verified is never changed (SKIPPED_VERIFIED): a change would
// clear its verification (migration 20261022120000), which an import must not do silently.
// Never touched: passport, unique ID, stages, documents, verification, jobs, allocation, form data.
//
// Database reads are batched (loadImportSnapshot): a handful of queries for the whole set of rows,
// never one per row.

import { ROW_STATUS, toColumns } from "./candidateImportRowValidator.js";
import { phoneDigits } from "./candidateImportNormalizers.js";
import { activeJobTypeNames } from "./jobTypeCatalog.js";

export const ROW_ACTION = Object.freeze({ CREATE: "CREATE", FILL: "FILL", NO_CHANGE: "NO_CHANGE", SKIP_VERIFIED: "SKIP_VERIFIED", NONE: "NONE" });

// The detail columns the importer reads and may fill (plus wife_full_name, for the Married rule).
const DETAIL_COLUMNS = Object.freeze([
    "nameAsInPassport", "maritalStatus", "bloodGroup", "height", "weightKg", "tshirtSize", "pantSize", "shoeSize", "englishKnowledge", "email",
    "city", "district", "dsDivision", "gnDivision", "otherJobSkills", "otherJobSkills2", "fatherBirthday", "fatherPassportNumber", "fatherAlive",
    "motherBirthday", "motherPassportNumber", "motherAlive", "wifeBirthday", "spousePassportNumber", "wifeFullName",
    "guardianName", "guardianRelationship", "guardianNic", "guardianBirthday", "guardianPhone", "guardianAddress",
]);
const CANDIDATE_COLUMNS = Object.freeze([
    "firstName", "otherName", "nic", "whatsappNumber", "contactNumber", "address", "dateOfBirth", "placeOfBirth",
    "passportIssueDate", "passportExpiryDate", "sex", "job", "jobExperience",
]);
const PHONE_COLUMNS = new Set(["whatsappNumber", "contactNumber", "guardianPhone"]);
const SPOUSE_COLUMNS = Object.freeze(["wifeBirthday", "spousePassportNumber"]);

export const EXISTING_CANDIDATE_SELECT = Object.freeze({
    passportId: true,
    uniqueId: true,
    ...Object.fromEntries(CANDIDATE_COLUMNS.map((c) => [c, true])),
    additionalDetails: { select: Object.fromEntries(DETAIL_COLUMNS.map((c) => [c, true])) },
    verification: { select: { detailsVerifiedAt: true } },
});

const IN_GROUP = 500;
const OR_GROUP = 200;
const groups = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const upper = (value) => String(value).toUpperCase();

// ---------------------------------------------------------------- database snapshot

// What the plans need from the database for these rows, in a few batched queries:
//   byPassport      upper(passport) -> the existing candidate (details, verification)
//   nicOwner        NIC -> upper(passport) of its holder
//   whatsappOwners  phone digits -> Set(upper(passport)) of every candidate with that number
//   activeJobTypes  the active job type names (once)
export async function loadImportSnapshot(db, rows, { activeJobTypes = null } = {}) {
    const passports = [...new Set(rows.map((r) => r.passport).filter(Boolean))];
    const nics = [...new Set(rows.map((r) => r.values?.nic).filter(Boolean))];
    const numbers = [...new Set(rows.map((r) => r.values?.whatsapp).filter(Boolean).map(phoneDigits).filter(Boolean))];

    const byPassport = new Map();
    for (const group of groups(passports, IN_GROUP)) {
        const found = await db.candidate.findMany({ where: { passportId: { in: group, mode: "insensitive" } }, select: EXISTING_CANDIDATE_SELECT });
        for (const candidate of found) byPassport.set(upper(candidate.passportId), candidate);
    }
    const nicOwner = new Map();
    for (const group of groups(nics, IN_GROUP)) {
        const found = await db.candidate.findMany({ where: { nic: { in: group } }, select: { passportId: true, nic: true } });
        for (const { passportId, nic } of found) nicOwner.set(upper(nic), upper(passportId));
    }
    // whatsapp_number is stored in several formats: narrow by the last four digits, compare digits here.
    const whatsappOwners = new Map();
    const wanted = new Set(numbers);
    for (const group of groups([...new Set(numbers.map((n) => n.slice(-4)))], OR_GROUP)) {
        const found = await db.candidate.findMany({ where: { OR: group.map((tail) => ({ whatsappNumber: { endsWith: tail } })) }, select: { passportId: true, whatsappNumber: true } });
        for (const { passportId, whatsappNumber } of found) {
            const digits = phoneDigits(whatsappNumber);
            if (!digits || !wanted.has(digits)) continue;
            if (!whatsappOwners.has(digits)) whatsappOwners.set(digits, new Set());
            whatsappOwners.get(digits).add(upper(passportId));
        }
    }
    return { byPassport, nicOwner, whatsappOwners, activeJobTypes: activeJobTypes ?? await activeJobTypeNames(db) };
}

// ---------------------------------------------------------------- the file itself

// Rows of the WHOLE file that can't be imported as they are, by source row number (no values):
//   duplicateRows        a passport number appearing on more than one row
//   nicConflictRows      a NIC given for more than one passport
//   whatsappConflictRows a WhatsApp number given for more than one passport (imported without it)
export function findSourceFlags(rows) {
    const usable = rows.filter((r) => r.status !== ROW_STATUS.INVALID && r.passport);
    const byKey = (key) => {
        const map = new Map();
        for (const row of usable) {
            const value = key(row);
            if (!value) continue;
            if (!map.has(value)) map.set(value, []);
            map.get(value).push(row);
        }
        return map;
    };
    const duplicateRows = [...byKey((r) => upper(r.passport)).values()].filter((g) => g.length > 1).flat().map((r) => r.rowNumber);
    const duplicates = new Set(duplicateRows);
    const shared = (key) => [...byKey(key).values()]
        .filter((g) => new Set(g.map((r) => upper(r.passport))).size > 1)
        .flat().map((r) => r.rowNumber).filter((n) => !duplicates.has(n));
    return {
        duplicateRows: duplicateRows.sort((a, b) => a - b),
        nicConflictRows: shared((r) => r.values.nic && upper(r.values.nic)).sort((a, b) => a - b),
        whatsappConflictRows: shared((r) => r.values.whatsapp && phoneDigits(r.values.whatsapp)).sort((a, b) => a - b),
    };
}

// ---------------------------------------------------------------- merge (fill blanks only)

const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const isoDay = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

function sameValue(column, stored, imported) {
    if (stored instanceof Date || imported instanceof Date) return isoDay(stored) === isoDay(imported);
    if (typeof imported === "boolean") return stored === imported;
    if (typeof imported === "number") return Number(stored) === imported;
    if (PHONE_COLUMNS.has(column)) return phoneDigits(stored) !== null && phoneDigits(stored) === phoneDigits(imported);
    return String(stored).trim().toUpperCase() === String(imported).trim().toUpperCase();
}

// The imported values whose stored value is empty; `differing` counts non-empty stored values
// that differ (never overwritten, never shown).
function fillBlanks(stored, imported) {
    const fill = {};
    let differing = 0;
    for (const [column, value] of Object.entries(imported)) {
        const current = stored?.[column];
        if (isBlank(current)) fill[column] = value;
        else if (!sameValue(column, current, value)) differing += 1;
    }
    return { fill, differing };
}

// The Additional Details rules (candidateAdditionalDetailsService.js): Married needs the spouse's
// name, and spouse details are kept only when Married. The import has no spouse NAME (unresolved
// in the legacy sheet), so Married is taken only when the record already holds one.
function applyFamilyRules(details, storedDetails, note) {
    if (details.maritalStatus === "MARRIED" && isBlank(storedDetails?.wifeFullName)) {
        delete details.maritalStatus;
        note("MARRIED_WITHOUT_SPOUSE_NAME");
    }
    const married = (storedDetails?.maritalStatus ?? details.maritalStatus ?? null) === "MARRIED";
    if (!married && SPOUSE_COLUMNS.some((c) => c in details)) {
        SPOUSE_COLUMNS.forEach((c) => delete details[c]);
        note("SPOUSE_DETAILS_NOT_MARRIED");
    }
}

// Issue date before expiry date, counting what the record already holds.
function applyPassportDateRule(candidate, stored, note) {
    const issue = candidate.passportIssueDate ?? stored?.passportIssueDate ?? null;
    const expiry = candidate.passportExpiryDate ?? stored?.passportExpiryDate ?? null;
    if (!issue || !expiry || isoDay(issue) < isoDay(expiry)) return;
    if (candidate.passportIssueDate) delete candidate.passportIssueDate;
    else delete candidate.passportExpiryDate;
    note("PASSPORT_DATES_INCONSISTENT");
}

// ---------------------------------------------------------------- plans

const EMPTY_FLAGS = Object.freeze({ duplicateRows: [], nicConflictRows: [], whatsappConflictRows: [] });

// One plan per row:
//   { rowNumber, maskedPassport, status, action, existing, codes, differing, write }
// write (internal, never sent to the browser):
//   CREATE: { candidate: {...}, details: {...} }
//   FILL:   { passportId, candidate: {...}, details: {...}, detailsExists }
export function planRows(rows, snapshot, flags = EMPTY_FLAGS) {
    const duplicates = new Set(flags.duplicateRows ?? []);
    const nicConflicts = new Set(flags.nicConflictRows ?? []);
    const whatsappConflicts = new Set(flags.whatsappConflictRows ?? []);
    return rows.map((row) => {
        const codes = row.issues.map((i) => i.code);
        const note = (code) => { if (!codes.includes(code)) codes.push(code); };
        const plan = { rowNumber: row.rowNumber, maskedPassport: row.maskedPassport, status: row.status, action: ROW_ACTION.NONE, existing: false, codes, differing: 0, write: null };
        if (row.status === ROW_STATUS.INVALID) return plan;
        if (duplicates.has(row.rowNumber)) {
            note("DUPLICATE_SOURCE_ROW");
            return { ...plan, status: ROW_STATUS.DUPLICATE };
        }

        const existing = snapshot.byPassport.get(upper(row.passport)) ?? null;
        plan.existing = Boolean(existing);
        const self = upper(existing?.passportId ?? row.passport);
        const { candidate, details } = toColumns(row.values);

        const nic = candidate.nic ? upper(candidate.nic) : null;
        const nicHolder = nic ? snapshot.nicOwner.get(nic) : undefined;
        if (nicConflicts.has(row.rowNumber) || (nicHolder && nicHolder !== self) || (existing?.nic && nic && upper(existing.nic) !== nic)) {
            note("NIC_CONFLICT");
            return { ...plan, status: ROW_STATUS.CONFLICT };
        }

        if (candidate.whatsappNumber) {
            const owners = snapshot.whatsappOwners.get(phoneDigits(candidate.whatsappNumber)) ?? new Set();
            if (whatsappConflicts.has(row.rowNumber) || [...owners].some((owner) => owner !== self)) {
                delete candidate.whatsappNumber;
                note("WHATSAPP_CONFLICT");
            }
        }

        if (!existing) {
            applyFamilyRules(details, null, note);
            const status = codes.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;
            return { ...plan, status, action: ROW_ACTION.CREATE, write: { candidate: { passportId: row.passport, ...candidate }, details } };
        }

        const candidateFill = fillBlanks(existing, candidate);
        const storedDetails = existing.additionalDetails ?? null;
        const detailsFill = fillBlanks(storedDetails, details);
        applyPassportDateRule(candidateFill.fill, existing, note);
        applyFamilyRules(detailsFill.fill, storedDetails, note);
        const differing = candidateFill.differing + detailsFill.differing;
        const changes = Object.keys(candidateFill.fill).length + Object.keys(detailsFill.fill).length;
        const status = codes.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;
        if (!changes) return { ...plan, status, differing, action: ROW_ACTION.NO_CHANGE };
        if (existing.verification?.detailsVerifiedAt) {
            note("SKIPPED_VERIFIED");
            return { ...plan, status, differing, action: ROW_ACTION.SKIP_VERIFIED };
        }
        return {
            ...plan, status, differing, action: ROW_ACTION.FILL,
            write: { passportId: existing.passportId, candidate: candidateFill.fill, details: detailsFill.fill, detailsExists: Boolean(storedDetails) },
        };
    });
}

// Counts for a set of plans (no candidate data). `unknownJobRoles`: rows with a role that matched no job type.
export function summarizePlans(plans) {
    const count = (predicate) => plans.filter(predicate).length;
    return {
        totalRows: plans.length,
        new: count((p) => p.action === ROW_ACTION.CREATE),
        existing: count((p) => p.existing),
        willFill: count((p) => p.action === ROW_ACTION.FILL),
        noChange: count((p) => p.action === ROW_ACTION.NO_CHANGE),
        valid: count((p) => p.status === ROW_STATUS.VALID),
        warnings: count((p) => p.status === ROW_STATUS.WARNING),
        invalid: count((p) => p.status === ROW_STATUS.INVALID),
        duplicates: count((p) => p.status === ROW_STATUS.DUPLICATE),
        conflicts: count((p) => p.status === ROW_STATUS.CONFLICT),
        skippedVerified: count((p) => p.action === ROW_ACTION.SKIP_VERIFIED),
        unknownJobRoles: count((p) => p.codes.includes("UNKNOWN_JOB_TYPE")),
        legacyPassportFormat: count((p) => p.codes.includes("LEGACY_PASSPORT_FORMAT")),
        whatsappConflicts: count((p) => p.codes.includes("WHATSAPP_CONFLICT")),
        fieldsDiffering: plans.reduce((sum, p) => sum + p.differing, 0),
    };
}
