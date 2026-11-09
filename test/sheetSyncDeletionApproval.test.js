// A rollback of a bulk import deletes many candidates at once, far more than the Sheet mirror's deletion guard
// (at most 10 rows and 5 % of the Sheet) lets it mark inactive, and the guard must stay. The rollback therefore records
// an approval for exactly each candidate it deletes (sheet_deletion_approval); the worker may mark the Sheet row of
// an APPROVED candidate that is absent from its complete snapshot inactive beyond the guard, once. Everything else
// is judged by the unchanged guard. Real PostgreSQL (PGlite) and an in-memory Sheet: no Google, no real Sheet.
import "./helpers/importLedgerKey.js";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { authIdFor } from "./helpers/fakeSupabaseAuth.js";
import { chunkRows, commitChunk, finishImport, previewImport } from "../src/services/candidateImportService.js";
import { executeRollback } from "../src/services/candidateImportRollback.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { createSheetSyncStore } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker } from "../src/services/sheetSyncWorker.js";
import { runSheetHealthCheck } from "../src/services/sheetHealthCheck.js";
import { readSheetSyncConfig, readSheetSyncTuning } from "../src/config/sheetSync.js";
import { SHEET_COLUMNS, SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";

const TAB = "Emlynk Candidate Operational Mirror";
const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN", name: "Admin User" };
const HEADERS = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE"];
const RECORD_STATUS_INDEX = SHEET_COLUMNS.findIndex((c) => c.field === "recordStatus");

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: { adminId: "admin-ADMIN", authUserId: authIdFor("admin-ADMIN"), name: "Admin User", email: "admin@example.invalid", role: "ADMIN", status: "ACTIVE", activatedAt: new Date() } });
    await prisma.jobType.upsert({ where: { code: "PLASTER" }, create: { code: "PLASTER", name: "PLASTER" }, update: {} });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "candidate_import"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate_verification";
        DELETE FROM "documents"; DELETE FROM "candidate"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
        UPDATE "sheet_sync_state" SET "integration_state" = 'UNKNOWN', "writer_lease_owner" = NULL, "writer_lease_expires_at" = NULL;
    `);
});

const pad = (n, width) => String(n).padStart(width, "0");
const row = (i) => ({
    rowNumber: i + 1,
    values: { "PASSPORT NUMBER": `N4${pad(i, 6)}`, SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${410000000 + i}V`, "WHATSAPP NUMBER": `072${pad(i, 7)}`, "JOB ROLE": "Plaster" },
});
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
async function importRows(rows) {
    const p = await previewImport({ db: prisma, actor: ADMIN, fileName: "legacy.xlsx", headers: HEADERS, rows });
    for (const [index, chunk] of chunkRows(rows, p.chunkSize).entries()) await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunk });
    await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
    return p;
}

function setup({ enabled = true } = {}) {
    const sheet = createFakeGoogleSheet({ tabName: TAB, rows: [] });
    const env = { SHEET_SYNC_ENABLED: enabled ? "true" : "false", SHEET_SPREADSHEET_ID: "fake-spreadsheet-id", SHEET_TAB_NAME: TAB };
    const [config, tuning] = [readSheetSyncConfig(env), readSheetSyncTuning(env)];
    const adapter = createGoogleSheetsAdapter({ config, sheetsClient: sheet.client });
    const engine = createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: adapter });
    const store = createSheetSyncStore({ db: prisma });
    const log = { log: () => {}, warn: () => {}, error: () => {} };
    const worker = createSheetSyncWorker({ store, engine, config, tuning, log, targetHint: "…id / tab", healthCheck: () => runSheetHealthCheck({ env, sheetsClient: sheet.client }) });
    return { sheet, store, worker };
}
async function sync({ store, worker }) {
    const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "SCHEDULER" });
    await worker.tick();
    return store.getRun(run.runId);
}
const statusOfRows = (sheet) => sheet.dataRows().map((r) => r[RECORD_STATUS_INDEX]);
const inactiveRows = (sheet) => statusOfRows(sheet).filter((s) => /inactive|deleted/i.test(String(s))).length;

describe("the Sheet mirror after a rollback of a whole import", () => {
    test("every deleted candidate's row is marked inactive although 15 is past the guard; the approvals are used up", async () => {
        const env = setup();
        await importRows(renumber([row(500)])); // another candidate stays: the snapshot is never empty
        const p = await importRows(renumber(Array.from({ length: 15 }, (_, k) => row(k + 1))));
        assert.equal((await sync(env)).status, "SUCCEEDED");
        assert.equal(env.sheet.dataRows().length, 16);
        assert.equal(inactiveRows(env.sheet), 0);

        assert.equal((await executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true })).status, "ROLLED_BACK");
        assert.equal(await prisma.candidate.count(), 1);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { consumedAt: null } }), 15);

        const run = await sync(env);
        assert.equal(run.status, "SUCCEEDED");
        assert.deepEqual([run.summary.approvedInactive, run.summary.markedInactive, run.summary.deletionGuardTriggered], [15, 15, false]);
        assert.equal(inactiveRows(env.sheet), 15, "the rows are marked, never deleted; the candidate that stays is untouched");
        assert.equal(env.sheet.dataRows().length, 16);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { consumedAt: null } }), 0, "used up");
        assert.equal((await sync(env)).summary.approvedInactive, 0, "nothing left to approve");
    });

    test("without an approval the deletion guard still refuses (candidates removed by anything else)", async () => {
        const env = setup();
        await importRows(renumber(Array.from({ length: 15 }, (_, k) => row(k + 1))));
        await sync(env);
        await prisma.candidate.deleteMany();
        const run = await sync(env);
        assert.deepEqual([run.summary.deletionGuardTriggered, run.summary.markedInactive, run.summary.notInDatabase], [true, 0, 15]);
        assert.equal(inactiveRows(env.sheet), 0);
    });

    test("only the approved rows are exempt: other absent rows beyond the guard are still refused", async () => {
        const env = setup();
        const approvedImport = await importRows(renumber(Array.from({ length: 12 }, (_, k) => row(k + 1))));
        await importRows(renumber(Array.from({ length: 11 }, (_, k) => row(100 + k))));
        await importRows(renumber([row(500)])); // stays
        await sync(env);
        assert.equal(env.sheet.dataRows().length, 24);
        await executeRollback({ db: prisma, actor: ADMIN, importId: approvedImport.importId, confirm: true }); // 12 approved
        await prisma.candidate.deleteMany({ where: { passportId: { not: "N4000500" } } }); // the other 11 vanish with no approval
        const run = await sync(env);
        assert.deepEqual([run.summary.approvedInactive, run.summary.deletionGuardTriggered, run.summary.notInDatabase], [12, true, 11]);
        assert.equal(inactiveRows(env.sheet), 12, "exactly the approved rows");
    });

    test("an approval for a candidate that is still in the database approves nothing, and is used up", async () => {
        const env = setup();
        const p = await importRows(renumber([row(1), row(2)]));
        await sync(env);
        const [kept] = await prisma.candidate.findMany();
        await prisma.sheetSyncDeletionApproval.create({ data: { uniqueId: kept.uniqueId, importId: p.importId } });
        const run = await sync(env);
        assert.deepEqual([run.summary.approvedInactive, inactiveRows(env.sheet)], [0, 0]);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { consumedAt: null } }), 0);
    });

    test("an empty database snapshot approves nothing (it never marks anything inactive)", async () => {
        const env = setup();
        const p = await importRows(renumber([row(1), row(2)]));
        await sync(env);
        await executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true });
        assert.equal(await prisma.candidate.count(), 0);
        const run = await sync(env);
        assert.deepEqual([run.summary.markedInactive, inactiveRows(env.sheet)], [0, 0]);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { consumedAt: null } }), 2, "kept for the next run, not consumed for nothing");
    });

    test("a dry run (writes disabled) neither marks rows nor uses up the approvals", async () => {
        const live = setup();
        const p = await importRows(renumber([row(1), row(2), row(3)]));
        await sync(live);
        await importRows(renumber([row(10)]));
        await executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true });
        const dry = setup({ enabled: false });
        await sync(dry);
        assert.equal(await prisma.sheetSyncDeletionApproval.count({ where: { consumedAt: null } }), 3);
        assert.equal(inactiveRows(live.sheet), 0);
    });
});

test("the engine's marked rows are internal ids only (no candidate data reaches the run summary)", async () => {
    const env = setup();
    const p = await importRows(renumber([row(1), row(2)]));
    await sync(env);
    await importRows(renumber([row(10), row(11), row(12)]));
    await executeRollback({ db: prisma, actor: ADMIN, importId: p.importId, confirm: true });
    const run = await sync(env);
    assert.ok(!JSON.stringify(run).includes("SYNTHSURNAME") && !JSON.stringify(run).includes("N40"));
    assert.ok(SYSTEM_CANDIDATE_ID_INDEX >= 0);
});
