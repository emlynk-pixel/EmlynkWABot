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
    ROW_ACTION, VISA_OUTCOMES, findAgentsByKeys, findClientsByKeys, findSourceFlags, importActions, loadImportSnapshot, planRows, summarizePlans,
} from "./candidateImportClassifier.js";
import { describeIssues } from "./candidateImportIssues.js";
import { applySuffixEdits, buildJobGroupPlan, executeJobGroups, GROUP_STATE, jobGroupView, loadJobGroupContext, noteGroupOutcomes, plannedJobMembers } from "./importJobGroups.js";
import { activeJobTypeNames } from "./jobTypeCatalog.js";
import { setAuditActor } from "./auditActor.js";
import { catchUpUniqueIdSequence, formatUniqueId } from "./candidateService.js";
import { RUN_KIND, RUN_TRIGGER } from "./sheetSyncStore.js";
import { requestSheetSyncRun } from "./sheetSyncStatusService.js";
import { allocateImportedCandidates } from "./workAllocationService.js";
import { AGENT_AUDIT_ACTION, ENTITY_STATUS, auditRow as entityAuditRow } from "./agentService.js";
import { CLIENT_AUDIT_ACTION } from "./clientService.js";
import { LEDGER_ENTITY, LEDGER_OP, changesOf, createLedger } from "./candidateImportLedger.js";
import { LedgerKeyConfigError, readLedgerKeyring } from "./importLedgerKeys.js";

export const IMPORT_CHUNK_SIZE = 100;
export const MAX_IMPORT_ROWS = 3000;
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PROBLEM_ROWS = 500;
const CHUNK_TRANSACTION = Object.freeze({ timeout: 30_000, maxWait: 10_000 });
const MAX_CELL_LENGTH = 4000;
const MAX_HEADERS = 400;
const MAX_ROW_KEYS = 200;
const PASSPORT_HEADER = SUPPORTED_SOURCE_COLUMNS.find((c) => c.field === "passport").header;

// ABORTED: stopped on purpose, the rows already imported are kept. ROLLING_BACK / ROLLED_BACK /
// ROLLED_BACK_WITH_CONFLICTS belong to the rollback of an import (not used before that work).
export const IMPORT_STATUS = Object.freeze({
    PREVIEWED: "PREVIEWED", COMMITTING: "COMMITTING", COMPLETED: "COMPLETED", COMPLETED_WITH_ERRORS: "COMPLETED_WITH_ERRORS", FAILED: "FAILED",
    ABORTED: "ABORTED", ROLLING_BACK: "ROLLING_BACK", ROLLED_BACK: "ROLLED_BACK", ROLLED_BACK_WITH_CONFLICTS: "ROLLED_BACK_WITH_CONFLICTS",
});
// Every state in which no more chunks may be committed.
const FINISHED = new Set([
    IMPORT_STATUS.COMPLETED, IMPORT_STATUS.COMPLETED_WITH_ERRORS, IMPORT_STATUS.FAILED, IMPORT_STATUS.ABORTED,
    IMPORT_STATUS.ROLLING_BACK, IMPORT_STATUS.ROLLED_BACK, IMPORT_STATUS.ROLLED_BACK_WITH_CONFLICTS,
]);
// A COMMITTING import with no chunk for this long has stopped (closed tab, lost network): its owner may
// resume it, and an ADMIN may abort it. Nothing is aborted automatically; an import that committed under the
// commit lease below is rolled back automatically long before this (importRecoveryService.js).
export const IMPORT_STALE_MS = 15 * 60_000;
// The COMMIT LEASE (migration 20261113120000): every chunk transaction, and every row transaction of a chunk that
// falls back to row by row, sets candidate_import.commit_lease_expires_at to database now() + this, in the statement
// that locks the import row. Only real backend work renews it (the browser's heartbeat does not). Longer than the
// longest chunk transaction (30 s) plus the pause between two chunk requests. An import whose lease has run out (and
// whose browser has stopped answering) is rolled back automatically by importRecoveryService.js.
export const IMPORT_COMMIT_LEASE_MS = 2 * 60_000;

// An import the automatic recovery has taken over (it stopped before it finished): nothing more is accepted for it.
const recoveryStartedError = () => new CandidateImportError(
    409, "IMPORT_RECOVERY_STARTED",
    "This import stopped before it finished, so it is being undone automatically. Nothing from it is kept. Upload the sheet again to import it.",
);
const isRecovered = (record) => Boolean(record?.recoveryStatus);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
export const isValidIdempotencyKey = (value) => typeof value === "string" && IDEMPOTENCY_KEY.test(value);

export const IMPORT_AUDIT_ACTION = Object.freeze({
    STARTED: "BULK_IMPORT_STARTED", COMPLETED: "BULK_IMPORT_COMPLETED", FAILED: "BULK_IMPORT_FAILED", ABORTED: "BULK_IMPORT_ABORTED",
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

// ---------------------------------------------------------------- active imports

const committedChunkIndexes = (record) => Object.entries(record.chunkResults ?? {}).filter(([, result]) => result?.status === "COMMITTED").map(([index]) => Number(index)).sort((a, b) => a - b);
export const isStaleImport = (record, now = new Date()) => record.status === IMPORT_STATUS.COMMITTING && now.getTime() - new Date(record.updatedAt).getTime() > IMPORT_STALE_MS;

// What the browser needs to resume or abort an import (counts and ids only).
const activeDetails = (record, actor, now) => ({
    importId: record.importId, status: record.status, fileName: record.fileName, totalRows: record.totalRows, chunkSize: record.chunkSize,
    chunkCount: Array.isArray(record.chunkHashes) ? record.chunkHashes.length : 0, committedChunks: committedChunkIndexes(record),
    ownedByYou: record.adminId === actor?.adminId, stale: isStaleImport(record, now), updatedAt: new Date(record.updatedAt).toISOString(),
    // Taken over by the automatic recovery (importRecoveryService.js): being undone in the background.
    recovery: record.recoveryStatus ?? null,
});

// A request for a file that already has an import: still committing (resume it) or already finished.
function importActiveError(record, now) {
    const committing = record.status === IMPORT_STATUS.COMMITTING;
    return new CandidateImportError(
        409, committing ? "IMPORT_ALREADY_ACTIVE" : "IMPORT_ALREADY_FINISHED",
        committing ? "This file is already being imported. Resume that import or abort it first." : "This request was already used by an import that has finished.",
        { details: { importId: record.importId, status: record.status, chunkSize: record.chunkSize, chunkCount: Array.isArray(record.chunkHashes) ? record.chunkHashes.length : 0, committedChunks: committedChunkIndexes(record), stale: isStaleImport(record, now) } },
    );
}

// The ledger's HMAC key (importLedgerKeys.js). An import that cannot record what it changed in a way a
// rollback can verify is not started: with no valid key nothing is written (no job type, no candidate, no
// ledger entry), and the answer says what is wrong with the configuration (codes only, never a secret).
// `injected`: a keyring passed by a caller (tests); otherwise the server's environment.
function loadLedgerKeyring(injected = null) {
    if (injected) return injected;
    try {
        return readLedgerKeyring();
    } catch (error) {
        if (!(error instanceof LedgerKeyConfigError)) throw error;
        throw new CandidateImportError(503, "LEDGER_KEY_NOT_CONFIGURED", "Imports are unavailable until the server's change-ledger key is configured. Nothing was imported.", { details: { problems: error.problems } });
    }
}

// Each administrator has at most ONE import committing (the partial unique index on admin_id enforces it
// too), so an accidental second Upload by the same person (second tab, retry, double click) never runs
// beside the first. Different administrators DO import at the same time: what they share is protected in
// the database, not by this rule: a chunk's unique IDs are allocated under one advisory lock, a Job group
// is read and written under a per-date advisory lock, and passports, NICs, Client / Agent names and
// Job-group keys are unique constraints (a chunk that loses such a race is retried row by row and finds
// the other import's row). Called before an import's first chunk; `client` is the database or the transaction.
async function assertNoOtherCommitting(client, { importId, actor, now }) {
    const other = await client.candidateImport.findFirst({ where: { status: IMPORT_STATUS.COMMITTING, adminId: actor.adminId, NOT: { importId } } });
    if (!other) return;
    throw new CandidateImportError(
        409, "IMPORT_IN_PROGRESS", "You have another import in progress. Resume it or abort it first.",
        { details: activeDetails(other, actor, now) },
    );
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
// role is lost. The job types the rows would need that do not exist yet: { name, code }.
function newJobTypesFor(canonical, activeJobTypes) {
    const fresh = new Set();
    for (const row of canonical) {
        for (const name of unknownJobRoles(sourceCells(row.values).jobRole, { activeJobTypes, aliases: JOB_ROLE_ALIASES })) fresh.add(name);
    }
    return [...fresh].map((name) => ({ name, code: name.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") })).filter((type) => type.code);
}

// Preview: the new job types are only counted as if they existed (nothing is created). Returns the active
// job type names to validate with.
async function jobTypesWithSheetRoles(db, canonical) {
    const activeJobTypes = await activeJobTypeNames(db);
    return [...activeJobTypes, ...newJobTypesFor(canonical, activeJobTypes).map((type) => type.name)];
}

// Commit: the new job types are created INSIDE the chunk's (or the row's) transaction, so they are committed,
// rolled back and recorded in the change ledger together with the rows that need them (a chunk that fails, or an
// import that is refused, leaves no job type behind; a rollback can remove exactly the ones this import made).
// One statement; only the rows actually created come back (a code that already exists, e.g. an inactive type or one
// another import created at the same moment, is skipped: the list is read again, and an inactive type's role stays
// unmatched, as it should). Returns { activeJobTypes, created: [{ id, name, code, isActive }] }.
async function ensureSheetJobTypes(tx, canonical) {
    const activeJobTypes = await activeJobTypeNames(tx);
    const added = newJobTypesFor(canonical, activeJobTypes);
    if (!added.length) return { activeJobTypes, created: [] };
    const created = await tx.jobType.createManyAndReturn({ data: added.map((type) => ({ ...type, isActive: true })), skipDuplicates: true, select: { id: true, name: true, code: true, isActive: true } });
    const names = created.length === added.length ? [...activeJobTypes, ...created.map((row) => row.name)] : await activeJobTypeNames(tx);
    return { activeJobTypes: names, created };
}

// The allow-list for the browser.
export const importSourceColumns = () => sourceColumnsForClient();

// Validates and classifies the rows; writes nothing to a candidate table. Returns the counts, the
// problem rows (masked) and the importId the commit refers to.
//
// idempotencyKey (header Idempotency-Key, one per file choice in the browser): the same key from the same
// admin and file names the same import, so a repeated or retried request never makes a second one (a
// PREVIEWED import is returned again, with its Job ID edits). A file the admin is already committing is
// refused with IMPORT_ALREADY_ACTIVE and the details to resume it, not previewed again.
export async function previewImport({ db, actor, fileName, headers, rows, idempotencyKey = null, ledgerKeyring = null, now = new Date() }) {
    if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
        throw new CandidateImportError(400, "INVALID_IDEMPOTENCY_KEY", "The request key is not valid.");
    }
    // Told at the preview, not after the person has checked everything: this server cannot run imports yet.
    loadLedgerKeyring(ledgerKeyring);
    const columns = analyzeSourceHeaders(headers);
    if (columns.missingRequired.length) {
        throw new CandidateImportError(422, "MISSING_REQUIRED_HEADINGS", `The sheet is missing required headings: ${columns.missingRequired.join(", ")}.`, { missing: columns.missingRequired });
    }
    const canonical = canonicalRows(rows);
    const chunks = chunkRows(canonical);
    const chunkHashes = chunks.map(hashChunk);
    const sameFile = (record) => JSON.stringify(record.chunkHashes) === JSON.stringify(chunkHashes);
    const forKey = () => (idempotencyKey ? db.candidateImport.findFirst({ where: { adminId: actor.adminId, idempotencyKey } }) : null);
    let reuse = await forKey();
    if (reuse) {
        if (!sameFile(reuse)) throw new CandidateImportError(409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different file.");
        if (reuse.status !== IMPORT_STATUS.PREVIEWED) throw importActiveError(reuse, now);
    } else {
        const running = await db.candidateImport.findFirst({ where: { adminId: actor.adminId, status: IMPORT_STATUS.COMMITTING } });
        if (running && sameFile(running)) throw importActiveError(running, now);
    }
    const activeJobTypes = await jobTypesWithSheetRoles(db, canonical);
    const validated = canonical.map((row) => validateLegacyRow(row, { activeJobTypes, today: now }));
    const sourceFlags = findSourceFlags(validated);
    const snapshot = await loadImportSnapshot(db, validated, { activeJobTypes });
    const plans = planRows(validated, snapshot, sourceFlags);
    // Jobs (Interview Date + UNIQUE NUMBER hundreds block): planned for the whole file, stored for the commit.
    const plannedGroups = buildJobGroupPlan(plans, await loadJobGroupContext(db, [...new Set(plans.filter((p) => p.job).map((p) => p.job.interviewDate))]));
    // A repeated request keeps the Job IDs the admin already chose.
    const jobGroups = reuse && Array.isArray(reuse.jobGroups) && reuse.jobGroups.length ? reuse.jobGroups : plannedGroups;
    noteGroupOutcomes(plans, jobGroups);
    const summary = {
        ...summarizePlans(plans),
        ...jobGroupCounts(jobGroups),
        jobMembers: plannedJobMembers(plans, jobGroups),
        ignoredSourceColumns: columns.ignored.length + columns.systemGenerated.length + columns.unresolved.length + columns.unknown.length,
    };
    let record = reuse;
    if (!record) {
        try {
            record = await db.candidateImport.create({
                data: {
                    importId: crypto.randomUUID(), adminId: actor.adminId, fileName, status: IMPORT_STATUS.PREVIEWED, totalRows: canonical.length, chunkSize: IMPORT_CHUNK_SIZE,
                    chunkHashes, sourceFlags, previewCounts: summary, chunkResults: {}, jobGroups, idempotencyKey, createdAt: now, updatedAt: now,
                },
            });
        } catch (error) {
            // Two requests with the same key at the same moment: the other one created it.
            if (!isUniqueViolation(error) || !idempotencyKey) throw error;
            record = await forKey();
            if (!record || !sameFile(record)) throw error;
            if (record.status !== IMPORT_STATUS.PREVIEWED) throw importActiveError(record, now);
        }
    }
    const importId = record.importId;
    const problems = plans.filter(isProblem);
    return {
        importId, chunkSize: IMPORT_CHUNK_SIZE, chunkCount: chunks.length, expiresAt: new Date(new Date(record.createdAt).getTime() + IMPORT_PREVIEW_TTL_MS).toISOString(),
        summary, columns, problems: problems.slice(0, MAX_PROBLEM_ROWS).map(problemOf), problemsTruncated: problems.length > MAX_PROBLEM_ROWS,
        rowIssues: rowIssuesOf(plans), actions: importActions(plans), jobGroups: jobGroups.map(jobGroupView),
    };
}

const jobGroupCounts = (groups) => ({
    jobsToCreate: groups.filter((g) => g.state === GROUP_STATE.NEW).length,
    jobsReused: groups.filter((g) => g.state === GROUP_STATE.EXISTING).length,
    jobGroupProblems: groups.filter((g) => g.state === GROUP_STATE.ERROR).length,
});

// PUT /import/:importId/job-groups { suffixes: { [group key]: "05" } }: the user chooses the last two
// digits of a NEW Job before the import (only before any chunk is committed). Checked again here against
// the database (codes and suffixes taken since the preview); nothing is saved on an error (409).
export async function updateImportJobGroups({ db, actor, importId, suffixes, now = new Date() }) {
    const record = await requireImport(db, { importId, actor, now });
    if (record.status !== IMPORT_STATUS.PREVIEWED) throw new CandidateImportError(409, "IMPORT_STARTED", "The import has started: Job IDs can no longer be chosen here.");
    if (!suffixes || typeof suffixes !== "object" || Array.isArray(suffixes)) throw new CandidateImportError(400, "INVALID_BODY", "suffixes must be an object of group -> two digits.");
    const groups = Array.isArray(record.jobGroups) ? record.jobGroups : [];
    const context = await loadJobGroupContext(db, [...new Set(groups.map((g) => g.interviewDate))]);
    const result = applySuffixEdits(groups, suffixes, context);
    if (result.errors) throw new CandidateImportError(409, "JOB_GROUP_SUFFIX_INVALID", result.errors[0].message, { errors: result.errors });
    await db.candidateImport.update({ where: { importId }, data: { jobGroups: result.groups, updatedAt: now } });
    return { jobGroups: result.groups.map(jobGroupView) };
}

// ---------------------------------------------------------------- unique IDs

// Bulk unique IDs from the SAME sequence single registration uses (candidate_unique_id_seq, migration
// 20261105120000; candidateService.js nextUniqueId): one query draws a whole chunk's numbers, with no
// candidate row read. nextval() is atomic, so a concurrent registration or import never draws the
// same number. Same format: zero-padded to 4. Only a number taken OUTSIDE the sequence can collide;
// commitChunk then moves the sequence past it (catchUpUniqueIdSequence) and retries the chunk.
export async function allocateUniqueIds(tx, count) {
    if (count <= 0) return [];
    const rows = await tx.$queryRaw`SELECT nextval('candidate_unique_id_seq')::text AS "value" FROM generate_series(1, ${count}::int)`;
    return rows.map((row) => BigInt(row.value)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(formatUniqueId);
}

// ---------------------------------------------------------------- writes

const auditEntry = (actor, data) => ({ auditId: crypto.randomUUID(), adminId: actor.adminId, ...data });

// The plans' writes, inside the caller's transaction. Returns the plans' outcomes. Every change is also
// recorded in the import's change ledger (candidateImportLedger.js), in this same transaction.
async function executePlans(tx, plans, { importId, actor, now = new Date(), jobGroups = [], chunkIndex = 0, ledgerKeyring = null, createdJobTypes = [] }) {
    const audits = [];
    const ledger = createLedger({ importId, chunkIndex, keyring: ledgerKeyring });
    // The job types this transaction created for the rows' Job Roles (ensureSheetJobTypes): CREATED by this import.
    for (const type of createdJobTypes) {
        ledger.add({ entityType: LEDGER_ENTITY.JOB_TYPE, entityKey: type.id, op: LEDGER_OP.CREATE, changes: changesOf({ name: type.name, code: type.code, isActive: type.isActive }, null, { hash: false }) });
    }
    // Every candidate these rows touch, by its internal unique_id (the ledger names no passport number).
    for (const plan of plans) if (plan.prior?.uniqueId) ledger.registerCandidate(plan.prior.passportId, plan.prior.uniqueId);
    const creates = plans.filter((p) => p.action === ROW_ACTION.CREATE);
    if (creates.length) {
        const ids = await allocateUniqueIds(tx, creates.length);
        await tx.candidate.createMany({ data: creates.map((p, i) => ({ ...p.write.candidate, uniqueId: ids[i] })) });
        const details = creates.filter((p) => Object.keys(p.write.details).length).map((p) => ({ passportId: p.write.candidate.passportId, ...p.write.details }));
        if (details.length) await tx.candidateAdditionalDetails.createMany({ data: details });
        creates.forEach((p, i) => {
            const audit = auditEntry(actor, {
                action: "CREATE_CANDIDATE", passportId: p.write.candidate.passportId, previousStatus: "NONE", newStatus: "CREATED",
                reason: `Candidate imported from a legacy sheet (bulk import ${importId}, ${ids[i]})`,
                // Which fields were given, never their values.
                newValue: JSON.stringify({ uniqueId: ids[i], importId, fields: Object.keys(p.write.candidate).filter((f) => f !== "passportId"), details: Object.keys(p.write.details) }),
            });
            audits.push(audit);
            ledger.registerCandidate(p.write.candidate.passportId, ids[i]);
            ledger.add({
                entityType: LEDGER_ENTITY.CANDIDATE, entityKey: ids[i], candidateUniqueId: ids[i], op: LEDGER_OP.CREATE, rowNumber: p.rowNumber,
                changes: changesOf(p.write.candidate, null, { hash: true }), auditIds: [audit.auditId],
            });
            if (Object.keys(p.write.details).length) {
                ledger.add({
                    entityType: LEDGER_ENTITY.DETAILS, entityKey: ids[i], candidateUniqueId: ids[i], op: LEDGER_OP.CREATE, rowNumber: p.rowNumber,
                    changes: changesOf(p.write.details, null, { hash: true }), auditIds: [audit.auditId],
                });
            }
        });
    }
    for (const plan of plans.filter((p) => p.action === ROW_ACTION.FILL)) {
        const { passportId, candidate, details, detailsExists } = plan.write;
        const uniqueId = ledger.uniqueIdOf(passportId);
        if (Object.keys(candidate).length) {
            await tx.candidate.update({ where: { passportId }, data: candidate });
            const audit = auditEntry(actor, {
                action: "UPDATE_CANDIDATE", passportId, previousStatus: "CREATED", newStatus: "UPDATED",
                reason: `Blank fields filled from a legacy sheet (bulk import ${importId})`,
                // The candidate history lists these keys; the values are never recorded.
                newValue: JSON.stringify(Object.fromEntries(Object.keys(candidate).map((f) => [f, null]))),
            });
            audits.push(audit);
            // before = the blank that was there (the import only fills blanks); after = hashed.
            ledger.add({
                entityType: LEDGER_ENTITY.CANDIDATE, entityKey: uniqueId, candidateUniqueId: uniqueId, op: LEDGER_OP.FILL, rowNumber: plan.rowNumber,
                changes: changesOf(candidate, plan.prior, { hash: true }), auditIds: [audit.auditId],
            });
        }
        if (Object.keys(details).length) {
            if (detailsExists) await tx.candidateAdditionalDetails.update({ where: { passportId }, data: details });
            else await tx.candidateAdditionalDetails.create({ data: { passportId, ...details } });
            const audit = auditEntry(actor, {
                action: detailsExists ? "UPDATE_ADDITIONAL_DETAILS" : "CREATE_ADDITIONAL_DETAILS", passportId,
                previousStatus: detailsExists ? "EXISTS" : "NONE", newStatus: detailsExists ? "UPDATED" : "CREATED",
                reason: `Blank additional details filled from a legacy sheet (bulk import ${importId})`,
                newValue: JSON.stringify({ importId, fields: Object.keys(details) }),
            });
            audits.push(audit);
            // A details row that did not exist is CREATED by the import (a rollback may delete it); an existing one is FILLED.
            ledger.add({
                entityType: LEDGER_ENTITY.DETAILS, entityKey: uniqueId, candidateUniqueId: uniqueId, op: detailsExists ? LEDGER_OP.FILL : LEDGER_OP.CREATE, rowNumber: plan.rowNumber,
                changes: changesOf(details, detailsExists ? plan.prior?.additionalDetails : null, { hash: true }), auditIds: [audit.auditId],
            });
        }
    }
    const effects = new Map(plans.map((plan) => [plan.rowNumber, {}]));
    await executeOrg(tx, plans, { importId, actor, audits, effects, ledger });
    await executeExtras(tx, plans, { importId, actor, audits, effects, now, ledger });
    // After the Test details (this chunk may have just saved the PASS) and the Clients / Agents.
    await executeJobGroups(tx, plans, jobGroups, { actor, importId, audits, effects, ledger });
    if (audits.length) await tx.auditLog.createMany({ data: audits });
    // The ledger with the writes: one statement, same transaction (a chunk that fails leaves no entry).
    await ledger.flush(tx);
    return plans.map((plan) => outcomeOf(plan, effects.get(plan.rowNumber)));
}

const passportOfPlan = (plan) => plan.write.passportId ?? plan.write.candidate.passportId;
// The stage row an existing candidate already had (read with the plan), or null.
const stageOf = (existing, stage) => existing?.stages?.find((row) => row.stage === stage) ?? null;
const isoDayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null);

// Allocation (to the OFFICER), the Test details, the visa stage and Departed of the CREATE / FILL rows, all
// fill-only (planned in candidateImportClassifier.js against this transaction's own snapshot).
async function executeExtras(tx, plans, { importId, actor, audits, effects, now, ledger }) {
    const writing = plans.filter((plan) => plan.write?.extras && (plan.action === ROW_ACTION.CREATE || plan.action === ROW_ACTION.FILL));
    const entries = writing.filter((plan) => plan.write.extras.allocation).map((plan) => ({ passportId: passportOfPlan(plan), analystId: plan.write.extras.allocation.analystId }));
    const allocationAudits = new Map();
    const allocated = new Set(await allocateImportedCandidates(tx, { actor, entries, auditIds: allocationAudits }));
    // Each allocation made (an existing holder is never replaced: only the candidates allocated here are recorded),
    // with the ASSIGN_CANDIDATE audit row allocateImportedCandidates wrote for it.
    for (const plan of writing) {
        const passportId = passportOfPlan(plan);
        if (!plan.write.extras.allocation || !allocated.has(passportId)) continue;
        const uniqueId = ledger.uniqueIdOf(passportId);
        ledger.add({
            entityType: LEDGER_ENTITY.ALLOCATION, entityKey: uniqueId, candidateUniqueId: uniqueId, op: LEDGER_OP.CREATE, rowNumber: plan.rowNumber,
            changes: changesOf({ analystId: plan.write.extras.allocation.analystId }, null, { hash: false }),
            auditIds: allocationAudits.has(passportId) ? [allocationAudits.get(passportId)] : [],
        });
    }
    const stageAudit = (passportId, stage, { from, to, before, after }) => {
        const audit = auditEntry(actor, {
            action: "UPDATE_STAGE", passportId, previousStatus: from ? "COMPLETED" : "NOT_COMPLETED", newStatus: to ? "COMPLETED" : "NOT_COMPLETED",
            reason: `Set from a legacy sheet (bulk import ${importId})`,
            previousValue: JSON.stringify({ stage, ...before }), newValue: JSON.stringify({ stage, ...after }),
        });
        audits.push(audit);
        return audit;
    };
    // A stage row the import made is CREATED (a rollback may delete it); one that existed is FILLED (only the
    // fields written, back to the blank that was there). `previous` is the stored row, null when there was none.
    const ledgerStage = (plan, passportId, stage, written, previous, audit) => {
        const uniqueId = ledger.uniqueIdOf(passportId);
        ledger.add({
            entityType: LEDGER_ENTITY.STAGE, entityKey: `${uniqueId}:${stage}`, candidateUniqueId: uniqueId, op: previous ? LEDGER_OP.FILL : LEDGER_OP.CREATE, rowNumber: plan.rowNumber,
            changes: changesOf(written, previous, { hash: false }), auditIds: [audit.auditId],
        });
    };
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
            const audit = stageAudit(passportId, "TEST_DETAILS", { from: false, to: completed, before, after: completed ? { ...after, completed: true } : after });
            const stored = stageOf(plan.prior, "TEST_DETAILS");
            ledgerStage(plan, passportId, "TEST_DETAILS", stored ? test.fill : { ...test.fill, completed, completedAt: completed ? now : null }, stored, audit);
            effect.testSet = 1;
        }
        for (const stage of stages) {
            await write(plan, stage, { passportId, stage, completed: true, completedAt: now }, { completed: true, completedAt: now });
            const audit = stageAudit(passportId, stage, { from: false, to: true, before: { completed: false }, after: { completed: true } });
            ledgerStage(plan, passportId, stage, { completed: true, completedAt: now }, stageOf(plan.prior, stage), audit);
            effect.stagesCompleted = (effect.stagesCompleted ?? 0) + 1;
        }
    }
    if (inserts.length) await tx.candidateStage.createMany({ data: inserts });

    // VISA STATUS "Departed": candidate.departed_at, once (fill-only: only a candidate with no final
    // status at all), in one statement. UPDATE ... RETURNING names exactly the candidates it changed: an effect,
    // an audit entry and a ledger entry exist only for those (an update count could not say which rows).
    const departing = writing.filter((plan) => plan.write.extras.departed);
    if (departing.length) {
        const updated = await tx.$queryRaw`
            UPDATE "candidate" SET "departed_at" = ${now}, "updated_date" = ${now}
            WHERE "passport_id" = ANY(${departing.map(passportOfPlan)}) AND "departed_at" IS NULL AND "outcome" IS NULL
            RETURNING "passport_id" AS "passportId"`;
        const changed = new Set(updated.map((row) => row.passportId));
        for (const plan of departing.filter((p) => changed.has(passportOfPlan(p)))) {
            effects.get(plan.rowNumber).departed = 1;
            const audit = auditEntry(actor, {
                action: "CANDIDATE_DEPARTED", passportId: passportOfPlan(plan), previousStatus: "NOT_DEPARTED", newStatus: "DEPARTED",
                reason: `Visa status Departed in a legacy sheet (bulk import ${importId})`, newValue: JSON.stringify({ importId }),
            });
            audits.push(audit);
            // Part of the candidate's own entry (created or filled by this import), written as a blank filled.
            ledger.addCandidateFields(passportOfPlan(plan), { rowNumber: plan.rowNumber, changes: changesOf({ departedAt: now }, null, { hash: true }), auditIds: [audit.auditId] });
        }
    }

    // VISA STATUS "Got Visa Not Going" / "Cancelled" / "Reject": candidate.outcome, once (fill-only, as above).
    // The rows are locked and updated in one statement that returns each changed candidate with the outcome_at it
    // had before: the ledger records exactly those, with their exact previous values.
    for (const outcome of VISA_OUTCOMES) {
        const recording = writing.filter((plan) => plan.write.extras.outcome === outcome);
        if (!recording.length) continue;
        const updated = await tx.$queryRaw`
            UPDATE "candidate" c SET "outcome" = ${outcome}, "outcome_at" = ${now}, "updated_date" = ${now}
            FROM (SELECT "passport_id", "outcome_at" FROM "candidate"
                  WHERE "passport_id" = ANY(${recording.map(passportOfPlan)}) AND "departed_at" IS NULL AND "outcome" IS NULL FOR UPDATE) o
            WHERE c."passport_id" = o."passport_id"
            RETURNING c."passport_id" AS "passportId", o."outcome_at" AS "previousOutcomeAt"`;
        const previousOutcomeAt = new Map(updated.map((row) => [row.passportId, row.previousOutcomeAt]));
        for (const plan of recording.filter((p) => previousOutcomeAt.has(passportOfPlan(p)))) {
            effects.get(plan.rowNumber).outcome = 1;
            const audit = auditEntry(actor, {
                action: "SET_FINAL_STATUS", passportId: passportOfPlan(plan), previousStatus: "NONE", newStatus: outcome,
                reason: `Visa status in a legacy sheet (bulk import ${importId})`, newValue: JSON.stringify({ importId }),
            });
            audits.push(audit);
            ledger.addCandidateFields(passportOfPlan(plan), {
                rowNumber: plan.rowNumber, auditIds: [audit.auditId],
                changes: changesOf({ outcome, outcomeAt: now }, { outcome: null, outcomeAt: previousOutcomeAt.get(passportOfPlan(plan)) }, { hash: true }),
            });
        }
    }
}

// The Clients and Agents the rows name: found again by name key (case and spacing ignored,
// findClientsByKeys / findAgentsByKeys) inside this transaction (an earlier
// chunk may have created one since the preview), else created, then linked; a blank registration
// number filled. Through the same audit actions as Admin > Clients / Agents. A name created twice at
// the same time fails on the unique indexes and the chunk is retried row by row (it then finds it).
async function executeOrg(tx, plans, { importId, actor, audits, effects, ledger }) {
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
                    const audit = entityAuditRow({
                        actor, action: AGENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: ENTITY_STATUS.ACTIVE, reason: reason("Agent created"),
                        newValue: JSON.stringify({ agentId, name: agent.name, countryCode: null, clientIds: [] }),
                    });
                    audits.push(audit);
                    // An Agent the import created (a name is business data: hashed).
                    ledger.add({ entityType: LEDGER_ENTITY.AGENT, entityKey: agentId, op: LEDGER_OP.CREATE, rowNumber: plan.rowNumber, changes: changesOf({ name: agent.name, countryCode: null }, null, { hash: true }), auditIds: [audit.auditId] });
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
                const audit = entityAuditRow({
                    actor, action: CLIENT_AUDIT_ACTION.CREATED, previousStatus: "NONE", newStatus: ENTITY_STATUS.ACTIVE, reason: reason("Client created"),
                    newValue: JSON.stringify({ clientId, name: company.name, agentIds: [agentId] }),
                });
                audits.push(audit);
                ledger.add({ entityType: LEDGER_ENTITY.CLIENT, entityKey: clientId, op: LEDGER_OP.CREATE, rowNumber: plan.rowNumber, changes: changesOf({ name: company.name, registrationNumber: companyNumber }, null, { hash: true }), auditIds: [audit.auditId] });
            }
            clientIds.set(company.key, clientId);
        }
        if (agentId) {
            const { count } = await tx.agentClient.createMany({ data: [{ agentId, clientId }], skipDuplicates: true });
            // A link only when this import made it (an existing link is never recorded, so never removed).
            if (count) {
                let auditIdsOfLink = [];
                if (!created) {
                    const audit = entityAuditRow({
                        actor, action: CLIENT_AUDIT_ACTION.AGENT_CHANGED, previousStatus: ENTITY_STATUS.ACTIVE, newStatus: ENTITY_STATUS.ACTIVE,
                        reason: reason("Client's agents changed: 1 added, 0 removed"), newValue: JSON.stringify({ clientId, added: [agentId], removed: [] }),
                    });
                    audits.push(audit);
                    auditIdsOfLink = [audit.auditId];
                }
                ledger.add({ entityType: LEDGER_ENTITY.AGENT_CLIENT, entityKey: `${agentId}:${clientId}`, op: LEDGER_OP.LINK, rowNumber: plan.rowNumber, auditIds: auditIdsOfLink });
            }
        }
        if (companyNumber && !created) {
            // One statement that locks the row, fills the blank and returns what was there (NULL or ""): the ledger
            // records the exact previous value, which an update count could not give.
            const [filled] = await tx.$queryRaw`
                UPDATE "client" c SET "registration_number" = ${companyNumber}, "updated_at" = CURRENT_TIMESTAMP
                FROM (SELECT "id", "registration_number" AS "previous" FROM "client"
                      WHERE "id" = ${clientId}::uuid AND ("registration_number" IS NULL OR "registration_number" = '') FOR UPDATE) o
                WHERE c."id" = o."id"
                RETURNING o."previous" AS "previous"`;
            if (filled) {
                const audit = entityAuditRow({
                    actor, action: CLIENT_AUDIT_ACTION.UPDATED, previousStatus: ENTITY_STATUS.ACTIVE, newStatus: ENTITY_STATUS.ACTIVE,
                    reason: reason("Client updated: registrationNumber"), previousValue: JSON.stringify({ clientId, registrationNumber: null }),
                    newValue: JSON.stringify({ clientId, registrationNumber: companyNumber }),
                });
                audits.push(audit);
                // Only the filled blank (before: exactly NULL or "" as it was, after: keyed digest): the Client itself existed before the import.
                ledger.add({ entityType: LEDGER_ENTITY.CLIENT, entityKey: clientId, op: LEDGER_OP.FILL, rowNumber: plan.rowNumber, changes: changesOf({ registrationNumber: companyNumber }, { registrationNumber: filled.previous }, { hash: true }), auditIds: [audit.auditId] });
            }
        }
    }
}

const OUTCOME_BY_ACTION = { [ROW_ACTION.CREATE]: ROW_OUTCOME.CREATED, [ROW_ACTION.FILL]: ROW_OUTCOME.FILLED, [ROW_ACTION.NO_CHANGE]: ROW_OUTCOME.NO_CHANGE, [ROW_ACTION.SKIP_VERIFIED]: ROW_OUTCOME.SKIPPED_VERIFIED };
const OUTCOME_BY_STATUS = { [ROW_STATUS.INVALID]: ROW_OUTCOME.INVALID, [ROW_STATUS.DUPLICATE]: ROW_OUTCOME.DUPLICATE, [ROW_STATUS.CONFLICT]: ROW_OUTCOME.CONFLICT };

// { r: row number, o: outcome, c: reason codes, w: had a warning, e?: what else was written }
// e: { allocated, testSet, stagesCompleted, departed, outcome, clientCreated, agentCreated } (only the non-zero ones)
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
    allocated: "allocated", testsSet: "testSet", stagesCompleted: "stagesCompleted", departed: "departed", outcomes: "outcome", jobsCreated: "jobCreated", jobAssignments: "jobAssigned", clientsCreated: "clientCreated", agentsCreated: "agentCreated",
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
    if (isRecovered(record)) throw recoveryStartedError();
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
// otherCommitting (same query, no extra round trip): the id of ANOTHER import of the SAME administrator that is
// COMMITTING, if any (imports of other administrators never matter here).
// The same statement renews the COMMIT LEASE in database time (an UPDATE locks the row exactly as FOR UPDATE does):
// a transaction that then refuses (finished, recovered) rolls the renewal back with everything else. While this
// transaction holds the lock, the recovery's FOR UPDATE SKIP LOCKED scan passes the import by: an import whose chunk
// is being processed is never taken for an abandoned one, however slow.
async function lockImport(tx, importId) {
    const [locked] = await tx.$queryRaw`
        UPDATE "candidate_import" c SET "commit_lease_expires_at" = now() + make_interval(secs => ${IMPORT_COMMIT_LEASE_MS / 1000}::double precision)
        WHERE c."import_id" = ${importId}::uuid
        RETURNING c."status", c."chunk_results" AS "chunkResults", c."recovery_status" AS "recoveryStatus",
               (SELECT o."import_id"::text FROM "candidate_import" o WHERE o."status" = 'COMMITTING' AND o."admin_id" = c."admin_id" AND o."import_id" <> c."import_id" LIMIT 1) AS "otherCommitting"`;
    const chunkResults = typeof locked.chunkResults === "string" ? JSON.parse(locked.chunkResults) : locked.chunkResults ?? {};
    return { status: locked.status, chunkResults, recoveryStatus: locked.recoveryStatus ?? null, otherCommitting: locked.otherCommitting ?? null };
}

// Under the import row's lock: the import must still accept chunks (it may have been finished or
// aborted since the request was checked, or taken over by the automatic recovery), and an import that has not
// started may start only when no other import is committing.
async function guardCommit(tx, locked, { importId, actor, now }) {
    if (isRecovered(locked)) throw recoveryStartedError();
    if (FINISHED.has(locked.status)) throw new CandidateImportError(409, "IMPORT_FINISHED", "This import is already finished.");
    if (locked.status === IMPORT_STATUS.PREVIEWED && locked.otherCommitting) await assertNoOtherCommitting(tx, { importId, actor, now });
}

// The chunk's result written to the (locked) import row, with BULK_IMPORT_STARTED on the first commit.
async function recordChunk(tx, locked, { importId, chunkIndex, actor, rows, now }) {
    const results = locked.chunkResults;
    const result = chunkResult(mergeOutcomes(results[chunkIndex], rows));
    if (locked.status === IMPORT_STATUS.PREVIEWED) {
        await tx.auditLog.create({ data: auditEntry(actor, { action: IMPORT_AUDIT_ACTION.STARTED, previousStatus: IMPORT_STATUS.PREVIEWED, newStatus: IMPORT_STATUS.COMMITTING, reason: `Bulk candidate import ${importId} started`, newValue: JSON.stringify({ importId }) }) });
    }
    try {
        await tx.candidateImport.update({
            where: { importId },
            data: { status: IMPORT_STATUS.COMMITTING, chunkResults: { ...results, [chunkIndex]: result }, updatedAt: now },
        });
    } catch (error) {
        // Only the one-COMMITTING-import-per-admin index can refuse this update: this admin started another import at the same moment.
        if (isUniqueViolation(error)) throw new CandidateImportError(409, "IMPORT_IN_PROGRESS", "You have another import in progress. Resume it or abort it first.");
        throw error;
    }
    return result;
}

// Commits one previewed chunk. Returns { chunkIndex, status, counts, failures: [{ rowNumber, passport, codes }] }.
export async function commitChunk({ db, actor, importId, chunkIndex, rows, now = new Date(), maxAttempts = 3, ledgerKeyring = null }) {
    const record = await requireImport(db, { importId, actor, now });
    const hashes = Array.isArray(record.chunkHashes) ? record.chunkHashes : [];
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= hashes.length) throw new CandidateImportError(400, "INVALID_CHUNK", "Unknown chunk.");
    const canonical = canonicalRows(rows);
    if (hashChunk(canonical) !== hashes[chunkIndex]) {
        throw new CandidateImportError(409, "CHUNK_MISMATCH", "These rows are not the rows that were previewed. Upload the sheet again.");
    }
    const previous = record.chunkResults?.[chunkIndex];
    if (previous?.status === "COMMITTED") return present(chunkIndex, previous, canonical, { alreadyCommitted: true });
    // No valid ledger key: nothing is written, not even a job type (see loadLedgerKeyring).
    const keyring = loadLedgerKeyring(ledgerKeyring);
    const context = { importId, actor, now, chunkIndex, ledgerKeyring: keyring, jobGroups: Array.isArray(record.jobGroups) ? record.jobGroups : [] };

    // The whole chunk in one transaction; a unique-ID race is retried with fresh numbers. The new job types for
    // the rows' unknown Job Roles are created inside it, after the import is locked and allowed to go on: an import
    // that is refused (finished, recovered, blocked by another of this administrator's imports) creates none.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await db.$transaction(async (tx) => {
                const locked = await lockImport(tx, importId);
                if (isRecovered(locked)) throw recoveryStartedError();
                if (locked.chunkResults[chunkIndex]?.status === "COMMITTED") return { ...locked.chunkResults[chunkIndex], alreadyCommitted: true };
                await guardCommit(tx, locked, { importId, actor, now });
                await setAuditActor(tx, actor);
                const { activeJobTypes, created } = await ensureSheetJobTypes(tx, canonical);
                const validated = canonical.map((row) => validateLegacyRow(row, { activeJobTypes, today: now }));
                const snapshot = await loadImportSnapshot(tx, validated, { activeJobTypes });
                const outcomes = await executePlans(tx, planRows(validated, snapshot, record.sourceFlags), { ...context, createdJobTypes: created });
                return recordChunk(tx, locked, { importId, chunkIndex, actor, rows: outcomes, now });
            }, CHUNK_TRANSACTION);
            return present(chunkIndex, result, canonical, result.alreadyCommitted ? { alreadyCommitted: true } : {});
        } catch (error) {
            // A refusal (finished, aborted, another import running) is the answer, not a row problem.
            if (error instanceof CandidateImportError) throw error;
            if (failureCode(error) === "UNIQUE_ID_COLLISION" && attempt < maxAttempts) continue;
            break;
        }
    }

    // The chunk failed as a whole (and rolled back alone): each row on its own, so a single bad or
    // conflicting row is isolated and the others are still written.
    const outcomes = [];
    // Still allowed? (finished or aborted, or another import started, while the chunk was failing)
    await db.$transaction(async (tx) => guardCommit(tx, await lockImport(tx, importId), { importId, actor, now }), CHUNK_TRANSACTION);
    // Each row's transaction locks the import row and checks again (so the automatic recovery can never take the import
    // over while one of its rows is being written, and no row is written once it has), renews the commit lease, and
    // creates the job types that row needs, recorded in that row's ledger entries.
    for (const row of canonical) {
        try {
            outcomes.push(...await db.$transaction(async (tx) => {
                await guardCommit(tx, await lockImport(tx, importId), { importId, actor, now });
                await setAuditActor(tx, actor);
                const { activeJobTypes, created } = await ensureSheetJobTypes(tx, [row]);
                const validated = [validateLegacyRow(row, { activeJobTypes, today: now })];
                const snapshot = await loadImportSnapshot(tx, validated, { activeJobTypes });
                return executePlans(tx, planRows(validated, snapshot, record.sourceFlags), { ...context, createdJobTypes: created });
            }, CHUNK_TRANSACTION));
        } catch (error) {
            // A refusal (finished, aborted, recovered meanwhile) stops the chunk: nothing more is written.
            if (error instanceof CandidateImportError) throw error;
            outcomes.push({ r: row.rowNumber, o: ROW_OUTCOME.FAILED, c: [failureCode(error)], w: false });
        }
    }
    const result = await db.$transaction(async (tx) => {
        const locked = await lockImport(tx, importId);
        await guardCommit(tx, locked, { importId, actor, now });
        return recordChunk(tx, locked, { importId, chunkIndex, actor, rows: outcomes, now });
    }, CHUNK_TRANSACTION);
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

// The totals of an import from its chunk results (what finish, abort and the automatic recovery record).
export function importCountsOf(record) {
    const chunkCount = Array.isArray(record.chunkHashes) ? record.chunkHashes.length : 0;
    const results = record.chunkResults ?? {};
    const counts = Object.values(results).reduce((sum, result) => addCounts(sum, result.counts ?? {}), {});
    counts.uncommittedChunks = chunkCount - Object.keys(results).length;
    counts.uncommittedRows = record.totalRows - (counts.rows ?? 0);
    return counts;
}

// Totals, final status, lifecycle audit, and (when anything was written) the existing RECONCILE run.
// Idempotent and safe against a second request at the same moment: the import row is locked, so only
// the call that moves it out of PREVIEWED / COMMITTING writes the audit entry and asks for the sync;
// the other one gets the finished result (alreadyFinished).
export const finishImport = (args) => closeImport({ ...args, abort: false });

// Stops an import on purpose: no more chunks are accepted, the rows already imported are KEPT, the status
// becomes ABORTED (a rollback is a separate, explicit action). The owner may abort their import; any ADMIN
// may abort one that has gone stale (15 minutes without a chunk), which frees the single committing slot.
export const abortImport = (args) => closeImport({ ...args, abort: true });

async function closeImport({ db, actor, importId, abort, now = new Date() }) {
    const outcome = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "candidate_import" WHERE "import_id" = ${importId}::uuid FOR UPDATE`;
        const existing = await tx.candidateImport.findUnique({ where: { importId } });
        if (!existing) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
        if (existing.adminId !== actor.adminId && !(abort && isStaleImport(existing, now))) {
            throw new CandidateImportError(403, "NOT_YOUR_IMPORT", abort ? "This import belongs to another user and has not stopped yet." : "This import was started by another user.");
        }
        // Taken over by the automatic recovery: it is being undone, so it can neither be completed nor aborted (an
        // import is completed only by a finish that reaches the backend before the recovery does).
        if (isRecovered(existing)) throw recoveryStartedError();
        if (FINISHED.has(existing.status)) return { record: existing, transitioned: false };

        const counts = importCountsOf(existing);
        const written = (counts.created ?? 0) + (counts.filled ?? 0);
        const errors = (counts.failed ?? 0) + counts.uncommittedRows;
        const status = abort ? IMPORT_STATUS.ABORTED
            : errors && !written ? IMPORT_STATUS.FAILED : errors ? IMPORT_STATUS.COMPLETED_WITH_ERRORS : IMPORT_STATUS.COMPLETED;
        const record = await tx.candidateImport.update({ where: { importId }, data: { status, resultCounts: counts, completedAt: now, updatedAt: now } });
        await tx.auditLog.create({
            data: auditEntry(actor, {
                action: abort ? IMPORT_AUDIT_ACTION.ABORTED : status === IMPORT_STATUS.FAILED ? IMPORT_AUDIT_ACTION.FAILED : IMPORT_AUDIT_ACTION.COMPLETED,
                previousStatus: existing.status, newStatus: status,
                reason: abort ? `Bulk candidate import ${importId} aborted${existing.adminId === actor.adminId ? "" : " (stopped import, aborted by another administrator)"}` : `Bulk candidate import ${importId} finished`,
                // Counts only: never a row.
                newValue: JSON.stringify({ importId, totalRows: existing.totalRows, ...counts, syncRequested: written > 0 }),
            }),
        });
        return { record, transitioned: true, written };
    }, CHUNK_TRANSACTION);
    if (!outcome.transitioned) return finishedView(outcome.record, { alreadyFinished: true });

    // The mirror is updated by the existing reconciliation (a queued or running one is reused). Requested
    // after the status commit, by the one call that made the transition.
    let sync = { requested: false, runId: null, alreadyActive: false };
    let record = outcome.record;
    if (outcome.written) {
        const { run, created } = await requestSheetSyncRun({ db, kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.ADMIN, requestedBy: actor.adminId, now });
        sync = { requested: true, runId: run.runId, alreadyActive: !created };
        record = await db.candidateImport.update({ where: { importId }, data: { syncRunId: run.runId } });
    }
    return finishedView(record, { sync });
}

function finishedView(record, extra = {}) {
    return { importId: record.importId, status: record.status, totalRows: record.totalRows, counts: record.resultCounts ?? {}, syncRunId: record.syncRunId ?? null, ...extra };
}

// The import's state (for a page reload): counts and statuses only.
export async function getImport({ db, actor, importId, now = new Date() }) {
    const record = await db.candidateImport.findUnique({ where: { importId } });
    if (!record || record.adminId !== actor.adminId) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
    const results = record.chunkResults ?? {};
    return {
        importId: record.importId, status: record.status, fileName: record.fileName, totalRows: record.totalRows, chunkSize: record.chunkSize,
        chunkCount: Array.isArray(record.chunkHashes) ? record.chunkHashes.length : 0, previewCounts: record.previewCounts,
        chunks: Object.fromEntries(Object.entries(results).map(([index, result]) => [index, { status: result.status, counts: result.counts }])),
        committedChunks: committedChunkIndexes(record), stale: isStaleImport(record, now),
        resultCounts: record.resultCounts ?? null, syncRunId: record.syncRunId ?? null, createdAt: record.createdAt, completedAt: record.completedAt,
        recovery: record.recoveryStatus ? { status: record.recoveryStatus, reason: record.recoveryReason, startedAt: record.recoveryStartedAt, completedAt: record.recoveryCompletedAt } : null,
    };
}

// The administrator's own import that is committing right now, if any (at most one per administrator): for
// the Upload dialog to offer Resume / Abort instead of starting another. Other administrators' imports are
// theirs and do not block this one. File name, counts and ids only.
export async function getActiveImport({ db, actor, now = new Date() }) {
    // Also a rollback of one of your imports that was interrupted (status ROLLING_BACK): to continue it.
    const active = await db.candidateImport.findFirst({ where: { status: { in: [IMPORT_STATUS.COMMITTING, IMPORT_STATUS.ROLLING_BACK] }, adminId: actor.adminId }, orderBy: { updatedAt: "desc" } });
    return { active: active ? activeDetails(active, actor, now) : null };
}

// ---------------------------------------------------------------- heartbeat

// POST /:importId/heartbeat, about every 20 s while the Upload dialog is committing: "the browser is still here".
// Records heartbeat_at in database time and NOTHING else: it never renews the commit lease (only a chunk does), so a
// browser that stays open while nothing reaches the backend delays the automatic recovery only for a bounded time
// (importRecoveryService.js). It never waits for a chunk: an import row locked by a chunk transaction is skipped (that
// chunk renews the lease anyway). Answers { status, recorded }; 409 IMPORT_RECOVERY_STARTED once the recovery has
// taken the import over (the dialog then stops), 409 IMPORT_FINISHED for a finished one.
export async function recordImportHeartbeat({ db, actor, importId }) {
    const updated = await db.$queryRaw`
        UPDATE "candidate_import" SET "heartbeat_at" = now()
        WHERE "import_id" = (SELECT "import_id" FROM "candidate_import"
                             WHERE "import_id" = ${importId}::uuid AND "admin_id" = ${actor.adminId} AND "status" = 'COMMITTING' AND "recovery_status" IS NULL
                             FOR UPDATE SKIP LOCKED)
        RETURNING "status"`;
    if (updated.length) return { status: updated[0].status, recorded: true };
    const record = await db.candidateImport.findUnique({ where: { importId }, select: { adminId: true, status: true, recoveryStatus: true } });
    if (!record || record.adminId !== actor.adminId) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
    if (isRecovered(record)) throw recoveryStartedError();
    if (FINISHED.has(record.status)) throw new CandidateImportError(409, "IMPORT_FINISHED", "This import is already finished.");
    // PREVIEWED (the first chunk has not committed yet), or COMMITTING with a chunk being written right now.
    return { status: record.status, recorded: false };
}
