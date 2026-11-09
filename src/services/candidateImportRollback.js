// Bulk candidate import: ROLLBACK, from the import's change ledger (candidateImportLedger.js).
//
// What it does: reverses what an import changed, entry by entry, and ONLY where the record is exactly as the
// import left it. Nothing is assumed from the fact that an entry exists: every entry is checked again, inside the
// transaction that reverses it, with the rows locked.
//
//   CREATE  the record is deleted only if every value the import wrote is still there (an HMAC check), nothing has
//           been recorded about it since by anything else, and nothing else depends on it (documents, Job
//           memberships, stages, forms, other Jobs ... found from the database's own foreign keys, so a table added
//           later is covered too). Otherwise it stays and the reason is recorded.
//   FILL    the fields the import filled are put back to the EXACT value they had (null stays null, "" stays "")
//           only if each still holds what the import wrote. A value that was not blank before the import could not
//           be stored in clear and is never restored.
//   LINK    the relationship is removed only if it is still as the import made it.
//
// Units (a rollback decides per unit, never half of one):
//   a candidate the import created, with everything that goes with it (details, stages, allocation, Job memberships):
//     deleted together, or kept together. A person who has since attached a document to it, or changed its stage,
//     keeps the candidate and what the import gave it.
//   a Job the import created, with its group row: deleted only when no member is left on it.
//   every other entry on its own (a membership of an existing candidate, a filled field, a Client's registration number).
// Order: created candidates, the loose entries of existing ones, Jobs, then links, Clients and Agents: a Job or a
// Client is considered only after what depends on it has been reverted (or has been found to stay).
//
// How: one call claims a LEASE on the import (compare-and-swap: free or expired), so two administrators (or a double
// click) cannot roll the same import back at once; it works in short batches, one transaction each (a unit inside a
// batch is guarded by a savepoint: an unexpected database error keeps that unit, records why, and carries on); it
// renews the lease after each batch and stops when its time budget is used, answering IN_PROGRESS. The browser calls
// again until DONE. Interrupted at any point it can simply be called again: finished entries are never touched twice
// (idempotent), the lease of a call that died runs out, and a conflict is recorded, not retried inside the same run.
//
// Audit: BULK_IMPORT_ROLLBACK_STARTED / _ENTRY (one per unit, with the candidate's id when there is one) /
// _COMPLETED / _FAILED. The ledger entries get their final status (REVERTED, CONFLICT, SKIPPED) with the codes of the
// reasons: never a value. A deleted candidate gets a sheet_deletion_approval in the SAME transaction, which lets
// the sheet worker mark that row inactive beyond its deletion guard (and nothing else). A reconciliation is
// requested when anything was reverted.
//
// Nothing here runs by itself and nothing runs when an import fails: a rollback is an explicit action (confirmed
// in the browser) on one import.

import crypto from "node:crypto";

import { CandidateImportError, IMPORT_STATUS } from "./candidateImportService.js";
import { ASSESSMENT, LEDGER_ENTITY as E, LEDGER_OP, LEDGER_STATUS, createAssessor } from "./candidateImportLedger.js";
import { readLedgerKeyring } from "./importLedgerKeys.js";
import { setAuditActor } from "./auditActor.js";
import { requestSheetSyncRun } from "./sheetSyncStatusService.js";
import { RUN_KIND, RUN_TRIGGER } from "./sheetSyncStore.js";

export const ROLLBACK_AUDIT_ACTION = Object.freeze({
    STARTED: "BULK_IMPORT_ROLLBACK_STARTED", ENTRY: "BULK_IMPORT_ROLLBACK_ENTRY", COMPLETED: "BULK_IMPORT_ROLLBACK_COMPLETED", FAILED: "BULK_IMPORT_ROLLBACK_FAILED",
});
export const ROLLBACK_LEASE_MS = 2 * 60_000;
export const ROLLBACK_TIME_BUDGET_MS = 40_000; // under Vercel's 60 s
const BATCH_ENTRIES = 120;
const BATCH_UNITS = 40;
const BATCH_TRANSACTION = Object.freeze({ timeout: 30_000, maxWait: 10_000 });
const PREVIEW_SAMPLE = 200;

// The states a rollback may start from. COMMITTING must be finished or aborted first; ROLLED_BACK is done;
// ROLLED_BACK_WITH_CONFLICTS may be run again (conflicts that have been resolved are then reverted).
export const ROLLBACK_START_STATUSES = new Set([
    IMPORT_STATUS.COMPLETED, IMPORT_STATUS.COMPLETED_WITH_ERRORS, IMPORT_STATUS.FAILED, IMPORT_STATUS.ABORTED, IMPORT_STATUS.ROLLED_BACK_WITH_CONFLICTS,
]);

// ---------------------------------------------------------------- access and loading

async function loadImport(db, importId) {
    const record = await db.candidateImport.findUnique({ where: { importId } });
    if (!record) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
    return record;
}

// The administrator who ran the import, or an Owner. (The routes already require an administrator.)
function requireAccess(record, actor) {
    if (record.adminId !== actor.adminId && actor.role !== "OWNER") {
        throw new CandidateImportError(403, "NOT_YOUR_IMPORT", "Only the administrator who ran this import, or an Owner, can roll it back.");
    }
}

const keyringOf = (injected) => {
    if (injected !== undefined) return injected;
    try { return readLedgerKeyring(); } catch { return null; }
};

// ---------------------------------------------------------------- what depends on a record (from the database's foreign keys)

// Every single-column foreign key that points at `table`: { table, column } (names quoted by the database). Read from
// the catalog, so a table added after this code was written is covered without changing it.
const referencing = new Map();
async function referencingTables(db, table) {
    if (!referencing.has(table)) {
        const rows = await db.$queryRaw`
            SELECT c."conrelid"::regclass::text AS "tbl", quote_ident(a."attname") AS "col"
            FROM "pg_constraint" c JOIN "pg_attribute" a ON a."attrelid" = c."conrelid" AND a."attnum" = c."conkey"[1]
            WHERE c."contype" = 'f' AND c."confrelid" = ${table}::regclass AND array_length(c."conkey", 1) = 1`;
        referencing.set(table, rows.map((row) => ({ table: row.tbl, column: row.col })));
    }
    return referencing.get(table);
}
const bare = (name) => name.replace(/^"|"$/g, "");

// ids -> Map(id -> [table names with a row pointing at it]), ignoring `ignore` (tables the rollback itself reverts together).
async function dependentTables(db, { table, keyType, ids, ignore = [] }) {
    const found = new Map();
    if (!ids.length) return found;
    for (const ref of await referencingTables(db, table)) {
        if (ignore.includes(bare(ref.table))) continue;
        const rows = await db.$queryRawUnsafe(`SELECT ${ref.column} AS "id", count(*)::int AS "n" FROM ${ref.table} WHERE ${ref.column} = ANY($1::${keyType}[]) GROUP BY ${ref.column}`, ids);
        for (const row of rows) (found.get(String(row.id)) ?? found.set(String(row.id), []).get(String(row.id))).push(bare(ref.table));
    }
    return found;
}

// ---------------------------------------------------------------- units

const FIRST_SINGLES = [E.JOB_CANDIDATE, E.STAGE, E.ALLOCATION, E.DETAILS, E.CANDIDATE];
const LAST_SINGLES = [E.AGENT_CLIENT, E.CLIENT, E.AGENT];
const DATE_FIELDS = { [E.STAGE]: new Set(["testDate", "completedAt"]) };

// The entries still to be reverted (status APPLIED), grouped into units and ordered (see the header).
export function buildUnits(rows) {
    const applied = rows.filter((r) => r.status === LEDGER_STATUS.APPLIED);
    const createdCandidates = new Set(rows.filter((r) => r.entityType === E.CANDIDATE && r.op === LEDGER_OP.CREATE).map((r) => r.entityKey));
    const used = new Set();
    const units = [];
    const take = (entries) => entries.forEach((e) => used.add(e.changeId));

    const byCandidate = new Map();
    for (const row of applied) {
        if (row.candidateUniqueId && createdCandidates.has(row.candidateUniqueId)) {
            if (!byCandidate.has(row.candidateUniqueId)) byCandidate.set(row.candidateUniqueId, []);
            byCandidate.get(row.candidateUniqueId).push(row);
        }
    }
    for (const [key, entries] of byCandidate) { units.push({ kind: "candidate", key, entries }); take(entries); }

    const singles = (types) => {
        for (const type of types) for (const entry of applied.filter((r) => r.entityType === type && !used.has(r.changeId))) { units.push({ kind: "single", key: entry.entityKey, entries: [entry] }); take([entry]); }
    };
    singles(FIRST_SINGLES);
    for (const job of applied.filter((r) => r.entityType === E.JOB && !used.has(r.changeId))) {
        const entries = [job, ...applied.filter((r) => r.entityType === E.JOB_GROUP && r.relatedJobId === job.entityKey && !used.has(r.changeId))];
        units.push({ kind: "job", key: job.entityKey, entries });
        take(entries);
    }
    singles(LAST_SINGLES);
    // Anything else (a group row whose Job is not in this import's ledger) is not understood: kept, with a reason.
    for (const entry of applied.filter((r) => !used.has(r.changeId))) units.push({ kind: "unsupported", key: entry.entityKey, entries: [entry] });
    return units;
}

const entryCount = (units) => units.reduce((n, u) => n + u.entries.length, 0);
function batchesOf(units) {
    const batches = [];
    let current = [];
    for (const unit of units) {
        current.push(unit);
        if (current.length >= BATCH_UNITS || entryCount(current) >= BATCH_ENTRIES) { batches.push(current); current = []; }
    }
    if (current.length) batches.push(current);
    return batches;
}

// ---------------------------------------------------------------- deciding (read-only)

const verdict = (entry, state, reasons = []) => ({ entry, state, reasons });
const REVERT = "REVERT";
const CONFLICT = "CONFLICT";
const SKIP = "SKIP";

const isHashed = (value) => Boolean(value) && typeof value === "object";
const restoreData = (entry) => Object.fromEntries(Object.entries(entry.changes ?? {}).map(([field, change]) => {
    const before = change.before;
    return [field, typeof before === "string" && DATE_FIELDS[entry.entityType]?.has(field) ? new Date(before) : before];
}));
// Every previous value is available exactly (a blank, or a value stored in clear). One that is not blank and was
// personal was stored only as a digest: it cannot be restored, so the entry stays.
const restorable = (entry) => Object.values(entry.changes ?? {}).every((change) => !isHashed(change.before));

// What earlier units WOULD remove, for a preview (it writes nothing, so those rows are still there when a later unit
// is judged): memberships ("jobId:passportId"), Jobs and Agent-Client links. A rollback itself starts each unit from
// the database as it really is, where they are already gone, so its record stays empty.
const newVirtual = () => ({ members: new Set(), jobs: new Set(), links: new Set() });

// What still points at a Job / Client / Agent, other than what is being reverted before it.
async function jobBlockers(db, jobId, virtual) {
    const members = (await db.jobCandidate.findMany({ where: { jobId }, select: { passportId: true } })).filter((m) => !virtual.members.has(`${jobId}:${m.passportId}`));
    const tables = (await dependentTables(db, { table: "job", keyType: "uuid", ids: [jobId], ignore: ["job_candidate", "job_job_type", "import_job_group"] })).get(jobId) ?? [];
    return { members: members.length, tables };
}
async function orgBlockers(db, kind, id, virtual) {
    const jobs = (await db.job.findMany({ where: kind === "client" ? { clientId: id } : { responsibleAgentId: id }, select: { id: true } })).filter((j) => !virtual.jobs.has(j.id));
    const links = (await db.agentClient.findMany({ where: kind === "client" ? { clientId: id } : { agentId: id }, select: { agentId: true, clientId: true } })).filter((l) => !virtual.links.has(`${l.agentId}:${l.clientId}`));
    const others = (await dependentTables(db, { table: kind, keyType: "uuid", ids: [id], ignore: ["job", "agent_client"] })).get(id) ?? [];
    return [...(jobs.length ? ["job"] : []), ...(links.length ? ["agent_client"] : []), ...others];
}

// A preview records, for the units after it, what a unit that is going to be reverted takes with it.
function recordVirtual(unit, verdicts, context) {
    if (verdicts.some((v) => v.state === CONFLICT) || !verdicts.some((v) => v.state === REVERT)) return;
    const { virtual, resolver } = context;
    if (unit.kind === "candidate") {
        const passportId = context.passportByUnit?.get(unit.key);
        for (const m of resolver.membershipsOf(passportId)) virtual.members.add(`${m.jobId}:${passportId}`);
    } else if (unit.kind === "job") virtual.jobs.add(unit.key);
    else if (unit.entries[0].entityType === E.JOB_CANDIDATE) {
        const [jobId, uniqueId] = unit.entries[0].entityKey.split(":");
        virtual.members.add(`${jobId}:${context.passportByUnit?.get(uniqueId)}`);
    } else if (unit.entries[0].entityType === E.AGENT_CLIENT) virtual.links.add(unit.entries[0].entityKey);
}

// Prepares what a batch's decisions read: the entries' current state, bulk (resolver.prefetch), and what depends on
// each candidate the batch would delete. `db` is the database (preview) or the batch's transaction (execution).
async function prepare(db, importId, rows, units, keyring) {
    const assessor = createAssessor({ db, importId, rows, keyring });
    await assessor.prefetch(units.flatMap((u) => u.entries));
    const candidateUnits = units.filter((u) => u.kind === "candidate");
    const passports = [];
    for (const unit of candidateUnits) {
        const passportId = await assessor.passportOf(unit.key);
        if (passportId) passports.push(passportId);
    }
    // Tables the rollback reverts WITH the candidate are judged by the unit (their entries), not here.
    const candidateDependents = await dependentTables(db, { table: "candidate", keyType: "text", ids: passports, ignore: ["candidate_stages", "candidate_additional_details", "candidate_allocation", "job_candidate"] });
    return { assessor, resolver: assessor.resolver, candidateDependents, virtual: newVirtual() };
}

const assessAll = async (assess, entries) => new Map(await Promise.all(entries.map(async (entry) => [entry.changeId, await assess(entry)])));
const reasonsOf = (assessed) => assessed.reasons ?? [];

// A unit's decision: one verdict per entry. Nothing is written.
async function decide(db, unit, context) {
    const { assessor, resolver, candidateDependents } = context;
    const assessed = await assessAll(assessor.assess, unit.entries);

    if (unit.kind === "candidate") {
        const candidate = unit.entries.find((e) => e.entityType === E.CANDIDATE);
        if (!candidate) return unit.entries.map((e) => verdict(e, CONFLICT, ["CANDIDATE_ENTRY_MISSING"]));
        if (assessed.get(candidate.changeId).state === ASSESSMENT.MISSING) return unit.entries.map((e) => verdict(e, SKIP, ["ALREADY_GONE"]));
        const reasons = new Map(unit.entries.map((e) => [e.changeId, assessed.get(e.changeId).state === ASSESSMENT.CONFLICT ? [...reasonsOf(assessed.get(e.changeId))] : []]));
        const passportId = await assessor.passportOf(unit.key);
        const others = candidateDependents.get(passportId) ?? [];
        if (others.length) reasons.get(candidate.changeId).push(`HAS_DEPENDENT_RECORDS:${others.join(",")}`);
        // Rows that would go with the candidate but that the import did not make: someone else's work.
        if (resolver.allocationOf(passportId) && !unit.entries.some((e) => e.entityType === E.ALLOCATION)) reasons.get(candidate.changeId).push("HAS_OTHER_ALLOCATION");
        if (resolver.detailsOf(passportId) && !unit.entries.some((e) => e.entityType === E.DETAILS)) reasons.get(candidate.changeId).push("HAS_OTHER_DETAILS");
        if ([...reasons.values()].some((r) => r.length)) {
            return unit.entries.map((e) => verdict(e, CONFLICT, reasons.get(e.changeId).length ? reasons.get(e.changeId) : [e === candidate ? "DEPENDENT_ENTRY_CONFLICT" : "PARENT_NOT_REVERTED"]));
        }
        return unit.entries.map((e) => (assessed.get(e.changeId).state === ASSESSMENT.MISSING ? verdict(e, SKIP, ["ALREADY_GONE"]) : verdict(e, REVERT)));
    }

    if (unit.kind === "job") {
        const job = unit.entries.find((e) => e.entityType === E.JOB);
        if (assessed.get(job.changeId).state === ASSESSMENT.MISSING) return unit.entries.map((e) => verdict(e, SKIP, ["ALREADY_GONE"]));
        const reasons = new Map(unit.entries.map((e) => [e.changeId, assessed.get(e.changeId).state === ASSESSMENT.CONFLICT ? [...reasonsOf(assessed.get(e.changeId))] : []]));
        // Members the import added are reverted before this point; any member left is someone's work (or a conflict).
        const blockers = await jobBlockers(db, job.entityKey, context.virtual);
        if (blockers.members && !reasons.get(job.changeId).includes("HAS_OTHER_MEMBERS")) reasons.get(job.changeId).push("HAS_OTHER_MEMBERS");
        if (blockers.tables.length) reasons.get(job.changeId).push(`HAS_DEPENDENT_RECORDS:${blockers.tables.join(",")}`);
        if ([...reasons.values()].some((r) => r.length)) {
            return unit.entries.map((e) => verdict(e, CONFLICT, reasons.get(e.changeId).length ? reasons.get(e.changeId) : ["PARENT_NOT_REVERTED"]));
        }
        return unit.entries.map((e) => (assessed.get(e.changeId).state === ASSESSMENT.MISSING ? verdict(e, SKIP, ["ALREADY_GONE"]) : verdict(e, REVERT)));
    }

    const [entry] = unit.entries;
    if (unit.kind === "unsupported") return [verdict(entry, CONFLICT, ["UNSUPPORTED_ENTRY"])];
    const a = assessed.get(entry.changeId);
    if (a.state === ASSESSMENT.MISSING) return [verdict(entry, SKIP, ["ALREADY_GONE"])];
    if (a.state === ASSESSMENT.CONFLICT) return [verdict(entry, CONFLICT, reasonsOf(a))];
    const reasons = [];
    if (entry.op === LEDGER_OP.FILL && !restorable(entry)) reasons.push("PREVIOUS_VALUE_NOT_RESTORABLE");
    // Created stage / details of an existing candidate: anything recorded about the candidate since, by anything else, keeps them.
    if (entry.op !== LEDGER_OP.FILL && (entry.entityType === E.STAGE || entry.entityType === E.DETAILS)) {
        const passportId = await assessor.passportOf(entry.entityType === E.STAGE ? entry.entityKey.split(":")[0] : entry.entityKey);
        if (passportId && resolver.laterAuditAfter(passportId, entry.createdAt)) reasons.push("CHANGED_AFTER_IMPORT");
    }
    if ((entry.entityType === E.CLIENT || entry.entityType === E.AGENT) && entry.op === LEDGER_OP.CREATE) {
        const table = entry.entityType === E.CLIENT ? "client" : "agent";
        const dependents = await orgBlockers(db, table, entry.entityKey, context.virtual);
        if (dependents.length) reasons.push(`HAS_DEPENDENT_RECORDS:${dependents.join(",")}`);
    }
    return [reasons.length ? verdict(entry, CONFLICT, reasons) : verdict(entry, REVERT)];
}

// ---------------------------------------------------------------- reversing (inside a batch's transaction)

const auditRow = (actor, data) => ({ auditId: crypto.randomUUID(), adminId: actor.adminId, ...data });

async function lockRows(tx, units) {
    const uniqueIds = [...new Set(units.flatMap((u) => u.entries.map((e) => e.candidateUniqueId ?? (u.kind === "single" && [E.CANDIDATE, E.DETAILS, E.ALLOCATION].includes(e.entityType) ? e.entityKey : null))).filter(Boolean))];
    if (uniqueIds.length) await tx.$queryRaw`SELECT "unique_id" FROM "candidate" WHERE "unique_id" = ANY(${uniqueIds}::text[]) ORDER BY "unique_id" FOR UPDATE`;
    const idsOf = (type) => [...new Set(units.flatMap((u) => u.entries.filter((e) => e.entityType === type).map((e) => e.entityKey)))].sort();
    const [jobs, clients, agents] = [idsOf(E.JOB), idsOf(E.CLIENT), idsOf(E.AGENT)];
    if (jobs.length) await tx.$queryRaw`SELECT "id" FROM "job" WHERE "id" = ANY(${jobs}::uuid[]) ORDER BY "id" FOR UPDATE`;
    if (clients.length) await tx.$queryRaw`SELECT "id" FROM "client" WHERE "id" = ANY(${clients}::uuid[]) ORDER BY "id" FOR UPDATE`;
    if (agents.length) await tx.$queryRaw`SELECT "id" FROM "agent" WHERE "id" = ANY(${agents}::uuid[]) ORDER BY "id" FOR UPDATE`;
}

// Writes one unit's reversal. Returns { action, passportId? } for the report and the audit entry.
async function apply(tx, unit, context, { importId }) {
    const { assessor } = context;
    if (unit.kind === "candidate") {
        const passportId = await assessor.passportOf(unit.key);
        await tx.candidate.delete({ where: { passportId } }); // its details, stages, allocation and memberships go with it (checked above)
        // The sheet worker may mark this candidate's Sheet row inactive beyond its deletion guard: this one only.
        await tx.sheetSyncDeletionApproval.createMany({ data: [{ uniqueId: unit.key, importId }], skipDuplicates: true });
        return { action: "DELETED_CANDIDATE", passportId };
    }
    if (unit.kind === "job") {
        await tx.jobJobType.deleteMany({ where: { jobId: unit.key } });
        await tx.importJobGroup.deleteMany({ where: { jobId: unit.key } });
        await tx.job.delete({ where: { id: unit.key } });
        return { action: "DELETED_JOB" };
    }
    const [entry] = unit.entries;
    const restore = restoreData(entry);
    switch (entry.entityType) {
        case E.JOB_CANDIDATE: {
            const [jobId, uniqueId] = entry.entityKey.split(":");
            const passportId = await assessor.passportOf(uniqueId);
            await tx.jobCandidate.delete({ where: { jobId_passportId: { jobId, passportId } } });
            return { action: "REMOVED_FROM_JOB", passportId };
        }
        case E.STAGE: {
            const [uniqueId, stage] = entry.entityKey.split(":");
            const passportId = await assessor.passportOf(uniqueId);
            if (entry.op === LEDGER_OP.FILL) await tx.candidateStage.update({ where: { passportId_stage: { passportId, stage } }, data: restore });
            else await tx.candidateStage.delete({ where: { passportId_stage: { passportId, stage } } });
            return { action: entry.op === LEDGER_OP.FILL ? "RESTORED" : "DELETED", passportId };
        }
        case E.ALLOCATION: {
            const passportId = await assessor.passportOf(entry.entityKey);
            await tx.candidateAllocation.delete({ where: { passportId } });
            return { action: "DELETED", passportId };
        }
        case E.DETAILS: {
            const passportId = await assessor.passportOf(entry.entityKey);
            if (entry.op === LEDGER_OP.FILL) await tx.candidateAdditionalDetails.update({ where: { passportId }, data: restore });
            else await tx.candidateAdditionalDetails.delete({ where: { passportId } });
            return { action: entry.op === LEDGER_OP.FILL ? "RESTORED" : "DELETED", passportId };
        }
        case E.CANDIDATE: { // a FILL: the fields the import filled, back to what they were
            const passportId = await assessor.passportOf(entry.entityKey);
            await tx.candidate.update({ where: { passportId }, data: restore });
            return { action: "RESTORED", passportId };
        }
        case E.AGENT_CLIENT: {
            const [agentId, clientId] = entry.entityKey.split(":");
            await tx.agentClient.delete({ where: { agentId_clientId: { agentId, clientId } } });
            return { action: "DELETED" };
        }
        case E.CLIENT:
            if (entry.op === LEDGER_OP.FILL) await tx.client.update({ where: { id: entry.entityKey }, data: restore });
            else await tx.client.delete({ where: { id: entry.entityKey } });
            return { action: entry.op === LEDGER_OP.FILL ? "RESTORED" : "DELETED" };
        case E.AGENT:
            await tx.agent.delete({ where: { id: entry.entityKey } });
            return { action: "DELETED" };
        default:
            throw new Error("UNSUPPORTED_ENTRY");
    }
}

const safeCode = (error) => {
    const code = error?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,20}$/.test(code) ? code : "DB_ERROR";
};

// One batch, one transaction: renew the lease, lock, decide again (inside the transaction), reverse what is still
// safe, record every entry's outcome. Returns the tallies. A unit that fails unexpectedly is rolled back to its
// savepoint and recorded as a conflict (REVERT_FAILED), the rest of the batch goes on.
async function processBatch(db, { importId, actor, token, keyring, now, rows, units }) {
    return db.$transaction(async (tx) => {
        const leased = await tx.$executeRaw`
            UPDATE "candidate_import" SET "rollback_lease_expires_at" = ${new Date(now.getTime() + ROLLBACK_LEASE_MS)}, "updated_at" = ${now}
            WHERE "import_id" = ${importId}::uuid AND "rollback_lease_token" = ${token}::uuid AND "status" = 'ROLLING_BACK'`;
        if (leased !== 1) throw new CandidateImportError(409, "ROLLBACK_LEASE_LOST", "Another request took over this rollback. Nothing was changed by this one.");
        await setAuditActor(tx, actor);
        await lockRows(tx, units);
        const context = await prepare(tx, importId, rows, units, keyring);
        const audits = [];
        const tally = { reverted: 0, conflicts: 0, skipped: 0 };
        for (const unit of units) {
            const verdicts = await decide(tx, unit, context);
            let outcome = verdicts;
            let done = null;
            if (verdicts.every((v) => v.state !== CONFLICT) && verdicts.some((v) => v.state === REVERT)) {
                await tx.$executeRaw`SAVEPOINT rollback_unit`;
                try {
                    done = await apply(tx, unit, context, { importId });
                    await tx.$executeRaw`RELEASE SAVEPOINT rollback_unit`;
                } catch (error) {
                    await tx.$executeRaw`ROLLBACK TO SAVEPOINT rollback_unit`;
                    outcome = verdicts.map((v) => verdict(v.entry, CONFLICT, [`REVERT_FAILED:${safeCode(error)}`]));
                }
            }
            for (const v of outcome) {
                const where = { changeId: v.entry.changeId, status: LEDGER_STATUS.APPLIED };
                if (v.state === REVERT) {
                    await tx.candidateImportChange.updateMany({ where, data: { status: LEDGER_STATUS.REVERTED, revertedAt: now, revertDetail: { action: done?.action ?? "REVERTED" } } });
                    tally.reverted += 1;
                } else if (v.state === SKIP) {
                    await tx.candidateImportChange.updateMany({ where, data: { status: LEDGER_STATUS.SKIPPED, revertedAt: now, revertDetail: { reasons: v.reasons } } });
                    tally.skipped += 1;
                } else {
                    await tx.candidateImportChange.updateMany({ where, data: { status: LEDGER_STATUS.CONFLICT, revertDetail: { reasons: v.reasons } } });
                    tally.conflicts += 1;
                }
            }
            if (done) {
                audits.push(auditRow(actor, {
                    action: ROLLBACK_AUDIT_ACTION.ENTRY, passportId: done.passportId ?? null, previousStatus: "IMPORTED", newStatus: "ROLLED_BACK",
                    reason: `Reversed by the rollback of bulk import ${importId}`,
                    newValue: JSON.stringify({ importId, kind: unit.kind, action: done.action, entries: unit.entries.map((e) => e.changeId) }),
                }));
            }
        }
        if (audits.length) await tx.auditLog.createMany({ data: audits });
        return tally;
    }, BATCH_TRANSACTION);
}

// ---------------------------------------------------------------- report

function conflictCodes(entry) {
    const reasons = entry.revertDetail?.reasons;
    return Array.isArray(reasons) ? reasons : [];
}
const codeOf = (reason) => String(reason).split(":")[0];

// Counts and codes only, from the ledger: never a value.
async function reportOf(db, record) {
    const rows = await db.candidateImportChange.findMany({ where: { importId: record.importId }, select: { entityType: true, op: true, status: true, rowNumber: true, revertDetail: true } });
    const count = (status) => rows.filter((r) => r.status === status).length;
    const byType = {};
    for (const row of rows) {
        const t = (byType[row.entityType] ??= { reverted: 0, conflicts: 0, skipped: 0, remaining: 0 });
        t[{ REVERTED: "reverted", CONFLICT: "conflicts", SKIPPED: "skipped", APPLIED: "remaining" }[row.status]] += 1;
    }
    const reasons = {};
    for (const row of rows.filter((r) => r.status === LEDGER_STATUS.CONFLICT)) for (const reason of conflictCodes(row)) reasons[codeOf(reason)] = (reasons[codeOf(reason)] ?? 0) + 1;
    const result = record.rollbackResult ?? {};
    return {
        importId: record.importId, status: record.status, previousStatus: record.rollbackPreviousStatus ?? null,
        done: record.status === IMPORT_STATUS.ROLLED_BACK || record.status === IMPORT_STATUS.ROLLED_BACK_WITH_CONFLICTS,
        startedAt: record.rollbackStartedAt ?? null, completedAt: record.rollbackCompletedAt ?? null,
        counts: { total: rows.length, reverted: count(LEDGER_STATUS.REVERTED), conflicts: count(LEDGER_STATUS.CONFLICT), skipped: count(LEDGER_STATUS.SKIPPED), remaining: count(LEDGER_STATUS.APPLIED) },
        byType, reasons,
        conflicts: rows.filter((r) => r.status === LEDGER_STATUS.CONFLICT).slice(0, PREVIEW_SAMPLE).map((r) => ({ entityType: r.entityType, op: r.op, rowNumber: r.rowNumber, reasons: conflictCodes(r) })),
        sync: result.sync ?? null, lastError: result.lastError ?? null,
    };
}

// ---------------------------------------------------------------- preview (read-only)

// What a rollback of this import would do right now, from the same decisions it would make: eligible, conflicting
// (with the reasons), missing, already reverted. Writes nothing.
export async function previewRollback({ db, actor, importId, keyring, now = new Date() }) {
    const record = await loadImport(db, importId);
    requireAccess(record, actor);
    const keys = keyringOf(keyring);
    const rows = await db.candidateImportChange.findMany({ where: { importId }, orderBy: [{ chunkIndex: "asc" }, { createdAt: "asc" }, { changeId: "asc" }] });
    // A NEW run tries every conflict of an earlier run again, so that is what is previewed. A run that was interrupted
    // (ROLLING_BACK) is continued as it is: the conflicts it already recorded stay recorded, and are shown as such.
    const resuming = record.status === IMPORT_STATUS.ROLLING_BACK;
    const asApplied = resuming ? rows : rows.map((r) => (r.status === LEDGER_STATUS.CONFLICT ? { ...r, status: LEDGER_STATUS.APPLIED } : r));
    const units = buildUnits(asApplied);
    const verdicts = [];
    const virtual = newVirtual();
    for (const batch of batchesOf(units)) {
        const context = await prepare(db, importId, asApplied, batch, keys);
        context.virtual = virtual; // shared by the whole preview: later batches see what earlier ones would remove
        context.passportByUnit = new Map();
        for (const unit of batch) {
            const uniqueId = unit.kind === "candidate" ? unit.key : unit.entries[0].entityType === E.JOB_CANDIDATE ? unit.entries[0].entityKey.split(":")[1] : null;
            if (uniqueId) context.passportByUnit.set(uniqueId, await context.assessor.passportOf(uniqueId));
            const decided = await decide(db, unit, context);
            verdicts.push(...decided);
            recordVirtual(unit, decided, context);
        }
    }
    if (resuming) {
        for (const entry of rows.filter((r) => r.status === LEDGER_STATUS.CONFLICT)) verdicts.push(verdict(entry, CONFLICT, conflictCodes(entry)));
    }
    const eligible = verdicts.filter((v) => v.state === REVERT);
    const conflicts = verdicts.filter((v) => v.state === CONFLICT);
    const missing = verdicts.filter((v) => v.state === SKIP);
    const reverted = rows.filter((r) => r.status === LEDGER_STATUS.REVERTED);
    const priorSkipped = rows.filter((r) => r.status === LEDGER_STATUS.SKIPPED);
    const reasons = {};
    for (const v of conflicts) for (const reason of v.reasons) reasons[codeOf(reason)] = (reasons[codeOf(reason)] ?? 0) + 1;
    const byType = {};
    const bump = (type, key) => { (byType[type] ??= { eligible: 0, conflicts: 0, missing: 0, alreadyReverted: 0 })[key] += 1; };
    eligible.forEach((v) => bump(v.entry.entityType, "eligible"));
    conflicts.forEach((v) => bump(v.entry.entityType, "conflicts"));
    [...missing, ...priorSkipped.map((entry) => ({ entry }))].forEach((v) => bump(v.entry.entityType, "missing"));
    reverted.forEach((r) => bump(r.entityType, "alreadyReverted"));
    const creates = (type) => eligible.filter((v) => v.entry.entityType === type && v.entry.op === LEDGER_OP.CREATE).length;
    const sample = (list) => list.slice(0, PREVIEW_SAMPLE).map((v) => ({ entityType: v.entry.entityType, op: v.entry.op, rowNumber: v.entry.rowNumber, reasons: v.reasons }));
    const hasActiveLease = record.status === IMPORT_STATUS.ROLLING_BACK && record.rollbackLeaseExpiresAt && record.rollbackLeaseExpiresAt > now;
    let blocked = null;
    if (record.status === IMPORT_STATUS.COMMITTING) blocked = "IMPORT_STILL_COMMITTING";
    else if (record.status === IMPORT_STATUS.PREVIEWED) blocked = "NOTHING_TO_ROLL_BACK";
    else if (record.status === IMPORT_STATUS.ROLLED_BACK) blocked = "ALREADY_ROLLED_BACK";
    else if (hasActiveLease) blocked = "ROLLBACK_IN_PROGRESS";
    else if (!ROLLBACK_START_STATUSES.has(record.status) && record.status !== IMPORT_STATUS.ROLLING_BACK) blocked = "NOT_ALLOWED";
    else if (!eligible.length) blocked = "NOTHING_TO_REVERT";
    return {
        importId, status: record.status, canStart: blocked === null, blockedReason: blocked, keyAvailable: Boolean(keys),
        summary: { total: rows.length, eligible: eligible.length, conflicts: conflicts.length, missing: missing.length + priorSkipped.length, alreadyReverted: reverted.length },
        willDelete: { candidates: creates(E.CANDIDATE), jobs: creates(E.JOB), clients: creates(E.CLIENT), agents: creates(E.AGENT) },
        byType, reasons, conflicts: sample(conflicts), missing: sample(missing),
    };
}

// ---------------------------------------------------------------- the lease

// Claims the rollback of an import for one call, or says why not. A fresh run (from a state that allows one) turns
// the entries that conflicted in an earlier run back into entries to try; a run that was interrupted is continued as it is.
async function claim(db, { importId, actor, token, now }) {
    return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "candidate_import" WHERE "import_id" = ${importId}::uuid FOR UPDATE`;
        const record = await tx.candidateImport.findUnique({ where: { importId } });
        if (!record) throw new CandidateImportError(404, "IMPORT_NOT_FOUND", "Import not found.");
        requireAccess(record, actor);
        const lease = { rollbackLeaseToken: token, rollbackLeaseExpiresAt: new Date(now.getTime() + ROLLBACK_LEASE_MS), updatedAt: now };
        if (record.status === IMPORT_STATUS.ROLLING_BACK) {
            if (record.rollbackLeaseExpiresAt && record.rollbackLeaseExpiresAt > now) {
                throw new CandidateImportError(409, "ROLLBACK_IN_PROGRESS", "This import is being rolled back right now. Wait for it to finish.", { details: { startedAt: record.rollbackStartedAt, startedByYou: record.rollbackAdminId === actor.adminId } });
            }
            await tx.candidateImport.update({ where: { importId }, data: lease }); // its call died: take over
            return { record, fresh: false };
        }
        if (record.status === IMPORT_STATUS.ROLLED_BACK) throw new CandidateImportError(409, "ALREADY_ROLLED_BACK", "This import has already been rolled back.");
        if (record.status === IMPORT_STATUS.COMMITTING) throw new CandidateImportError(409, "IMPORT_STILL_COMMITTING", "This import is still committing. Finish or abort it first.");
        if (!ROLLBACK_START_STATUSES.has(record.status)) throw new CandidateImportError(409, "NOTHING_TO_ROLL_BACK", "This import has nothing to roll back.");
        await tx.candidateImport.update({
            where: { importId },
            data: { status: IMPORT_STATUS.ROLLING_BACK, rollbackPreviousStatus: record.status, rollbackAdminId: actor.adminId, rollbackStartedAt: now, rollbackCompletedAt: null, rollbackResult: null, ...lease },
        });
        await tx.candidateImportChange.updateMany({ where: { importId, status: LEDGER_STATUS.CONFLICT }, data: { status: LEDGER_STATUS.APPLIED, revertDetail: null } });
        await tx.auditLog.create({
            data: auditRow(actor, {
                action: ROLLBACK_AUDIT_ACTION.STARTED, previousStatus: record.status, newStatus: IMPORT_STATUS.ROLLING_BACK, reason: `Rollback of bulk candidate import ${importId} started`,
                newValue: JSON.stringify({ importId }),
            }),
        });
        return { record, fresh: true };
    }, BATCH_TRANSACTION);
}

async function releaseLease(db, importId, token, now) {
    await db.$executeRaw`UPDATE "candidate_import" SET "rollback_lease_expires_at" = ${now} WHERE "import_id" = ${importId}::uuid AND "rollback_lease_token" = ${token}::uuid`.catch(() => {});
}

// ---------------------------------------------------------------- execution

// Rolls an import back, within a time budget. Returns the report: done = false means "call again" (a long import takes
// several calls; each is safe to repeat). confirm must be true. expectedEligible (a number): what the administrator was
// shown; a fresh run is refused (409 ROLLBACK_PREVIEW_CHANGED, with the new counts) when it no longer matches.
export async function executeRollback({
    db, actor, importId, confirm = false, expectedEligible = null, keyring, clock = () => new Date(), timeBudgetMs = ROLLBACK_TIME_BUDGET_MS,
}) {
    if (confirm !== true) throw new CandidateImportError(400, "CONFIRMATION_REQUIRED", "Confirm the rollback to run it.");
    const record = await loadImport(db, importId);
    requireAccess(record, actor);
    const keys = keyringOf(keyring);

    if (record.status !== IMPORT_STATUS.ROLLING_BACK && expectedEligible !== null) {
        const preview = await previewRollback({ db, actor, importId, keyring: keys, now: clock() });
        if (preview.summary.eligible !== expectedEligible) {
            throw new CandidateImportError(409, "ROLLBACK_PREVIEW_CHANGED", "The import changed since you reviewed it. Review it again before rolling back.", { details: { summary: preview.summary } });
        }
    }
    const token = crypto.randomUUID();
    const startedAt = clock();
    await claim(db, { importId, actor, token, now: startedAt });

    try {
        const rows = await db.candidateImportChange.findMany({ where: { importId }, orderBy: [{ chunkIndex: "asc" }, { createdAt: "asc" }, { changeId: "asc" }] });
        const batches = batchesOf(buildUnits(rows));
        for (let i = 0; i < batches.length; i++) {
            if (clock().getTime() - startedAt.getTime() > timeBudgetMs) {
                await releaseLease(db, importId, token, clock()); // the next call continues at once
                return reportOf(db, await loadImport(db, importId));
            }
            await processBatch(db, { importId, actor, token, keyring: keys, now: clock(), rows, units: batches[i] });
        }
        return await finalize(db, { importId, actor, token, now: clock() });
    } catch (error) {
        if (error instanceof CandidateImportError) {
            if (error.code !== "ROLLBACK_LEASE_LOST") await releaseLease(db, importId, token, clock());
            throw error;
        }
        // Unexpected: what the failed batch did was rolled back with it. Say so, free the lease, keep the state: call again to continue.
        const code = safeCode(error);
        await db.$transaction(async (tx) => {
            await tx.candidateImport.updateMany({
                where: { importId, rollbackLeaseToken: token },
                data: { rollbackLeaseExpiresAt: clock(), rollbackResult: { lastError: { code, at: clock().toISOString() } } },
            });
            await tx.auditLog.create({
                data: auditRow(actor, {
                    action: ROLLBACK_AUDIT_ACTION.FAILED, previousStatus: IMPORT_STATUS.ROLLING_BACK, newStatus: IMPORT_STATUS.ROLLING_BACK,
                    reason: `Rollback of bulk candidate import ${importId} was interrupted (${code}); what the failed step did was rolled back with it`, newValue: JSON.stringify({ importId, code }),
                }),
            });
        }).catch(() => {});
        throw new CandidateImportError(409, "ROLLBACK_INTERRUPTED", "The rollback was interrupted. Nothing is half done. Continue it to retry.", { details: { code } });
    }
}

// Every entry has been tried: the final status, the report, the audit entry, and the request for a reconciliation
// (the Sheet is mirrored from the database as it now is; the approvals let it mark the deleted candidates' rows).
async function finalize(db, { importId, actor, token, now }) {
    const finished = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "candidate_import" WHERE "import_id" = ${importId}::uuid FOR UPDATE`;
        const record = await tx.candidateImport.findUnique({ where: { importId } });
        if (record.rollbackLeaseToken !== token || record.status !== IMPORT_STATUS.ROLLING_BACK) throw new CandidateImportError(409, "ROLLBACK_LEASE_LOST", "Another request took over this rollback.");
        // An entry no unit understood is kept, with a reason, rather than left looking untouched.
        await tx.candidateImportChange.updateMany({ where: { importId, status: LEDGER_STATUS.APPLIED }, data: { status: LEDGER_STATUS.CONFLICT, revertDetail: { reasons: ["NOT_REACHED"] } } });
        const statuses = await tx.candidateImportChange.groupBy({ by: ["status"], where: { importId }, _count: { _all: true } });
        const n = (status) => statuses.find((s) => s.status === status)?._count._all ?? 0;
        const conflicts = n(LEDGER_STATUS.CONFLICT);
        const status = conflicts ? IMPORT_STATUS.ROLLED_BACK_WITH_CONFLICTS : IMPORT_STATUS.ROLLED_BACK;
        const result = { reverted: n(LEDGER_STATUS.REVERTED), conflicts, skipped: n(LEDGER_STATUS.SKIPPED) };
        await tx.candidateImport.update({
            where: { importId },
            data: { status, rollbackCompletedAt: now, rollbackLeaseToken: null, rollbackLeaseExpiresAt: null, rollbackResult: result, updatedAt: now },
        });
        await tx.auditLog.create({
            data: auditRow(actor, {
                action: ROLLBACK_AUDIT_ACTION.COMPLETED, previousStatus: IMPORT_STATUS.ROLLING_BACK, newStatus: status, reason: `Rollback of bulk candidate import ${importId} finished`,
                newValue: JSON.stringify({ importId, ...result }),
            }),
        });
        return { result, status };
    }, BATCH_TRANSACTION);

    let sync = { requested: false, runId: null, alreadyActive: false };
    if (finished.result.reverted > 0) {
        const { run, created } = await requestSheetSyncRun({ db, kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.ADMIN, requestedBy: actor.adminId, now });
        sync = { requested: true, runId: run.runId, alreadyActive: !created };
        await db.candidateImport.update({ where: { importId }, data: { rollbackResult: { ...finished.result, sync } } });
    }
    return reportOf(db, await loadImport(db, importId));
}

// The rollback's state, for a page reload or to continue: counts and codes only.
export async function getRollback({ db, actor, importId }) {
    const record = await loadImport(db, importId);
    requireAccess(record, actor);
    return reportOf(db, record);
}
