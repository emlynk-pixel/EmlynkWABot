// Google Sheet mirror, Phase 3: the outbox migration and its change-capture
// triggers, on a REAL PostgreSQL (PGlite, test/helpers/pgliteDatabase.js)
// with every migration applied, through the real Prisma client and the real
// candidate service. No Google client exists anywhere in this file.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import {
    createCandidate,
    parseCandidateBody,
    parseStageBody,
    updateCandidateDetails,
    updateStage,
} from "../src/services/candidateService.js";

const REGISTRATION = {
    passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V",
    whatsappNumber: "+94771234567", jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
};

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
});
after(async () => database?.close());

beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
});

const queue = () => prisma.sheetSyncQueue.findMany({ orderBy: { createdAt: "asc" } });
const pending = async () => (await queue()).filter((row) => row.status === "PENDING");

async function register(overrides = {}) {
    const { values, errors } = parseCandidateBody({ ...REGISTRATION, ...overrides }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values });
}

let documentCounter = 0;
const documentData = (passportId, overrides = {}) => {
    documentCounter += 1;
    return {
        documentId: `00000000-0000-4000-8000-${String(documentCounter).padStart(12, "0")}`,
        passportId, documentType: "MEDICAL", originalFilename: "medical.pdf", storedFilename: "medical.pdf",
        storagePath: `clients/${passportId}/medical.pdf`, receivedDate: new Date("2026-10-01T00:00:00Z"),
        processingStatus: "STORED", verificationStatus: "VERIFIED", fileSha256: String(documentCounter).padStart(64, "0"),
        ...overrides,
    };
};

const OUTBOX_MIGRATION = "20261006120000_sheet_sync_outbox";

describe("outbox migration", () => {
    test("applies on top of every existing one and adds only the sheet sync tables", async () => {
        assert.ok(migrationNames().includes(OUTBOX_MIGRATION));
        const tables = (await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'sheet_sync_%' ORDER BY 1`)).rows.map((r) => r.table_name);
        assert.deepEqual(tables, ["sheet_sync_queue", "sheet_sync_runs", "sheet_sync_state"]);
        const state = await prisma.sheetSyncState.findMany();
        assert.deepEqual(state.map((s) => [s.stateId, s.integrationState]), [["sheet-sync", "UNKNOWN"]]);
    });

    test("a database migrated up to the previous migration has none of it (the outbox migration is additive)", async () => {
        const names = migrationNames();
        const previous = names[names.indexOf(OUTBOX_MIGRATION) - 1];
        const older = await createTestDatabase({ upTo: previous });
        try {
            const count = (await older.pg.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'sheet_sync_%'`)).rows[0].n;
            assert.equal(count, 0);
        } finally {
            await older.close();
        }
    });

    test("queue rows hold no candidate data: identity and bookkeeping columns only", async () => {
        const columns = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'sheet_sync_queue' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
        assert.deepEqual(columns, [
            "queue_id", "unique_id", "status", "candidate_deleted", "attempts", "next_attempt_at", "lease_owner",
            "lease_expires_at", "last_result", "last_error_class", "last_error_code", "created_at", "updated_at", "completed_at",
        ]);
    });

    test("RLS is on for the new tables", async () => {
        const rows = (await pg.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'sheet_sync_%' AND relkind = 'r' ORDER BY 1`)).rows;
        assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity]), [
            ["sheet_sync_queue", true], ["sheet_sync_runs", true], ["sheet_sync_state", true],
        ]);
    });

    test("the database refuses an unknown queue status and a second active run of one kind", async () => {
        await assert.rejects(pg.query(`INSERT INTO "sheet_sync_queue" ("unique_id", "status") VALUES ('0001', 'BOGUS')`));
        await prisma.sheetSyncRun.create({ data: { runId: "r1", kind: "RECONCILE", triggerSource: "ADMIN" } });
        await assert.rejects(prisma.sheetSyncRun.create({ data: { runId: "r2", kind: "RECONCILE", triggerSource: "SCHEDULER" } }), { code: "P2002" });
        // Another kind, or a finished run, does not conflict.
        await prisma.sheetSyncRun.create({ data: { runId: "r3", kind: "TEST_CONNECTION", triggerSource: "ADMIN" } });
        await prisma.sheetSyncRun.update({ where: { runId: "r1" }, data: { status: "SUCCEEDED" } });
        await prisma.sheetSyncRun.create({ data: { runId: "r4", kind: "RECONCILE", triggerSource: "ADMIN" } });
    });
});

describe("change capture through the real candidate service (Section 4.4 writers)", () => {
    test("registration (users + comment stage, one transaction) -> one pending row for the new unique_id", async () => {
        const { uniqueId } = await register({ comment: "Prefers night shifts" });
        const rows = await queue();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].uniqueId, uniqueId);
        assert.equal(rows[0].status, "PENDING");
        assert.equal(rows[0].candidateDeleted, false);
    });

    test("details edit and stage saves (single statements, no transaction of their own) coalesce into that one row", async () => {
        const { passportId, uniqueId } = await register();
        await updateCandidateDetails({ db: prisma, passportId, values: parseCandidateBody({ ...REGISTRATION, address: "12 Galle Road" }, { creating: false }).values });
        await updateStage({ db: prisma, passportId, stage: "IVS_INTERVIEW", values: parseStageBody({ completed: true }, "IVS_INTERVIEW").values });
        await updateStage({ db: prisma, passportId, stage: "TEST_DETAILS", values: parseStageBody({ notes: "Sat the test" }, "TEST_DETAILS").values });
        const rows = await queue();
        assert.equal(rows.length, 1, "rapid changes to one candidate leave one pending row");
        assert.equal(rows[0].uniqueId, uniqueId);
    });

    test("document insert, supersede (updateMany), date correction and removal (deleteMany) each capture the candidate", async () => {
        const { passportId, uniqueId } = await register();
        for (const write of [
            () => prisma.document.create({ data: documentData(passportId) }),
            () => prisma.document.updateMany({ where: { passportId }, data: { verificationStatus: "SUPERSEDED" } }),
            () => prisma.document.updateMany({ where: { passportId }, data: { policeSubmittedDate: new Date("2026-09-30") } }),
            () => prisma.document.deleteMany({ where: { passportId } }),
            // OCR field reconciliation writes candidate with updateMany.
            () => prisma.candidate.updateMany({ where: { passportId, placeOfBirth: null }, data: { placeOfBirth: "Colombo" } }),
        ]) {
            await prisma.sheetSyncQueue.deleteMany();
            await write();
            assert.deepEqual((await pending()).map((r) => r.uniqueId), [uniqueId]);
        }
    });

    test("a change while the candidate's row is PROCESSING adds a new pending row (the change is never lost)", async () => {
        const { passportId, uniqueId } = await register();
        const [row] = await queue();
        await prisma.sheetSyncQueue.update({ where: { queueId: row.queueId }, data: { status: "PROCESSING" } });
        await updateStage({ db: prisma, passportId, stage: "VISA_APPROVAL", values: parseStageBody({ completed: true }, "VISA_APPROVAL").values });
        const rows = await queue();
        assert.deepEqual(rows.map((r) => [r.uniqueId, r.status]), [[uniqueId, "PROCESSING"], [uniqueId, "PENDING"]]);
    });

    test("a pending row keeps its retry schedule when more changes arrive (no backoff bypass)", async () => {
        const { passportId } = await register();
        const later = new Date(Date.now() + 10 * 60_000);
        await prisma.sheetSyncQueue.updateMany({ data: { nextAttemptAt: later, attempts: 2 } });
        await updateStage({ db: prisma, passportId, stage: "IVS_INTERVIEW", values: parseStageBody({ completed: true }, "IVS_INTERVIEW").values });
        const [row] = await queue();
        assert.equal(row.nextAttemptAt.getTime(), later.getTime());
        assert.equal(row.attempts, 2);
    });

    test("candidates are captured separately; another candidate's change never touches this one's row", async () => {
        const first = await register();
        const second = await register({ passportId: "N7654321", nic: "199012345678", whatsappNumber: "+94770000002" });
        assert.deepEqual((await pending()).map((r) => r.uniqueId).sort(), [first.uniqueId, second.uniqueId].sort());
    });

    test("a rolled-back candidate change leaves no queue row (atomic with the change)", async () => {
        const { passportId } = await register();
        await prisma.sheetSyncQueue.deleteMany();
        await assert.rejects(prisma.$transaction(async (tx) => {
            await tx.candidateStage.create({ data: { passportId, stage: "FINALIZING_JOB", completed: true } });
            throw new Error("rollback");
        }));
        assert.deepEqual(await queue(), []);
    });

    test("deleting a candidate marks the pending row candidate_deleted; the cascaded stage delete can't clear it", async () => {
        const { passportId, uniqueId } = await register({ comment: "note" });
        await prisma.sheetSyncQueue.deleteMany();
        await prisma.candidate.delete({ where: { passportId } }); // stages cascade
        const rows = await pending();
        assert.deepEqual(rows.map((r) => [r.uniqueId, r.candidateDeleted]), [[uniqueId, true]]);
    });

    test("a passport number correction (ON UPDATE CASCADE to documents and stages) keeps the same unique_id", async () => {
        const { passportId, uniqueId } = await register({ comment: "note" });
        await prisma.document.create({ data: documentData(passportId) });
        await prisma.sheetSyncQueue.deleteMany();
        await pg.query(`UPDATE "candidate" SET "passport_id" = 'N9999999' WHERE "passport_id" = $1`, [passportId]);
        const rows = await pending();
        assert.deepEqual(rows.map((r) => [r.uniqueId, r.candidateDeleted]), [[uniqueId, false]]);
    });
});
