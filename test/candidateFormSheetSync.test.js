// Candidate Form submissions -> the "Candidate Form Submissions" tab of the Google Sheet
// (formSubmissionSync.js). Real PostgreSQL (PGlite, every migration applied), the real public and
// admin routers (to submit and to create share links), the real adapter and sync against the
// in-memory fake Google Sheet, and the real worker loop for the integration cases. Nothing can
// reach Google. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeGoogleSheet, googleError } from "./helpers/fakeGoogleSheet.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ANSWER_FIELDS } from "../src/services/candidateFormDataService.js";
import { DEFAULT_FORM_SUBMISSIONS_TAB, readFormSubmissionSheetConfig, readSheetSyncTuning } from "../src/config/sheetSync.js";
import { createFormSubmissionSheetsAdapter } from "../src/services/formSubmissionSheetAdapter.js";
import { createFormSubmissionSyncStore } from "../src/services/formSubmissionSyncStore.js";
import { createFormSubmissionSync, FORM_SYNC_TIMINGS } from "../src/services/formSubmissionSync.js";
import {
    ANSWER_COLUMNS_NOT_IN_SHEET, FORM_SUBMISSION_COLUMNS, FORM_SUBMISSION_COLUMN_COUNT, FORM_SUBMISSION_HEADERS, SUBMISSION_ID_INDEX, SYSTEM_CANDIDATE_ID_INDEX, buildSubmissionCells, readFormSubmissionLayout,
} from "../src/services/formSubmissionSheetSchema.js";
import { SHEET_COLUMN_COUNT, SHEET_HEADERS } from "../src/services/sheetSchema.js";
import { createSheetSyncStore } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker } from "../src/services/sheetSyncWorker.js";

const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const ADMIN = { adminId: "u-admin", role: "ADMIN", name: "ADMIN 1", email: "u-admin@example.invalid", authUserId: "00000000-0000-4000-8000-000000000001" };
const A = {
    passportId: "N1000001", uniqueId: "8001", firstName: "Anusha", otherName: "De Soysa", nic: "900000001V", sex: "F", dateOfBirth: new Date("1990-05-01"),
    placeOfBirth: "Negombo", address: "1 Old Road", contactNumber: "0112345678", whatsappNumber: "+94771111111", job: "Welder TIG", jobExperience: "5 years",
    passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};
const B = { passportId: "N2000002", uniqueId: "8002", firstName: "Kamal", otherName: "Perera", nic: "199012345678", sex: "M", whatsappNumber: "+94772222222" };
const FORM_TAB = DEFAULT_FORM_SUBMISSIONS_TAB;
const MIRROR_TAB = "Emlynk Candidate Operational Mirror";
const DESTINATION = Object.freeze({ key: "default", name: MIRROR_TAB, spreadsheetId: "spreadsheet-id-0123456789", tabName: MIRROR_TAB });

let database;
let prisma;
let pg;
const quiet = { warn() {}, error() {}, info() {}, log() {} };
const events = [];
const capture = { warn: (line) => events.push(line), error: (line) => events.push(line), info: (line) => events.push(line), log: (line) => events.push(line) };

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ADMIN });
});
after(async () => database?.close());
beforeEach(async () => {
    events.length = 0;
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "candidate_call_logs"; DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_draft";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [A, B] });
});

// ---------------------------------------------------------------- the public form, over HTTP

function app() {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: quiet }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: ADMIN.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(method, path, { body, token } = {}) {
    const listener = await new Promise((resolve) => { const s = app().listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}
const admin = (method, path, options) => call(method, `/api/admin${path}`, options);
const pub = (path, options) => call("POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${path}`, options);

let lastSecret = "";
async function session(candidate) {
    const shared = await admin("POST", `/candidates/${candidate.passportId}/form-share`);
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    lastSecret = shared.body.url.split("#k=")[1];
    const verified = await pub("/verify", { body: { linkSecret: lastSecret, passportNumber: candidate.passportId, nic: candidate.nic } });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.body.token;
}
const ANSWERS = () => ({
    basic: { fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "MARRIED", birthDate: "1990-05-01", birthPlace: "negombo", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian" },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "0771234567", email: "Anusha.D@example.com", cityInRomania: "cluj napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 years", otherSkills1: "n/a", otherSkills2: "N/A", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "n7654321", birthDate: "1960-03-02" },
        mother: { name: "kumari", surname: "de soysa", passportNumber: "N/A", birthDate: "1965-02-03" },
        spouse: { name: "ruwan", surname: "perera", passportNumber: "N/A", birthDate: "1988-07-12" },
        child1: "nimal", child2: "N/A", child3: "", fatherAlive: "YES", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const submit = (token, answers = ANSWERS(), idempotencyKey = "key-0000000000000001") => pub("/submit", { token, body: { answers, idempotencyKey } });
async function submitAs(candidate, answers) {
    const r = await submit(await session(candidate), answers);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r;
}
const outbox = () => prisma.candidateFormSheetSync.findMany({ orderBy: { createdAt: "asc" } });

// ---------------------------------------------------------------- the sync, against the fake Sheet

let now;
const tick = (ms) => { now = new Date(now.getTime() + ms); };
const lease = async (work) => ({ busy: false, value: await work() });

function setup({ sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header: [] }), enabled = true, destination = DESTINATION, timings = FORM_SYNC_TIMINGS, buildCells } = {}) {
    now = new Date();
    const store = createFormSubmissionSyncStore({ db: prisma });
    const adapter = createFormSubmissionSheetsAdapter({ config: { enabled, spreadsheetId: destination.spreadsheetId, tabName: FORM_TAB }, sheetsClient: sheet.client });
    const sync = createFormSubmissionSync({ db: prisma, store, adapterFor: () => adapter, tabName: FORM_TAB, ...(buildCells ? { buildCells } : {}), clock: () => now, log: capture, timings, random: () => 0.5 });
    const run = (withLease = lease) => sync.processDue({ owner: "test-worker", destination, withWriterLease: withLease });
    return { sheet, store, sync, run };
}
const cellsOf = (sheet, rowNumber = 2) => {
    const row = sheet.row(rowNumber);
    return Object.fromEntries(FORM_SUBMISSION_COLUMNS.map((c) => [c.field, row[sheet.header().indexOf(c.header)]]));
};
const dataRows = (sheet) => sheet.dataRows().filter((row) => row.some((cell) => cell !== ""));

describe("the outbox: written with the submission, once", () => {
    test("a successful submit creates exactly one outbox row with a stable submission ID, in the same transaction, holding no candidate data", async () => {
        assert.deepEqual(await outbox(), []);
        await submitAs(A);
        const rows = await outbox();
        assert.equal(rows.length, 1);
        assert.equal(await prisma.candidateFormResponse.count(), 1);
        const [row] = rows;
        assert.equal(row.passportId, A.passportId);
        assert.match(row.submissionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(row.status, "PENDING");
        assert.equal(row.attempts, 0);
        assert.deepEqual(Object.keys(row).sort(), ["attempts", "completedAt", "createdAt", "lastErrorClass", "lastErrorCode", "lastResult", "leaseExpiresAt", "leaseOwner", "nextAttemptAt", "passportId", "status", "submissionId", "updatedAt"]);
        assert.ok(!JSON.stringify(row).includes(A.nic) && !JSON.stringify(row).includes("ANUSHA"), "no candidate data in the outbox");
    });

    test("a retried, repeated or concurrent submit never queues a second row", async () => {
        const token = await session(A);
        const first = await submit(token, ANSWERS(), "key-retry-0000000001");
        const retry = await submit(token, ANSWERS(), "key-retry-0000000001");
        assert.deepEqual([first.status, retry.status], [200, 200]);
        const other = await submit(token, ANSWERS(), "key-other-0000000002");
        assert.equal(other.status, 409);
        assert.equal((await outbox()).length, 1);

        const racing = await session(B);
        const results = await Promise.all([submit(racing, ANSWERS(), "key-race-00000000001"), submit(racing, ANSWERS(), "key-race-00000000002")]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal((await outbox()).length, 2);
        assert.deepEqual((await outbox()).map((r) => r.passportId).sort(), [A.passportId, B.passportId]);
        // The database itself refuses a second row for the candidate.
        await assert.rejects(prisma.candidateFormSheetSync.create({ data: { passportId: A.passportId } }), /Unique constraint/);
    });

    test("a refused or incomplete submit, and a saved step (draft), queue nothing", async () => {
        const token = await session(A);
        const bad = ANSWERS();
        bad.basic.fullName = "";
        assert.equal((await submit(token, bad)).status, 400);
        assert.equal((await submit("garbage-token")).status, 401);
        assert.equal((await pub("/draft", { token, body: { step: "personal", answers: { basic: ANSWERS().basic, contact: ANSWERS().contact } } })).status, 200);
        assert.deepEqual(await outbox(), []);
        assert.equal(await prisma.candidateFormResponse.count(), 0);
    });

    test("the submit does not need Google at all: it succeeds with no Sheet configured, no client, no worker", async () => {
        // Nothing in this test file's submit path builds a Sheets client (the live one refuses to exist under the test runner).
        const r = await submitAs(A);
        assert.ok(Date.parse(r.body.submittedAt) > 0);
        assert.equal((await outbox())[0].status, "PENDING");
    });
});

describe("the submission row in the Candidate Form Submissions tab", () => {
    test("one submit -> one row: the new tab gets its header, then the submission with its stable IDs and every answer", async () => {
        await submitAs(A);
        const { sheet, run, store } = setup();
        const summary = await run();
        assert.deepEqual([summary.claimed, summary.appended, summary.updated], [1, 1, 0]);

        assert.deepEqual(sheet.header(), [...FORM_SUBMISSION_HEADERS]);
        assert.equal(dataRows(sheet).length, 1);
        const [queued] = await outbox();
        const cells = cellsOf(sheet);
        assert.equal(cells.submissionId, queued.submissionId);
        assert.equal(cells.systemCandidateId, A.uniqueId);
        assert.equal(cells.passportNumber, A.passportId);
        assert.equal(cells.candidateName, "ANUSHA DE SOYSA");
        assert.equal(cells.submissionStatus, "SUBMITTED");
        const stored = await prisma.candidateFormResponse.findUnique({ where: { passportId: A.passportId } });
        assert.equal(cells.submittedAt, stored.submittedAt.toISOString().replace(/\.\d{3}Z$/, "Z"));
        assert.deepEqual(
            [cells.fullName, cells.surname, cells.otherNames, cells.nic, cells.sex, cells.civilStatus, cells.birthDate, cells.birthPlace],
            ["ANUSHA DE SOYSA", "DE SOYSA", "ANUSHA", A.nic, "FEMALE", "MARRIED", "1990-05-01", "NEGOMBO"],
        );
        assert.deepEqual([cells.address, cells.city, cells.district, cells.dsDivision, cells.gnDivision, cells.alternativePhone, cells.email, cells.whatsappNumber],
            ["12 GALLE ROAD", "NEGOMBO", "GAMPAHA", "NEGOMBO", "KURANA", "0771234567", "Anusha.D@example.com", A.whatsappNumber]);
        assert.deepEqual([cells.passportIssueDate, cells.passportExpiryDate, cells.jobCategory, cells.experience, cells.otherSkills1, cells.englishKnowledge], ["2020-01-15", "2030-01-14", "WELDER TIG", "5 YEARS", "N/A", "GOOD"]);
        assert.deepEqual([cells.shirtSize, cells.waistSize, cells.shoeSize], ["M", "32", "EU 42"]);
        assert.deepEqual([cells.fatherName, cells.fatherPassportNumber, cells.fatherBirthDate, cells.motherName, cells.motherPassportNumber, cells.spouseName, cells.spouseBirthDate, cells.child1Name, cells.child2Name, cells.child3Name],
            ["SUNIL", "N7654321", "1960-03-02", "KUMARI", "N/A", "RUWAN", "1988-07-12", "NIMAL", "N/A", ""]);
        assert.deepEqual([cells.guardianName, cells.guardianRelationship, cells.guardianNic, cells.guardianBirthDate, cells.guardianPhone, cells.guardianAddress],
            ["KAMAL PERERA", "UNCLE", "901234567V", "1960-01-01", "+94 77 123 4567", "45 LAKE ROAD"]);

        const [done] = await outbox();
        assert.deepEqual([done.status, done.lastResult, done.attempts, done.lastErrorClass], ["COMPLETED", "APPENDED", 1, null]);
        assert.deepEqual(await store.counts(), { PENDING: 0, PROCESSING: 0, COMPLETED: 1, FAILED: 0 });
    });

    test("only the form's own tab is touched, with RAW values, and the Sheet is never cleared or deleted from", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        await run();
        for (const c of sheet.calls) {
            const ranges = c.range ? [c.range] : c.ranges ?? [];
            for (const range of ranges) assert.ok(range.startsWith(`'${FORM_TAB}'!`), range);
            assert.ok(!range_mentions(c, MIRROR_TAB));
        }
        // Only the header (values.update on A1:..1) and appends happen here; the fake records the input option of appends.
        assert.deepEqual(sheet.writes().map((w) => w.method), ["update", "append"]);
        assert.match(sheet.writes()[0].range, /^'Candidate Form Submissions'!A1:[A-Z]+1$/);
        assert.deepEqual([sheet.writes()[1].valueInputOption, sheet.writes()[1].insertDataOption], ["RAW", "INSERT_ROWS"]);
        assert.ok(sheet.calls.every((c) => !["clear", "delete"].includes(c.method)));
    });

    test("two submissions go in as two rows, each with its own IDs, in one write", async () => {
        await submitAs(A);
        await submitAs(B, (() => { const b = ANSWERS(); b.basic.fullName = "kamal perera"; b.basic.civilStatus = "SINGLE"; return b; })());
        const { sheet, run } = setup();
        const summary = await run();
        assert.deepEqual([summary.claimed, summary.appended], [2, 2]);
        const rows = dataRows(sheet);
        assert.equal(rows.length, 2);
        const ids = rows.map((row) => row[sheet.header().indexOf("_SUBMISSION_ID")]);
        assert.equal(new Set(ids).size, 2);
        const byPassport = Object.fromEntries(rows.map((row) => [row[sheet.header().indexOf("Passport Number")], row]));
        assert.equal(byPassport[B.passportId][sheet.header().indexOf("Candidate Name")], "KAMAL PERERA");
        assert.equal(byPassport[B.passportId][sheet.header().indexOf("_SYSTEM_CANDIDATE_ID")], B.uniqueId);
        assert.equal(byPassport[A.passportId][sheet.header().indexOf("_SYSTEM_CANDIDATE_ID")], A.uniqueId);
        assert.equal(sheet.writes().filter((w) => w.method === "append").length, 1);
    });

    test("the passport and NIC are data, never the key: the row is found by its submission ID even after the passport changes", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        await run();
        await pg.exec(`UPDATE "candidate" SET passport_id = 'N1000009' WHERE passport_id = 'N1000001'`);
        const [queued] = await outbox();
        assert.equal(queued.passportId, "N1000009", "the outbox follows a corrected passport ID (cascade)");
        await prisma.candidateFormSheetSync.update({ where: { submissionId: queued.submissionId }, data: { status: "PENDING", nextAttemptAt: now } });
        tick(1000);
        await run();
        assert.equal(dataRows(sheet).length, 1, "rewritten in place");
        assert.equal(cellsOf(sheet).passportNumber, "N1000009");
        assert.equal(cellsOf(sheet).submissionId, queued.submissionId);
    });
});

describe("no duplicate rows", () => {
    test("a submission already in the Sheet is rewritten in place, not appended again (a crash after the write)", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        await run();
        const [done] = await outbox();
        // The write reached the Sheet but was never recorded: the row is queued again.
        await prisma.candidateFormSheetSync.update({ where: { submissionId: done.submissionId }, data: { status: "PENDING", attempts: 0, nextAttemptAt: now } });
        tick(1000);
        const again = await run();
        assert.deepEqual([again.appended, again.updated], [0, 1]);
        assert.equal(dataRows(sheet).length, 1);
        assert.equal((await outbox())[0].lastResult, "UPDATED");
        assert.equal(sheet.writes().filter((w) => w.method === "append").length, 1, "only the first run appended");
    });

    test("a processed submission is not processed again; running twice is harmless", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        assert.equal((await run()).claimed, 1);
        assert.equal((await run()).claimed, 0);
        tick(60 * 60_000);
        assert.equal((await run()).claimed, 0);
        assert.equal(dataRows(sheet).length, 1);
    });

    test("two workers racing for the same row: one claims it, the Sheet gets one row", async () => {
        await submitAs(A);
        const sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header: [] });
        const one = setup({ sheet });
        const two = setup({ sheet });
        const results = await Promise.all([one.run(), two.run()]);
        assert.equal(results.reduce((n, r) => n + r.claimed, 0), 1);
        assert.equal(dataRows(sheet).length, 1);
    });

    test("a copy an operator made of a row is reported, and the first one is the one kept in step", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        await run();
        const copy = sheet.row(2);
        sheet.setCell(3, 0, copy[0]);
        copy.forEach((cell, i) => sheet.setCell(3, i, cell));
        const [done] = await outbox();
        await prisma.candidateFormSheetSync.update({ where: { submissionId: done.submissionId }, data: { status: "PENDING", nextAttemptAt: now } });
        tick(1000);
        await run();
        assert.ok(events.some((line) => line.includes("sheet_sync.form_duplicate_rows")));
        assert.equal(dataRows(sheet).length, 2, "nothing was removed or added");
    });
});

describe("a Sheet problem never fails the submission, and the row is retried", () => {
    test("Google unavailable: the submit already succeeded; the row stays queued with a backoff, a code and no data", async () => {
        const r = await submitAs(A);
        assert.equal(r.status, 200);
        const { sheet, run } = setup();
        sheet.failNext("*", googleError(503, { googleStatus: "UNAVAILABLE" }), 99);
        const summary = await run();
        assert.deepEqual([summary.claimed, summary.retried, summary.failed], [1, 1, 0]);
        const [row] = await outbox();
        assert.deepEqual([row.status, row.attempts, row.lastErrorClass, row.lastErrorCode], ["PENDING", 1, "GOOGLE_UNAVAILABLE", "503/UNAVAILABLE"]);
        assert.ok(row.nextAttemptAt > now, "the next attempt is later");
        assert.equal(await prisma.candidateFormResponse.count(), 1, "the submission itself is untouched");
        assert.equal((await prisma.candidateFormAccess.findUnique({ where: { passportId: A.passportId } })).status, "SUBMITTED");
        assert.ok(!JSON.stringify(row).includes("TOKEN") && !events.join("\n").match(/ya29|TOKEN|Fake Tab/), "no Google message text or token is kept or logged");
    });

    test("retry works: once Google is back the same row is written, once, and the error is cleared", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        sheet.failNext("append", googleError(503), 1);
        await run();
        assert.equal(dataRows(sheet).length, 0);
        assert.equal((await run()).claimed, 0, "not before its backoff has passed");
        tick(20_000);
        const retry = await run();
        assert.deepEqual([retry.claimed, retry.appended], [1, 1]);
        assert.equal(dataRows(sheet).length, 1);
        const [row] = await outbox();
        assert.deepEqual([row.status, row.attempts, row.lastErrorClass, row.lastResult], ["COMPLETED", 2, null, "APPENDED"]);
    });

    test("repeated failures back off further and never dead-letter a Google outage", async () => {
        await submitAs(A);
        const { sheet, run } = setup();
        sheet.failNext("*", googleError(429, { reason: "rateLimitExceeded" }), 99);
        const delays = [];
        for (let i = 0; i < 8; i++) {
            await run();
            const [row] = await outbox();
            delays.push(row.nextAttemptAt.getTime() - now.getTime());
            tick(row.nextAttemptAt.getTime() - now.getTime() + 1);
        }
        assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]), delays.join(","));
        assert.ok(delays.at(-1) <= 15 * 60_000 * 1.01, "bounded");
        assert.equal((await outbox())[0].status, "PENDING");
        sheet.clearFailures();
        assert.equal((await run()).appended, 1);
    });

    test("a missing tab or no access is a configuration problem: checked every 15 minutes, attempts not used up, fixed by fixing the Sheet", async () => {
        await submitAs(A);
        const sheet = createFakeGoogleSheet({ tabName: "Some Other Tab", header: [] });
        const { run } = setup({ sheet });
        const first = await run();
        assert.equal(first.retried, 1);
        let [row] = await outbox();
        assert.deepEqual([row.status, row.attempts, row.lastErrorClass], ["PENDING", 0, "BAD_REQUEST"]);
        assert.ok(row.nextAttemptAt.getTime() - now.getTime() >= 14 * 60_000);
        // The tab appears (someone creates it).
        const fixed = setup({ sheet: createFakeGoogleSheet({ tabName: FORM_TAB, header: [] }) });
        tick(16 * 60_000);
        await prisma.candidateFormSheetSync.update({ where: { submissionId: row.submissionId }, data: { nextAttemptAt: new Date(0) } });
        assert.equal((await fixed.run()).appended, 1);
        [row] = await outbox();
        assert.equal(row.status, "COMPLETED");
    });

    test("a tab whose header lacks our columns is SCHEMA_INVALID: nothing is written, nothing repaired, the row waits", async () => {
        await submitAs(A);
        const sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header: ["Something", "Else"] });
        const { run } = setup({ sheet });
        await run();
        const [row] = await outbox();
        assert.deepEqual([row.status, row.lastErrorClass], ["PENDING", "SCHEMA_INVALID"]);
        assert.match(row.lastErrorCode, /^MISSING:_SYSTEM_CANDIDATE_ID/);
        assert.deepEqual(sheet.writes(), []);
        assert.deepEqual(sheet.header(), ["Something", "Else"]);
    });

    test("an unexpected error in one submission does not hold up the others, and a submission that keeps failing is dead-lettered after 5 attempts", async () => {
        await submitAs(A);
        await submitAs(B, (() => { const b = ANSWERS(); b.basic.civilStatus = "SINGLE"; return b; })());
        const poisoned = (input) => {
            if (input.candidate.passportId === A.passportId) throw new Error("unexpected bug with secret text");
            return buildSubmissionCells(input);
        };
        const { sheet, run, store } = setup({ buildCells: poisoned });
        let summary = await run();
        assert.deepEqual([summary.appended, summary.retried], [1, 1]);
        assert.equal(dataRows(sheet).length, 1);
        for (let i = 0; i < 6; i++) {
            tick(30 * 60_000);
            await run();
        }
        const rows = await outbox();
        const poisonedRow = rows.find((r) => r.passportId === A.passportId);
        assert.deepEqual([poisonedRow.status, poisonedRow.attempts, poisonedRow.lastErrorClass], ["FAILED", 5, "INTERNAL"]);
        assert.equal(rows.find((r) => r.passportId === B.passportId).status, "COMPLETED");
        assert.ok(!events.join("\n").includes("secret text"));
        // An operator can put it back.
        assert.equal(await store.requeueFailed({ now }), 1);
        assert.equal((await outbox()).find((r) => r.passportId === A.passportId).status, "PENDING");
    });

    test("a submission that is no longer in the database is settled, not retried for ever", async () => {
        await submitAs(A);
        await pg.exec(`ALTER TABLE "candidate_form_response" DISABLE TRIGGER USER; DELETE FROM "candidate_form_response"; ALTER TABLE "candidate_form_response" ENABLE TRIGGER USER;`);
        const { sheet, run } = setup();
        const summary = await run();
        assert.deepEqual([summary.notInDatabase, summary.appended], [1, 0]);
        assert.equal((await outbox())[0].lastResult, "NOT_IN_DATABASE");
        assert.equal(dataRows(sheet).length, 0);
    });
});

describe("the tab's columns", () => {
    test("any column order and operator columns are fine; operator cells are never overwritten", async () => {
        await submitAs(A);
        const header = ["Operator note", ...[...FORM_SUBMISSION_HEADERS].reverse().slice(0, 20), "Another note", ...[...FORM_SUBMISSION_HEADERS].reverse().slice(20)];
        const sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header });
        const { run } = setup({ sheet });
        await run();
        const column = (name) => sheet.header().indexOf(name);
        assert.equal(sheet.row(2)[column("Passport Number")], A.passportId);
        assert.equal(sheet.row(2)[column("Operator note")], "");
        sheet.setCell(2, column("Operator note"), "called, will bring docs");
        sheet.setCell(2, column("Another note"), "second note");
        const [done] = await outbox();
        await prisma.candidateFormSheetSync.update({ where: { submissionId: done.submissionId }, data: { status: "PENDING", nextAttemptAt: now } });
        tick(1000);
        await run();
        assert.equal(sheet.row(2)[column("Operator note")], "called, will bring docs");
        assert.equal(sheet.row(2)[column("Another note")], "second note");
        assert.equal(sheet.row(2)[column("Candidate Name")], "ANUSHA DE SOYSA");
        assert.equal(dataRows(sheet).length, 1);
    });

    test("the layout check finds missing and repeated columns by their exact text", () => {
        assert.equal(readFormSubmissionLayout([]).empty, true);
        assert.equal(readFormSubmissionLayout([...FORM_SUBMISSION_HEADERS]).valid, true);
        const missing = readFormSubmissionLayout(FORM_SUBMISSION_HEADERS.filter((h) => h !== "_SUBMISSION_ID"));
        assert.deepEqual(missing.problems.map((p) => [p.problem, p.header]), [["MISSING", "_SUBMISSION_ID"]]);
        const repeated = readFormSubmissionLayout([...FORM_SUBMISSION_HEADERS, "Passport Number"]);
        assert.deepEqual(repeated.problems.map((p) => [p.problem, p.header, p.columns.length]), [["DUPLICATE", "Passport Number", 2]]);
        assert.equal(readFormSubmissionLayout(FORM_SUBMISSION_HEADERS.map((h) => h.toLowerCase())).valid, false, "exact text");
    });

    test("every answer of the Candidate Form has a column, and the required columns are there", () => {
        for (const [, , column] of ANSWER_FIELDS) {
            if (ANSWER_COLUMNS_NOT_IN_SHEET.has(column)) assert.ok(!FORM_SUBMISSION_COLUMNS.some((c) => c.source === column), `${column} is listed as not in the Sheet`);
            else assert.ok(FORM_SUBMISSION_COLUMNS.some((c) => c.source === column), `no column for ${column}`);
        }
        for (const column of ANSWER_COLUMNS_NOT_IN_SHEET) assert.ok(ANSWER_FIELDS.some((f) => f[2] === column), `${column} is an answer`);
        for (const header of ["_SYSTEM_CANDIDATE_ID", "_SUBMISSION_ID", "Passport Number", "Candidate Name", "Submitted At", "Submission Status"]) {
            assert.ok(FORM_SUBMISSION_HEADERS.includes(header), header);
        }
        assert.equal(FORM_SUBMISSION_COLUMNS[SYSTEM_CANDIDATE_ID_INDEX].header, "_SYSTEM_CANDIDATE_ID");
        assert.equal(FORM_SUBMISSION_COLUMNS[SUBMISSION_ID_INDEX].header, "_SUBMISSION_ID");
        assert.equal(new Set(FORM_SUBMISSION_HEADERS).size, FORM_SUBMISSION_COLUMN_COUNT);
        // The six system columns, WhatsApp Number, the verified NIC Number and every answer of the form.
        // (less the answers that are not columns yet: ANSWER_COLUMNS_NOT_IN_SHEET).
        assert.equal(FORM_SUBMISSION_COLUMN_COUNT, ANSWER_FIELDS.length - ANSWER_COLUMNS_NOT_IN_SHEET.size + 8);
    });

    test("nothing about the share link or the session is a column: no link ID, secret, token, hash or idempotency key", async () => {
        const forbidden = /link|secret|token|hash|idempotency|ip address|key/i;
        for (const header of FORM_SUBMISSION_HEADERS) assert.ok(!forbidden.test(header), header);
        const token = await session(A);
        const link = await prisma.candidateFormLink.findFirst();
        await submit(token, ANSWERS(), "key-sensitive-0000001");
        const { sheet, run } = setup();
        await run();
        const everything = [...sheet.header(), ...sheet.row(2), JSON.stringify(await outbox()), events.join("\n")].join("\n");
        for (const secret of [lastSecret, token, link.linkId, link.tokenHash, "key-sensitive-0000001", SECRET]) assert.ok(!everything.includes(secret), secret.slice(0, 12));
        assert.ok(!/Bearer|cf1~/.test(everything));
    });
});

describe("the gate, the destination and the mirror", () => {
    test("while SHEET_SYNC_ENABLED is off nothing is written and the rows simply wait (the worker does not even claim them)", async () => {
        await submitAs(A);
        const sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header: [] });
        const { sync } = setup({ sheet, enabled: false });
        const worker = workerWith({ sync, enabled: false });
        await worker.tick();
        assert.deepEqual(sheet.calls, []);
        assert.equal((await outbox())[0].status, "PENDING");
        // Even called directly, the adapter refuses to write.
        const direct = await sync.processDue({ owner: "t", destination: DESTINATION, withWriterLease: lease });
        assert.equal(direct.retried, 1);
        assert.deepEqual(sheet.writes(), []);
        assert.equal((await outbox())[0].attempts, 0, "a refused write does not use up an attempt");
    });

    test("the mirror's tab can never receive form data: a destination whose tab is the form tab is refused", async () => {
        await submitAs(A);
        const sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header: [] });
        const { run } = setup({ sheet, destination: { ...DESTINATION, tabName: FORM_TAB } });
        const summary = await run();
        assert.deepEqual([summary.claimed, summary.reason], [0, "TAB_CONFLICT"]);
        assert.deepEqual(sheet.calls, []);
        assert.equal((await outbox())[0].status, "PENDING");
    });

    test("the tab name comes from configuration, with the agreed default", () => {
        assert.deepEqual(readFormSubmissionSheetConfig({}), { tabName: "Candidate Form Submissions", problems: [] });
        assert.equal(readFormSubmissionSheetConfig({ SHEET_FORM_SUBMISSIONS_TAB_NAME: "Form Intake" }).tabName, "Form Intake");
        assert.equal(readFormSubmissionSheetConfig({ SHEET_FORM_SUBMISSIONS_TAB_NAME: "x".repeat(101) }).problems.length, 1);
    });

    test("the worker loop runs the form sync every tick; a failure in it never reaches the mirror's loop; the mirror's engine is never used", async () => {
        await submitAs(A);
        const sheet = createFakeGoogleSheet({ tabName: FORM_TAB, header: [] });
        const { sync } = setup({ sheet });
        let mirrorUsed = 0;
        const worker = workerWith({ sync, enabled: true, onMirror: () => { mirrorUsed += 1; } });
        const result = await worker.tick();
        assert.equal(result.runId, null);
        assert.equal(dataRows(sheet).length, 1);
        assert.equal(mirrorUsed, 0);
        assert.ok(sheet.calls.every((c) => [c.range, ...(c.ranges ?? [])].filter(Boolean).every((r) => r.startsWith(`'${FORM_TAB}'!`))));

        // A broken form sync: the tick still completes and still serves the mirror's runs.
        const broken = workerWith({ sync: { processDue: async () => { throw new Error("form sync exploded"); }, batchSize: 25 }, enabled: true });
        await assert.doesNotReject(broken.tick());
        assert.ok(events.some((line) => line.includes("sheet_sync.form_submissions_tick_failed")));
    });

    test("the operational mirror keeps its own schema: the approved 84 columns (row key B), none of them the form tab's", () => {
        assert.equal(SHEET_COLUMN_COUNT, 84);
        assert.equal(SHEET_HEADERS.length, 84);
        assert.equal(SHEET_HEADERS[1], "_SYSTEM_CANDIDATE_ID");
        assert.ok(!SHEET_HEADERS.includes("_SUBMISSION_ID"));
        assert.deepEqual(FORM_SUBMISSION_HEADERS.filter((h) => SHEET_HEADERS.includes(h)), ["_SYSTEM_CANDIDATE_ID"], "only the shared technical ID header, in a different tab");
        assert.notEqual(FORM_TAB, MIRROR_TAB);
    });
});

// A real worker over the real store (PGlite), with the form sync injected and a mirror engine that must stay unused.
function workerWith({ sync, enabled, onMirror = () => {} }) {
    const mirrorEngine = { reconcile: async () => { onMirror(); throw new Error("the mirror must not run"); } };
    return createSheetSyncWorker({
        store: createSheetSyncStore({ db: prisma }),
        forDestination: () => ({ engine: mirrorEngine, healthCheck: async () => { onMirror(); throw new Error("the mirror must not run"); } }),
        destinations: [DESTINATION],
        config: { enabled, gate: enabled ? "ENABLED" : "DISABLED", destinations: [DESTINATION], spreadsheetId: DESTINATION.spreadsheetId, tabName: DESTINATION.tabName },
        tuning: readSheetSyncTuning({}),
        formSubmissions: sync,
        log: capture,
        owner: "test-worker",
    });
}

function range_mentions(call, tab) {
    return JSON.stringify(call).includes(tab);
}
