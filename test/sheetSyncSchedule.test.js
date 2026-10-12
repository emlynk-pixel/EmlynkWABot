// Google Sheet sync schedule: no real-time synchronization; a full
// reconciliation at 06:00, 12:00 and 18:00 Asia/Colombo (one Cloud Scheduler
// job calling the worker's OIDC-protected POST /tasks/reconcile), plus the
// manual Sync Now. Real PostgreSQL (PGlite); Google is an in-memory fake.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { createSheetSyncStore, RUN_KIND, RUN_TRIGGER } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker } from "../src/services/sheetSyncWorker.js";
import { createOidcVerifier, createSheetSyncHttpServer } from "../src/sheetSyncWorkerProcess.js";
import { SHEET_SYNC_SCHEDULE, readSheetSyncConfig, readSheetSyncTuning } from "../src/config/sheetSync.js";
import { BUSINESS_TIME_ZONE } from "../src/utils/businessDay.js";
import { SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";

const TAB = "Emlynk Candidate Operational Mirror";
const AUDIENCE = "https://emlynk-sheet-sync-worker.example.run.app";
const INVOKER = "emlynk-sheet-sync-scheduler@project.iam.gserviceaccount.com";
const silent = { log() {}, warn() {}, error() {} };

// Accepts only tokens shaped "good:<email>:<email_verified>:<audience>".
const fakeOauthClient = {
    async verifyIdToken({ idToken, audience }) {
        const match = /^good:(.+?):(true|false):(.+)$/.exec(idToken);
        if (!match || match[3] !== audience) throw new Error("bad token");
        return { getPayload: () => ({ email: match[1], email_verified: match[2] === "true" }) };
    },
};

// The "HH:MM" wall-clock times a 5-field cron fires at on any day (minute
// and hour lists only; every day, month and weekday).
function cronTimes(cron) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
    assert.deepEqual([dayOfMonth, month, dayOfWeek], ["*", "*", "*"], "every day");
    const list = (field) => field.split(",").map((v) => { assert.match(v, /^\d+$/); return Number(v); });
    return list(hour).flatMap((h) => list(minute).map((m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)).sort();
}

// The Asia/Colombo wall-clock "HH:MM" of an instant.
const colomboTime = (date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

describe("the schedule", () => {
    test("one job: 06:00, 12:00 and 18:00 every day, in Asia/Colombo (the project's operational time zone)", () => {
        assert.equal(SHEET_SYNC_SCHEDULE.cron, "0 6,12,18 * * *");
        assert.deepEqual(cronTimes(SHEET_SYNC_SCHEDULE.cron), ["06:00", "12:00", "18:00"]);
        assert.deepEqual([...SHEET_SYNC_SCHEDULE.times], ["06:00", "12:00", "18:00"]);
        assert.equal(SHEET_SYNC_SCHEDULE.timeZone, "Asia/Colombo");
        assert.equal(SHEET_SYNC_SCHEDULE.timeZone, BUSINESS_TIME_ZONE);
        assert.deepEqual([SHEET_SYNC_SCHEDULE.httpMethod, SHEET_SYNC_SCHEDULE.path], ["POST", "/tasks/reconcile"]);
    });

    test("in UTC the runs are 00:30, 06:30 and 12:30 (Sri Lanka is UTC+05:30, no daylight saving); server time zone is irrelevant", () => {
        const fires = ["2026-10-09T00:30:00Z", "2026-10-09T06:30:00Z", "2026-10-09T12:30:00Z"].map((iso) => colomboTime(new Date(iso)));
        assert.deepEqual(fires, ["06:00", "12:00", "18:00"]);
        // Same in June (no seasonal shift).
        assert.equal(colomboTime(new Date("2026-06-15T00:30:00Z")), "06:00");
    });

    test("the documented Cloud Scheduler command uses exactly this schedule", () => {
        const docs = readFileSync(new URL("../Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
        const create = docs.match(/gcloud scheduler jobs create http (\S+)[^\n]*\\\n[^\n]*\\\n[^\n]*/);
        assert.ok(create, "a scheduler create command is documented");
        const command = create[0];
        assert.equal(create[1], SHEET_SYNC_SCHEDULE.jobName);
        assert.ok(command.includes(`--schedule="${SHEET_SYNC_SCHEDULE.cron}"`), command);
        assert.ok(command.includes(`--time-zone=${SHEET_SYNC_SCHEDULE.timeZone}`), command);
        assert.ok(command.includes(`--uri="$URL${SHEET_SYNC_SCHEDULE.path}"`), command);
        assert.ok(command.includes(`--http-method=${SHEET_SYNC_SCHEDULE.httpMethod}`), command);
        assert.ok(command.includes("--oidc-service-account-email=$SCHED_SA") && command.includes('--oidc-token-audience="$URL"'), command);
        // No other (older) automatic schedule is documented as a command to run.
        const schedules = [...docs.matchAll(/--schedule="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual([...new Set(schedules)], [SHEET_SYNC_SCHEDULE.cron]);
    });
});

describe("scheduled and manual runs against the real database", () => {
    let database;
    let prisma;
    before(async () => {
        database = await createTestDatabase();
        ({ prisma } = database);
    });
    after(async () => database?.close());
    beforeEach(async () => {
        await database.pg.exec(`
            DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
            DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
            UPDATE "sheet_sync_state" SET "integration_state" = 'UNKNOWN', "writer_lease_owner" = NULL, "writer_lease_expires_at" = NULL;
        `);
    });

    function setup() {
        const sheet = createFakeGoogleSheet({ tabName: TAB });
        const env = { SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: "fake-spreadsheet-id", SHEET_TAB_NAME: TAB };
        const config = readSheetSyncConfig(env);
        const store = createSheetSyncStore({ db: prisma });
        const engine = createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: createGoogleSheetsAdapter({ config, sheetsClient: sheet.client }) });
        const worker = createSheetSyncWorker({ store, engine, config, tuning: readSheetSyncTuning(env), log: silent, healthCheck: async () => ({ ok: true }) });
        // Exactly what src/sheetSyncWorker.js wires up for Cloud Scheduler.
        const server = createSheetSyncHttpServer({
            log: silent,
            verifyScheduler: createOidcVerifier({ audience: AUDIENCE, invoker: INVOKER, client: fakeOauthClient }),
            requestReconcile: async () => {
                const { run, created } = await store.requestRun({ kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.SCHEDULER });
                return { runId: run.runId, status: run.status, created };
            },
        });
        return { sheet, store, worker, server };
    }

    async function register(passportId, firstName) {
        const { values, errors } = parseCandidateBody({
            passportId, surname: "Test", otherNames: firstName, nic: `19900000${passportId.slice(-4)}`, whatsappNumber: `+9477000${passportId.slice(-4)}`,
            jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
        }, { creating: true });
        assert.equal(errors, undefined);
        return createCandidate({ db: prisma, values });
    }

    test("Cloud Scheduler at 06:00, 12:00 and 18:00: each authenticated call records a SCHEDULER run that mirrors the database as it is then", async () => {
        const { sheet, store, worker, server } = setup();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${server.address().port}${SHEET_SYNC_SCHEDULE.path}`;
        const fire = () => fetch(url, { method: SHEET_SYNC_SCHEDULE.httpMethod, headers: { Authorization: `Bearer good:${INVOKER}:true:${AUDIENCE}` } });
        try {
            const candidates = [];
            for (const [i, time] of SHEET_SYNC_SCHEDULE.times.entries()) {
                candidates.push(await register(`N900000${i}`, `Person ${"ABC"[i]}`));
                await worker.tick();
                assert.equal(sheet.dataRows().length, i, `${time}: nothing is written before the scheduled run`);

                const response = await fire();
                assert.equal(response.status, 202, time);
                const { runId } = await response.json();
                await worker.tick();
                const run = await store.getRun(runId);
                assert.deepEqual([run.triggerSource, run.status, run.dryRun], ["SCHEDULER", "SUCCEEDED", false], time);
                assert.deepEqual(sheet.dataRows().map((r) => r[SYSTEM_CANDIDATE_ID_INDEX]).sort(), candidates.map((c) => c.uniqueId).sort(), `${time}: the Sheet holds the current database`);
            }
            const rejected = await fetch(url, { method: "POST", headers: { Authorization: `Bearer good:someone-else@x.iam.gserviceaccount.com:true:${AUDIENCE}` } });
            assert.equal(rejected.status, 401, "scheduler authentication is unchanged");
        } finally {
            server.close();
        }
    });

    test("manual Sync Now and a scheduled run arriving together: one run, not two (duplicate protection)", async () => {
        const { store } = setup();
        const manual = await store.requestRun({ kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.ADMIN });
        const scheduled = await store.requestRun({ kind: RUN_KIND.RECONCILE, triggerSource: RUN_TRIGGER.SCHEDULER });
        assert.equal(scheduled.created, false);
        assert.equal(scheduled.run.runId, manual.run.runId);
    });
});

describe("the worker loop never syncs in real time", () => {
    test("with changes queued and writes enabled, a tick neither claims queue rows nor calls the per-candidate sync", async () => {
        const calls = [];
        const spy = (name, value) => async (...args) => { calls.push(name); return typeof value === "function" ? value(...args) : value; };
        const store = {
            heartbeat: spy("heartbeat"), claimRun: spy("claimRun", null), pruneCompleted: spy("pruneCompleted", 0),
            claimQueueBatch: spy("claimQueueBatch", [{ queueId: "q", uniqueId: "0001", attempts: 1 }]),
            getState: spy("getState", { integrationState: "OK" }),
            acquireWriterLease: spy("acquireWriterLease", true), releaseWriterLease: spy("releaseWriterLease"),
        };
        const engine = { reconcile: spy("reconcile", {}), syncCandidates: spy("syncCandidates", new Map()), checkTarget: spy("checkTarget", {}) };
        const env = { SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: "id", SHEET_TAB_NAME: TAB };
        const worker = createSheetSyncWorker({ store, engine, config: readSheetSyncConfig(env), tuning: readSheetSyncTuning(env), log: silent, healthCheck: async () => ({}) });
        for (let i = 0; i < 3; i++) await worker.tick();
        assert.ok(!calls.includes("claimQueueBatch"), "no queue claim");
        assert.ok(!calls.includes("syncCandidates"), "no per-candidate sync");
        assert.ok(!calls.includes("reconcile"), "no run requested, so no reconciliation");
        assert.ok(!calls.includes("acquireWriterLease"), "no Sheet write attempt");
    });
});
