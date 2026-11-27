// The one-time recalculation of Test details / Job details completion (BACKFILL-001 to 009), on a REAL
// PostgreSQL (PGlite, every migration applied): the empty Job details Date is filled first from the day the
// Job was assigned (never overwriting one), then completion is recalculated; the dry run writes nothing, apply
// changes only those columns in batches, a second apply finds nothing, and the record reverts it.
// Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { giveTestPassAndJob } from "./helpers/visaPrerequisites.js";
import { DEFAULT_BATCH_SIZE, applyStageCompletionBackfill, parseBatchSize, planStageCompletionBackfill, revertStageCompletionBackfill } from "../src/services/stageCompletionBackfill.js";
import { isJobDetailsComplete, isTestDetailsComplete } from "../src/services/stageCompletion.js";
import { businessDateOf } from "../src/utils/businessDay.js";

const IDS = ["P0000001", "P0000002", "P0000003", "P0000004", "P0000005", "P0000006", "P0000007"];
const [KEEPS_TEST, WRONG_TICK_TEST, UNTICKED_TEST, WRONG_TICK_JOB, UNTICKED_JOB, NO_DATE_JOB, NO_ROW_JOB] = IDS;
const DAY = new Date("2026-10-05");
const EARLIER = new Date("2026-09-01T00:00:00Z");
const ASSIGNED = new Date("2026-08-20T10:00:00Z");
const ASSIGNED_DAY = "2026-08-20";

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
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: IDS.map((passportId, i) => ({ passportId, uniqueId: `80${i}`, firstName: "Nimal", otherName: "Perera", nic: `91000000${i}V` })) });
    const test = (passportId, data) => prisma.candidateStage.create({ data: { passportId, stage: "TEST_DETAILS", ...data } });
    const full = { testAgentName: "Nimal", testId: "T-1", testDate: DAY, testResult: "PASS" };
    await test(KEEPS_TEST, { ...full, completed: true, completedAt: EARLIER }); // right already
    await test(WRONG_TICK_TEST, { testAgentName: "Nimal", testResult: "PASS", completed: true, completedAt: EARLIER, notes: "kept note" }); // ticked, no Test ID / date
    await test(UNTICKED_TEST, { ...full, completed: false }); // everything filled, never ticked
    // Job details. P4: ticked, no Job. P5: Job and a Date, not ticked. P6: Job, ticked, Date empty.
    // P7: Job, and no Job details row at all. The Jobs were assigned on ASSIGNED.
    await prisma.candidateStage.create({ data: { passportId: WRONG_TICK_JOB, stage: "JOB_DETAILS", completed: true, completedAt: EARLIER, jobDetailsDate: DAY } });
    for (const id of [UNTICKED_JOB, NO_DATE_JOB, NO_ROW_JOB]) {
        await giveTestPassAndJob(prisma, id);
        await prisma.jobCandidate.updateMany({ where: { passportId: id }, data: { assignedAt: ASSIGNED } });
    }
    await prisma.candidateStage.create({ data: { passportId: UNTICKED_JOB, stage: "JOB_DETAILS", completed: false, jobDetailsDate: DAY } });
    await prisma.candidateStage.create({ data: { passportId: NO_DATE_JOB, stage: "JOB_DETAILS", completed: true, completedAt: EARLIER, notes: "n" } });
    await pg.exec(`DELETE FROM "sheet_sync_queue"`);
});

const rows = () => prisma.candidateStage.findMany({ orderBy: [{ passportId: "asc" }, { stage: "asc" }] });
const dump = async () => JSON.stringify(await rows());
const stageOf = async (passportId, stage) => prisma.candidateStage.findUnique({ where: { passportId_stage: { passportId, stage } } });
const day = (value) => value?.toISOString().slice(0, 10) ?? null;

describe("the rule (stageCompletion.js)", () => {
    test("BACKFILL-001 Test details needs all four; Job details needs a Job and a date; text is trimmed", () => {
        const full = { testAgentName: "A", testId: "T", testDate: DAY, testResult: "PASS" };
        assert.equal(isTestDetailsComplete(full), true);
        for (const [field, value] of [["testAgentName", "  "], ["testId", ""], ["testDate", null], ["testResult", "FAIL"], ["testResult", null]]) {
            assert.equal(isTestDetailsComplete({ ...full, [field]: value }), false, `${field} ${value}`);
        }
        assert.equal(isTestDetailsComplete({ ...full, notes: null }), true, "notes never count");
        const job = { job: { jobCode: "JOB-1", client: { name: "Acme" } } };
        assert.equal(isJobDetailsComplete({ jobDetailsDate: DAY }, job), true);
        assert.equal(isJobDetailsComplete({ jobDetailsDate: null }, job), false);
        assert.equal(isJobDetailsComplete({ jobDetailsDate: DAY }, { job: null }), false);
        assert.equal(isJobDetailsComplete({ jobDetailsDate: DAY }, { job: { jobCode: "JOB-1", client: { name: " " } } }), false);
    });

    test("BACKFILL-002 the batch size: 1 to 1000, a whole number, 200 when not given", () => {
        assert.equal(parseBatchSize(undefined), DEFAULT_BATCH_SIZE);
        assert.equal(parseBatchSize("50"), 50);
        for (const bad of ["0", "1001", "2.5", "abc", -1]) assert.throws(() => parseBatchSize(bad), RangeError, String(bad));
    });
});

describe("the backfill", () => {
    test("BACKFILL-003 the dry run reports the date fills, every stage's counts and the Sheet queue, and writes nothing", async () => {
        const before = await dump();
        const queueBefore = await prisma.sheetSyncQueue.count();
        const { changes, report } = await planStageCompletionBackfill({ db: prisma });
        assert.equal(await dump(), before, "nothing written");
        assert.equal(await prisma.sheetSyncQueue.count(), queueBefore, "nothing queued");
        assert.equal(report.candidates, 7);
        assert.deepEqual(report.stages.TEST_DETAILS, { stayComplete: 1, becomeIncomplete: 1, becomeComplete: 1, stayIncomplete: 4 });
        // P4 loses its tick (no Job); P5 completes; P6 keeps its tick (its empty Date is filled); P7 completes (row created).
        assert.deepEqual(report.stages.JOB_DETAILS, { stayComplete: 1, becomeIncomplete: 1, becomeComplete: 2, stayIncomplete: 3 });
        assert.deepEqual(report.becomeIncompleteBecause.JOB_DETAILS, { noJob: 1 });
        assert.deepEqual(
            [report.jobDetailsDate.emptyDatesFilledFromAssignedDate, report.jobDetailsDate.jobDetailsRowsCreated, report.jobDetailsDate.existingDatesKept, report.jobDetailsDate.noJobSoNoDate],
            [2, 1, 2, 3],
        );
        assert.equal(changes.length, 6);
        assert.deepEqual(changes.filter((c) => c.filledDate).map((c) => [c.passportId, c.filledDate, c.rowCreated]).sort(), [[NO_DATE_JOB, ASSIGNED_DAY, false], [NO_ROW_JOB, ASSIGNED_DAY, true]]);
        // Google Sheet queue: every changed candidate once (none is pending here).
        assert.deepEqual([report.googleSheetSync.candidatesChanged, report.googleSheetSync.queueItemsAlreadyPending, report.googleSheetSync.queueItemsThatWouldBeCreated], [6, 0, 6]);
        assert.ok(!JSON.stringify(report).includes("P000000"), "the report names no candidate");
    });

    test("BACKFILL-004 a candidate already waiting in the Sheet queue is not counted again", async () => {
        await prisma.sheetSyncQueue.create({ data: { uniqueId: "801", status: "PENDING" } }); // P2's
        const { report } = await planStageCompletionBackfill({ db: prisma });
        assert.deepEqual([report.googleSheetSync.queueItemsAlreadyPending, report.googleSheetSync.queueItemsThatWouldBeCreated], [1, 5]);
    });

    test("BACKFILL-005 apply fills only EMPTY dates, changes only completion and those dates, in batches, with a record saved first; a second run finds nothing", async () => {
        const before = await rows();
        let record = null;
        const result = await applyStageCompletionBackfill({ db: prisma, batchSize: 2, writeRecord: async (r) => { record = r; } });
        assert.deepEqual([result.planned, result.batchSize, result.datesFilled, result.rowsCreated], [6, 2, 2, 1]);
        assert.equal(record.changes.length, 6, "the record was written before anything changed");

        assert.equal((await stageOf(KEEPS_TEST, "TEST_DETAILS")).completed, true);
        assert.equal((await stageOf(WRONG_TICK_TEST, "TEST_DETAILS")).completed, false);
        assert.equal((await stageOf(UNTICKED_TEST, "TEST_DETAILS")).completed, true);
        assert.equal((await stageOf(WRONG_TICK_JOB, "JOB_DETAILS")).completed, false);
        // An existing date is never overwritten.
        assert.equal(day((await stageOf(WRONG_TICK_JOB, "JOB_DETAILS")).jobDetailsDate), "2026-10-05");
        assert.equal(day((await stageOf(UNTICKED_JOB, "JOB_DETAILS")).jobDetailsDate), "2026-10-05");
        assert.equal((await stageOf(UNTICKED_JOB, "JOB_DETAILS")).completed, true);
        // The empty date took the day the Job was assigned; the tick it already had is kept.
        const filled = await stageOf(NO_DATE_JOB, "JOB_DETAILS");
        assert.deepEqual([day(filled.jobDetailsDate), filled.completed, filled.notes], [ASSIGNED_DAY, true, "n"]);
        // A candidate with a Job and no row got one, complete.
        const created = await stageOf(NO_ROW_JOB, "JOB_DETAILS");
        assert.deepEqual([day(created.jobDetailsDate), created.completed, Boolean(created.completedAt)], [ASSIGNED_DAY, true, true]);
        // A candidate with no Job got no date and no row.
        assert.equal(await stageOf(KEEPS_TEST, "JOB_DETAILS"), null);

        // Every other column of the rows that existed is identical.
        const strip = ({ completed, completedAt, updatedAt, jobDetailsDate, ...rest }) => JSON.stringify(rest);
        const after = await rows();
        const kept = new Set(before.map((r) => `${r.passportId}:${r.stage}`));
        assert.deepEqual(after.filter((r) => kept.has(`${r.passportId}:${r.stage}`)).map(strip), before.map(strip));
        // Idempotent.
        const again = await applyStageCompletionBackfill({ db: prisma, writeRecord: async () => {} });
        assert.deepEqual([again.planned, again.datesFilled, again.completionChanged], [0, 0, 0]);
    });

    test("BACKFILL-006 revert puts the previous values back, dates and the created row included; a row changed since is left alone", async () => {
        const before = await dump();
        let record = null;
        await applyStageCompletionBackfill({ db: prisma, writeRecord: async (r) => { record = r; } });
        assert.notEqual(await dump(), before);
        // Someone saved P3's Test details by hand afterwards (a later change must not be undone).
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: UNTICKED_TEST, stage: "TEST_DETAILS" } }, data: { completed: false, completedAt: null } });
        const result = await revertStageCompletionBackfill({ db: prisma, record: JSON.parse(JSON.stringify(record)), batchSize: 3 });
        assert.deepEqual([result.restored, result.skipped], [5, 1]);
        assert.equal(await stageOf(NO_ROW_JOB, "JOB_DETAILS"), null, "the row the backfill created is gone");
        assert.equal((await stageOf(NO_DATE_JOB, "JOB_DETAILS")).jobDetailsDate, null, "the filled date is empty again");
        assert.equal((await stageOf(NO_DATE_JOB, "JOB_DETAILS")).completed, true);
        assert.equal((await stageOf(WRONG_TICK_TEST, "TEST_DETAILS")).completedAt.toISOString(), EARLIER.toISOString(), "the previous completion time is back");
        assert.equal((await stageOf(UNTICKED_TEST, "TEST_DETAILS")).completed, false);
        // Apart from that one later change, the rows are exactly as they were.
        const restored = JSON.parse(await dump());
        const original = JSON.parse(before);
        assert.deepEqual(restored.map(({ updatedAt, ...r }) => r), original.map(({ updatedAt, ...r }) => r));
    });

    test("BACKFILL-007 a created row is kept by the revert when something else was recorded on it since", async () => {
        let record = null;
        await applyStageCompletionBackfill({ db: prisma, writeRecord: async (r) => { record = r; } });
        await prisma.candidateStage.update({ where: { passportId_stage: { passportId: NO_ROW_JOB, stage: "JOB_DETAILS" } }, data: { notes: "typed later" } });
        await revertStageCompletionBackfill({ db: prisma, record: JSON.parse(JSON.stringify(record)) });
        assert.equal((await stageOf(NO_ROW_JOB, "JOB_DETAILS")).notes, "typed later");
    });

    test("BACKFILL-008 nothing but the two stages is ever planned", async () => {
        await prisma.candidateStage.create({ data: { passportId: KEEPS_TEST, stage: "VISA_APPROVAL", completed: true, completedAt: EARLIER } });
        const { changes } = await planStageCompletionBackfill({ db: prisma });
        assert.ok(changes.every((c) => c.stage === "TEST_DETAILS" || c.stage === "JOB_DETAILS"));
    });

    test("BACKFILL-009 a Job assigned today fills today's business day", async () => {
        await prisma.jobCandidate.updateMany({ where: { passportId: NO_DATE_JOB }, data: { assignedAt: new Date() } });
        const { changes } = await planStageCompletionBackfill({ db: prisma });
        assert.equal(changes.find((c) => c.passportId === NO_DATE_JOB && c.filledDate).filledDate, businessDateOf(new Date()));
    });
});
