// The per-import CHANGE LEDGER (table candidate_import_change, migration 20261112130000).
//
// Every change a bulk import makes to the database is recorded here, in the SAME transaction as the
// change: one chunk of ~100 rows is one transaction (or one row's own transaction when a chunk falls
// back to row by row), so a chunk that fails leaves neither its changes nor its ledger rows, and a chunk
// that commits has both. A repeated write of the same change is refused by the unique index
// (flush uses skipDuplicates), so a retry never records an entry twice.
//
// What an entry says (internal ids only, never a passport number):
//   entity_type / entity_key   CANDIDATE and its details / allocation: the candidate's unique_id; CANDIDATE_STAGE
//                              "<unique_id>:<STAGE>"; CLIENT, AGENT, JOB, IMPORT_JOB_GROUP: the row's uuid;
//                              AGENT_CLIENT "<agentId>:<clientId>"; JOB_CANDIDATE "<jobId>:<unique_id>"
//   op                         CREATE (made by the import), FILL (blank fields of an existing entity filled),
//                              LINK (a relationship made by the import)
//   changes                    { field: { before, after } }. Personal and business values (candidate, details,
//                              Client, Agent) are written as { h: sha256 }; before is the blank that was there.
//                              Everything else (ids, flags, statuses, stage and Job values) is stored as it is.
//   rollback_action            DELETE_IF_UNCHANGED | CLEAR_IF_UNCHANGED | NONE: what a rollback may do, and only
//                              if the record is unchanged since (assessImportLedger tells which entries are)
//
// Why hashes: the ledger must not become a second copy of candidate data (backups, exports), yet a rollback
// must know "is this still exactly what the import wrote". A hash answers that. Imports are fill-only
// (blank -> value), so the previous value is always the blank itself, which is stored as it was.
//
// Nothing here writes to a candidate table, deletes anything, or reverses anything. Reversing is a separate,
// explicit action (rollback) that consumes these entries.

import crypto from "node:crypto";

export const LEDGER_ENTITY = Object.freeze({
    CANDIDATE: "CANDIDATE", DETAILS: "CANDIDATE_ADDITIONAL_DETAILS", STAGE: "CANDIDATE_STAGE", ALLOCATION: "CANDIDATE_ALLOCATION",
    CLIENT: "CLIENT", AGENT: "AGENT", AGENT_CLIENT: "AGENT_CLIENT", JOB: "JOB", JOB_GROUP: "IMPORT_JOB_GROUP", JOB_CANDIDATE: "JOB_CANDIDATE",
});
export const LEDGER_OP = Object.freeze({ CREATE: "CREATE", FILL: "FILL", LINK: "LINK" });
export const ROLLBACK_ACTION = Object.freeze({ DELETE_IF_UNCHANGED: "DELETE_IF_UNCHANGED", CLEAR_IF_UNCHANGED: "CLEAR_IF_UNCHANGED", NONE: "NONE" });
export const LEDGER_STATUS = Object.freeze({ APPLIED: "APPLIED", REVERTED: "REVERTED", CONFLICT: "CONFLICT", SKIPPED: "SKIPPED" });

// ---------------------------------------------------------------- values and hashes

const isBlank = (value) => value === null || value === undefined || value === "";
const isoOf = (date) => (Number.isNaN(date.getTime()) ? "" : date.toISOString());

// One text form per value, whatever the representation (a Date from the database or the date string the
// import wrote; a Decimal or a number): what is hashed and what a later comparison hashes again.
export function canonicalValue(value) {
    if (isBlank(value)) return "";
    if (value instanceof Date) {
        const iso = isoOf(value);
        return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    return String(value);
}

export const digestOf = (field, value) => crypto.createHash("sha256").update(`${field}\u0000${canonicalValue(value)}`).digest("hex");

// A value as the ledger stores it: blank as it was, hashed when it is personal / business data.
export function ledgerValue(field, value, { hash }) {
    if (value === null || value === undefined) return null;
    if (value === "") return "";
    if (hash) return { h: digestOf(field, value) };
    // A date in its canonical text (YYYY-MM-DD for a date, ISO for a timestamp): what matchesWritten compares.
    return value instanceof Date ? canonicalValue(value) : typeof value === "object" ? String(value) : value;
}

// { field: { before, after } } for the fields an import wrote. `written`: the values written; `previous`: the
// entity's values before (undefined for a new entity: before is null).
export function changesOf(written, previous, { hash }) {
    const out = {};
    for (const [field, value] of Object.entries(written ?? {})) {
        if (value === undefined) continue;
        out[field] = { before: ledgerValue(field, previous?.[field], { hash }), after: ledgerValue(field, value, { hash }) };
    }
    return out;
}

// Does the entity's CURRENT value still equal what the import wrote? entry: { before, after } as stored.
export function matchesWritten(field, current, entry) {
    const after = entry?.after;
    if (after && typeof after === "object" && typeof after.h === "string") return digestOf(field, current) === after.h;
    return canonicalValue(current) === canonicalValue(after);
}

const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value);
const digestOfEntry = (entry) => crypto.createHash("sha256").update(JSON.stringify(stable({ changes: entry.changes, jobId: entry.relatedJobId ?? null }))).digest("hex");

// ---------------------------------------------------------------- recording (one per chunk transaction)

// ledger = createLedger({ importId, chunkIndex }); the writers call add / addCandidateFields next to the
// write they record; flush(tx) stores everything in one statement inside the chunk's transaction.
export function createLedger({ importId, chunkIndex }) {
    const entries = new Map();
    const uniqueIds = new Map();
    const keyOf = (entry) => `${entry.entityType}|${entry.entityKey}|${entry.op}`;
    const upper = (passport) => String(passport).toUpperCase();

    const ledger = {
        // A candidate's internal id, by passport (the key the writers use): unique_id of a created or an existing candidate.
        registerCandidate(passportId, uniqueId) {
            if (passportId && uniqueId) uniqueIds.set(upper(passportId), uniqueId);
        },
        uniqueIdOf: (passportId) => uniqueIds.get(upper(passportId)) ?? null,

        add({ entityType, entityKey, op, rowNumber = null, candidateUniqueId = null, changes = {}, relatedJobId = null, jobCreatedByImport = null, auditIds = [], rollbackAction = null }) {
            const entry = {
                importId, chunkIndex, rowNumber, entityType, entityKey: String(entityKey), candidateUniqueId, op, preExisting: op === LEDGER_OP.FILL,
                changes, relatedJobId, jobCreatedByImport, auditIds: [...auditIds],
                rollbackAction: rollbackAction ?? (op === LEDGER_OP.FILL ? ROLLBACK_ACTION.CLEAR_IF_UNCHANGED : ROLLBACK_ACTION.DELETE_IF_UNCHANGED),
            };
            const key = keyOf(entry);
            const existing = entries.get(key);
            if (existing) {
                // The same entity changed twice in this chunk: one entry (the fields of both; the first value of a field stays).
                existing.changes = { ...entry.changes, ...existing.changes };
                existing.auditIds = [...new Set([...existing.auditIds, ...entry.auditIds])];
            } else entries.set(key, entry);
            return entry;
        },

        // Fields written to a CANDIDATE after it was created or filled (departed / outcome): added to that
        // candidate's entry of this chunk, or a FILL entry when the row only changed those.
        addCandidateFields(passportId, { rowNumber = null, changes, auditIds = [] }) {
            const uniqueId = ledger.uniqueIdOf(passportId);
            if (!uniqueId) return null;
            const created = entries.get(`${LEDGER_ENTITY.CANDIDATE}|${uniqueId}|${LEDGER_OP.CREATE}`);
            if (created) {
                created.changes = { ...changes, ...created.changes };
                created.auditIds = [...new Set([...created.auditIds, ...auditIds])];
                return created;
            }
            return ledger.add({ entityType: LEDGER_ENTITY.CANDIDATE, entityKey: uniqueId, op: LEDGER_OP.FILL, rowNumber, candidateUniqueId: uniqueId, changes, auditIds });
        },

        get size() { return entries.size; },
        list: () => [...entries.values()],

        // One statement, inside the caller's transaction. skipDuplicates: an entry already recorded (same
        // import, entity, op and content) is not recorded twice.
        async flush(tx) {
            if (!entries.size) return 0;
            const data = [...entries.values()].map((entry) => ({ ...entry, changesDigest: digestOfEntry(entry) }));
            const { count } = await tx.candidateImportChange.createMany({ data, skipDuplicates: true });
            return count;
        },
    };
    return ledger;
}

// ---------------------------------------------------------------- eligibility (read-only)

export const ASSESSMENT = Object.freeze({ ELIGIBLE: "ELIGIBLE", CONFLICT: "CONFLICT", MISSING: "MISSING", ALREADY_REVERTED: "ALREADY_REVERTED" });

const changedFields = (changes, current) => Object.entries(changes ?? {}).filter(([field, entry]) => !matchesWritten(field, current?.[field], entry)).map(([field]) => field);

// For every ledger entry of an import: can it still be reversed safely? Read-only: writes nothing, reverses
// nothing. ELIGIBLE = the record is exactly as the import left it (and, for what the import created, nothing
// else depends on it). CONFLICT = something changed it since, or depends on it, with the reasons (codes).
// MISSING = the record is gone. ALREADY_REVERTED = a rollback already did it. Phase 6 (rollback) applies only
// the ELIGIBLE entries and reports the others.
export async function assessImportLedger({ db, importId }) {
    const rows = await db.candidateImportChange.findMany({ where: { importId }, orderBy: [{ chunkIndex: "asc" }, { createdAt: "asc" }, { changeId: "asc" }] });
    const ledgered = (type) => new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityKey));
    const ledgeredJobs = ledgered(LEDGER_ENTITY.JOB);
    const ledgeredLinks = ledgered(LEDGER_ENTITY.AGENT_CLIENT);
    const ledgeredMembers = ledgered(LEDGER_ENTITY.JOB_CANDIDATE);
    const ledgeredStages = ledgered(LEDGER_ENTITY.STAGE);
    const passportCache = new Map();
    const passportOf = async (uniqueId) => {
        if (!passportCache.has(uniqueId)) passportCache.set(uniqueId, (await db.candidate.findFirst({ where: { uniqueId }, select: { passportId: true } }))?.passportId ?? null);
        return passportCache.get(uniqueId);
    };
    const select = (entry) => Object.fromEntries(Object.keys(entry.changes ?? {}).map((f) => [f, true]));

    async function assess(entry) {
        const reasons = [];
        const created = entry.op !== LEDGER_OP.FILL;
        const finish = (state) => ({ changeId: entry.changeId, entityType: entry.entityType, entityKey: entry.entityKey, op: entry.op, rowNumber: entry.rowNumber, state, reasons });
        const compare = (current) => {
            const fields = changedFields(entry.changes, current);
            if (fields.length) reasons.push(`FIELD_CHANGED:${fields.join(",")}`);
        };
        const verdict = () => finish(reasons.length ? ASSESSMENT.CONFLICT : ASSESSMENT.ELIGIBLE);
        if (entry.status === LEDGER_STATUS.REVERTED) return finish(ASSESSMENT.ALREADY_REVERTED);

        switch (entry.entityType) {
            case LEDGER_ENTITY.CANDIDATE: {
                const current = await db.candidate.findFirst({ where: { uniqueId: entry.entityKey }, select: { ...select(entry), passportId: true } });
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                if (created) {
                    const [documents, members, stages, later] = await Promise.all([
                        db.document.count({ where: { passportId: current.passportId } }),
                        db.jobCandidate.findMany({ where: { passportId: current.passportId }, select: { jobId: true } }),
                        db.candidateStage.findMany({ where: { passportId: current.passportId }, select: { stage: true } }),
                        // Anything recorded about this candidate after the import, by something other than this import.
                        db.auditLog.findFirst({
                            where: { passportId: current.passportId, createdDate: { gt: entry.createdAt }, OR: [{ reason: null }, { NOT: { reason: { contains: importId } } }] },
                            select: { auditId: true },
                        }),
                    ]);
                    if (documents) reasons.push("HAS_DOCUMENTS");
                    if (members.some((m) => !ledgeredMembers.has(`${m.jobId}:${entry.entityKey}`))) reasons.push("HAS_OTHER_JOB_MEMBERSHIP");
                    if (stages.some((s) => !ledgeredStages.has(`${entry.entityKey}:${s.stage}`))) reasons.push("HAS_OTHER_STAGES");
                    if (later) reasons.push("CHANGED_AFTER_IMPORT");
                }
                return verdict();
            }
            case LEDGER_ENTITY.DETAILS: {
                const passportId = await passportOf(entry.entityKey);
                const current = passportId ? await db.candidateAdditionalDetails.findUnique({ where: { passportId }, select: select(entry) }) : null;
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                return verdict();
            }
            case LEDGER_ENTITY.STAGE: {
                const [uniqueId, stage] = entry.entityKey.split(":");
                const passportId = await passportOf(uniqueId);
                const current = passportId ? await db.candidateStage.findUnique({ where: { passportId_stage: { passportId, stage } }, select: select(entry) }) : null;
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                return verdict();
            }
            case LEDGER_ENTITY.ALLOCATION: {
                const passportId = await passportOf(entry.entityKey);
                const current = passportId ? await db.candidateAllocation.findUnique({ where: { passportId }, select: select(entry) }) : null;
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                return verdict();
            }
            case LEDGER_ENTITY.CLIENT: {
                const current = await db.client.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                if (created) {
                    const [jobs, links] = await Promise.all([
                        db.job.findMany({ where: { clientId: entry.entityKey }, select: { id: true } }),
                        db.agentClient.findMany({ where: { clientId: entry.entityKey }, select: { agentId: true } }),
                    ]);
                    if (jobs.some((j) => !ledgeredJobs.has(j.id))) reasons.push("HAS_OTHER_JOBS");
                    if (links.some((l) => !ledgeredLinks.has(`${l.agentId}:${entry.entityKey}`))) reasons.push("HAS_OTHER_AGENT_LINKS");
                }
                return verdict();
            }
            case LEDGER_ENTITY.AGENT: {
                const current = await db.agent.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                if (created) {
                    const [jobs, links] = await Promise.all([
                        db.job.findMany({ where: { responsibleAgentId: entry.entityKey }, select: { id: true } }),
                        db.agentClient.findMany({ where: { agentId: entry.entityKey }, select: { clientId: true } }),
                    ]);
                    if (jobs.some((j) => !ledgeredJobs.has(j.id))) reasons.push("HAS_OTHER_JOBS");
                    if (links.some((l) => !ledgeredLinks.has(`${entry.entityKey}:${l.clientId}`))) reasons.push("HAS_OTHER_AGENT_LINKS");
                }
                return verdict();
            }
            case LEDGER_ENTITY.AGENT_CLIENT: {
                const [agentId, clientId] = entry.entityKey.split(":");
                return (await db.agentClient.findUnique({ where: { agentId_clientId: { agentId, clientId } }, select: { agentId: true } })) ? verdict() : finish(ASSESSMENT.MISSING);
            }
            case LEDGER_ENTITY.JOB: {
                const current = await db.job.findUnique({ where: { id: entry.entityKey }, select: { ...select(entry), status: true } });
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                if (current.status !== "PROCESSING") reasons.push("JOB_STATUS_CHANGED");
                const members = await db.jobCandidate.findMany({ where: { jobId: entry.entityKey }, select: { passportId: true, candidate: { select: { uniqueId: true } } } });
                if (members.some((m) => !ledgeredMembers.has(`${entry.entityKey}:${m.candidate.uniqueId}`))) reasons.push("HAS_OTHER_MEMBERS");
                return verdict();
            }
            case LEDGER_ENTITY.JOB_GROUP: {
                const current = await db.importJobGroup.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                return verdict();
            }
            case LEDGER_ENTITY.JOB_CANDIDATE: {
                const [jobId, uniqueId] = entry.entityKey.split(":");
                const passportId = await passportOf(uniqueId);
                const current = passportId ? await db.jobCandidate.findUnique({ where: { jobId_passportId: { jobId, passportId } }, select: { isActive: true, releasedAt: true } }) : null;
                if (!current) return finish(ASSESSMENT.MISSING);
                if (!current.isActive || current.releasedAt) reasons.push("MEMBERSHIP_CHANGED");
                return verdict();
            }
            default:
                reasons.push("UNKNOWN_ENTITY");
                return verdict();
        }
    }

    const entries = [];
    for (const row of rows) entries.push(await assess(row));
    const count = (state) => entries.filter((e) => e.state === state).length;
    return {
        importId,
        summary: { total: entries.length, eligible: count(ASSESSMENT.ELIGIBLE), conflicts: count(ASSESSMENT.CONFLICT), missing: count(ASSESSMENT.MISSING), alreadyReverted: count(ASSESSMENT.ALREADY_REVERTED) },
        entries,
    };
}
