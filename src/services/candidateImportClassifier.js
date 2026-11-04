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
// Never touched: passport, unique ID, documents, verification, jobs, form data.
//
// Process columns (`write.extras`, also fill-only, also never for a verified record):
//   OFFICER          matched by first name to ONE active user (any role); the candidate is allocated
//                    to them when it has no allocation (an allocation to someone else: OFFICER_DIFFERS).
//                    No match / several / not active: an ERROR, the row is not imported.
//   VISA STATUS      Submit completes the Visa submission stage, Got Visa the Visa approval stage (a
//                    completed stage stays as it is);
//                    Departed records the candidate as departed (candidate.departed_at, when not yet set).
//                    The Finalizing job stage is never touched.
//   INTERVIEW ...    the Test details stage: date, result and Test ID (testId.js), each only when blank
// COMPANY / AGENT / COMPANY NUMBER (`org`): the Client and its Agent, found by name (case and spaces
// ignored) or created; a Client's registration number filled when blank. Not candidate data: done
// for every row that is imported or matched (not for an ERROR row). A Client is never created without
// an Agent (every Client has one), an Agent never without a Company.
//
// Database reads are batched (loadImportSnapshot): a handful of queries for the whole set of rows,
// never one per row.

import { ROLES } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";
import { ROW_STATUS, toColumns } from "./candidateImportRowValidator.js";
import { firstNameKey, orgKey, phoneDigits } from "./candidateImportNormalizers.js";
import { activeJobTypeNames } from "./jobTypeCatalog.js";
import { formatTestId } from "./testId.js";

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
    departedAt: true,
    allocation: { select: { analystId: true } },
    stages: {
        where: { stage: { in: ["TEST_DETAILS", "VISA_SUBMISSION", "VISA_APPROVAL"] } },
        select: { stage: true, completed: true, testId: true, jobId: true, testDate: true, testResult: true },
    },
});

// VISA STATUS -> the stage it completes: Submit -> Visa submission, Got Visa -> Visa approval. "Departed"
// is not a stage: it sets candidate.departed_at.
export const VISA_STAGE = Object.freeze({ VISA_SUBMITTED: "VISA_SUBMISSION", VISA_APPROVED: "VISA_APPROVAL" });
const KNOWN_ROLES = new Set(Object.values(ROLES));

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
    return {
        byPassport, nicOwner, whatsappOwners, activeJobTypes: activeJobTypes ?? await activeJobTypeNames(db),
        ...await loadProcessSnapshot(db, rows),
    };
}

// The users (for OFFICER), Clients and Agents the rows name:
//   officers  first-name key -> [{ adminId, name, status }] (every current role; the retired ones never match)
//   clients   name key -> { id, name, isActive, registrationNumber, agentIds }
//   agents    name key -> [{ id, name, isActive, countryCode }] (one name can exist in several countries)
async function loadProcessSnapshot(db, rows) {
    const officers = new Map();
    if (rows.some((r) => r.values?.officer)) {
        const users = await db.user.findMany({ select: { adminId: true, name: true, role: true, status: true } });
        for (const user of users.filter((u) => KNOWN_ROLES.has(u.role))) {
            const key = firstNameKey(user.name);
            if (!key) continue;
            if (!officers.has(key)) officers.set(key, []);
            officers.get(key).push(user);
        }
    }
    const keys = (field) => [...new Set(rows.map((r) => r.values?.[field]).filter(Boolean).map(orgKey))];
    const clients = new Map();
    for (const group of groups(keys("company"), IN_GROUP)) {
        // Two older records with the same normalized name: the oldest is the one used.
        for (const client of await findClientsByKeys(db, group)) if (!clients.has(orgKey(client.name))) clients.set(orgKey(client.name), client);
    }
    const agents = new Map();
    for (const group of groups(keys("agent"), IN_GROUP)) {
        for (const agent of await findAgentsByKeys(db, group)) {
            const key = orgKey(agent.name);
            if (!agents.has(key)) agents.set(key, []);
            agents.get(key).push(agent);
        }
    }
    return { officers, clients, agents };
}

// Clients / Agents by name KEY (orgKey: trimmed, repeated spaces collapsed, lower case), compared with
// the stored name normalized the same way, so "ABC Ltd", "ABC  Ltd" and " abc ltd " are one Client
// whatever spacing an older record was saved with. Used by the preview AND inside the commit
// transaction (candidateImportService.js), so both find the same record.
const NORMALIZED_NAME = (column) => `lower(regexp_replace(btrim("${column}"), '[[:space:]]+', ' ', 'g'))`;
export async function findClientsByKeys(db, keys) {
    if (!keys.length) return [];
    const rows = await db.$queryRawUnsafe(
        `SELECT "id"::text AS "id", "name", "is_active" AS "isActive", "registration_number" AS "registrationNumber" FROM "client" WHERE ${NORMALIZED_NAME("name")} = ANY($1::text[]) ORDER BY "created_at", "id"`,
        keys,
    );
    if (!rows.length) return [];
    const links = await db.agentClient.findMany({ where: { clientId: { in: rows.map((row) => row.id) } }, select: { clientId: true, agentId: true } });
    return rows.map((row) => ({ ...row, agentIds: links.filter((link) => link.clientId === row.id).map((link) => link.agentId) }));
}
export async function findAgentsByKeys(db, keys) {
    if (!keys.length) return [];
    return db.$queryRawUnsafe(
        `SELECT "id"::text AS "id", "name", "is_active" AS "isActive", "country_code" AS "countryCode" FROM "agent" WHERE ${NORMALIZED_NAME("name")} = ANY($1::text[]) ORDER BY "created_at", "id"`,
        keys,
    );
}

// ---------------------------------------------------------------- the file itself

// Rows of the WHOLE file that can't be imported as they are, by source row number (no values):
//   duplicateRows        a passport number appearing on more than one row
//   nicConflictRows      a NIC given for more than one passport
//   whatsappConflictRows a WhatsApp number given for more than one passport (imported without it)
//   companyNumberConflictRows  a Company given with two different Company Numbers (no number written)
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
    const numbered = [...byKey((r) => r.values.company && r.values.companyNumber && orgKey(r.values.company)).values()]
        .filter((g) => new Set(g.map((r) => upper(r.values.companyNumber))).size > 1)
        .flat().map((r) => r.rowNumber);
    return {
        duplicateRows: duplicateRows.sort((a, b) => a - b),
        nicConflictRows: shared((r) => r.values.nic && upper(r.values.nic)).sort((a, b) => a - b),
        whatsappConflictRows: shared((r) => r.values.whatsapp && phoneDigits(r.values.whatsapp)).sort((a, b) => a - b),
        companyNumberConflictRows: numbered.sort((a, b) => a - b),
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

const EMPTY_FLAGS = Object.freeze({ duplicateRows: [], nicConflictRows: [], whatsappConflictRows: [], companyNumberConflictRows: [] });

// The ONE active user a sheet OFFICER names (by first name, any role) -> { user } | { error }.
function matchOfficer(name, officers) {
    const users = officers.get(firstNameKey(name)) ?? [];
    const active = users.filter((user) => user.status === USER_STATUS.ACTIVE);
    if (active.length === 1) return { user: active[0] };
    if (active.length > 1) return { error: "OFFICER_AMBIGUOUS" };
    return { error: users.length ? "OFFICER_NOT_ACTIVE" : "OFFICER_NOT_FOUND" };
}

const stageOf = (existing, stage) => existing?.stages?.find((row) => row.stage === stage) ?? null;

// The Test details to write, fill-only: { fill: { testDate?, testResult?, testId? }, create, differs }.
// The Test ID is generated from the Test date (testId.js) when the stage has none.
function planTest(values, existing) {
    if (!values.testDate && !values.testResult) return null;
    const stored = stageOf(existing, "TEST_DETAILS");
    const imported = {};
    if (values.testDate) imported.testDate = values.testDate;
    if (values.testResult) imported.testResult = values.testResult;
    // The Test ID names the date the stage will hold (a date already there is kept).
    const testDate = stored?.testDate ?? values.testDate;
    if (testDate) imported.testId = formatTestId(testDate);
    if (!stored) return { fill: imported, create: true, differs: false };
    const current = { testDate: stored.testDate, testResult: stored.testResult, testId: stored.testId ?? stored.jobId };
    const { fill, differing } = fillBlanks(current, imported);
    // A stage with a typed Test ID is not "different" for that alone: the typed one is kept.
    const typedId = current.testId && imported.testId && !sameValue("testId", current.testId, imported.testId) ? 1 : 0;
    const differs = differing - typedId > 0;
    return Object.keys(fill).length || differs ? { fill, create: false, differs } : null;
}

// The Client / Agent work of a row -> { org, codes }. org (internal):
//   company        { name, key, clientId }        clientId null = create the Client
//   agent          { name, key, agentId } | null  an Agent to LINK to the Client (agentId null = create it)
//   agentName      the matched / new Agent's name, for the preview (also when already linked)
//   companyNumber  the registration number to fill (blank in Emlynk), or null
// Every refusal is a WARNING: the candidate is imported anyway.
function planOrg(values, snapshot, numberConflict) {
    const codes = [];
    const { company, agent, companyNumber } = values;
    if (!company) {
        if (agent) codes.push("AGENT_NEEDS_COMPANY");
        if (companyNumber) codes.push("COMPANY_NUMBER_WITHOUT_COMPANY");
        return { org: null, codes };
    }
    const client = snapshot.clients.get(orgKey(company)) ?? null;
    let agentRef = null;
    if (agent) {
        const found = snapshot.agents.get(orgKey(agent)) ?? [];
        if (found.length > 1) codes.push("AGENT_AMBIGUOUS");
        else if (found.length === 1 && !found[0].isActive) {
            // An inactive Agent is never given a Client (clientService.js); one already linked stays.
            if (!client?.agentIds.includes(found[0].id)) codes.push("AGENT_INACTIVE");
        } else agentRef = { name: agent, key: orgKey(agent), agentId: found[0]?.id ?? null };
    }
    if (!client && !agentRef) {
        if (!codes.length) codes.push("CLIENT_NEEDS_AGENT");
        return { org: null, codes };
    }
    let number = null;
    if (companyNumber) {
        const stored = client?.registrationNumber ?? null;
        if (numberConflict || (stored && upper(stored.trim()) !== upper(companyNumber))) codes.push("COMPANY_NUMBER_CONFLICT");
        else if (!stored) number = companyNumber;
    }
    const link = Boolean(agentRef) && !(client && agentRef.agentId && client.agentIds.includes(agentRef.agentId));
    return {
        org: {
            company: { name: client?.name ?? company, key: orgKey(company), clientId: client?.id ?? null },
            agent: link ? agentRef : null,
            agentName: agentRef?.name ?? null,
            agentExists: Boolean(agentRef?.agentId),
            companyNumber: number,
        },
        codes,
    };
}

// One plan per row:
//   { rowNumber, maskedPassport, status, action, existing, codes, issues, differing, write, org, officer }
// issues: [{ field, code }] (codes, with the field each one is about: candidateImportIssues.js)
// write (internal, never sent to the browser):
//   CREATE: { candidate: {...}, details: {...}, extras }
//   FILL:   { passportId, candidate: {...}, details: {...}, detailsExists, extras }
//   extras: { allocation: { analystId } | null, test: planTest() | null, stages: [stage to complete], departed: boolean }
// org (internal): planOrg(), for every row that is not an ERROR row. officer: { sheetName, userName }.
export function planRows(rows, snapshot, flags = EMPTY_FLAGS) {
    const duplicates = new Set(flags.duplicateRows ?? []);
    const nicConflicts = new Set(flags.nicConflictRows ?? []);
    const whatsappConflicts = new Set(flags.whatsappConflictRows ?? []);
    const numberConflicts = new Set(flags.companyNumberConflictRows ?? []);
    return rows.map((row) => {
        const codes = row.issues.map((i) => i.code);
        const issues = [...row.issues];
        const note = (code, field = null) => {
            if (!codes.includes(code)) codes.push(code);
            if (!issues.some((i) => i.code === code && i.field === field)) issues.push({ field, code });
        };
        const plan = {
            rowNumber: row.rowNumber, maskedPassport: row.maskedPassport, status: row.status, action: ROW_ACTION.NONE, existing: false, codes, issues, differing: 0,
            write: null, org: null, officer: null, blankResult: Boolean(row.values.testResultDefaulted),
        };
        if (row.status === ROW_STATUS.INVALID) return plan;
        // OFFICER: an unmatched officer is an ERROR (never assigned to a guess).
        let officer = null;
        if (row.values.officer) {
            const match = matchOfficer(row.values.officer, snapshot.officers ?? new Map());
            if (match.error) {
                note(match.error, "officer");
                return { ...plan, status: ROW_STATUS.INVALID };
            }
            officer = match.user;
            plan.officer = { sheetName: row.values.officer, userName: officer.name };
        }
        if (duplicates.has(row.rowNumber)) {
            note("DUPLICATE_SOURCE_ROW", "passport");
            return { ...plan, status: ROW_STATUS.DUPLICATE };
        }

        const existing = snapshot.byPassport.get(upper(row.passport)) ?? null;
        plan.existing = Boolean(existing);
        const self = upper(existing?.passportId ?? row.passport);
        const { candidate, details } = toColumns(row.values);

        const nic = candidate.nic ? upper(candidate.nic) : null;
        const nicHolder = nic ? snapshot.nicOwner.get(nic) : undefined;
        if (nicConflicts.has(row.rowNumber) || (nicHolder && nicHolder !== self) || (existing?.nic && nic && upper(existing.nic) !== nic)) {
            note("NIC_CONFLICT", "nic");
            return { ...plan, status: ROW_STATUS.CONFLICT };
        }

        if (candidate.whatsappNumber) {
            const owners = snapshot.whatsappOwners.get(phoneDigits(candidate.whatsappNumber)) ?? new Set();
            if (whatsappConflicts.has(row.rowNumber) || [...owners].some((owner) => owner !== self)) {
                delete candidate.whatsappNumber;
                note("WHATSAPP_CONFLICT", "whatsapp");
            }
        }

        // Client / Agent: not candidate data, so for every row that is not an ERROR row.
        const orgPlan = planOrg(row.values, snapshot, numberConflicts.has(row.rowNumber));
        orgPlan.codes.forEach((code) => note(code, code.startsWith("COMPANY_NUMBER") ? "companyNumber" : code.startsWith("AGENT") ? "agent" : "company"));
        plan.org = orgPlan.org;

        // Allocation, Test and visa stages: fill-only.
        const extras = { allocation: null, test: planTest(row.values, existing), stages: [], departed: false };
        if (officer) {
            const holder = existing?.allocation?.analystId ?? null;
            if (!holder) extras.allocation = { analystId: officer.adminId };
            else if (holder !== officer.adminId) note("OFFICER_DIFFERS", "officer");
        }
        if (extras.test?.differs) note("TEST_DETAILS_DIFFER", "testDate");
        if (extras.test && !Object.keys(extras.test.fill).length) extras.test = null;
        const visaStage = VISA_STAGE[row.values.visaStatus];
        if (visaStage && !stageOf(existing, visaStage)?.completed) extras.stages.push(visaStage);
        if (row.values.visaStatus === "DEPARTED" && !existing?.departedAt) extras.departed = true;
        const hasExtras = Boolean(extras.allocation || extras.test || extras.stages.length || extras.departed);

        if (!existing) {
            applyFamilyRules(details, null, note);
            const status = codes.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;
            return { ...plan, status, action: ROW_ACTION.CREATE, write: { candidate: { passportId: row.passport, ...candidate }, details, extras } };
        }

        const candidateFill = fillBlanks(existing, candidate);
        const storedDetails = existing.additionalDetails ?? null;
        const detailsFill = fillBlanks(storedDetails, details);
        applyPassportDateRule(candidateFill.fill, existing, note);
        applyFamilyRules(detailsFill.fill, storedDetails, note);
        const differing = candidateFill.differing + detailsFill.differing;
        const changes = Object.keys(candidateFill.fill).length + Object.keys(detailsFill.fill).length;
        const status = codes.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;
        if (!changes && !hasExtras) return { ...plan, status, differing, action: ROW_ACTION.NO_CHANGE };
        if (existing.verification?.detailsVerifiedAt) {
            note("SKIPPED_VERIFIED");
            return { ...plan, status, differing, action: ROW_ACTION.SKIP_VERIFIED };
        }
        return {
            ...plan, status, differing, action: ROW_ACTION.FILL,
            write: { passportId: existing.passportId, candidate: candidateFill.fill, details: detailsFill.fill, detailsExists: Boolean(storedDetails), extras },
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
        allocations: count((p) => p.write?.extras?.allocation),
        testsToSet: count((p) => p.write?.extras?.test),
        visaSubmitted: count((p) => p.write?.extras?.stages.includes(VISA_STAGE.VISA_SUBMITTED)),
        visaApproved: count((p) => p.write?.extras?.stages.includes(VISA_STAGE.VISA_APPROVED)),
        departed: count((p) => p.write?.extras?.departed),
        clientsToCreate: new Set(plans.filter((p) => p.org && !p.org.company.clientId).map((p) => p.org.company.key)).size,
        agentsToCreate: new Set(plans.filter((p) => p.org?.agent && !p.org.agent.agentId).map((p) => p.org.agent.key)).size,
        companyNumbersToFill: new Set(plans.filter((p) => p.org?.companyNumber).map((p) => p.org.company.key)).size,
    };
}

// The automatic actions the preview shows before anything is confirmed (no candidate data: user,
// Client and Agent names, and counts). Lists are capped; `rows` is how many rows lead to each.
const MAX_ACTION_ITEMS = 100;
export function importActions(plans) {
    const tally = (entries) => {
        const map = new Map();
        for (const { key, ...item } of entries) {
            if (!map.has(key)) map.set(key, { ...item, rows: 0 });
            map.get(key).rows += 1;
        }
        return [...map.values()].slice(0, MAX_ACTION_ITEMS);
    };
    const willAllocate = (p) => Boolean(p.write?.extras?.allocation);
    return {
        officers: tally(plans.filter((p) => p.officer).map((p) => ({
            key: `${firstNameKey(p.officer.sheetName)}\u0000${p.officer.userName}`, sheetName: p.officer.sheetName, userName: p.officer.userName,
        }))),
        officerAssignments: tally(plans.filter(willAllocate).map((p) => ({ key: p.officer.userName, userName: p.officer.userName }))),
        clients: tally(plans.filter((p) => p.org).map((p) => ({ key: p.org.company.key, name: p.org.company.name, action: p.org.company.clientId ? "REUSE" : "CREATE" }))),
        agents: tally(plans.filter((p) => p.org?.agentName).map((p) => ({ key: orgKey(p.org.agentName), name: p.org.agentName, action: p.org.agentExists ? "REUSE" : "CREATE" }))),
        visa: {
            VISA_SUBMITTED: plans.filter((p) => p.write?.extras?.stages.includes(VISA_STAGE.VISA_SUBMITTED)).length,
            VISA_APPROVED: plans.filter((p) => p.write?.extras?.stages.includes(VISA_STAGE.VISA_APPROVED)).length,
            DEPARTED: plans.filter((p) => p.write?.extras?.departed).length,
        },
        tests: plans.filter((p) => p.write?.extras?.test).length,
        testsBlankResultAsPass: plans.filter((p) => p.write?.extras?.test?.fill.testResult === "PASS" && p.blankResult).length,
    };
}
