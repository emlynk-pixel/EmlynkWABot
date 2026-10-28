// Candidate Form -> Admin / Manager Confirm -> canonical record -> Google Sheet operational mirror
// (SHEET-FINAL-*). Only CONFIRMED values become canonical (candidate / candidate_additional_details),
// and the mirror reads the canonical record only, never candidate_form_response. Confirming marks
// the candidate in the existing sheet_sync_queue (database triggers); the Sheet itself is written
// only by the existing RECONCILE runs (scheduled or Sync Now).
// Real PostgreSQL (PGlite, every migration), the real routers, reader, mapper, engine, store and
// worker; Google is an in-memory Sheet (test/helpers/fakeGoogleSheet.js). Synthetic data.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createPublicCandidateDetailsRouter, PUBLIC_CANDIDATE_DETAILS_PATH } from "../src/routes/publicCandidateDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { CONFIRMABLE_FIELDS, confirmFormField } from "../src/services/candidateFormFieldConfirmService.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { CANDIDATE_AGGREGATE_SELECT, mapCandidateToSheetRow } from "../src/services/candidateSheetMapper.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { createSheetSyncStore } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker } from "../src/services/sheetSyncWorker.js";
import { runSheetHealthCheck } from "../src/services/sheetHealthCheck.js";
import { readSheetSyncConfig, readSheetSyncTuning } from "../src/config/sheetSync.js";
import { SHEET_COLUMNS, SHEET_HEADERS, SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";
import { findRomanianCity } from "../src/utils/romaniaCities.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261102120000_candidate_form_finalized_details";
const TAB = "Emlynk Candidate Operational Mirror";
const MIRRORED_AT = new Date("2026-10-27T06:00:00.000Z");
const SECRET = "test-candidate-form-secret-0123456789-abcdefghijklmnop";
const ORIGIN = "https://candidate-form.example.test";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANN: user("u-ann", "ANALYST", 4) };
const A = {
    passportId: "N8100001", uniqueId: "8101", firstName: "Anusha", otherName: "De Soysa", nic: "810000001V", sex: "F", address: "1 old road", placeOfBirth: "Negombo",
    whatsappNumber: "+94781000001", contactNumber: "0771234567", dateOfBirth: new Date("2003-06-05"), jobExperience: "3 years", job: "PLUMBER",
    passportIssueDate: new Date("2020-01-15"), passportExpiryDate: new Date("2030-01-14"),
};
// The Candidate Form columns of the mirror (everything after the original 41).
const FORM_FIELDS = SHEET_COLUMNS.slice(41).map((c) => c.field);

// A married candidate with every answer filled (synthetic).
const ANSWERS = () => ({
    basic: {
        fullName: "anusha de soysa", surname: "de soysa", otherNames: "anusha", sex: "FEMALE", civilStatus: "MARRIED", birthDate: "2003-06-05", birthPlace: "negombo",
        bloodGroup: "AB-", height: "5 ft 9 in", weight: "70500 g", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "english, romanian",
    },
    contact: { address: "12 galle road", city: "negombo", district: "gampaha", dsDivision: "negombo", gnDivision: "kurana", alternativePhone: "0771234567", email: "new@example.com", cityInRomania: "cluj napoca" },
    passport: { issueDate: "2020-01-15", expiryDate: "2030-01-14" },
    qualifications: { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "3 years", otherSkills1: "forklift", otherSkills2: "basic welding", englishKnowledge: "GOOD" },
    measurements: { shirtSize: "M", waistSize: "32", shoeSize: "eu 42" },
    family: {
        father: { name: "sunil", surname: "de soysa", passportNumber: "n1234567", birthDate: "1960-03-02" },
        mother: { name: "kumari", surname: "de soysa", passportNumber: "N7654321", birthDate: "1965-02-03" },
        spouse: { name: "nimal", surname: "perera", passportNumber: "N5555555", birthDate: "1988-04-04" },
        child1: "kasun", child2: "N/A", child3: "", fatherAlive: "NO", motherAlive: "YES",
    },
    guardian: { name: "kamal perera", relationship: "uncle", nic: "901234567v", birthDate: "1960-01-01", phone: "+94 77 123 4567", address: "45 lake road" },
});
const withAnswer = (answers, at, value) => {
    const parts = at.split(".");
    let target = answers;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
    return answers;
};

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "candidate_form_field_review"; DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_draft";
        DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_prefill_snapshot"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_stages"; DELETE FROM "documents"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
        UPDATE "sheet_sync_state" SET "integration_state" = 'UNKNOWN', "writer_lease_owner" = NULL, "writer_lease_expires_at" = NULL,
            "last_error_class" = NULL, "last_error_code" = NULL, "last_sync_success_at" = NULL;
    `);
    await prisma.candidate.create({ data: A });
    await prisma.candidateAllocation.create({ data: { passportId: A.passportId, analystId: USERS.ANN.adminId } });
});

// ---------------------------------------------------------------- helpers

function app(who) {
    const server = express();
    server.use(PUBLIC_CANDIDATE_DETAILS_PATH, createPublicCandidateDetailsRouter({ db: prisma, tokenSecret: SECRET, allowedOrigin: ORIGIN, verifyIpLimiter: noRateLimit, verifyPassportLimiter: noRateLimit, log: { warn() {}, error() {}, info() {}, log() {} } }));
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit, candidateFormOrigin: ORIGIN }));
    server.use(errorHandler);
    return server;
}
async function call(who, method, at, { body, token } = {}) {
    const listener = await new Promise((resolve) => { const s = app(who).listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const headers = { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const res = await fetch(`http://127.0.0.1:${listener.address().port}${at}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}
const pub = (at, options) => call(USERS.ADMIN, "POST", `${PUBLIC_CANDIDATE_DETAILS_PATH}${at}`, options);
async function submitForm(answers = ANSWERS()) {
    const link = (await call(USERS.ADMIN, "POST", `/api/admin/candidates/${A.passportId}/form-share`)).body.url.split("#k=")[1];
    const token = (await pub("/verify", { body: { linkSecret: link, passportNumber: A.passportId, nic: A.nic } })).body.token;
    assert.equal((await pub("/form", { token, body: {} })).status, 200);
    const r = await pub("/submit", { token, body: { answers, idempotencyKey: "key-final-0000000001" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
}
const pendingList = async () => (await call(USERS.ADMIN, "GET", `/api/admin/candidates/${A.passportId}/form-submission`)).body.pending;
const pendingFor = async (field) => (await pendingList()).find((p) => p.field === field);
async function review(who, action, field) {
    const p = await pendingFor(field);
    assert.ok(p, `${field} is pending`);
    return call(who, "POST", `/api/admin/candidates/${A.passportId}/form-submission/${action}-field`, { body: { field, expectedCurrentValue: p.current, expectedSubmittedValue: p.submitted } });
}
const confirmField = (field, who = USERS.MANAGER) => review(who, "confirm", field);
const rejectField = (field, who = USERS.ADMIN) => review(who, "reject", field);
// Confirms every pending field, one at a time (each Confirm can resolve others: Married records the spouse name).
async function confirmAll() {
    for (let pending = await pendingList(); pending.length; pending = await pendingList()) {
        const r = await confirmField(pending[0].field);
        assert.equal(r.status, 200, `${pending[0].field}: ${JSON.stringify(r.body)}`);
    }
}

const details = () => prisma.candidateAdditionalDetails.findUnique({ where: { passportId: A.passportId } });
const pendingQueue = () => prisma.sheetSyncQueue.findMany({ where: { uniqueId: A.uniqueId, status: "PENDING" } });
// The mirror row exactly as a reconcile maps it (the real reader on the real database).
async function mirrorRow() {
    return mapCandidateToSheetRow(await createCandidateAggregateReader({ db: prisma }).findByUniqueId(A.uniqueId), { mirroredAt: MIRRORED_AT });
}
const cellOf = (row, field) => row[SHEET_COLUMNS.find((c) => c.field === field).index];
const formCells = (row) => Object.fromEntries(FORM_FIELDS.map((field) => [field, cellOf(row, field)]));

// A worker on a fake Sheet with the full header (or `header`), as in sheetSyncWorker.test.js.
function mirrorSetup({ header } = {}) {
    const sheet = createFakeGoogleSheet({ tabName: TAB, ...(header ? { header } : {}) });
    const env = { SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: "fake-spreadsheet-id", SHEET_TAB_NAME: TAB };
    const config = readSheetSyncConfig(env);
    const adapter = createGoogleSheetsAdapter({ config, sheetsClient: sheet.client });
    const engine = createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: adapter, clock: () => new Date() });
    const store = createSheetSyncStore({ db: prisma });
    const log = { log() {}, warn() {}, error() {} };
    const worker = createSheetSyncWorker({
        store, engine, config, tuning: readSheetSyncTuning(env), clock: () => new Date(), log, random: () => 0.5, targetHint: "…id / tab",
        healthCheck: () => runSheetHealthCheck({ env, sheetsClient: sheet.client, clock: () => new Date() }),
    });
    return { sheet, store, worker };
}
// One durable RECONCILE run (SCHEDULER: the 06:00 / 12:00 / 18:00 schedule; ADMIN: Sync Now) and the tick that executes it.
async function reconcile({ store, worker }, triggerSource = "SCHEDULER") {
    const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource });
    await worker.tick();
    return store.getRun(run.runId);
}
const sheetRowOf = (sheet) => {
    const rows = sheet.dataRows().filter((r) => r[SYSTEM_CANDIDATE_ID_INDEX] === A.uniqueId);
    assert.equal(rows.length, 1);
    return Object.fromEntries(SHEET_COLUMNS.map((c) => [c.field, rows[0][c.index]]));
};

// ---------------------------------------------------------------- the flow

describe("submitted -> confirmed -> canonical -> mirror", () => {
    test("SHEET-FINAL-001 a new submission changes nothing in the mirror before Confirm (and queues nothing)", async () => {
        const before = await mirrorRow();
        await prisma.sheetSyncQueue.deleteMany();
        await submitForm();
        assert.deepEqual(await mirrorRow(), before, "the mapped row is identical");
        assert.ok(Object.values(formCells(await mirrorRow())).every((cell) => cell === ""), "every Candidate Form column is blank");
        assert.equal(await details(), null, "no canonical row was created by the submission");
        assert.deepEqual(await pendingQueue(), [], "a submission does not mark the candidate for the mirror");
    });

    test("SHEET-FINAL-002 / 003 Confirm writes the canonical value and marks the candidate in the existing sheet_sync_queue", async () => {
        await submitForm();
        await prisma.sheetSyncQueue.deleteMany();
        const r = await confirmField("basic.bloodGroup");
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal((await details()).bloodGroup, "AB-");
        assert.equal((await pendingQueue()).length, 1, "one PENDING row for the candidate (the candidate_additional_details trigger)");
        // A core candidate field (candidate table): its own, existing trigger.
        await prisma.sheetSyncQueue.deleteMany();
        assert.equal((await confirmField("qualifications.jobCategory")).status, 200);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).job, "PLUMBER, WELDER TIG", "added to the list; nothing on it lost");
        assert.equal((await pendingQueue()).length, 1);
        // The audit entry names the column, old and new value.
        const audits = await prisma.auditLog.findMany({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED" }, orderBy: { createdDate: "asc" } });
        assert.deepEqual(audits.map((a) => JSON.parse(a.newValue)), [{ bloodGroup: "AB-" }, { job: "WELDER TIG" }]);
    });

    test("SHEET-FINAL-004 the existing reconcile writes the confirmed value to the mirror", async () => {
        const mirror = mirrorSetup();
        await submitForm();
        await reconcile(mirror);
        assert.equal(sheetRowOf(mirror.sheet).bloodGroup, "", "not confirmed yet: blank");
        assert.equal((await confirmField("basic.bloodGroup")).status, 200);
        assert.equal(cellOf(await mirrorRow(), "bloodGroup"), "AB-", "the mapper output");
        assert.equal(sheetRowOf(mirror.sheet).bloodGroup, "", "nothing is written in real time");
        const run = await reconcile(mirror);
        assert.equal(run.status, "SUCCEEDED");
        assert.equal(sheetRowOf(mirror.sheet).bloodGroup, "AB-");
        assert.equal(sheetRowOf(mirror.sheet).systemCandidateId, A.uniqueId, "same row key (AO)");
    });

    test("SHEET-FINAL-005 / 006 a rejected (revoked) value never reaches the record or the mirror, and cannot be confirmed afterwards", async () => {
        const mirror = mirrorSetup();
        await submitForm();
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, bloodGroup: "O+" } });
        assert.equal((await rejectField("basic.bloodGroup")).status, 200);
        assert.equal((await details()).bloodGroup, "O+", "the record keeps its value");
        assert.equal((await rejectField("guardian.name")).status, 200);
        assert.equal((await details()).guardianName, null);
        await reconcile(mirror);
        assert.deepEqual([sheetRowOf(mirror.sheet).bloodGroup, sheetRowOf(mirror.sheet).guardianName], ["O+", ""]);
        const again = await call(USERS.ADMIN, "POST", `/api/admin/candidates/${A.passportId}/form-submission/confirm-field`, { body: { field: "guardian.name", expectedCurrentValue: null, expectedSubmittedValue: "KAMAL PERERA" } });
        assert.deepEqual([again.status, again.body.code], [409, "FORM_FIELD_REVIEW_STALE"]);
        assert.equal((await details()).guardianName, null);
    });

    test("SHEET-FINAL-007 candidate_additional_details insert, update and delete each mark the candidate (the existing capture function)", async () => {
        const [trigger] = (await pg.query(`
            SELECT t.tgname, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid
            WHERE c.relname = 'candidate_additional_details' AND NOT t.tgisinternal AND t.tgname LIKE '%sheet_sync%'`)).rows;
        assert.deepEqual(trigger, { tgname: "candidate_additional_details_sheet_sync_capture", proname: "sheet_sync_capture_candidate_child" });
        await prisma.sheetSyncQueue.deleteMany();
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, shoeSize: "9" } });
        assert.equal((await pendingQueue()).length, 1);
        await prisma.sheetSyncQueue.deleteMany();
        await prisma.candidateAdditionalDetails.update({ where: { passportId: A.passportId }, data: { email: "x@example.com" } });
        assert.equal((await pendingQueue()).length, 1);
        // Coalesced: more changes keep ONE pending row.
        await prisma.candidateAdditionalDetails.update({ where: { passportId: A.passportId }, data: { city: "KANDY" } });
        assert.equal((await pendingQueue()).length, 1);
        await prisma.sheetSyncQueue.deleteMany();
        await prisma.candidateAdditionalDetails.delete({ where: { passportId: A.passportId } });
        assert.equal((await pendingQueue()).length, 1);
        assert.equal((await pendingQueue())[0].candidateDeleted, false, "the candidate itself still exists");
        // Deleting the candidate cascades: captured once, on "candidate", as deleted.
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, shoeSize: "9" } });
        await prisma.sheetSyncQueue.deleteMany();
        await pg.exec(`DELETE FROM "candidate_allocation"; DELETE FROM "candidate" WHERE "passport_id" = '${A.passportId}'`);
        assert.deepEqual((await pendingQueue()).map((r) => r.candidateDeleted), [true]);
    });

    test("SHEET-FINAL-008 every Candidate Form answer, once confirmed, appears in its mirror column", async () => {
        const mirror = mirrorSetup();
        await submitForm();
        await confirmAll();
        const expected = {
            nameAsInPassport: "ANUSHA DE SOYSA", civilStatus: "MARRIED", bloodGroup: "AB-", height: `5'9"`, weightKg: "70.5", hasDrivingLicence: "YES",
            canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "ENGLISH, ROMANIAN", email: "new@example.com", city: "NEGOMBO", district: "GAMPAHA",
            dsDivision: "NEGOMBO", gnDivision: "KURANA", cityInRomania: "Cluj-Napoca", distanceToBucharestKm: String(findRomanianCity("Cluj-Napoca").distanceKm),
            otherJobCategory: "", otherSkills1: "FORKLIFT", otherSkills2: "BASIC WELDING", englishKnowledge: "GOOD", shirtSize: "M", waistSize: "32", shoeSize: "EU 42",
            fatherName: "SUNIL DE SOYSA", fatherPassportNumber: "N1234567", fatherBirthday: "1960-03-02", fatherAlive: "NO",
            motherName: "KUMARI DE SOYSA", motherPassportNumber: "N7654321", motherBirthday: "1965-02-03", motherAlive: "YES",
            spouseName: "NIMAL PERERA", spousePassportNumber: "N5555555", spouseBirthday: "1988-04-04",
            child1Name: "KASUN", child2Name: "", child3Name: "",
            guardianName: "KAMAL PERERA", guardianRelationship: "UNCLE", guardianNic: "901234567V", guardianBirthday: "1960-01-01", guardianPhone: "+94771234567", guardianAddress: "45 LAKE ROAD",
        };
        assert.deepEqual(formCells(await mirrorRow()), expected, "mapper output");
        await reconcile(mirror);
        const row = sheetRowOf(mirror.sheet);
        assert.deepEqual(Object.fromEntries(FORM_FIELDS.map((f) => [f, row[f]])), expected, "the Sheet after the reconcile");
        // The confirmed core fields reach their existing columns too.
        assert.deepEqual([row.address, row.job], ["12 GALLE ROAD", "PLUMBER, WELDER TIG"]);
        // Nothing is left pending; "N/A" answers (2nd child) were never offered.
        assert.deepEqual(await pendingList(), []);
    });

    test("SHEET-FINAL-009 a historical candidate (no details row, or one with only the older columns) syncs safely with blank new cells", async () => {
        const mirror = mirrorSetup();
        assert.ok(Object.values(formCells(await mirrorRow())).every((cell) => cell === ""));
        assert.equal((await reconcile(mirror)).status, "SUCCEEDED");
        assert.ok(FORM_FIELDS.every((f) => sheetRowOf(mirror.sheet)[f] === ""));
        // Older details only: those columns fill, the new ones stay blank.
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, tshirtSize: "L", fatherAlive: true, maritalStatus: "SINGLE" } });
        assert.equal((await reconcile(mirror)).status, "SUCCEEDED");
        const row = sheetRowOf(mirror.sheet);
        assert.deepEqual([row.shirtSize, row.fatherAlive, row.civilStatus, row.bloodGroup, row.weightKg, row.guardianBirthday], ["L", "YES", "SINGLE", "", "", ""]);
        assert.equal(row.passportNumber, A.passportId, "the original columns are unaffected");
    });

    test("SHEET-FINAL-011 a live Sheet without the new headers stops the reconcile with the existing SCHEMA_INVALID, writing nothing", async () => {
        const mirror = mirrorSetup({ header: SHEET_HEADERS.slice(0, 41) });
        await submitForm();
        await confirmField("basic.bloodGroup");
        const run = await reconcile(mirror);
        assert.deepEqual([run.status, run.errorClass], ["FAILED", "SCHEMA_INVALID"]);
        assert.deepEqual(mirror.sheet.writes(), []);
        // Once the headers are added, the next run proceeds.
        mirror.sheet.setHeader([...SHEET_HEADERS]);
        assert.equal((await reconcile(mirror)).status, "SUCCEEDED");
        assert.equal(sheetRowOf(mirror.sheet).bloodGroup, "AB-");
    });

    test("SHEET-FINAL-012 Sync Now (ADMIN) and the scheduled run write the same confirmed canonical values", async () => {
        await submitForm();
        await confirmAll();
        const scheduled = mirrorSetup();
        const manual = mirrorSetup();
        assert.equal((await reconcile(scheduled, "SCHEDULER")).status, "SUCCEEDED");
        assert.equal((await reconcile(manual, "ADMIN")).status, "SUCCEEDED");
        const strip = ({ lastMirroredAt, ...rest }) => rest;
        assert.deepEqual(strip(sheetRowOf(manual.sheet)), strip(sheetRowOf(scheduled.sheet)));
        assert.equal(sheetRowOf(manual.sheet).bloodGroup, "AB-");
    });
});

// ---------------------------------------------------------------- confirmation rules

describe("Confirm / Reject rules for the newly confirmable fields", () => {
    test("only ADMIN and MANAGER can confirm or reject; other roles change nothing", async () => {
        await submitForm();
        for (const who of [USERS.DESK, USERS.ANN]) {
            for (const action of ["confirm", "reject"]) {
                const r = await review(who, action, "basic.bloodGroup");
                assert.equal(r.status, 403, `${who.role} ${action}`);
            }
        }
        assert.equal(await details(), null);
        assert.equal(await prisma.candidateFormFieldReview.count(), 0);
        assert.equal((await confirmField("basic.bloodGroup", USERS.ADMIN)).status, 200);
    });

    test("the Additional Details rules hold: spouse only when Married, children in order and not when Single", async () => {
        await submitForm();
        // The record has no civil status yet: the spouse can't be confirmed first.
        for (const field of ["family.spouse.fullName", "family.spouse.birthDate", "family.spouse.passportNumber"]) {
            const r = await confirmField(field);
            assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_PREREQUISITE"], field);
        }
        assert.equal(await details(), null, "nothing written");
        // Confirming Married also records the submitted spouse name (the record requires one when married).
        assert.equal((await confirmField("basic.civilStatus")).status, 200);
        assert.deepEqual([(await details()).maritalStatus, (await details()).wifeFullName], ["MARRIED", "NIMAL PERERA"]);
        assert.equal(await pendingFor("family.spouse.fullName"), undefined, "the spouse name is no longer pending");
        assert.equal((await confirmField("family.spouse.birthDate")).status, 200);
        const [audit] = await prisma.auditLog.findMany({ where: { action: "CANDIDATE_FORM_FIELD_CONFIRMED", reason: { contains: "civilStatus" } } });
        assert.deepEqual(JSON.parse(audit.newValue), { maritalStatus: "MARRIED", wifeFullName: "NIMAL PERERA" });
        // Admin can still save the Additional Details form afterwards (the record is valid for it).
        const view = (await call(USERS.ADMIN, "GET", `/api/admin/candidates/${A.passportId}/additional-details`)).body;
        const saved = await call(USERS.ADMIN, "PUT", `/api/admin/candidates/${A.passportId}/additional-details`, { body: { ...view.details, otherJobSkills: "Forklift", expectedUpdatedDate: view.updatedDate } });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal((await details()).bloodGroup, null, "a value never confirmed stays empty");
    });

    test("Single with children on record is refused; a later child needs the earlier one", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, child1Name: "OLD CHILD" } });
        await submitForm(withAnswer(withAnswer(withAnswer(withAnswer(ANSWERS(), "basic.civilStatus", "SINGLE"), "family.child1", "kasun"), "family.child2", "ruwan"), "family.child3", "N/A"));
        const single = await confirmField("basic.civilStatus");
        assert.deepEqual([single.status, single.body.code], [409, "FORM_FIELD_PREREQUISITE"]);
        assert.match(single.body.message, /children/);
        assert.equal((await details()).maritalStatus, null);
        await pg.exec(`UPDATE "candidate_additional_details" SET "child_1_name" = NULL`);
        const second = await confirmField("family.child2");
        assert.deepEqual([second.status, second.body.code], [409, "FORM_FIELD_PREREQUISITE"]);
        assert.equal((await confirmField("family.child1")).status, 200);
        assert.equal((await confirmField("family.child2")).status, 200);
        assert.deepEqual([(await details()).child1Name, (await details()).child2Name], ["KASUN", "RUWAN"]);
    });

    test("job category: an OTHER answer is not a job type (its text is Other Job Category); No Preferred Type replaces the list", async () => {
        await submitForm(withAnswer(withAnswer(ANSWERS(), "qualifications.jobCategory", "OTHER"), "qualifications.jobCategoryOther", "crane operator"));
        assert.equal(await pendingFor("qualifications.jobCategory"), undefined);
        assert.equal((await confirmField("qualifications.jobCategoryOther")).status, 200);
        assert.equal((await details()).otherJobCategory, "CRANE OPERATOR");
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).job, "PLUMBER", "the job types are untouched");

        await pg.exec(`DELETE FROM "candidate_form_field_review"; DELETE FROM "candidate_form_sheet_sync"; DELETE FROM "candidate_form_response"; DELETE FROM "candidate_form_access"; DELETE FROM "candidate_form_link";`);
        await submitForm(withAnswer(ANSWERS(), "qualifications.jobCategory", "NO_PREFERENCE"));
        assert.deepEqual(await pendingFor("qualifications.jobCategory"), { field: "qualifications.jobCategory", current: "PLUMBER", submitted: "NO_PREFERENCE" });
        assert.equal((await confirmField("qualifications.jobCategory")).status, 200);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).job, "NO_PREFERENCE");
        assert.equal(cellOf(await mirrorRow(), "job"), "No Preferred Type");
    });

    test("job category: a type already on the list is not pending; a full list (10) refuses a Confirm", async () => {
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { job: "PLUMBER, welder tig" } });
        await submitForm();
        assert.equal(await pendingFor("qualifications.jobCategory"), undefined, "already on the list (any letter case)");
        const ten = Array.from({ length: 10 }, (_, i) => `TYPE ${i}`).join(", ");
        await prisma.candidate.update({ where: { passportId: A.passportId }, data: { job: ten } });
        const r = await confirmField("qualifications.jobCategory");
        assert.deepEqual([r.status, r.body.code], [409, "FORM_FIELD_PREREQUISITE"]);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: A.passportId } })).job, ten);
    });

    test("a value already in the record is not pending (case-insensitive; phone numbers by digits; weight by number)", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, bloodGroup: "AB-", email: "NEW@example.com", guardianPhone: "0771234567", weightKg: "70.50" } });
        await submitForm(withAnswer(ANSWERS(), "guardian.phone", "+94771234567"));
        for (const field of ["basic.bloodGroup", "contact.email", "guardian.phone", "basic.weight"]) assert.equal(await pendingFor(field), undefined, field);
    });

    test("every allowlisted field has a canonical target in candidate or candidate_additional_details, never in candidate_form_response", () => {
        for (const [field, mapping] of Object.entries(CONFIRMABLE_FIELDS)) {
            assert.ok(["candidate", "details"].includes(mapping.table), field);
            assert.equal(typeof mapping.column, "string", field);
        }
        // The form's 56 answers, a parent's / the spouse's name + surname counted once each (3 x 2 -> 3).
        assert.equal(Object.keys(CONFIRMABLE_FIELDS).length, 53);
    });
});

// ---------------------------------------------------------------- the mirror reads canonical data only

describe("no raw Candidate Form dependency in the mirror", () => {
    test("the reader selects no Candidate Form table, and neither the reader nor the mapper mentions one", () => {
        assert.deepEqual(Object.keys(CANDIDATE_AGGREGATE_SELECT).filter((key) => /^form/.test(key)), []);
        assert.ok(CANDIDATE_AGGREGATE_SELECT.additionalDetails);
        for (const file of ["candidateAggregateReader.js", "candidateSheetMapper.js"]) {
            const source = fs.readFileSync(path.join(HERE, "..", "src", "services", file), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
            assert.doesNotMatch(source, /formResponse|candidate_form_response|candidateFormResponse|formSnapshot|formDraft/, file);
        }
    });

    test("the mirror row is the same with or without a submission: only Confirm changes it", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: A.passportId, bloodGroup: "O+" } });
        const before = await mirrorRow();
        await submitForm();
        assert.deepEqual(await mirrorRow(), before);
        assert.equal(cellOf(before, "bloodGroup"), "O+");
    });
});

// ---------------------------------------------------------------- migration rehearsal

describe(`migration ${MIGRATION}`, () => {
    test("additive only: nullable columns, CHECKs, one capture trigger; no DROP, RENAME, UPDATE or DELETE", () => {
        assert.ok(migrationNames().includes(MIGRATION));
        const sql = fs.readFileSync(path.join(HERE, "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8").replace(/--.*$/gm, "");
        // (INSERT / UPDATE / DELETE appear only as the trigger's events.)
        const statements = sql.replace(/AFTER INSERT OR UPDATE OR DELETE ON/g, "");
        assert.doesNotMatch(statements, /\b(DROP|RENAME|TYPE|UPDATE|DELETE|TRUNCATE|INSERT)\b|NOT NULL|ALTER COLUMN|CREATE TABLE|CREATE FUNCTION|CREATE OR REPLACE/i);
        assert.deepEqual(sql.match(/ADD COLUMN/g).length, 25);
        assert.deepEqual(sql.match(/CREATE TRIGGER "\w+"/g), ['CREATE TRIGGER "candidate_additional_details_sheet_sync_capture"']);
        assert.match(sql, /EXECUTE FUNCTION "sheet_sync_capture_candidate_child"\(\)/);
    });

    test("rehearsal: historical candidates, submissions and details survive; NULLs are safe; confirmed values persist and map", async () => {
        const names = migrationNames();
        const previous = names[names.indexOf(MIGRATION) - 1];
        const old = await createTestDatabase({ upTo: previous });
        try {
            const { pg: oldPg, prisma: oldPrisma } = old;
            await oldPrisma.user.create({ data: USERS.ADMIN });
            // A database as it is before this migration: candidates, an older submission, an existing details row, a queued sync.
            await oldPg.exec(`
                INSERT INTO "candidate" ("passport_id", "unique_id", "nic", "first_name", "other_name", "updated_date") VALUES
                    ('N8200001', '8201', '820000001V', 'Old', 'Candidate', now()), ('N8200002', '8202', '820000002V', 'No', 'Details', now());
                INSERT INTO "candidate_additional_details" ("passport_id", "tshirt_size", "father_alive", "marital_status", "other_job_skills", "updated_date")
                    VALUES ('N8200001', 'L', true, 'MARRIED', 'Forklift', now());
                INSERT INTO "candidate_form_response" ("passport_id", "full_name", "surname", "other_names", "blood_group", "weight_kg", "guardian_name", "guardian_nic", "city_in_romania", "distance_to_bucharest_km")
                    VALUES ('N8200001', 'OLD CANDIDATE', 'CANDIDATE', 'OLD', 'B+', 82.25, 'KAMAL', '901234567V', 'Iași', ${findRomanianCity("Iasi").distanceKm});
            `);
            const before = {
                candidates: (await oldPg.query(`SELECT * FROM "candidate" ORDER BY "passport_id"`)).rows,
                responses: (await oldPg.query(`SELECT * FROM "candidate_form_response"`)).rows,
                details: (await oldPg.query(`SELECT * FROM "candidate_additional_details"`)).rows,
                queue: (await oldPg.query(`SELECT "unique_id", "status" FROM "sheet_sync_queue" ORDER BY "unique_id"`)).rows,
            };

            await oldPg.exec(fs.readFileSync(path.join(HERE, "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8"));

            // Nothing lost or rewritten.
            assert.deepEqual((await oldPg.query(`SELECT * FROM "candidate" ORDER BY "passport_id"`)).rows, before.candidates, "no candidate lost or changed");
            assert.deepEqual((await oldPg.query(`SELECT * FROM "candidate_form_response"`)).rows, before.responses, "no Candidate Form response lost or changed");
            const detailsAfter = (await oldPg.query(`SELECT * FROM "candidate_additional_details"`)).rows;
            assert.equal(detailsAfter.length, 1);
            for (const [column, value] of Object.entries(before.details[0])) assert.deepEqual(detailsAfter[0][column], value, column);
            const added = Object.keys(detailsAfter[0]).filter((column) => !(column in before.details[0]));
            assert.equal(added.length, 25);
            assert.ok(added.every((column) => detailsAfter[0][column] === null), "the new columns are NULL on existing rows");
            assert.deepEqual((await oldPg.query(`SELECT "unique_id", "status" FROM "sheet_sync_queue" ORDER BY "unique_id"`)).rows, before.queue, "the migration queues nothing itself");

            // Historical rows map safely (blank new cells).
            const reader = createCandidateAggregateReader({ db: oldPrisma });
            for (const uniqueId of ["8201", "8202"]) {
                const row = mapCandidateToSheetRow(await reader.findByUniqueId(uniqueId), { mirroredAt: MIRRORED_AT });
                assert.deepEqual([cellOf(row, "bloodGroup"), cellOf(row, "guardianName"), cellOf(row, "distanceToBucharestKm")], ["", "", ""], uniqueId);
            }
            assert.deepEqual([cellOf(mapCandidateToSheetRow(await reader.findByUniqueId("8201"), { mirroredAt: MIRRORED_AT }), "shirtSize")], ["L"]);

            // Confirm new fields on the migrated database (the service, as the route calls it).
            const actor = { adminId: "u-admin" };
            await oldPg.exec(`DELETE FROM "sheet_sync_queue"`);
            for (const [field, current, submitted] of [["basic.bloodGroup", null, "B+"], ["basic.weight", null, "82.25"], ["guardian.nic", null, "901234567V"], ["contact.cityInRomania", null, "Iași"]]) {
                await confirmFormField({ db: oldPrisma, actor, passportId: "N8200001", field, expectedCurrentValue: current, expectedSubmittedValue: submitted });
            }
            const confirmed = await oldPrisma.candidateAdditionalDetails.findUnique({ where: { passportId: "N8200001" } });
            assert.deepEqual([confirmed.bloodGroup, Number(confirmed.weightKg), confirmed.guardianNic, confirmed.cityInRomania, confirmed.tshirtSize], ["B+", 82.25, "901234567V", "Iași", "L"]);
            assert.equal((await oldPrisma.sheetSyncQueue.findMany({ where: { uniqueId: "8201", status: "PENDING" } })).length, 1, "the new trigger marks the candidate");
            const row = mapCandidateToSheetRow(await reader.findByUniqueId("8201"), { mirroredAt: MIRRORED_AT });
            assert.deepEqual(
                [cellOf(row, "bloodGroup"), cellOf(row, "weightKg"), cellOf(row, "guardianNic"), cellOf(row, "cityInRomania"), cellOf(row, "distanceToBucharestKm"), cellOf(row, "civilStatus"), cellOf(row, "otherSkills1")],
                ["B+", "82.25", "901234567V", "Iași", String(findRomanianCity("Iasi").distanceKm), "MARRIED", "Forklift"],
            );

            // The constraints hold.
            await assert.rejects(oldPg.query(`UPDATE "candidate_additional_details" SET "blood_group" = 'Z+'`), /blood_group_check/);
            await assert.rejects(oldPg.query(`UPDATE "candidate_additional_details" SET "weight_kg" = 5`), /weight_kg_check/);
            await assert.rejects(oldPg.query(`UPDATE "candidate_additional_details" SET "english_knowledge" = 'PERFECT'`), /english_knowledge_check/);
        } finally {
            await old.close();
        }
    });
});
