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
//                              AGENT_CLIENT "<agentId>:<clientId>"; JOB_CANDIDATE "<jobId>:<unique_id>"; JOB_TYPE: its uuid
//   op                         CREATE (made by the import), FILL (blank fields of an existing entity filled),
//                              LINK (a relationship made by the import)
//   changes                    { field: { before, after } }
//   rollback_action            DELETE_IF_UNCHANGED | CLEAR_IF_UNCHANGED | NONE: what a rollback may do, and only
//                              if the record is unchanged since (assessImportLedger tells which entries are)
//
// The two values of a change:
//   before   the EXACT previous value, as it was: null, "" (empty string) and any other value are different
//            things and stay different (an import only fills blanks, so it is null or ""; a rollback restores
//            exactly that, never "some blank"). A personal value that was not blank would be stored as an HMAC
//            and could not be restored: assessImportLedger flags such an entry (PREVIOUS_VALUE_NOT_RESTORABLE).
//   after    what the import wrote. Personal and business values (candidate, details, Client, Agent) are NOT
//            stored: an entry holds { m: "hmac-sha256", k: <key id>, h: <HMAC> } (importLedgerKeys.js), a keyed
//            digest bound to the entry, so the ledger is no second copy of personal data and cannot be reversed
//            by guessing NICs or phone numbers; the server recomputes it from the current value to check "is this
//            still what the import wrote". Ids, flags, statuses and stage / Job / allocation values are stored
//            as they are. Entries from before the key existed hold { h: <plain sha256> } with no method: they
//            are still verifiable (compareWritten) and are re-signed by rekeyImportLedger.
//
// Nothing here writes to a candidate table, deletes anything, or reverses anything, except rekeyImportLedger,
// which only replaces a digest in the ledger by a stronger one. Reversing is a separate, explicit action
// (rollback) that consumes these entries.

import crypto from "node:crypto";

import { HMAC_METHOD, LedgerKeyConfigError, hmacMessage, readLedgerKeyring } from "./importLedgerKeys.js";

export const LEDGER_ENTITY = Object.freeze({
    CANDIDATE: "CANDIDATE", DETAILS: "CANDIDATE_ADDITIONAL_DETAILS", STAGE: "CANDIDATE_STAGE", ALLOCATION: "CANDIDATE_ALLOCATION",
    CLIENT: "CLIENT", AGENT: "AGENT", AGENT_CLIENT: "AGENT_CLIENT", JOB: "JOB", JOB_GROUP: "IMPORT_JOB_GROUP", JOB_CANDIDATE: "JOB_CANDIDATE",
    // A Job Type a chunk created for a sheet Job Role that was not a type yet (migration 20261113120000). Its name and
    // code are catalog values, not personal data: stored as they are.
    JOB_TYPE: "JOB_TYPE",
});
export const LEDGER_OP = Object.freeze({ CREATE: "CREATE", FILL: "FILL", LINK: "LINK" });
export const ROLLBACK_ACTION = Object.freeze({ DELETE_IF_UNCHANGED: "DELETE_IF_UNCHANGED", CLEAR_IF_UNCHANGED: "CLEAR_IF_UNCHANGED", NONE: "NONE" });
export const LEDGER_STATUS = Object.freeze({ APPLIED: "APPLIED", REVERTED: "REVERTED", CONFLICT: "CONFLICT", SKIPPED: "SKIPPED" });

// ---------------------------------------------------------------- values and digests

const isBlank = (value) => value === null || value === undefined || value === "";
const isoOf = (date) => (Number.isNaN(date.getTime()) ? "" : date.toISOString());

// One text form per value, whatever the representation (a Date from the database or the date text the import
// wrote; a Decimal or a number): what is digested and what a later comparison digests again.
export function canonicalValue(value) {
    if (isBlank(value)) return "";
    if (value instanceof Date) {
        const iso = isoOf(value);
        return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
}

// The PLAIN sha256 of earlier ledger entries. Used only to VERIFY such an entry; nothing new is ever written with it.
export const legacyDigestOf = (field, value) => crypto.createHash("sha256").update(`${field}\u0000${canonicalValue(value)}`).digest("hex");

export const entryContext = (entry) => `${entry.importId}|${entry.entityType}|${entry.entityKey}`;

// A value as the ledger stores it. before / after: a blank stays EXACTLY what it was (null or ""), a personal value
// becomes { m, k, h } under the current key, anything else is kept (dates as canonical text).
export function ledgerValue(field, value, { hash, keyring = null, ctx = "" }) {
    if (value === null || value === undefined) return null;
    if (value === "") return "";
    if (hash) {
        if (!keyring) throw new LedgerKeyConfigError(["MISSING_KEYRING"]); // never a plain-hash fallback
        return keyring.digest(field, canonicalValue(value), ctx);
    }
    return value instanceof Date ? canonicalValue(value) : typeof value === "object" ? String(value) : value;
}

// What the writers describe (raw, in memory only): { field: { before, after, hash } }. `previous` is the entity's
// values before the write (undefined for an entity that did not exist: before is null).
export function changesOf(written, previous, { hash }) {
    const out = {};
    for (const [field, value] of Object.entries(written ?? {})) {
        if (value === undefined) continue;
        // ?? keeps "" as it is: only null / undefined (no previous value) become null.
        out[field] = { before: previous?.[field] ?? null, after: value, hash };
    }
    return out;
}

// raw descriptors -> the stored { field: { before, after } }, under the current key, bound to the entry (ctx).
export function finalizeChanges(raw, { keyring, ctx }) {
    const out = {};
    for (const [field, change] of Object.entries(raw ?? {})) {
        const hash = change.hash === true;
        out[field] = { before: ledgerValue(field, change.before, { hash, keyring, ctx }), after: ledgerValue(field, change.after, { hash, keyring, ctx }) };
    }
    return out;
}

export const COMPARE = Object.freeze({ MATCH: "MATCH", MISMATCH: "MISMATCH", KEY_UNAVAILABLE: "KEY_UNAVAILABLE" });

const safeEqualHex = (a, b) => {
    const [x, y] = [Buffer.from(String(a), "hex"), Buffer.from(String(b), "hex")];
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// Does the entity's CURRENT value still equal what the import wrote? `after` as stored. KEY_UNAVAILABLE: the
// entry was signed with a key this server no longer has (nothing is guessed).
export function compareWritten(field, current, after, { keyring = null, ctx = "" } = {}) {
    if (after && typeof after === "object" && typeof after.h === "string") {
        if (after.m === HMAC_METHOD) {
            const expected = keyring?.hmac(after.k, hmacMessage(field, canonicalValue(current), ctx));
            if (expected === null || expected === undefined) return COMPARE.KEY_UNAVAILABLE;
            return safeEqualHex(expected, after.h) ? COMPARE.MATCH : COMPARE.MISMATCH;
        }
        // An earlier entry: a plain sha256 (no method).
        return safeEqualHex(legacyDigestOf(field, current), after.h) ? COMPARE.MATCH : COMPARE.MISMATCH;
    }
    return canonicalValue(current) === canonicalValue(after) ? COMPARE.MATCH : COMPARE.MISMATCH;
}
export const matchesWritten = (field, current, change, options) => compareWritten(field, current, change?.after, options) === COMPARE.MATCH;

const isDigest = (value) => Boolean(value) && typeof value === "object" && typeof value.h === "string";
const isLegacyDigest = (value) => isDigest(value) && value.m !== HMAC_METHOD;

const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value);
const digestOfEntry = (changes, relatedJobId) => crypto.createHash("sha256").update(JSON.stringify(stable({ changes, jobId: relatedJobId ?? null }))).digest("hex");

// ---------------------------------------------------------------- recording (one per chunk transaction)

// ledger = createLedger({ importId, chunkIndex, keyring }); the writers call add / addCandidateFields next to the
// write they record; flush(tx) stores everything in one statement inside the chunk's transaction. keyring:
// the loaded importLedgerKeys keyring; without it an entry holding personal values cannot be written (no fallback).
export function createLedger({ importId, chunkIndex, keyring = null }) {
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
        // import, entity, op and content) is not recorded twice. Throws LedgerKeyConfigError (before writing
        // anything) when an entry holds a personal value and there is no key.
        async flush(tx) {
            if (!entries.size) return 0;
            const data = [...entries.values()].map((entry) => {
                const changes = finalizeChanges(entry.changes, { keyring, ctx: entryContext(entry) });
                return { ...entry, changes, changesDigest: digestOfEntry(changes, entry.relatedJobId) };
            });
            const { count } = await tx.candidateImportChange.createMany({ data, skipDuplicates: true });
            return count;
        },
    };
    return ledger;
}

// ---------------------------------------------------------------- the current record of an entry (read-only)

// A reader of the CURRENT state of what an import changed. It loads in bulk (prefetch: a handful of queries for a
// few hundred candidates, so assessing or rolling back a 3,000-row import does not cost thousands of queries) and
// falls back to a single query for anything not prefetched. A rollback creates one per batch INSIDE the batch's
// transaction, after the rows are locked, so what it reads is what it then changes.
export function createResolver(db, importId) {
    const candidates = new Map(); // unique_id -> the candidate row (all columns) | null
    const details = new Map(); // passport -> row | null
    const stages = new Map(); // passport -> rows[]
    const allocations = new Map(); // passport -> row | null
    const memberships = new Map(); // passport -> job_candidate rows[]
    const documents = new Map(); // passport -> count
    const audits = new Map(); // passport -> dates of audit rows by anything other than this import, after the entries
    const select = (entry) => Object.fromEntries(Object.keys(entry.changes ?? {}).map((f) => [f, true]));

    const uniqueIdOf = (entry) => {
        switch (entry.entityType) {
            case LEDGER_ENTITY.CANDIDATE: case LEDGER_ENTITY.DETAILS: case LEDGER_ENTITY.ALLOCATION: return entry.entityKey;
            case LEDGER_ENTITY.STAGE: return entry.entityKey.split(":")[0];
            case LEDGER_ENTITY.JOB_CANDIDATE: return entry.entityKey.split(":")[1];
            default: return null;
        }
    };
    const groupBy = (rows, key) => {
        const out = new Map();
        for (const row of rows) {
            if (!out.has(row[key])) out.set(row[key], []);
            out.get(row[key]).push(row);
        }
        return out;
    };

    async function prefetch(entries) {
        const ids = [...new Set(entries.map(uniqueIdOf).filter(Boolean))].filter((id) => !candidates.has(id));
        if (!ids.length) return;
        const found = await db.candidate.findMany({ where: { uniqueId: { in: ids } } });
        for (const id of ids) candidates.set(id, found.find((c) => c.uniqueId === id) ?? null);
        const passportIds = found.map((c) => c.passportId);
        if (!passportIds.length) return;
        const [detailRows, stageRows, allocationRows, memberRows, documentCounts] = await Promise.all([
            db.candidateAdditionalDetails.findMany({ where: { passportId: { in: passportIds } } }),
            db.candidateStage.findMany({ where: { passportId: { in: passportIds } } }),
            db.candidateAllocation.findMany({ where: { passportId: { in: passportIds } } }),
            db.jobCandidate.findMany({ where: { passportId: { in: passportIds } } }),
            db.document.groupBy({ by: ["passportId"], where: { passportId: { in: passportIds } }, _count: { _all: true } }),
        ]);
        const [stageBy, memberBy] = [groupBy(stageRows, "passportId"), groupBy(memberRows, "passportId")];
        const counts = new Map(documentCounts.map((row) => [row.passportId, row._count._all]));
        for (const passportId of passportIds) {
            details.set(passportId, detailRows.find((d) => d.passportId === passportId) ?? null);
            stages.set(passportId, stageBy.get(passportId) ?? []);
            allocations.set(passportId, allocationRows.find((a) => a.passportId === passportId) ?? null);
            memberships.set(passportId, memberBy.get(passportId) ?? []);
            documents.set(passportId, counts.get(passportId) ?? 0);
        }
        // Anything recorded about these candidates after the import's entries, by something other than this import.
        const since = entries.filter((e) => e.createdAt).reduce((min, e) => (!min || e.createdAt < min ? e.createdAt : min), null);
        if (since) {
            const later = await db.auditLog.findMany({
                where: { passportId: { in: passportIds }, createdDate: { gt: since }, OR: [{ reason: null }, { NOT: { reason: { contains: importId } } }] },
                select: { passportId: true, createdDate: true },
            });
            const laterBy = groupBy(later, "passportId");
            for (const passportId of passportIds) audits.set(passportId, (laterBy.get(passportId) ?? []).map((a) => a.createdDate));
        }
    }
    const ensure = async (uniqueId) => {
        if (!candidates.has(uniqueId)) await prefetch([{ entityType: LEDGER_ENTITY.CANDIDATE, entityKey: uniqueId, changes: {}, createdAt: new Date(0) }]);
    };
    const passportOf = async (uniqueId) => {
        await ensure(uniqueId);
        return candidates.get(uniqueId)?.passportId ?? null;
    };

    // The fields an entry recorded, as they are now (null when the record is gone).
    async function fetchCurrent(entry) {
        switch (entry.entityType) {
            case LEDGER_ENTITY.CANDIDATE:
                await ensure(entry.entityKey);
                return candidates.get(entry.entityKey);
            case LEDGER_ENTITY.DETAILS: {
                const passportId = await passportOf(entry.entityKey);
                return passportId ? details.get(passportId) : null;
            }
            case LEDGER_ENTITY.STAGE: {
                const [uniqueId, stage] = entry.entityKey.split(":");
                const passportId = await passportOf(uniqueId);
                return passportId ? (stages.get(passportId) ?? []).find((s) => s.stage === stage) ?? null : null;
            }
            case LEDGER_ENTITY.ALLOCATION: {
                const passportId = await passportOf(entry.entityKey);
                return passportId ? allocations.get(passportId) : null;
            }
            case LEDGER_ENTITY.CLIENT:
                return db.client.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
            case LEDGER_ENTITY.AGENT:
                return db.agent.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
            case LEDGER_ENTITY.JOB:
                return db.job.findUnique({ where: { id: entry.entityKey }, select: { ...select(entry), status: true } });
            case LEDGER_ENTITY.JOB_GROUP:
                return db.importJobGroup.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
            case LEDGER_ENTITY.JOB_TYPE:
                return db.jobType.findUnique({ where: { id: entry.entityKey }, select: select(entry) });
            default:
                return null;
        }
    }
    return {
        prefetch, passportOf, fetchCurrent,
        membershipsOf: (passportId) => memberships.get(passportId) ?? [],
        stagesOf: (passportId) => stages.get(passportId) ?? [],
        allocationOf: (passportId) => allocations.get(passportId) ?? null,
        detailsOf: (passportId) => details.get(passportId) ?? null,
        documentCount: (passportId) => documents.get(passportId) ?? 0,
        laterAuditAfter: (passportId, createdAt) => (audits.get(passportId) ?? []).some((date) => date > createdAt),
    };
}

// ---------------------------------------------------------------- eligibility (read-only)

export const ASSESSMENT = Object.freeze({ ELIGIBLE: "ELIGIBLE", CONFLICT: "CONFLICT", MISSING: "MISSING", ALREADY_REVERTED: "ALREADY_REVERTED" });

// The keyring for a check: the one passed, else the configured one, else none (then an entry signed with an HMAC
// is reported KEY_UNAVAILABLE, never guessed).
function keyringFor(keyring) {
    if (keyring !== undefined) return keyring;
    try { return readLedgerKeyring(); } catch { return null; }
}

// For every ledger entry of an import: can it still be reversed safely? Read-only: writes nothing, reverses
// nothing. ELIGIBLE = the record is exactly as the import left it (and, for what the import created, nothing
// else depends on it). CONFLICT = something changed it since, or depends on it, with the reasons (codes).
// MISSING = the record is gone. ALREADY_REVERTED = a rollback already did it. Phase 6 (rollback) applies only
// the ELIGIBLE entries and reports the others. Reasons:
//   FIELD_CHANGED:<fields>        a value the import wrote is not what is there now
//   KEY_UNAVAILABLE:<key ids>     the entry was signed with a key this server does not have (cannot be verified)
//   PREVIOUS_VALUE_NOT_RESTORABLE the value before the import cannot be restored exactly (it was not stored in clear)
//   HAS_DOCUMENTS, HAS_OTHER_JOB_MEMBERSHIP, HAS_OTHER_STAGES, CHANGED_AFTER_IMPORT, HAS_OTHER_MEMBERS,
//   HAS_OTHER_JOBS, HAS_OTHER_AGENT_LINKS, JOB_STATUS_CHANGED, MEMBERSHIP_CHANGED
// notes (not conflicts): LEGACY_PLAIN_SHA256 (re-sign it with rekeyImportLedger).
export async function assessImportLedger({ db, importId, keyring }) {
    const rows = await db.candidateImportChange.findMany({ where: { importId }, orderBy: [{ chunkIndex: "asc" }, { createdAt: "asc" }, { changeId: "asc" }] });
    const { assess, prefetch } = createAssessor({ db, importId, rows, keyring });
    const entries = [];
    for (let i = 0; i < rows.length; i += 500) {
        await prefetch(rows.slice(i, i + 500)); // a few queries for 500 entries, not several per entry
        for (const row of rows.slice(i, i + 500)) entries.push(await assess(row));
    }
    return summarizeAssessment(importId, entries);
}

export function summarizeAssessment(importId, entries) {
    const count = (state) => entries.filter((e) => e.state === state).length;
    return {
        importId,
        summary: {
            total: entries.length, eligible: count(ASSESSMENT.ELIGIBLE), conflicts: count(ASSESSMENT.CONFLICT), missing: count(ASSESSMENT.MISSING),
            alreadyReverted: count(ASSESSMENT.ALREADY_REVERTED), legacyPlainSha256: entries.filter((e) => e.notes.includes("LEGACY_PLAIN_SHA256")).length,
        },
        entries,
    };
}

// The checks of assessImportLedger, bound to a database client (the database, or a rollback's transaction, so the
// rollback re-checks every entry inside the transaction that reverts it) and to the import's entries (the
// context: what the import itself made).
export function createAssessor({ db, importId, rows, keyring }) {
    const keys = keyringFor(keyring);
    const ledgered = (type) => new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityKey));
    const ledgeredJobs = ledgered(LEDGER_ENTITY.JOB);
    const ledgeredLinks = ledgered(LEDGER_ENTITY.AGENT_CLIENT);
    const ledgeredMembers = ledgered(LEDGER_ENTITY.JOB_CANDIDATE);
    const ledgeredStages = ledgered(LEDGER_ENTITY.STAGE);
    const resolver = createResolver(db, importId);
    const { passportOf, fetchCurrent } = resolver;

    async function assess(entry) {
        const reasons = [];
        const notes = [];
        const created = entry.op !== LEDGER_OP.FILL;
        const finish = (state) => ({ changeId: entry.changeId, entityType: entry.entityType, entityKey: entry.entityKey, op: entry.op, rowNumber: entry.rowNumber, state, reasons, notes });
        const verdict = () => finish(reasons.length ? ASSESSMENT.CONFLICT : ASSESSMENT.ELIGIBLE);
        if (entry.status === LEDGER_STATUS.REVERTED) return finish(ASSESSMENT.ALREADY_REVERTED);

        const compare = (current) => {
            const ctx = entryContext(entry);
            const changed = [];
            const unavailable = new Set();
            for (const [field, change] of Object.entries(entry.changes ?? {})) {
                if (isLegacyDigest(change.after) && !notes.includes("LEGACY_PLAIN_SHA256")) notes.push("LEGACY_PLAIN_SHA256");
                const result = compareWritten(field, current?.[field], change.after, { keyring: keys, ctx });
                if (result === COMPARE.MISMATCH) changed.push(field);
                else if (result === COMPARE.KEY_UNAVAILABLE) unavailable.add(change.after.k);
                // To restore a FILL exactly, the value before must be stored in clear (a blank always is).
                if (entry.op === LEDGER_OP.FILL && isDigest(change.before) && !reasons.includes("PREVIOUS_VALUE_NOT_RESTORABLE")) reasons.push("PREVIOUS_VALUE_NOT_RESTORABLE");
            }
            if (changed.length) reasons.push(`FIELD_CHANGED:${changed.join(",")}`);
            if (unavailable.size) reasons.push(`KEY_UNAVAILABLE:${[...unavailable].join(",")}`);
        };

        switch (entry.entityType) {
            case LEDGER_ENTITY.CANDIDATE: {
                const current = await fetchCurrent(entry);
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                if (created) {
                    const passportId = current.passportId;
                    if (resolver.documentCount(passportId)) reasons.push("HAS_DOCUMENTS");
                    if (resolver.membershipsOf(passportId).some((m) => !ledgeredMembers.has(`${m.jobId}:${entry.entityKey}`))) reasons.push("HAS_OTHER_JOB_MEMBERSHIP");
                    if (resolver.stagesOf(passportId).some((s) => !ledgeredStages.has(`${entry.entityKey}:${s.stage}`))) reasons.push("HAS_OTHER_STAGES");
                    // Anything recorded about this candidate after the import, by something other than this import.
                    if (resolver.laterAuditAfter(passportId, entry.createdAt)) reasons.push("CHANGED_AFTER_IMPORT");
                }
                return verdict();
            }
            case LEDGER_ENTITY.DETAILS:
            case LEDGER_ENTITY.STAGE:
            case LEDGER_ENTITY.ALLOCATION:
            case LEDGER_ENTITY.JOB_GROUP:
            // A Job Type: its name, code and active flag must still be what the import made. Whether anything uses it is
            // judged by the rollback (Jobs through the foreign keys, candidate preferences by name).
            case LEDGER_ENTITY.JOB_TYPE: {
                const current = await fetchCurrent(entry);
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                return verdict();
            }
            case LEDGER_ENTITY.CLIENT: {
                const current = await fetchCurrent(entry);
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
                const current = await fetchCurrent(entry);
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
                const current = await fetchCurrent(entry);
                if (!current) return finish(ASSESSMENT.MISSING);
                compare(current);
                if (current.status !== "PROCESSING") reasons.push("JOB_STATUS_CHANGED");
                const members = await db.jobCandidate.findMany({ where: { jobId: entry.entityKey }, select: { passportId: true, candidate: { select: { uniqueId: true } } } });
                if (members.some((m) => !ledgeredMembers.has(`${entry.entityKey}:${m.candidate.uniqueId}`))) reasons.push("HAS_OTHER_MEMBERS");
                return verdict();
            }
            case LEDGER_ENTITY.JOB_CANDIDATE: {
                const [jobId, uniqueId] = entry.entityKey.split(":");
                const passportId = await passportOf(uniqueId);
                const current = passportId ? resolver.membershipsOf(passportId).find((m) => m.jobId === jobId) ?? null : null;
                if (!current) return finish(ASSESSMENT.MISSING);
                if (!current.isActive || current.releasedAt) reasons.push("MEMBERSHIP_CHANGED");
                return verdict();
            }
            default:
                reasons.push("UNKNOWN_ENTITY");
                return verdict();
        }
    }

    return { assess, prefetch: resolver.prefetch, resolver, passportOf, fetchCurrent };
}

// ---------------------------------------------------------------- re-signing (legacy entries, key rotation)

// Replaces, in this import's entries, every digest that is a plain sha256 (made before the key existed) or was
// signed with a key other than the current one, by an HMAC under the CURRENT key. A digest is replaced only when
// the record's current value still matches it (so the new digest says exactly what the old one did); one that
// no longer matches (changed since: a conflict anyway), whose record is gone, or whose key this server does
// not have is left as it is and counted. Writes only candidate_import_change.changes / changes_digest.
// Returns { entries, rekeyed, unverified } (fields).
export async function rekeyImportLedger({ db, importId, keyring }) {
    if (!keyring) throw new LedgerKeyConfigError(["MISSING_KEYRING"]);
    const { fetchCurrent } = createResolver(db, importId);
    const rows = await db.candidateImportChange.findMany({ where: { importId } });
    const result = { entries: 0, rekeyed: 0, unverified: 0 };
    for (const row of rows) {
        const stale = Object.entries(row.changes ?? {}).filter(([, change]) => isDigest(change.after) && (change.after.m !== HMAC_METHOD || change.after.k !== keyring.currentId));
        if (!stale.length) continue;
        const current = await fetchCurrent(row);
        const ctx = entryContext(row);
        const changes = { ...row.changes };
        let changed = 0;
        for (const [field, change] of stale) {
            if (current && compareWritten(field, current[field], change.after, { keyring, ctx }) === COMPARE.MATCH) {
                changes[field] = { ...change, after: keyring.digest(field, canonicalValue(current[field]), ctx) };
                changed += 1;
            } else result.unverified += 1;
        }
        if (!changed) continue;
        await db.candidateImportChange.update({ where: { changeId: row.changeId }, data: { changes, changesDigest: digestOfEntry(changes, row.relatedJobId) } });
        result.entries += 1;
        result.rekeyed += changed;
    }
    return result;
}
