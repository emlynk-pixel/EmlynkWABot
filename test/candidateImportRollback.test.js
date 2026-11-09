// Bulk candidate import: ROLLBACK (candidateImportRollback.js) end to end on a real PostgreSQL (PGlite, every
// migration). SYNTHETIC data only.
//
// A rollback reverses what an import did, from its change ledger, and only where the record is exactly as the
// import left it. These tests check what it reverses (created and filled records, Jobs, Clients, Agents,
// memberships, stages, allocations), what it must NOT touch (anything changed or used since), that it is
// atomic, resumable and safe against a second caller, and that nothing personal or secret is returned.
import "./helpers/importLedgerKey.js";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { IMPORT_CHUNK_SIZE, abortImport, chunkRows, commitChunk, finishImport, previewImport } from "../src/services/candidateImportService.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { ASSESSMENT, LEDGER_ENTITY as E, LEDGER_OP, assessImportLedger, canonicalValue, entryContext, legacyDigestOf } from "../src/services/candidateImportLedger.js";
import { ROLLBACK_LEASE_MS, buildUnits, executeRollback, getRollback, previewRollback } from "../src/services/candidateImportRollback.js";
import { readLedgerKeyring } from "../src/services/importLedgerKeys.js";

const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN", name: "Admin User" };
const ADMIN2 = { adminId: "admin-ADMIN2", role: "ADMIN", name: "Second Admin" };
const OWNER = { adminId: "admin-OWNER", role: "OWNER", name: "Owner User" };
const USERS = {
    "admin-ADMIN": ["Admin User", "ADMIN"], "admin-ADMIN2": ["Second Admin", "ADMIN"], "admin-OWNER": ["Owner User", "OWNER"],
    "admin-ANALYST": ["Ann Analyst", "ANALYST"], "u-john": ["John Silva", "ANALYST"], "u-anna": ["Anna Other", "ANALYST"],
};
const HEADERS = [
    "PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE", "OFFICER", "VISA STATUS", "INTERVIEW DATE", "INTERVIEW PASS FAIL",
    "COMPANY", "COMPANY NUMBER", "AGENT", "UNIQUE NUMBER", "ADDRESS", "BIRTH DATE", "SHIRT SIZE", "FATHER NAME",
];
const TODAY = new Date("2026-11-04T06:00:00Z");
const keyring = readLedgerKeyring();

let database;
let prisma;
let pg;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const [adminId, [name, role]] of Object.entries(USERS)) {
        await prisma.user.create({ data: { adminId, authUserId: authIdFor(adminId), name, email: `${adminId}@example.invalid`, role, status: "ACTIVE", activatedAt: new Date() } });
    }
    await prisma.jobType.upsert({ where: { code: "PLASTER" }, create: { code: "PLASTER", name: "PLASTER" }, update: {} });
    const app = express();
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: createRequireActiveUser({ db: prisma, verifyAccessToken: fakeVerifyAccessToken }), apiLimiter: (req, res, next) => next() }));
    app.use((error, req, res, next) => res.status(500).json({ message: "Internal server error" })); // eslint-disable-line no-unused-vars
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await database?.close();
});
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "candidate_import"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details";
        DELETE FROM "import_job_group"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate_verification"; DELETE FROM "documents"; DELETE FROM "candidate";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
});

// ---------------------------------------------------------------- synthetic rows and helpers

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N5${pad(i, 6)}`;
const SECRETS = (i) => [passportOf(i), `SYNTHSURNAME${i}`, `SYNTH GIVEN ${i}`, `${510000000 + i}V`, `073${pad(i, 7)}`, `${i} Synthetic Road`];
function row(i, u = 3100, d = "11.07.2026", overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${510000000 + i}V`,
            "WHATSAPP NUMBER": `073${pad(i, 7)}`, "JOB ROLE": "Plaster", OFFICER: "John", "INTERVIEW DATE": d, "INTERVIEW PASS FAIL": "PASS",
            COMPANY: "Synth Builders", AGENT: "Synth Agency", "UNIQUE NUMBER": u === null ? "" : String(u),
            ADDRESS: `${i} Synthetic Road`, "BIRTH DATE": "05.03.1990", "SHIRT SIZE": "2XL", "FATHER NAME": "SYNTHFATHER",
            ...overrides,
        },
    };
}
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
const many = (count, start = 1, overrides = {}) => renumber(Array.from({ length: count }, (_, k) => row(start + k, 3100 + (k % 90), "11.07.2026", overrides)));
const preview = (rows, actor = ADMIN) => previewImport({ db: prisma, actor, fileName: "legacy.xlsx", headers: HEADERS, rows, now: TODAY });
const commit = (p, rows, index, actor = ADMIN, db = prisma) => commitChunk({ db, actor, importId: p.importId, chunkIndex: index, rows: chunkRows(rows, p.chunkSize)[index], now: TODAY });
async function importRows(rows, actor = ADMIN) {
    const p = await preview(rows, actor);
    for (let index = 0; index < p.chunkCount; index++) await commit(p, rows, index, actor);
    await finishImport({ db: prisma, actor, importId: p.importId });
    return p;
}
const ledgerOf = (p) => prisma.candidateImportChange.findMany({ where: { importId: p.importId } });
const importRow = (p) => prisma.candidateImport.findUnique({ where: { importId: p.importId } });
const rejection = (promise) => promise.then(() => assert.fail("expected a rejection"), (error) => error);
const candidateByPassport = (i) => prisma.candidate.findUnique({ where: { passportId: passportOf(i) } });
const rollback = (p, options = {}) => executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true, ...options });
const statuses = async (p) => {
    const out = {};
    for (const e of await ledgerOf(p)) out[e.status] = (out[e.status] ?? 0) + 1;
    return out;
};
const counts = async () => ({
    candidates: await prisma.candidate.count(), details: await prisma.candidateAdditionalDetails.count(), stages: await prisma.candidateStage.count(),
    allocations: await prisma.candidateAllocation.count(), members: await prisma.jobCandidate.count(), jobs: await prisma.job.count(),
    groups: await prisma.importJobGroup.count(), clients: await prisma.client.count(), agents: await prisma.agent.count(), links: await prisma.agentClient.count(),
});
const NOTHING = { candidates: 0, details: 0, stages: 0, allocations: 0, members: 0, jobs: 0, groups: 0, clients: 0, agents: 0, links: 0 };
async function register(i, extra = {}) {
    const { values, errors } = parseCandidateBody({
        passportId: passportOf(i), surname: `SYNTHSURNAME${i}`, otherNames: `SYNTH GIVEN ${i}`, nic: `${510000000 + i}V`, whatsappNumber: `073${pad(i, 7)}`, jobTypes: ["PLASTER"], ...extra,
    }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values, actor: ADMIN });
}
const addDocument = (passportId) => prisma.document.create({
    data: {
        documentId: randomUUID(), passportId, documentType: "PASSPORT", originalFilename: "file.pdf", storedFilename: "file.pdf",
        storagePath: `clients/${passportId}/${randomUUID()}.pdf`, receivedDate: new Date(), processingStatus: "STORED", verificationStatus: "VERIFIED",
    },
});
const auditCount = (action, importId) => prisma.auditLog.count({ where: { action, reason: { contains: importId } } });

// A client whose transactions run `hook(callNumber, tx)` after their work, before commit.
function withTransactionHook(hook) {
    let calls = 0;
    return new Proxy(prisma, {
        get(target, prop) {
            if (prop === "$transaction") return (fn, options) => target.$transaction(async (tx) => { const result = await fn(tx); await hook(++calls, tx); return result; }, options);
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
// A client whose transaction fails candidate.delete for one candidate (an unexpected database error).
function withFailingCandidateDelete(passportId) {
    const wrapTx = (tx) => new Proxy(tx, {
        get(target, prop) {
            if (prop === "candidate") {
                return new Proxy(target.candidate, {
                    get(model, method) {
                        if (method === "delete") return async (args) => { if (args.where.passportId === passportId) throw Object.assign(new Error("synthetic"), { code: "P2003" }); return model.delete(args); };
                        const value = model[method];
                        return typeof value === "function" ? value.bind(model) : value;
                    },
                });
            }
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return new Proxy(prisma, {
        get(target, prop) {
            if (prop === "$transaction") return (fn, options) => target.$transaction((tx) => fn(wrapTx(tx)), options);
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

// ---------------------------------------------------------------- rollback of what the import created

describe("a completed import that created everything", () => {
    test("preview says everything is eligible and writes nothing; the rollback then removes exactly what the import made", async () => {
        const rows = renumber([row(1, 3100, "11.07.2026", { "VISA STATUS": "Submit" }), row(2, 3101), row(3, 3102)]);
        const p = await importRows(rows);
        const before = await counts();
        assert.ok(before.candidates === 3 && before.jobs === 1 && before.clients === 1 && before.agents === 1 && before.links === 1 && before.allocations === 3);

        const snapshot = { statuses: await statuses(p), status: (await importRow(p)).status, audits: await prisma.auditLog.count() };
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.deepEqual([shown.canStart, shown.blockedReason, shown.keyAvailable], [true, null, true]);
        assert.equal(shown.summary.conflicts + shown.summary.missing + shown.summary.alreadyReverted, 0);
        assert.equal(shown.summary.eligible, shown.summary.total);
        assert.deepEqual(shown.willDelete, { candidates: 3, jobs: 1, clients: 1, agents: 1 });
        assert.deepEqual({ statuses: await statuses(p), status: (await importRow(p)).status, audits: await prisma.auditLog.count() }, snapshot, "a preview writes nothing");
        assert.deepEqual(await counts(), before);

        const report = await rollback(p, { expectedEligible: shown.summary.eligible });
        assert.deepEqual([report.status, report.done, report.counts.conflicts, report.counts.remaining], ["ROLLED_BACK", true, 0, 0]);
        assert.deepEqual(await counts(), NOTHING);
        assert.equal(await prisma.jobType.count({ where: { code: "PLASTER" } }), 1, "what the import did not make is untouched");
        assert.deepEqual(await statuses(p), { REVERTED: shown.summary.total });
        const record = await importRow(p);
        assert.deepEqual([record.status, record.rollbackPreviousStatus, record.rollbackAdminId, record.rollbackLeaseToken], ["ROLLED_BACK", "COMPLETED", "admin-ADMIN", null]);
        assert.ok(record.rollbackStartedAt && record.rollbackCompletedAt);
    });

    test("audit trail, Sheet approvals and the sync request: one entry per unit, one approval per deleted candidate, one reconcile asked for", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        await rollback(p);
        assert.deepEqual([await auditCount("BULK_IMPORT_ROLLBACK_STARTED", p.importId), await auditCount("BULK_IMPORT_ROLLBACK_COMPLETED", p.importId)], [1, 1]);
        const entryAudits = await prisma.auditLog.findMany({ where: { action: "BULK_IMPORT_ROLLBACK_ENTRY", reason: { contains: p.importId } } });
        assert.ok(entryAudits.length >= 3, "two candidates, the Job, the Client, the Agent ...");
        assert.equal(entryAudits.filter((a) => a.passportId).length, 2, "a candidate's own audit rows carry its id");
        // The import's own audit history is kept.
        assert.ok(await auditCount("CREATE_CANDIDATE", p.importId) >= 2 || (await prisma.auditLog.count({ where: { action: "CREATE_CANDIDATE", reason: { contains: p.importId } } })) >= 2);

        const approvals = await prisma.sheetSyncDeletionApproval.findMany({ where: { importId: p.importId } });
        const deleted = of(await ledgerOf(p), E.CANDIDATE, LEDGER_OP.CREATE).map((e) => e.entityKey).sort();
        assert.deepEqual(approvals.map((a) => a.uniqueId).sort(), deleted);
        assert.ok(approvals.every((a) => a.consumedAt === null));
        // The deleted candidates reach the sync queue through the existing trigger, flagged as deleted.
        assert.ok((await prisma.sheetSyncQueue.count({ where: { uniqueId: { in: deleted }, candidateDeleted: true } })) >= 2);
        assert.equal(await prisma.sheetSyncRun.count({ where: { kind: "RECONCILE" } }), 1);
        assert.equal((await importRow(p)).rollbackResult.sync.requested, true);
    });

    test("responses hold no personal data and no secret", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        const report = await rollback(p);
        const text = JSON.stringify([shown, report, await getRollback({ db: prisma, actor: ADMIN, importId: p.importId })]);
        for (const secret of [...SECRETS(1), ...SECRETS(2)]) assert.ok(!text.includes(secret), `must not contain ${secret.slice(0, 5)}…`);
        assert.ok(!text.includes(process.env.IMPORT_LEDGER_HMAC_SECRET));
    });

    test("a second rollback is refused (ALREADY_ROLLED_BACK); the preview then shows everything as already reverted", async () => {
        const p = await importRows(renumber([row(1)]));
        await rollback(p);
        const again = await rejection(rollback(p));
        assert.deepEqual([again.status, again.code], [409, "ALREADY_ROLLED_BACK"]);
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.deepEqual([shown.canStart, shown.blockedReason, shown.summary.eligible, shown.summary.alreadyReverted > 0], [false, "ALREADY_ROLLED_BACK", 0, true]);
    });

    test("an import that finished with errors (rows never committed) is rolled back for what it wrote", async () => {
        const rows = many(IMPORT_CHUNK_SIZE + 20, 1);
        const p = await preview(rows);
        await commit(p, rows, 0); // the second chunk is never sent
        const finished = await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(finished.status, "COMPLETED_WITH_ERRORS");
        const report = await rollback(p);
        assert.deepEqual([report.status, (await counts()).candidates], ["ROLLED_BACK", 0]);
    });
});

const of = (entries, type, op = null) => entries.filter((e) => e.entityType === type && (op === null || e.op === op));

describe("an import that filled blanks of existing candidates", () => {
    test("each filled field goes back to the EXACT value it had: null stays null, an empty string stays an empty string; the candidate stays", async () => {
        await register(1);
        await register(2);
        await prisma.candidate.update({ where: { passportId: passportOf(1) }, data: { address: "" } });
        await prisma.candidate.update({ where: { passportId: passportOf(2) }, data: { address: null } });
        const untouched = (await candidateByPassport(1)).firstName;
        const p = await importRows(renumber([row(1, 3100), row(2, 3101)]));
        assert.equal((await candidateByPassport(1)).address, "1 Synthetic Road");

        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK");
        const [one, two] = [await candidateByPassport(1), await candidateByPassport(2)];
        assert.strictEqual(one.address, "", "an empty string again");
        assert.strictEqual(two.address, null, "null again");
        assert.equal(one.firstName, untouched, "what the candidate already had is untouched");
        assert.deepEqual([await prisma.candidate.count(), await prisma.candidateAllocation.count()], [2, 0], "the candidates stay; the allocation the import made is removed");
        const details = await prisma.candidateAdditionalDetails.findUnique({ where: { passportId: passportOf(1) } });
        assert.equal(details, null, "a details row the import created is removed");
    });

    test("a Client's registration number goes back to exactly what it was (null / empty string); an existing allocation is never touched", async () => {
        const agent = await prisma.agent.create({ data: { name: "Synth Agency", countryCode: "RO" } });
        const [emptied, nulled] = [
            await prisma.client.create({ data: { name: "Synth Builders", registrationNumber: "" } }),
            await prisma.client.create({ data: { name: "Other Builders", registrationNumber: null } }),
        ];
        await prisma.agentClient.createMany({ data: [{ agentId: agent.id, clientId: emptied.id }, { agentId: agent.id, clientId: nulled.id }] });
        await register(1);
        await prisma.candidateAllocation.create({ data: { passportId: passportOf(1), analystId: "u-anna" } });
        const p = await importRows(renumber([
            row(1, 3100, "11.07.2026", { "COMPANY NUMBER": "REG-1" }),
            row(2, 3200, "11.07.2026", { COMPANY: "Other Builders", "COMPANY NUMBER": "REG-2" }),
        ]));
        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK");
        assert.strictEqual((await prisma.client.findUnique({ where: { id: emptied.id } })).registrationNumber, "");
        assert.strictEqual((await prisma.client.findUnique({ where: { id: nulled.id } })).registrationNumber, null);
        assert.equal((await prisma.candidateAllocation.findUnique({ where: { passportId: passportOf(1) } })).analystId, "u-anna");
        assert.deepEqual([(await counts()).clients, (await counts()).agents], [2, 1], "Clients and Agents that existed before stay");
    });
});

// ---------------------------------------------------------------- partial imports

describe("an import that did not finish", () => {
    const TWO_CHUNKS = IMPORT_CHUNK_SIZE + 30;

    test("aborted after the first chunk: the rollback reverses only what that chunk wrote", async () => {
        const rows = many(TWO_CHUNKS, 1);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await abortImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal((await counts()).candidates, IMPORT_CHUNK_SIZE);
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(shown.willDelete.candidates, IMPORT_CHUNK_SIZE);
        const report = await rollback(p);
        assert.deepEqual([report.status, report.previousStatus, (await counts()).candidates], ["ROLLED_BACK", "ABORTED", 0]);
    });

    test("an import that is still committing cannot be rolled back (finish or abort it first); one that never started has nothing to roll back", async () => {
        const rows = many(TWO_CHUNKS, 1);
        const p = await preview(rows);
        const nothing = await rejection(rollback(p));
        assert.deepEqual([nothing.status, nothing.code], [409, "NOTHING_TO_ROLL_BACK"]);
        await commit(p, rows, 0);
        const committing = await rejection(rollback(p));
        assert.deepEqual([committing.status, committing.code], [409, "IMPORT_STILL_COMMITTING"]);
        assert.equal((await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId })).blockedReason, "IMPORT_STILL_COMMITTING");
        assert.equal((await counts()).candidates, IMPORT_CHUNK_SIZE, "nothing was touched");
    });
});

// ---------------------------------------------------------------- what must not be touched

describe("records changed or used since the import are never touched", () => {
    const setup = async () => {
        const rows = renumber([row(1, 3100, "11.07.2026", { "VISA STATUS": "Submit" }), row(2, 3101), row(3, 3102)]);
        return { p: await importRows(rows), rows };
    };

    test("a value the import wrote was changed afterwards: that candidate (and what the import gave it) stays; the others are removed", async () => {
        const { p } = await setup();
        await prisma.candidate.update({ where: { passportId: passportOf(1) }, data: { address: "Changed by a person" } });
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.ok(shown.summary.conflicts > 0 && shown.summary.eligible > 0);
        assert.ok(shown.reasons.FIELD_CHANGED >= 1 && shown.reasons.PARENT_NOT_REVERTED >= 1);
        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        const kept = await candidateByPassport(1);
        assert.equal(kept.address, "Changed by a person", "the person's change stands");
        assert.deepEqual([await candidateByPassport(2), await candidateByPassport(3)], [null, null]);
        const stages = await prisma.candidateStage.count({ where: { passportId: passportOf(1) } });
        assert.ok(stages >= 2, "what the import gave the kept candidate stays with it");
        assert.ok(await prisma.candidateAllocation.findUnique({ where: { passportId: passportOf(1) } }));
        assert.ok(report.counts.conflicts >= 1 && report.reasons.FIELD_CHANGED >= 1);
        const conflicted = await prisma.candidateImportChange.findMany({ where: { importId: p.importId, status: "CONFLICT" } });
        assert.ok(conflicted.every((e) => Array.isArray(e.revertDetail.reasons) && e.revertDetail.reasons.length));
    });

    test("a document attached since keeps the candidate; a stage changed since keeps it too", async () => {
        const { p } = await setup();
        await addDocument(passportOf(1));
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: passportOf(2), stage: "TEST_DETAILS" } }, data: { testResult: "FAIL" } });
        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.ok(await candidateByPassport(1) && await candidateByPassport(2));
        assert.equal(await candidateByPassport(3), null, "the untouched one is removed");
        assert.ok(report.reasons.HAS_DOCUMENTS >= 1 && report.reasons.FIELD_CHANGED >= 1);
    });

    test("a Job someone else put a candidate on, and a Client another Job uses, stay (and so does the Agent)", async () => {
        const { p } = await setup();
        const [job] = await prisma.job.findMany();
        const [client] = await prisma.client.findMany();
        const [agent] = await prisma.agent.findMany();
        await register(900);
        await prisma.jobCandidate.create({ data: { jobId: job.id, passportId: passportOf(900), assignedBy: "admin-ADMIN" } });
        const type = await prisma.jobType.findFirst();
        await prisma.job.create({ data: { jobCode: "JOB-2026-990001", jobTypeId: type.id, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", fromCountryCode: "RO", status: "PROCESSING", createdById: "admin-ADMIN" } });
        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.equal((await counts()).candidates, 1, "only the candidate someone else added is left");
        assert.deepEqual([await prisma.job.count({ where: { id: job.id } }), await prisma.client.count({ where: { id: client.id } }), await prisma.agent.count({ where: { id: agent.id } })], [1, 1, 1]);
        assert.equal(await prisma.jobCandidate.count({ where: { jobId: job.id } }), 1, "the other member is untouched, the import's are gone");
        assert.ok(report.reasons.HAS_OTHER_MEMBERS >= 1);
    });

    test("a record of another workflow that points at a candidate (found from the database's foreign keys) keeps it", async () => {
        const { p } = await setup();
        const dependents = await prisma.$queryRaw`
            SELECT c."conrelid"::regclass::text AS "tbl" FROM "pg_constraint" c
            WHERE c."contype" = 'f' AND c."confrelid" = 'candidate'::regclass AND array_length(c."conkey", 1) = 1`;
        assert.ok(dependents.length >= 4, "the catalog lists the tables that point at a candidate");
        await prisma.candidateVerification.create({ data: { passportId: passportOf(2) } });
        const report = await rollback(p);
        assert.ok(await candidateByPassport(2), "a verification record (another workflow) keeps the candidate");
        assert.ok(report.reasons.HAS_DEPENDENT_RECORDS >= 1);
        assert.deepEqual([await candidateByPassport(1), await candidateByPassport(3)], [null, null], "the others are removed");
    });

    test("a retry once the cause is gone reverses what was kept (a new run turns conflicts back into entries to try)", async () => {
        const { p } = await setup();
        const doc = await addDocument(passportOf(1));
        assert.equal((await rollback(p)).status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.ok(await candidateByPassport(1));
        await prisma.document.delete({ where: { documentId: doc.documentId } });
        const again = await rollback(p);
        assert.deepEqual([again.status, again.previousStatus, again.counts.conflicts], ["ROLLED_BACK", "ROLLED_BACK_WITH_CONFLICTS", 0]);
        assert.deepEqual(await counts(), NOTHING);
    });
});

describe("continuing an interrupted run", () => {
    test("a run that is CONTINUED keeps the conflicts it already recorded (only a NEW run retries them); a new run then reverts them once the cause is gone", async () => {
        const rows = renumber([row(1), row(2)]);
        const p = await importRows(rows);
        const doc = await addDocument(passportOf(1));
        assert.equal((await rollback(p)).status, "ROLLED_BACK_WITH_CONFLICTS");
        // Make it look like that run was interrupted before it finished: still ROLLING_BACK, its lease run out.
        await prisma.candidateImport.update({ where: { importId: p.importId }, data: { status: "ROLLING_BACK", rollbackLeaseToken: randomUUID(), rollbackLeaseExpiresAt: new Date(Date.now() - 1000), rollbackCompletedAt: null } });
        await prisma.document.delete({ where: { documentId: doc.documentId } }); // the cause is gone meanwhile

        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.ok(shown.summary.conflicts > 0, "the conflicts it recorded are shown as recorded");
        assert.equal(shown.summary.eligible, 0, "not offered again by a continuation");
        const resumed = await rollback(p);
        assert.equal(resumed.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.ok(await candidateByPassport(1), "a continuation does not retry");

        const fresh = await rollback(p); // a NEW run, from the finished state
        assert.deepEqual([fresh.status, fresh.counts.conflicts], ["ROLLED_BACK", 0]);
        assert.deepEqual(await counts(), NOTHING);
    });
});

// ---------------------------------------------------------------- ledger entries that are missing, legacy or unverifiable

describe("missing, legacy and unverifiable ledger entries", () => {
    test("a record that is already gone is skipped, not an error; the rest is reverted", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        await prisma.candidate.delete({ where: { passportId: passportOf(1) } });
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.ok(shown.summary.missing >= 1);
        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK");
        assert.ok(report.counts.skipped >= 1);
        assert.deepEqual((await counts()).candidates, 0);
        const skipped = await prisma.candidateImportChange.findMany({ where: { importId: p.importId, status: "SKIPPED" } });
        assert.ok(skipped.every((e) => e.revertDetail.reasons.includes("ALREADY_GONE")));
    });

    test("entries from before the key existed (a plain sha256) still verify and are reverted", async () => {
        const p = await importRows(renumber([row(1)]));
        for (const entry of await ledgerOf(p)) {
            if (![E.CANDIDATE, E.DETAILS].includes(entry.entityType)) continue;
            const current = entry.entityType === E.CANDIDATE ? await candidateByPassport(1) : await prisma.candidateAdditionalDetails.findUnique({ where: { passportId: passportOf(1) } });
            const changes = Object.fromEntries(Object.entries(entry.changes).map(([field, c]) => [field, c.after?.h ? { ...c, after: { h: legacyDigestOf(field, current[field]) } } : c]));
            await prisma.candidateImportChange.update({ where: { changeId: entry.changeId }, data: { changes } });
        }
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(shown.summary.conflicts, 0);
        assert.equal((await rollback(p)).status, "ROLLED_BACK");
        assert.equal((await counts()).candidates, 0);
    });

    test("the HMAC key is not available: personal values cannot be verified, so those candidates stay and the reason is KEY_UNAVAILABLE; with the key back, a retry reverts them", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        const foreign = readLedgerKeyring({ IMPORT_LEDGER_HMAC_SECRET: "foreign-secret-foreign-secret-foreign-secret", IMPORT_LEDGER_HMAC_KEY_ID: "foreign" });
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId, keyring: foreign });
        assert.ok(shown.reasons.KEY_UNAVAILABLE >= 1);
        const noKey = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId, keyring: null });
        assert.equal(noKey.keyAvailable, false);
        const report = await rollback(p, { keyring: foreign });
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.equal((await counts()).candidates, 2, "nothing personal was reverted without being verified");
        assert.ok(report.reasons.KEY_UNAVAILABLE >= 1);
        const retried = await rollback(p, { keyring });
        assert.deepEqual([retried.status, (await counts()).candidates], ["ROLLED_BACK", 0]);
    });

    test("a value that was not blank before the import is never restored: that entry stays", async () => {
        await register(1);
        const p = await importRows(renumber([row(1, 3100)]));
        const fill = of(await ledgerOf(p), E.CANDIDATE, LEDGER_OP.FILL)[0];
        const changes = { ...fill.changes, address: { ...fill.changes.address, before: { m: "hmac-sha256", k: keyring.currentId, h: "0".repeat(64) } } };
        await prisma.candidateImportChange.update({ where: { changeId: fill.changeId }, data: { changes } });
        const report = await rollback(p);
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.ok(report.reasons.PREVIOUS_VALUE_NOT_RESTORABLE >= 1);
        assert.equal((await candidateByPassport(1)).address, "1 Synthetic Road", "left as the import wrote it");
    });
});

// ---------------------------------------------------------------- two callers, interruptions, big imports

describe("one rollback at a time, and safe to repeat", () => {
    test("two requests at the same moment: exactly one runs; nothing is reverted twice", async () => {
        const p = await importRows(renumber([row(1), row(2), row(3)]));
        const results = await Promise.allSettled([rollback(p), executeRollback({ db: prisma, actor: OWNER, importId: p.importId, confirm: true })]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const refused = results.find((r) => r.status === "rejected").reason;
        assert.equal(refused.status, 409);
        assert.ok(["ROLLBACK_IN_PROGRESS", "ALREADY_ROLLED_BACK"].includes(refused.code), refused.code);
        assert.deepEqual(await counts(), NOTHING);
        assert.equal(await auditCount("BULK_IMPORT_ROLLBACK_COMPLETED", p.importId), 1);
    });

    test("a live lease held by another call refuses a new one (ROLLBACK_IN_PROGRESS); an expired lease is taken over and the run continues", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        const held = new Date(Date.now() + ROLLBACK_LEASE_MS);
        await prisma.candidateImport.update({ where: { importId: p.importId }, data: { status: "ROLLING_BACK", rollbackPreviousStatus: "COMPLETED", rollbackAdminId: "admin-ADMIN", rollbackStartedAt: new Date(), rollbackLeaseToken: randomUUID(), rollbackLeaseExpiresAt: held } });
        const refused = await rejection(rollback(p));
        assert.deepEqual([refused.status, refused.code], [409, "ROLLBACK_IN_PROGRESS"]);
        assert.equal((await counts()).candidates, 2, "nothing was touched while it was held");
        await prisma.candidateImport.update({ where: { importId: p.importId }, data: { rollbackLeaseExpiresAt: new Date(Date.now() - 1000) } });
        const report = await rollback(p);
        assert.deepEqual([report.status, (await counts()).candidates], ["ROLLED_BACK", 0]);
    });

    test("only the administrator who ran the import, or an Owner, can preview or run it", async () => {
        const p = await importRows(renumber([row(1)]));
        for (const call of [() => previewRollback({ db: prisma, actor: ADMIN2, importId: p.importId }), () => executeRollback({ db: prisma, actor: ADMIN2, importId: p.importId, confirm: true }), () => getRollback({ db: prisma, actor: ADMIN2, importId: p.importId })]) {
            const error = await rejection(call());
            assert.deepEqual([error.status, error.code], [403, "NOT_YOUR_IMPORT"]);
        }
        assert.equal((await counts()).candidates, 1);
        assert.equal((await executeRollback({ db: prisma, actor: OWNER, importId: p.importId, confirm: true })).status, "ROLLED_BACK");
    });

    test("it needs explicit confirmation, and refuses when the import changed since it was reviewed", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        const unconfirmed = await rejection(executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: false }));
        assert.deepEqual([unconfirmed.status, unconfirmed.code], [400, "CONFIRMATION_REQUIRED"]);
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        await addDocument(passportOf(1)); // changes what is eligible after the review
        const stale = await rejection(rollback(p, { expectedEligible: shown.summary.eligible }));
        assert.deepEqual([stale.status, stale.code], [409, "ROLLBACK_PREVIEW_CHANGED"]);
        assert.ok(stale.details.summary.eligible < shown.summary.eligible);
        assert.equal((await counts()).candidates, 2, "nothing was touched");
        assert.equal((await importRow(p)).status, "COMPLETED");
    });
});

describe("interruptions", () => {
    test("a batch that fails unexpectedly is rolled back with its own work; what earlier batches did stays; a retry finishes without repeating anything", async () => {
        const p = await importRows(many(100, 1));
        const batches = buildUnits(await ledgerOf(p)).length;
        assert.ok(batches >= 100);
        // The 1st transaction is the claim, the 2nd and 3rd the first two batches: the 4th (the third batch) fails after its work.
        const failing = withTransactionHook((call) => { if (call === 4) throw Object.assign(new Error("synthetic"), { code: "XX000" }); });
        const interrupted = await rejection(executeRollback({ db: failing, actor: ADMIN, importId: p.importId, confirm: true }));
        assert.deepEqual([interrupted.status, interrupted.code], [409, "ROLLBACK_INTERRUPTED"]);
        const mid = await counts();
        const revertedCandidates = (await ledgerOf(p)).filter((e) => e.entityType === E.CANDIDATE && e.status === "REVERTED").length;
        assert.ok(revertedCandidates > 0 && mid.candidates > 0 && mid.candidates < 100, `some batches committed (${mid.candidates} left)`);
        assert.equal(mid.candidates, 100 - revertedCandidates, "what the first two batches did stays; the failed third left no trace");
        const state = await importRow(p);
        assert.deepEqual([state.status, state.rollbackLeaseToken !== null], ["ROLLING_BACK", true]);
        assert.ok(state.rollbackResult.lastError.code);
        assert.equal(await auditCount("BULK_IMPORT_ROLLBACK_FAILED", p.importId), 1);
        const statusMid = await statuses(p);
        assert.ok(statusMid.APPLIED > 0 && statusMid.REVERTED > 0);

        const done = await rollback(p);
        assert.deepEqual([done.status, done.counts.conflicts, done.counts.remaining], ["ROLLED_BACK", 0, 0]);
        assert.deepEqual(await counts(), NOTHING);
        assert.equal(await auditCount("BULK_IMPORT_ROLLBACK_STARTED", p.importId), 1, "continued, not restarted");
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { importId: p.importId } }), 100, "one approval per candidate, none twice");
    });

    test("an unexpected database error on one unit keeps that unit (recorded REVERT_FAILED) and the rest is reverted", async () => {
        const p = await importRows(renumber([row(1), row(2), row(3)]));
        const report = await executeRollback({ db: withFailingCandidateDelete(passportOf(2)), actor: ADMIN, importId: p.importId, confirm: true });
        assert.equal(report.status, "ROLLED_BACK_WITH_CONFLICTS");
        assert.ok(await candidateByPassport(2), "the candidate that could not be deleted stays");
        assert.deepEqual([await candidateByPassport(1), await candidateByPassport(3)], [null, null]);
        assert.ok(report.reasons.REVERT_FAILED >= 1);
        const kept = await prisma.candidateStage.count({ where: { passportId: passportOf(2) } });
        assert.ok(kept >= 1, "what goes with it stays with it (the unit is whole)");
    });

    test("a time budget makes the call answer IN_PROGRESS; calling again continues until done, with the same end state", async () => {
        const p = await importRows(many(100, 1));
        let now = Date.now();
        const clock = () => new Date((now += 400));
        let calls = 0;
        let report;
        do {
            report = await executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true, clock, timeBudgetMs: 700 });
            calls += 1;
            assert.ok(calls < 20);
        } while (!report.done);
        assert.ok(calls > 1, "needed several calls");
        assert.deepEqual([report.status, report.counts.conflicts, report.counts.remaining], ["ROLLED_BACK", 0, 0]);
        assert.deepEqual(await counts(), NOTHING);
        assert.equal(await auditCount("BULK_IMPORT_ROLLBACK_STARTED", p.importId), 1);
    });
});

describe("a large import", () => {
    test("500 candidates over five chunks, with Jobs: reversed in short batches, completely, with bounded work per batch", async () => {
        const rows = renumber(Array.from({ length: 500 }, (_, k) => row(k + 1, 3100 + k, k < 250 ? "11.07.2026" : "12.07.2026")));
        const p = await importRows(rows);
        const built = await counts();
        assert.deepEqual([built.candidates, built.jobs >= 5], [500, true]);
        const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(shown.summary.conflicts, 0);
        assert.equal(shown.summary.eligible, shown.summary.total);
        const report = await rollback(p, { expectedEligible: shown.summary.eligible });
        assert.deepEqual([report.status, report.counts.reverted, report.counts.remaining], ["ROLLED_BACK", shown.summary.total, 0]);
        assert.deepEqual(await counts(), NOTHING);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { importId: p.importId } }), 500);
    });
});

// ---------------------------------------------------------------- the API

describe("API", () => {
    async function call(method, path, adminId, body) {
        const headers = { Accept: "application/json" };
        if (adminId) headers.Authorization = `Bearer ${tokenFor(adminId)}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(`${baseUrl}/api/admin/settings/sheet-sync/import${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json().catch(() => null) };
    }

    test("preview, confirm, run and report; the confirmation is required; nothing personal is returned", async () => {
        const p = await importRows(renumber([row(1), row(2)]));
        const shown = await call("GET", `/${p.importId}/rollback/preview`, "admin-ADMIN");
        assert.deepEqual([shown.status, shown.body.canStart, shown.body.summary.conflicts], [200, true, 0]);
        const unconfirmed = await call("POST", `/${p.importId}/rollback`, "admin-ADMIN", { expectedEligible: shown.body.summary.eligible });
        assert.deepEqual([unconfirmed.status, unconfirmed.body.code], [400, "CONFIRMATION_REQUIRED"]);
        assert.equal((await counts()).candidates, 2);
        const done = await call("POST", `/${p.importId}/rollback`, "admin-ADMIN", { confirm: true, expectedEligible: shown.body.summary.eligible });
        assert.deepEqual([done.status, done.body.status, done.body.done], [200, "ROLLED_BACK", true]);
        assert.equal((await counts()).candidates, 0);
        const report = await call("GET", `/${p.importId}/rollback`, "admin-ADMIN");
        assert.deepEqual([report.status, report.body.counts.reverted > 0], [200, true]);
        const text = JSON.stringify([shown.body, done.body, report.body]);
        for (const secret of [...SECRETS(1), ...SECRETS(2)]) assert.ok(!text.includes(secret));
    });

    test("roles and ownership are enforced by the backend: an Analyst gets 403, another administrator 403, an Owner may; a bad id is 400", async () => {
        const p = await importRows(renumber([row(1)]));
        assert.equal((await call("GET", `/${p.importId}/rollback/preview`, "admin-ANALYST")).status, 403);
        assert.equal((await call("POST", `/${p.importId}/rollback`, "admin-ANALYST", { confirm: true })).status, 403);
        const other = await call("POST", `/${p.importId}/rollback`, "admin-ADMIN2", { confirm: true });
        assert.deepEqual([other.status, other.body.code], [403, "NOT_YOUR_IMPORT"]);
        assert.equal((await call("GET", "/not-a-uuid/rollback/preview", "admin-ADMIN")).status, 400);
        assert.equal((await call("GET", `/${randomUUID()}/rollback/preview`, "admin-ADMIN")).status, 404);
        assert.equal((await call("POST", `/${p.importId}/rollback`, "admin-OWNER", { confirm: true })).body.status, "ROLLED_BACK");
    });

    test("GET /active also names a rollback that was interrupted, so it can be continued", async () => {
        const p = await importRows(renumber([row(1)]));
        await prisma.candidateImport.update({ where: { importId: p.importId }, data: { status: "ROLLING_BACK", rollbackAdminId: "admin-ADMIN", rollbackLeaseExpiresAt: new Date(Date.now() - 1000) } });
        const active = await call("GET", "/active", "admin-ADMIN");
        assert.deepEqual([active.body.active.importId, active.body.active.status], [p.importId, "ROLLING_BACK"]);
    });
});

// The assessment helpers the rollback builds on stay available to other callers.
test("the ledger's own check agrees with what a rollback would do", async () => {
    const p = await importRows(renumber([row(1)]));
    const assessed = await assessImportLedger({ db: prisma, importId: p.importId, keyring });
    const shown = await previewRollback({ db: prisma, actor: ADMIN, importId: p.importId });
    assert.equal(assessed.summary.eligible, shown.summary.eligible);
    assert.ok(canonicalValue("x") === "x" && typeof entryContext === "function" && ASSESSMENT.ELIGIBLE === "ELIGIBLE");
});
