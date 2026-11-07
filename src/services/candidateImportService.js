// Bulk candidate import (Settings > Google Sheet Sync > Update Sheet).
//
//   Browser: reads the .xlsx, sends ONLY the allow-listed columns (candidateImportSourceMapping.js)
//   preview()      re-normalize, re-validate, classify against the database; writes NOTHING to
//                  any candidate table; records a candidate_import row (counts, chunk hashes)
//   commitChunk()  one chunk of ~100 previewed rows, in ONE short transaction; the chunk must hash
//                  to what was previewed. A failed chunk rolls back alone (earlier chunks stay) and
//                  is then retried row by row, so one bad row can't block the others. Idempotent:
//                  a committed chunk is never written twice; a retried row finds its own earlier
//                  write as an existing record with nothing to fill.
//   finishImport() totals, lifecycle audit, and a request for the EXISTING reconciliation
//                  (sheet_sync_runs): the database changes already queued themselves through
//                  the existing triggers; the mirror is written by the existing worker only.
//
// The database stays the source of truth: nothing here writes to Google, and no value goes to
// the mirror except through the mapper (candidateSheetMapper.js) from the database.
// Nothing here logs; results hold row numbers, masked passports and reason codes only.

import crypto from "node:crypto";

import { JOB_ROLE_ALIASES, SUPPORTED_SOURCE_COLUMNS, analyzeSourceHeaders, sourceColumnFor, sourceColumnsForClient, sourceHeaderKey } from "./candidateImportSourceMapping.js";
import { ROW_STATUS, sourceCells, validateLegacyRow } from "./candidateImportRowValidator.js";
import { maskIdentifier, normalizePassport, unknownJobRoles } from "./candidateImportNormalizers.js";
import {
    ROW_ACTION, findAgentsByKeys, findClientsByKeys, findSourceFlags, importActions, loadImportSnapshot, planRows, summarizePlans,
} from "./candidateImportClassifier.js";
import { describeIssues } from "./candidateImportIssues.js";
import { activeJobTypeNames } from "./jobTypeCatalog.js";
import { setAuditActor } from "./auditActor.js";
import { RUN_KIND, RUN_TRIGGER } from "./sheetSyncStore.js";
import { requestSheetSyncRun } from "./sheetSyncStatusService.js";
import { allocateImportedCandidates } from "./workAllocationService.js";
import { AGENT_AUDIT_ACTION, ENTITY_STATUS, auditRow as entityAuditRow } from "./agentService.js";
import { CLIENT_AUDIT_ACTION } from "./clientService.js";

export const IMPORT_CHUNK_SIZE = 100;
export const MAX_IMPORT_ROWS = 3000;
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PROBLEM_ROWS = 500;
const CHUNK_TRANSACTION = Object.freeze({ timeout: 30_000, maxWait: 10_000 });
const MAX_CELL_LENGTH = 4000;
const MAX_HEADERS = 400;
const MAX_ROW_KEYS = 200;
// pg_advisory_xact_lock key: bulk unique-ID allocation, one import transaction at a time.
const UNIQUE_ID_LOCK = 724_310_001;
const PASSPORT_HEADER = SUPPORTED_SOURCE_COLUMNS.find((c) => c.field === "passport").header;

export const IMPORT_STATUS = Object.freeze({
    PREVIEWED: "PREVIEWED", COMMITTING: "COMMITTING", COMPLETED: "COMPLETED", COMPLETED_WITH_ERRORS: "COMPLETED_WITH_ERRORS", FAILED: "FAILED",
});
const FINISHED = new Set([IMPORT_STATUS.COMPLETED, IMPORT_STATUS.COMPLETED_WITH_ERRORS, IMPORT_STATUS.FAILED]);

export const IMPORT_AUDIT_ACTION = Object.freeze({
    STARTED: "BULK_IMPORT_STARTED", COMPLETED: "BULK_IMPORT_COMPLETED", FAILED: "BULK_IMPORT_FAILED",
});

// A row's outcome in a commit (stored per chunk, by row number).
export const ROW_OUTCOME = Object.freeze({
    CREATED: "CREATED", FILLED: "FILLED", NO_CHANGE: "NO_CHANGE", SKIPPED_VERIFIED: "SKIPPED_VERIFIED",
    INVALID: "INVALID", DUPLICATE: "DUPLICATE", CONFLICT: "CONFLICT", FAILED: "FAILED",
});
const WRITTEN = new Set([ROW_OUTCOME.CREATED, ROW_OUTCOME.FILLED]);

export class CandidateImportError extends Error {
    constructor(status, code, message, extra = {}) {
        super(message);
        this.name = "CandidateImportError";
        this.status = status;
        this.code = code;
        Object.assign(this, extra);
    }
}

// ---------------------------------------------------------------- request bodies

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// "C:\\fakepath\\Legacy Candidates.xlsx" -> "Legacy Candidates.xlsx". Only a .xlsx workbook.
export function cleanImportFileName(value) {
    if (typeof value !== "string") return null;
    const base = value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^\w .()-]/g, "_").trim().slice(-200);
    return /\.xlsx$/i.test(base) && base.length > 5 ? base : null;
}

function parseRows(rows, { max, errors }) {
    if (!Array.isArray(rows) || rows.length === 0) { errors.push({ field: "rows", message: "must list at least one row" }); return null; }
    if (rows.length > max) { errors.push({ field: "rows", message: `must list at most ${max} rows` }); return null; }
    let previous = 0;
    const parsed = [];
    for (const row of rows) {
        if (!isPlainObject(row) || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 || row.rowNumber <= previous || !isPlainObject(row.values)) {
            errors.push({ field: "rows", message: "each row needs an increasing rowNumber (2 or more) and a values object" });
            return null;
        }
        const entries = Object.entries(row.values);
        if (entries.length > MAX_ROW_KEYS || !entries.every(([, v]) => v === null || ((typeof v === "string" || typeof v === "number") && String(v).length <= MAX_CELL_LENGTH))) {
            errors.push({ field: "rows", message: `each value must be text of at most ${MAX_CELL_LENGTH} characters` });
            return null;
        }
        previous = row.rowNumber;
        parsed.push(row);
    }
    return parsed;
}

// POST .../preview: { fileName, headers: [header text], rows: [{ rowNumber, values: { header: text } }] }
export function parsePreviewBody(body) {
    const errors = [];
    if (!isPlainObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const fileName = cleanImportFileName(body.fileName);
    if (!fileName) errors.push({ field: "fileName", message: "must be an .xlsx file name" });
    const headers = body.headers;
    if (!Array.isArray(headers) || headers.length === 0 || headers.length > MAX_HEADERS || !headers.every((h) => typeof h === "string" && h.length <= 200)) {
        errors.push({ field: "headers", message: `must list the sheet's headers (at most ${MAX_HEADERS})` });
    }
    const rows = parseRows(body.rows, { max: MAX_IMPORT_ROWS, errors });
    return errors.length ? { errors } : { values: { fileName, headers, rows } };
}

// POST .../chunks/:index: { rows }
export function parseChunkBody(body) {
    const errors = [];
    if (!isPlainObject(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const rows = parseRows(body.rows, { max: IMPORT_CHUNK_SIZE, errors });
    return errors.length ? { errors } : { values: { rows } };
}

export const isValidImportId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// ---------------------------------------------------------------- canonical rows and hashes

// Only the allow-listed columns, keys normalized and sorted, values as text: the same rows always
// give the same form (and hash), whatever the browser's key order or spelling of a header.
export function canonicalRows(rows) {
    return rows.map(({ rowNumber, values }) => {
        const kept = new Map();
        for (const [header, value] of Object.entries(values)) {
            const key = sourceHeaderKey(header);
            if (!sourceColumnFor(key)?.field || kept.has(key)) continue;
            kept.set(key, value === null || value === undefined ? "" : String(value));
        }
        return { rowNumber, values: Object.fromEntries([...kept].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
    });
}

export const hashChunk = (rows) => crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");

export function chunkRows(rows, size = IMPORT_CHUNK_SIZE) {
    return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
}

// ---------------------------------------------------------------- preview

const problemOf = (plan) => ({ rowNumber: plan.rowNumber, passport: plan.maskedPassport, status: plan.status, action: plan.action, codes: plan.codes, ...describeIssues(plan.issues) });
const isProblem = (plan) => plan.status !== ROW_STATUS.VALID || plan.action === ROW_ACTION.SKIP_VERIFIED;

// Every row with an issue, as readable messages (candidateImportIssues.js): the SAME messages as the
// problems table, for the ERRORS / WARNINGS columns of the validation sheet the browser builds.
// Row numbers and messages only: no cell value.
const rowIssuesOf = (plans) => plans.filter((plan) => plan.issues.length).map((plan) => ({ rowNumber: plan.rowNumber, ...describeIssues(plan.issues) }));

// A Job Role in the sheet that is not a job type (and has no alias) becomes a new job type, so no
// role is lost. Preview (create = false) only counts them as if they existed; the commit creates them.
// Returns the active job type names to validate with.
async function jobTypesWithSheetRoles(db, canonical, { create }) {
    const activeJobTypes = await activeJobTypeNames(db);
    const fresh = new Set();
    for (const row of canonical) {
        for (const name of unknownJobRoles(sourceCells(row.values).jobRole, { activeJobTypes, aliases: JOB_ROLE_ALIASES })) fresh.add(name);
    }
    if (!fresh.size) return activeJobTypes;
    const added = [...fresh].map((name) => ({ name, code: name.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") })).filter((type) => type.code);
    if (!create) return [...activeJobTypes, ...added.map((type) => type.name)];
    // One statement; only the rows actually created come back (a code that already exists, e.g. an
    // inactive type, is skipped and its role stays unmatched, as an inactive type should).
    const created = await db.jobType.createManyAndReturn({ data: added.map((type) => ({ ...type, isActive: true })), skipDuplicates: true, select: { name: true } });
    return [...activeJobTypes, ...created.map((row) => row.name)];
}

// The allow-list for the browser.
export const importSourceColumns = () => sourceColumnsForClient();

// Validates and classifies the rows; writes nothing to a candidate table. Returns the counts, the
// problem rows (masked) and the importId the commit refers to.
export async function previewImport({ db, actor, fileName, headers, rows, now = new Date() }) {
    const columns = analyzeSourceHeaders(headers);
    if (columns.missingRequired.length) {
        throw new CandidateImportError(422, "MISSING_REQUIRED_HEADINGS", `The sheet is missing required headings: ${columns.missingRequired.join(", ")}.`, { missing: columns.missingRequired });
    }
    const canonical = canonicalRows(rows);
    const activeJobTypes = await jobTypesWithSheetRoles(db, canonical, { create: false });
    const validated = canonical.map((row) => validateLegacyRow(row, { activeJobTypes, today: now }));
    const sourceFlags = findSourceFlags(validated);
    const snapshot = await loadImportSnapshot(db, validated, { activeJobTypes });
    const plans = planRows(validated, snapshot, sourceFlags);
    const summary = {
        ...summarizePlans(plans),
        ignoredSourceColumns: columns.ignored.length + columns.systemGenerated.length + columns.unresolved.length + columns.unknown.length,
    };
    const chunks = chunkRows(canonical);
    const importId = crypto.randomUUID();
    await db.candidateImport.create({
        data: {
            importId, adminId: actor.adminId, fileName, status: IMPORT_STATUS.PREVIEWED, totalRows: canonical.length, chunkSize: IMPORT_CHUNK_SIZE,
            chunkHashes: chunks.map(hashChunk), sourceFlags, previewCounts: summary, chunkResults: {}, createdAt: now, updatedAt: now,
        },
    });
    const problems = plans.filter(isProblem);
    return {
        importId, chunkSize: IMPORT_CHUNK_SIZE, chunkCount: chunks.length, expiresAt: new Date(now.getTime() + IMPORT_PREVIEW_TTL_MS).toISOString(),
        summary, columns, problems: problems.slice(0, MAX_PROBLEM_ROWS).map(problemOf), problemsTruncated: problems.length > MAX_PROBLEM_ROWS,
        rowIssues: rowIssuesOf(plans), actions: importActions(plans),
    };
}

// ---------------------------------------------------------------- unique IDs

// Bulk unique IDs: one advisory lock and ONE max() query for a whole chunk, instead of reading every
// candidate once per new candidate (candidateService.js nextUniqueId, which single registration
// keeps using). Same numbering: the highest numeric unique_id + 1, zero-padded to 4. A concurrent
// single registration can still take one of these numbers first: the insert then fails on the
// unique index and the chunk is retried with fresh numbers (commitChunk).
export async function allocateUniqueIds(tx, count) {
    if (count <= 0) return [];
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${UNIQUE_ID_LOCK})`);
    const [{ highest }] = await tx.$queryRaw`SELECT COALESCE(MAX(CAST("unique_id" AS BIGINT)), 0)::text AS "highest" FROM "candidate" WHERE "unique_id" ~ '^[0-9]{1,15}$'`;
    const start = Number(highest) + 1;
    return Array.from({ length: count }, (_, i) => String(start + i).padStart(4, "0"));
}

// ---------------------------------------------------------------- writes

const auditEntry = (actor, data) => ({ auditId: crypto.randomUUID(), adminId: actor.adminId, ...data });

// The plans' writes, inside the caller's transaction. Returns the plans' outcomes.
async function executePlans(tx, plans, { importId, actor, now = new Date() }) {
    const audits = [];
    const creates = plans.filter((p) => p.action === ROW_ACTION.CREATE);
    if (creates.length) {
        const ids = await allocateUniqueIds(tx, creates.length);
        await tx.candidate.createMany({ data: creates.map((p, i) => ({ ...p.write.candidate, uniqueId: ids[i] })) });
        const details = creates.filter((p) => Object.keys(p.write.details).length).map((p) => ({ passportId: p.write.candidate.passportId, ...p.write.details }));
        if (details.length) await tx.candidateAdditionalDetails.createMany({ data: details });
        creates.forEach((p, i) => audits.push(auditEntry(actor, {
            action: "CREATE_CANDIDATE", passportId: p.write.candidate.passportId, previousStatus: "NONE", newStatus: "CREATED",
            reason: `Candidate imported from a legacy sheet (bulk import ${importId}, ${ids[i]})`,
            // Which fields were given, never their values.
            newValue: JSON.stringify({ uniqueId: ids[i], importId, fields: Object.keys(p.write.candidate).filter((f) => f !== "passportId"), details: Object.keys(p.write.details) }),
        })));
    }
    for (const plan of plans.filter((p) => p.action === ROW_ACTION.FILL)) {
        const { passportId, candidate, details, detailsExists } = plan.write;
        if (Object.keys(candidate).length) {
            await tx.candidate.update({ where: { passportId }, data: candidate });
            audits.push(auditEntry(actor, {
                action: "UPDATE_CANDIDATE", passportId, previousStatus: "CREATED", newStatus: "UPDATED",
                reason: `Blank fields filled from a legacy sheet (bulk import ${importId})`,
                // The candidate history lists these keys; the values are never recorded.
                newValue: JSON.stringify(Object.fromEntries(Object.keys(candidate).map((f) => [f, null]))),
            }));
        }
        if (Object.keys(details).length) {
            if (detailsExists) await tx.candidateAdditionalDetails.update({ where: { passportId }, data: details });
            else await tx.candidateAdditionalDetails.create({ data: { passportId, ...details } });
            audits.push(auditEntry(actor, {
                action: detailsExists ? "UPDATE_ADDITIONAL_DETAILS" : "CREATE_ADDITIONAL_DETAILS", passportId,
                previousStatus: detailsExists ? "EXISTS" : "NONE", newStatus: detailsExists ? "UPDATED" : "CREATED",
                reason: `Blank additional details filled from a legacy sheet (bulk import ${importId})`,
                newValue: JSON.stringify({ importId, fields: Object.keys(details) }),
            }));
        }
    }
    const effects = new Map(plans.map((plan) => [plan.rowNumber, {}]));
    await executeOrg(tx, plans, { importId, actor, audits, effects });
    await executeExtras(tx, plans, { importId, actor, audits, effects, now });
    if (audits.length) await tx.auditLog.createMany({ data: audits });
    return plans.map((plan) => outcomeOf(plan, effects.get(plan.rowNumber)));
}

const passportOfPlan = (plan) => plan.write.passportId ?? plan.write.candidate.passportId;
const isoDayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);

// Allocation (to the OFFICER), the Test details, the visa stage and Departed of the CREATE / FILL rows, all
// fill-only (planned in candidateImportClassifier.js against this transaction's own snapshot).
async function executeExtras(tx, plans, { importId, actor, audits, effects, now }) {
    const writing = plans.filter((plan) => plan.write?.extras && (plan.action === ROW_ACTION.CREATE || plan.action === ROW_ACTION.FILL));
    const entries = writing.filter((plan) => plan.write.extras.allocation).map((plan) => ({ passportId: passportOfPlan(plan), analystId: plan.write.extras.allocation.analystId }));
    const allocated = new Set(await allocateImportedCandidates(tx, { actor, entries }));
    const stageAudit = (passportId, stage, { from, to, before, after }) => audits.push(auditEntry(actor, {
        action: "UPDATE_STAGE", passportId, previousStatus: from ? "COMPLETED" : "NOT_COMPLETED", newStatus: to ? "COMPLETED" : "NOT_COMPLETED",
        reason: `Set from a legacy sheet (bulk import ${importId})`,
        previousValue: JSON.stringify({ stage, ...before }), newValue: JSON.stringify({ stage, ...after }),
    }));
    // A new candidate has no stage rows: its rows are inserted together. An existing one's are upserted.
    const inserts = [];
    const write = (plan, stage, create, update) => {
        if (plan.action === ROW_ACTION.CREATE) inserts.push(create);
        else return tx.candidateStage.upsert({ where: { passportId_stage: { passportId: create.passportId, stage } }, create, update });
        return null;
    };
    for (const plan of writing) {
        const passportId = passportOfPlan(plan);
        const { test, stages } = plan.write.extras;
        const effect = effects.get(plan.rowNumber);
        if (allocated.has(passportId)) effect.allocated = 1;
        if (test) {
            // A new Test details row is completed when it has a result (a test held).
            const completed = test.create && Boolean(test.fill.testResult);
            await write(plan, "TEST_DETAILS", { passportId, stage: "TEST_DETAILS", ...test.fill, completed, completedAt: completed ? now : null }, test.fill);
            const after = Object.fromEntries(Object.entries(test.fill).map(([field, value]) => [field, isoDayOf(value)]));
            const before = Object.fromEntries(Object.keys(test.fill).map((field) => [field, null]));
            stageAudit(passportId, "TEST_DETAILS", { from: false, to: completed, before, after: completed ? { ...after, completed: true } : after });
            effect.testSet = 1;
        }
        for (const stage of stages) {
            await write(plan, stage, { passportId, stage, completed: true, completedAt: now }, { completed: true, completedAt: now });
            stageAudit(passportId, stage, { from: false, to: true, before: { completed: false }, after: { completed: true } });
            effect.stagesCompleted = (effect.stagesCompleted ?? 0) + 1;
        }
    }
    if (inserts.length) await tx.candidateStage.createMany({ data: inserts });

    // VISA STATUS "Departed": candidate.departed_at, once (fill-only), in one statement.
    const departing = writing.filter((plan) => plan.write.extras.departed);
    if (departing.length) {
        const passportIds = departing.map(passportOfPlan);
        await tx.candidate.updateMany({ where: { passportId: { in: passportIds }, departedAt: null }, data: { departedAt: now } });
        for (const plan of departing) {
            effects.get(plan.rowNumber).departed = 1;
            audits.push(auditEntry(actor, {
                action: "CANDIDATE_DEPARTED", passportId: passportOfPlan(plan), previousStatus: "NOT_DEPARTED", newStatus: "DEPARTED",
                reason: `Visa status Departed in a legacy sheet (bulk import ${importId})`, newValue: JSON.stringify({ importId }),
            }));
        }
    }
}

// The Clients and Agents the rows name: found again by name key (case and spacing ignored,
// findClientsByKeys / findAgentsByKeys) inside this transaction (an earlier
// chunk may have created one since the preview), else created, then linked; a blank registration
// number filled. Through the same audit actions as Admin > Clients / Agents. A name created twice at
// the same time fails on the unique indexes and the chunk is retried row by row (it then finds it).
async function executeOrg(tx, plans, { importId, actor, audits, effects }) {
    const agentIds = new Map();
    const clientIds = new Map();
    const reason = (what) => `${what} by a legacy sheet (bulk import ${importId})`;
    for (const plan of plans.filter((p) => p.org)) {
        const { company, agent, companyNumber } = plan.org;
        const effect = effects.get(plan.rowNumber);
        let agentId = null;
        if (agent) {
            agentId = agent.agentId ?? agentIds.get(agent.key) ?? null;
            if (!agentId) {
                const found = await findAgentsByKeys(tx, [agent.key]);
                if (found.length === 1 && found[0].isActive) agentId = found[0].id;
                else if (!found.length) {
                    const row = await tx.agent.create({ data: { name: agent.name, countryCode: null }, select: { id: true } });
                    agentId = row.id;
                    effect.agentCreated = 1;
                    audits.push(entityAuditRow({
                        actor, action: AGENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: ENTITY_STATUS.ACTIVE, reason: reason("Agent created"),
                        newValue: JSON.stringify({ agentId, name: agent.name, countryCode: null, clientIds: [] }),
                    }));
                }
                agentIds.set(agent.key, agentId);
            }
        }
        let clientId = company.clientId ?? clientIds.get(company.key) ?? null;
        let created = false;
        if (!clientId) {
            clientId = (await findClientsByKeys(tx, [company.key]))[0]?.id ?? null;
            if (!clientId) {
                if (!agentId) continue; // every Client has an Agent: none usable, no Client
                clientId = (await tx.client.create({ data: { name: company.name, registrationNumber: companyNumber }, select: { id: true } })).id;
                created = true;
                effect.clientCreated = 1;
                audits.push(entityAuditRow({
                    actor, action: CLIENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: ENTITY_STATUS.ACTIVE, reason: reason("Client created"),
                    newValue: JSON.stringify({ clientId, name: company.name, agentIds: [agentId] }),
                }));
            }
            clientIds.set(company.key, clientId);
        }
        if (agentId) {
            const { count } = await tx.agentClient.createMany({ data: [{ agentId, clientId }], skipDuplicates: true });
            if (count && !created) {
                audits.push(entityAuditRow({
                    actor, action: CLIENT_AUDIT_ACTION.AGENT_CHANGED, previousStatus: ENTITY_STATUS.ACTIVE, newStatus: ENTITY_STATUS.ACTIVE,
                    reason: reason("Client's agents changed: 1 added, 0 removed"), newValue: JSON.stringify({ clientId, added: [agentId], removed: [] }),
                }));
            }
        }
        if (companyNumber && !created) {
            const { count } = await tx.client.updateMany({ where: { id: clientId, OR: [{ registrationNumber: null }, { registrationNumber: "" }] }, data: { registrationNumber: companyNumber } });
            if (count) {
                audits.push(entityAuditRow({
                    actor, action: CLIENT_AUDIT_ACTION.UPDATED, previousStatus: ENTITY_STATUS.ACTIVE, newStatus: ENTITY_STATUS.ACTIVE,
                    reason: reason("Client updated: registrationNumber"), previousValue: JSON.stringify({ clientId, registrationNumber: null }),
                    newValue: JSON.stringify({ clientId, registrationNumber: companyNumber }),
                }));
            }
        }
    }
}

const OUTCOME_BY_ACTION = { [ROW_ACTION.CREATE]: ROW_OUTCOME.CREATED, [ROW_ACTION.FILL]: ROW_OUTCOME.FILLED, [ROW_ACTION.NO_CHANGE]: ROW_OUTCOME.NO_CHANGE, [ROW_ACTION.SKIP_VERIFIED]: ROW_OUTCOME.SKIPPED_VERIFIED };
const OUTCOME_BY_STATUS = { [ROW_STATUS.INVALID]: ROW_OUTCOME.INVALID, [ROW_STATUS.DUPLICATE]: ROW_OUTCOME.DUPLICATE, [ROW_STATUS.CONFLICT]: ROW_OUTCOME.CONFLICT };

// { r: row number, o: outcome, c: reason codes, w: had a warning, e?: what else was written }
// e: { allocated, testSet, stagesCompleted, departed, clientCreated, agentCreated } (only the non-zero ones)
function outcomeOf(plan, effect = {}) {
    const outcome = { r: plan.rowNumber, o: OUTCOME_BY_ACTION[plan.action] ?? OUTCOME_BY_STATUS[plan.status] ?? ROW_OUTCOME.FAILED, c: plan.codes, w: plan.status === ROW_STATUS.WARNING };
    return Object.keys(effect).length ? { ...outcome, e: effect } : outcome;
}

// A retry never loses an earlier attempt's write: a row CREATED / FILLED before keeps that outcome.
function mergeOutcomes(previous, current) {
    const earlier = new Map((previous?.rows ?? []).map((row) => [row.r, row]));
    return current.map((row) => (WRITTEN.has(earlier.get(row.r)?.o) ? earlier.get(row.r) : row));
}

export function countOutcomes(rows) {
    const count = (outcome) => rows.filter((row) => row.o === outcome).length;
    return {
        rows: rows.length, created: count(ROW_OUTCOME.CREATED), filled: count(ROW_OUTCOME.FILLED), noChange: count(ROW_OUTCOME.NO_CHANGE),
        skippedVerified: count(ROW_OUTCOME.SKIPPED_VERIFIED), invalid: count(ROW_OUTCOME.INVALID), duplicates: count(ROW_OUTCOME.DUPLICATE),
        conflicts: count(ROW_OUTCOME.CONFLICT), failed: count(ROW_OUTCOME.FAILED),
        warnings: rows.filter((row) => row.w && WRITTEN.has(row.o)).length,
        ...Object.fromEntries(Object.entries(EFFECT_COUNTS).map(([name, key]) => [name, rows.reduce((sum, row) => sum + (row.e?.[key] ?? 0), 0)])),
    };
}

// Result count -> the per-row effect it adds up (outcomeOf).
const EFFECT_COUNTS = Object.freeze({
    allocated: "allocated", testsSet: "testSet", stagesCompleted: "stagesCompleted", departed: "departed", clientsCreated: "clientCreated", agentsCreated: "agentCreated",
});

const chunkResult = (rows) => {
    const counts = countOutcomes(rows);
    return { status: counts.failed ? "PARTIAL" : "COMMITTED", counts, rows };
};

// ---------------------------------------------------------------- commit

async function requireImport(db, { importId, actor, now }) {
    const record = await db.candidateImport.findUnique({ where: { importId } });
    if (!record) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
    // Only the person who previewed the file commits it.
    if (record.adminId !== actor.adminId) throw new CandidateImportError(403, "NOT_YOUR_IMPORT", "This import was started by another user.");
    if (FINISHED.has(record.status)) throw new CandidateImportError(409, "IMPORT_FINISHED", "This import is already finished.");
    if (record.status === IMPORT_STATUS.PREVIEWED && now.getTime() - new Date(record.createdAt).getTime() > IMPORT_PREVIEW_TTL_MS) {
        throw new CandidateImportError(410, "PREVIEW_EXPIRED", "This preview has expired. Upload the sheet again.");
    }
    return record;
}

const isUniqueViolation = (error) => error?.code === "P2002";
const uniqueTarget = (error) => {
    const target = error?.meta?.target ?? error?.meta?.driverAdapterError?.cause?.constraint?.fields;
    return Array.isArray(target) ? target.join(",") : String(target ?? "");
};
const failureCode = (error) => {
    // The officer was deactivated after the preview (allocateImportedCandidates).
    if (/^OFFICER_/.test(error?.code ?? "")) return error.code;
    if (!isUniqueViolation(error)) return "DB_ERROR";
    const target = uniqueTarget(error);
    if (/nic/i.test(target)) return "NIC_CONFLICT";
    if (/whatsapp/i.test(target)) return "WHATSAPP_CONFLICT";
    if (/unique_id|uniqueId/i.test(target)) return "UNIQUE_ID_COLLISION";
    if (/name/i.test(target)) return "DB_ERROR"; // a Client / Agent name taken at the same time
    return "PASSPORT_EXISTS";
};

// The import row, locked for the rest of the transaction: two requests for the same import never
// interleave (the second waits, then finds the first one's result).
async function lockImport(tx, importId) {
    const [locked] = await tx.$queryRaw`SELECT "status", "chunk_results" AS "chunkResults" FROM "candidate_import" WHERE "import_id" = ${importId}::uuid FOR UPDATE`;
    const chunkResults = typeof locked.chunkResults === "string" ? JSON.parse(locked.chunkResults) : locked.chunkResults ?? {};
    return { status: locked.status, chunkResults };
}

// The chunk's result written to the (locked) import row, with BULK_IMPORT_STARTED on the first commit.
async function recordChunk(tx, locked, { importId, chunkIndex, actor, rows, now }) {
    const results = locked.chunkResults;
    const result = chunkResult(mergeOutcomes(results[chunkIndex], rows));
    if (locked.status === IMPORT_STATUS.PREVIEWED) {
        await tx.auditLog.create({ data: auditEntry(actor, { action: IMPORT_AUDIT_ACTION.STARTED, previousStatus: IMPORT_STATUS.PREVIEWED, newStatus: IMPORT_STATUS.COMMITTING, reason: `Bulk candidate import ${importId} started`, newValue: JSON.stringify({ importId }) }) });
    }
    await tx.candidateImport.update({
        where: { importId },
        data: { status: IMPORT_STATUS.COMMITTING, chunkResults: { ...results, [chunkIndex]: result }, updatedAt: now },
    });
    return result;
}

// Commits one previewed chunk. Returns { chunkIndex, status, counts, failures: [{ rowNumber, passport, codes }] }.
export async function commitChunk({ db, actor, importId, chunkIndex, rows, now = new Date(), maxAttempts = 3 }) {
    const record = await requireImport(db, { importId, actor, now });
    const hashes = Array.isArray(record.chunkHashes) ? record.chunkHashes : [];
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= hashes.length) throw new CandidateImportError(400, "INVALID_CHUNK", "Unknown chunk.");
    const canonical = canonicalRows(rows);
    if (hashChunk(canonical) !== hashes[chunkIndex]) {
        throw new CandidateImportError(409, "CHUNK_MISMATCH", "These rows are not the rows that were previewed. Upload the sheet again.");
    }
    const previous = record.chunkResults?.[chunkIndex];
    if (previous?.status === "COMMITTED") return present(chunkIndex, previous, canonical, { alreadyCommitted: true });

    const activeJobTypes = await jobTypesWithSheetRoles(db, canonical, { create: true });
    const validated = canonical.map((row) => validateLegacyRow(row, { activeJobTypes, today: now }));
    const context = { importId, actor, now };

    // The whole chunk in one transaction; a unique-ID race is retried with fresh numbers.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await db.$transaction(async (tx) => {
                const locked = await lockImport(tx, importId);
                if (locked.chunkResults[chunkIndex]?.status === "COMMITTED") return { ...locked.chunkResults[chunkIndex], alreadyCommitted: true };
                await setAuditActor(tx, actor);
                const snapshot = await loadImportSnapshot(tx, validated, { activeJobTypes });
                const outcomes = await executePlans(tx, planRows(validated, snapshot, record.sourceFlags), context);
                return recordChunk(tx, locked, { importId, chunkIndex, actor, rows: outcomes, now });
            }, CHUNK_TRANSACTION);
            return present(chunkIndex, result, canonical, result.alreadyCommitted ? { alreadyCommitted: true } : {});
        } catch (error) {
            if (failureCode(error) === "UNIQUE_ID_COLLISION" && attempt < maxAttempts) continue;
            break;
        }
    }

    // The chunk failed as a whole (and rolled back alone): each row on its own, so a single bad or
    // conflicting row is isolated and the others are still written.
    const outcomes = [];
    for (const row of validated) {
        try {
            outcomes.push(...await db.$transaction(async (tx) => {
                await setAuditActor(tx, actor);
                const snapshot = await loadImportSnapshot(tx, [row], { activeJobTypes });
                return executePlans(tx, planRows([row], snapshot, record.sourceFlags), context);
            }, CHUNK_TRANSACTION));
        } catch (error) {
            outcomes.push({ r: row.rowNumber, o: ROW_OUTCOME.FAILED, c: [failureCode(error)], w: false });
        }
    }
    const result = await db.$transaction(async (tx) => recordChunk(tx, await lockImport(tx, importId), { importId, chunkIndex, actor, rows: outcomes, now }), CHUNK_TRANSACTION);
    return present(chunkIndex, result, canonical);
}

// The browser's view of a chunk result: counts, and the rows that were not written (masked).
function present(chunkIndex, result, canonical, extra = {}) {
    const passportOf = (row) => row.values[PASSPORT_HEADER] ?? "";
    const masked = new Map(canonical.map((row) => [row.rowNumber, maskIdentifier(normalizePassport(passportOf(row)).value ?? passportOf(row))]));
    return {
        chunkIndex, status: result.status, counts: result.counts, ...extra,
        failures: result.rows.filter((row) => row.o === ROW_OUTCOME.FAILED).map((row) => ({
            rowNumber: row.r, passport: masked.get(row.r) ?? "***", codes: row.c, errors: describeIssues(row.c.map((code) => ({ code }))).errors,
        })),
    };
}

// ---------------------------------------------------------------- finish

const addCounts = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));

// Totals, final status, lifecycle audit, and (when anything was written) the existing RECONCILE run.
export async function finishImport({ db, actor, importId, now = new Date() }) {
    const existing = await db.candidateImport.findUnique({ where: { importId } });
    if (!existing) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
    if (existing.adminId !== actor.adminId) throw new CandidateImportError(403, "NOT_YOUR_IMPORT", "This import was started by another user.");
    if (FINISHED.has(existing.status)) return finishedView(existing, { alreadyFinished: true });

    const chunkCount = Array.isArray(existing.chunkHashes) ? existing.chunkHashes.length : 0;
    const results = existing.chunkResults ?? {};
    const counts = Object.values(results).reduce((sum, result) => addCounts(sum, result.counts ?? {}), {});
    counts.uncommittedChunks = chunkCount - Object.keys(results).length;
    counts.uncommittedRows = existing.totalRows - (counts.rows ?? 0);
    const written = (counts.created ?? 0) + (counts.filled ?? 0);
    const errors = (counts.failed ?? 0) + counts.uncommittedRows;
    const status = errors && !written ? IMPORT_STATUS.FAILED : errors ? IMPORT_STATUS.COMPLETED_WITH_ERRORS : IMPORT_STATUS.COMPLETED;

    // The mirror is updated by the existing reconciliation (a queued or running one is reused).
    let sync = { requested: false, runId: null, alreadyActive: false };
    if (written) {
        const { run, created } = await requestSheetSyncRun({ db, kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.ADMIN, requestedBy: actor.adminId, now });
        sync = { requested: true, runId: run.runId, alreadyActive: !created };
    }
    const record = await db.$transaction(async (tx) => {
        const updated = await tx.candidateImport.update({
            where: { importId },
            data: { status, resultCounts: counts, syncRunId: sync.runId, completedAt: now, updatedAt: now },
        });
        await tx.auditLog.create({
            data: auditEntry(actor, {
                action: status === IMPORT_STATUS.FAILED ? IMPORT_AUDIT_ACTION.FAILED : IMPORT_AUDIT_ACTION.COMPLETED,
                previousStatus: existing.status, newStatus: status,
                reason: `Bulk candidate import ${importId} finished`,
                // Counts only: never a row.
                newValue: JSON.stringify({ importId, totalRows: existing.totalRows, ...counts, syncRequested: sync.requested }),
            }),
        });
        return updated;
    });
    return finishedView(record, { sync });
}

function finishedView(record, extra = {}) {
    return { importId: record.importId, status: record.status, totalRows: record.totalRows, counts: record.resultCounts ?? {}, syncRunId: record.syncRunId ?? null, ...extra };
}

// The import's state (for a page reload): counts and statuses only.
export async function getImport({ db, actor, importId }) {
    const record = await db.candidateImport.findUnique({ where: { importId } });
    if (!record || record.adminId !== actor.adminId) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
    const results = record.chunkResults ?? {};
    return {
        importId: record.importId, status: record.status, fileName: record.fileName, totalRows: record.totalRows, chunkSize: record.chunkSize,
        chunkCount: Array.isArray(record.chunkHashes) ? record.chunkHashes.length : 0, previewCounts: record.previewCounts,
        chunks: Object.fromEntries(Object.entries(results).map(([index, result]) => [index, { status: result.status, counts: result.counts }])),
        resultCounts: record.resultCounts ?? null, syncRunId: record.syncRunId ?? null, createdAt: record.createdAt, completedAt: record.completedAt,
    };
}
