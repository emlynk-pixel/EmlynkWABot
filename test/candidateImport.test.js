// Bulk candidate import (Settings > Google Sheet Sync > Update Sheet) end to end on a real
// PostgreSQL (PGlite, every migration incl. the sheet-sync and verification triggers): preview,
// classification, chunked commit, merge, audit, the existing reconciliation, and the API's roles.
// SYNTHETIC candidates only. Google is an in-memory Sheet (test/helpers/fakeGoogleSheet.js).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { authIdFor, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import {
    IMPORT_CHUNK_SIZE, allocateUniqueIds, chunkRows, commitChunk, finishImport, previewImport,
} from "../src/services/candidateImportService.js";
import { createCandidate, parseCandidateBody, updateCandidateDetails } from "../src/services/candidateService.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { createSheetSyncStore } from "../src/services/sheetSyncStore.js";
import { createSheetSyncWorker } from "../src/services/sheetSyncWorker.js";
import { readSheetSyncConfig, readSheetSyncTuning } from "../src/config/sheetSync.js";
import { SHEET_COLUMNS, SHEET_HEADERS, SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";

const ROLES = ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"];
const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN" };
const MANAGER = { adminId: "admin-MANAGER", role: "MANAGER" };
const HEADERS = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "FULL NAME", "NIC NUMBER", "WHATSAPP NUMBER", "CONTACT NUMBER", "Job Role", "BIRTH DATE",
    "PASSPORT EXPIRE DATE", "ADDRESS", "Marital Status", "SHIRT SIZE", "LOAN APPLY AMOUNT", "ACTIVE STATUS", "UNIQUE NUMBER", "FATHER NAME"];

let database;
let prisma;
let pg;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const role of ROLES) {
        await prisma.user.create({ data: { adminId: `admin-${role}`, authUserId: authIdFor(`admin-${role}`), name: role, email: `${role.toLowerCase()}@example.invalid`, role, status: "ACTIVE" } });
    }
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
        DELETE FROM "candidate_import"; DELETE FROM "candidate_verification"; DELETE FROM "candidate_additional_details";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
    // audit_logs is append-only (a trigger refuses DELETE): each test reads only its own entries.
});

// ---------------------------------------------------------------- synthetic legacy rows

const pad = (n, width) => String(n).padStart(width, "0");
// Synthetic identifiers, unique per i: N9xxxxxx passports, 8xxxxxxxxV NICs, 077xxxxxxx phones.
const passportOf = (i) => `N9${pad(i, 6)}`;
const nicOf = (i) => `${800000000 + i}V`;
const phoneOf = (i) => `077${pad(i, 7)}`;
function legacyRow(i, overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "FULL NAME": `SYNTH GIVEN ${i} SYNTHSURNAME${i}`,
            "NIC NUMBER": nicOf(i), "WHATSAPP NUMBER": phoneOf(i), "CONTACT NUMBER": "", "Job Role": "Plaster", "BIRTH DATE": "05.03.1990",
            "PASSPORT EXPIRE DATE": "01.01.2031", ADDRESS: `${i} Synthetic Road`, "Marital Status": "x (Single)", "SHIRT SIZE": "2XL",
            "LOAN APPLY AMOUNT": "999", "ACTIVE STATUS": "INACTIVE", "UNIQUE NUMBER": "77", "FATHER NAME": "SYNTHFATHER",
            ...overrides,
        },
    };
}
const rowsFor = (count, start = 1) => Array.from({ length: count }, (_, k) => legacyRow(start + k));
// Excel row numbers must increase.
const renumber = (rows) => rows.map((row, k) => ({ ...row, rowNumber: k + 2 }));

async function preview(rows, actor = ADMIN, db = prisma) {
    return previewImport({ db, actor, fileName: "legacy.xlsx", headers: HEADERS, rows });
}
async function commitAll(previewResult, rows, { actor = ADMIN, db = prisma } = {}) {
    const results = [];
    for (const [index, chunk] of chunkRows(rows, previewResult.chunkSize).entries()) {
        results.push(await commitChunk({ db, actor, importId: previewResult.importId, chunkIndex: index, rows: chunk }));
    }
    return results;
}
async function importRows(rows, options = {}) {
    const p = await preview(rows, options.actor, options.db);
    const chunks = await commitAll(p, rows, options);
    const finished = await finishImport({ db: options.db ?? prisma, actor: options.actor ?? ADMIN, importId: p.importId });
    return { preview: p, chunks, finished };
}

async function register(i, extra = {}) {
    const { values, errors } = parseCandidateBody({
        passportId: passportOf(i), surname: `REGSURNAME${i}`, otherNames: `REG GIVEN ${i}`, nic: nicOf(i), whatsappNumber: phoneOf(i), jobTypes: ["PLASTER"], ...extra,
    }, { creating: true });
    assert.equal(errors, undefined);
    return createCandidate({ db: prisma, values, actor: ADMIN });
}

const counts = async () => ({
    candidates: await prisma.candidate.count(), details: await prisma.candidateAdditionalDetails.count(),
    stages: await prisma.candidateStage.count(), documents: await prisma.document.count(),
});

// Counts every Prisma operation (model and raw) through an extended client.
function counting() {
    const counter = { operations: 0 };
    const client = prisma.$extends({ query: { async $allOperations({ args, query }) { counter.operations++; return query(args); } } });
    return { client, counter };
}

// ---------------------------------------------------------------- preview

describe("preview", () => {
    test("38. preview never writes to a candidate table (only the import's own metadata row)", async () => {
        await register(900);
        const before = await counts();
        const queue = await prisma.sheetSyncQueue.count();
        const result = await preview([...rowsFor(3), legacyRow(900, { "CONTACT NUMBER": "0770000999" })].map((r, k) => ({ ...r, rowNumber: k + 2 })));
        assert.deepEqual(await counts(), before);
        assert.equal(await prisma.sheetSyncQueue.count(), queue, "nothing queued for the mirror");
        assert.equal(await prisma.candidateImport.count(), 1);
        assert.equal(result.summary.totalRows, 4);
        assert.equal(result.summary.new, 3);
        assert.equal(result.summary.existing, 1);
        assert.equal(result.summary.willFill, 1);
        assert.equal(result.summary.ignoredSourceColumns, 4, "LOAN APPLY AMOUNT, ACTIVE STATUS, UNIQUE NUMBER, FATHER NAME");
    });

    test("the import record holds no candidate data", async () => {
        const result = await preview(rowsFor(2));
        const record = await prisma.candidateImport.findUnique({ where: { importId: result.importId } });
        const stored = JSON.stringify(record);
        for (const secret of [passportOf(1), nicOf(1), "SYNTHSURNAME1", "SYNTH GIVEN", "Synthetic Road", "770000001"]) assert.ok(!stored.includes(secret), secret);
    });

    test("7. extra legacy columns are ignored: system-owned values (ACTIVE STATUS, UNIQUE NUMBER) never reach the record", async () => {
        await importRows(rowsFor(1));
        const candidate = await prisma.candidate.findUnique({ where: { passportId: passportOf(1) } });
        assert.notEqual(candidate.uniqueId, "77", "the legacy UNIQUE NUMBER is not the Emlynk ID");
        assert.equal(candidate.uniqueId, "0001");
    });

    test("6/missing headings: a sheet without SURNAME is refused before anything is classified", async () => {
        await assert.rejects(
            previewImport({ db: prisma, actor: ADMIN, fileName: "legacy.xlsx", headers: ["PASSPORT NUMBER", "OTHER NAME"], rows: rowsFor(1) }),
            (error) => error.status === 422 && error.code === "MISSING_REQUIRED_HEADINGS" && /SURNAME/.test(error.message),
        );
        assert.equal(await prisma.candidateImport.count(), 0);
    });

    test("problem rows are masked; a VALID row is not listed", async () => {
        const rows = renumber([legacyRow(1), legacyRow(2, { "PASSPORT NUMBER": "N90000012" }), legacyRow(3, { "OTHER NAME": "" })]);
        const result = await preview(rows);
        assert.deepEqual(result.problems.map((p) => [p.rowNumber, p.passport, p.status]), [[3, "N9*****12", "WARNING"], [4, "N9****03", "INVALID"]]);
        assert.ok(!JSON.stringify(result).includes(passportOf(3)));
    });
});

// ---------------------------------------------------------------- classification

describe("existing, duplicate and conflicting candidates", () => {
    test("30. a passport already registered is EXISTING (matched case-insensitively), never a second record", async () => {
        await register(1);
        const result = await preview(renumber([legacyRow(1, { "PASSPORT NUMBER": passportOf(1).toLowerCase() })]));
        assert.equal(result.summary.existing, 1);
        assert.equal(result.summary.new, 0);
    });

    test("31. NIC conflicts: the registered passport has another NIC, or the NIC belongs to another passport (database or file)", async () => {
        await register(1);
        await register(2);
        const rows = renumber([
            legacyRow(1, { "NIC NUMBER": nicOf(51) }),          // same passport, different NIC
            legacyRow(3, { "NIC NUMBER": nicOf(2) }),           // NIC of candidate 2
            legacyRow(4, { "NIC NUMBER": nicOf(60) }), legacyRow(5, { "NIC NUMBER": nicOf(60) }), // one NIC, two passports in the file
            legacyRow(6),
        ]);
        const result = await preview(rows);
        assert.deepEqual(result.problems.filter((p) => p.status === "CONFLICT").map((p) => p.rowNumber), [2, 3, 4, 5]);
        assert.ok(result.problems.every((p) => p.status !== "CONFLICT" || p.codes.includes("NIC_CONFLICT")));
        assert.equal(result.summary.conflicts, 4);
        assert.equal(result.summary.new, 1);
    });

    test("32. a WhatsApp number owned by another candidate is a field-level conflict: imported without it, never overwritten", async () => {
        await register(1);
        const { chunks } = await importRows(renumber([legacyRow(2, { "WHATSAPP NUMBER": `+94${phoneOf(1).slice(1)}` })]));
        assert.equal(chunks[0].counts.created, 1);
        const imported = await prisma.candidate.findUnique({ where: { passportId: passportOf(2) } });
        assert.equal(imported.whatsappNumber, null);
        const owner = await prisma.candidate.findUnique({ where: { passportId: passportOf(1) } });
        assert.equal(owner.whatsappNumber, "+94770000001", "the owner's number is untouched");
    });

    test("33. a passport twice in the file: every occurrence DUPLICATE_SOURCE_ROW, none imported", async () => {
        const rows = renumber([legacyRow(1), legacyRow(1, { "OTHER NAME": "SYNTH OTHER" }), legacyRow(2)]);
        const { preview: p, chunks } = await importRows(rows);
        assert.equal(p.summary.duplicates, 2);
        assert.deepEqual(p.problems.map((x) => x.codes.includes("DUPLICATE_SOURCE_ROW")), [true, true]);
        assert.equal(chunks[0].counts.duplicates, 2);
        assert.equal(chunks[0].counts.created, 1);
        assert.equal(await prisma.candidate.count({ where: { passportId: passportOf(1) } }), 0);
    });

    test("34. surname only (other names blank): INVALID, nothing written", async () => {
        const { chunks } = await importRows(renumber([legacyRow(1, { "OTHER NAME": "" })]));
        assert.equal(chunks[0].counts.invalid, 1);
        assert.equal(await prisma.candidate.count(), 0);
    });

    test("29. an unknown job role leaves the job unset with UNKNOWN_JOB_TYPE; no job type is created", async () => {
        const typesBefore = await prisma.jobType.count();
        const { preview: p } = await importRows(renumber([legacyRow(1, { "Job Role": "Welder" }), legacyRow(2, { "Job Role": "plaster" })]));
        assert.equal(p.summary.unknownJobRoles, 1);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: passportOf(1) } })).job, null);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: passportOf(2) } })).job, "PLASTER");
        assert.equal(await prisma.jobType.count(), typesBefore);
    });
});

// ---------------------------------------------------------------- merge

describe("existing candidates: fill blanks only", () => {
    test("36/37. empty fields are filled; non-empty ones are never overwritten (only counted)", async () => {
        await register(1, { address: "" });
        const before = await prisma.candidate.findUnique({ where: { passportId: passportOf(1) } });
        const { preview: p, chunks } = await importRows(renumber([legacyRow(1, { "CONTACT NUMBER": "0770000999" })]));
        assert.ok(p.summary.fieldsDiffering >= 2, "surname and other names differ and are kept");
        assert.equal(chunks[0].counts.filled, 1);
        const after = await prisma.candidate.findUnique({ where: { passportId: passportOf(1) }, include: { additionalDetails: true } });
        assert.equal(after.otherName, before.otherName, "surname kept");
        assert.equal(after.firstName, before.firstName, "other names kept");
        assert.equal(after.uniqueId, before.uniqueId);
        assert.equal(after.whatsappNumber, before.whatsappNumber);
        assert.equal(after.address, "1 Synthetic Road", "empty address filled");
        assert.equal(after.contactNumber, "+94770000999");
        assert.equal(after.additionalDetails.nameAsInPassport, "SYNTH GIVEN 1 SYNTHSURNAME1");
        assert.equal(after.additionalDetails.tshirtSize, "XXL");
        // Re-importing the same sheet changes nothing more.
        const again = await importRows(renumber([legacyRow(1, { "CONTACT NUMBER": "0770000999" })]));
        assert.equal(again.chunks[0].counts.noChange, 1);
    });

    test("35. a candidate whose details are verified is SKIPPED_VERIFIED: nothing changes, verification stays", async () => {
        await register(1, { address: "" });
        await prisma.candidateVerification.create({ data: { passportId: passportOf(1), detailsVerifiedAt: new Date(), detailsVerifiedById: ADMIN.adminId } });
        const { preview: p, chunks } = await importRows(renumber([legacyRow(1)]));
        assert.equal(p.summary.skippedVerified, 1);
        assert.equal(chunks[0].counts.skippedVerified, 1);
        assert.equal((await prisma.candidate.findUnique({ where: { passportId: passportOf(1) } })).address, null);
        assert.ok((await prisma.candidateVerification.findUnique({ where: { passportId: passportOf(1) } })).detailsVerifiedAt);
    });

    test("Married without a spouse name on record is not imported (the record's rule); spouse details only when Married", async () => {
        const { chunks } = await importRows(renumber([legacyRow(1, { "Marital Status": "x (Married)" })]));
        assert.equal(chunks[0].counts.created, 1);
        const details = await prisma.candidateAdditionalDetails.findUnique({ where: { passportId: passportOf(1) } });
        assert.equal(details.maritalStatus, null);
    });

    test("never touched: stages, documents, verification, allocation", async () => {
        await register(1);
        const stages = await prisma.candidateStage.count();
        await importRows(renumber([legacyRow(1), legacyRow(2)]));
        assert.equal(await prisma.candidateStage.count(), stages, "no stage row is created or completed");
        assert.equal(await prisma.document.count(), 0, "no document row is invented");
        assert.equal(await prisma.candidateVerification.count(), 0);
        assert.equal(await prisma.candidateAllocation.count(), 0);
    });
});

// ---------------------------------------------------------------- commit

describe("chunked commit", () => {
    test("39/28. rows are committed chunk by chunk; the records hold the normalized values", async () => {
        const rows = rowsFor(IMPORT_CHUNK_SIZE + 5);
        const { preview: p, chunks, finished } = await importRows(rows);
        assert.equal(p.chunkCount, 2);
        assert.deepEqual(chunks.map((c) => c.counts.created), [IMPORT_CHUNK_SIZE, 5]);
        assert.equal(finished.status, "COMPLETED");
        assert.equal(finished.counts.created, IMPORT_CHUNK_SIZE + 5);
        const record = await prisma.candidate.findUnique({ where: { passportId: passportOf(7) }, include: { additionalDetails: true } });
        assert.equal(record.otherName, "SYNTHSURNAME7", "SURNAME -> other_name");
        assert.equal(record.firstName, "SYNTH GIVEN 7", "OTHER NAME -> first_name");
        assert.equal(record.nic, nicOf(7));
        assert.equal(record.whatsappNumber, "+94770000007");
        assert.equal(record.dateOfBirth.toISOString().slice(0, 10), "1990-03-05");
        assert.equal(record.job, "PLASTER");
        assert.equal(record.additionalDetails.maritalStatus, "SINGLE");
        assert.equal(record.additionalDetails.nameAsInPassport, "SYNTH GIVEN 7 SYNTHSURNAME7");
    });

    test("a chunk must be exactly what was previewed (hash), and only its own user commits it", async () => {
        const rows = rowsFor(2);
        const p = await preview(rows);
        const tampered = [{ ...rows[0], values: { ...rows[0].values, SURNAME: "CHANGED" } }, rows[1]];
        await assert.rejects(commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows: tampered }), (e) => e.code === "CHUNK_MISMATCH");
        await assert.rejects(commitChunk({ db: prisma, actor: MANAGER, importId: p.importId, chunkIndex: 0, rows }), (e) => e.code === "NOT_YOUR_IMPORT");
        assert.equal(await prisma.candidate.count(), 0);
    });

    test("41. retry / idempotency: a committed chunk is not written twice; re-importing finds nothing new", async () => {
        const rows = rowsFor(3);
        const p = await preview(rows);
        const first = await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows });
        const second = await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows });
        assert.equal(first.counts.created, 3);
        assert.equal(second.alreadyCommitted, true);
        assert.equal(await prisma.candidate.count(), 3);
        const again = await importRows(rows);
        assert.equal(again.chunks[0].counts.created, 0);
        assert.equal(again.chunks[0].counts.noChange, 3);
        assert.equal(await prisma.candidate.count(), 3);
    });

    test("40. partial failure: a chunk that fails rolls back alone, is retried row by row, and only the bad row fails", async () => {
        const rows = rowsFor(IMPORT_CHUNK_SIZE + 3);
        const p = await preview(rows);
        const poisoned = withFailingCreate(passportOf(IMPORT_CHUNK_SIZE + 2), { code: "P2002", meta: { target: ["nic"] } });
        const results = await commitAll(p, rows, { db: poisoned });
        assert.equal(results[0].status, "COMMITTED");
        assert.equal(results[1].status, "PARTIAL");
        assert.deepEqual(results[1].failures, [{ rowNumber: IMPORT_CHUNK_SIZE + 3, passport: "N9****02", codes: ["NIC_CONFLICT"] }]);
        assert.equal(await prisma.candidate.count(), IMPORT_CHUNK_SIZE + 2, "chunk 1 kept; chunk 2 imported all but the bad row");
        // Retrying the partial chunk later (the problem fixed) writes only the missing row, once.
        const retry = await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 1, rows: rows.slice(IMPORT_CHUNK_SIZE) });
        assert.equal(retry.status, "COMMITTED");
        assert.equal(retry.counts.created, 3, "earlier creations keep their outcome");
        assert.equal(await prisma.candidate.count(), IMPORT_CHUNK_SIZE + 3);
        const finished = await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(finished.status, "COMPLETED");
    });

    test("finish with an uncommitted chunk: COMPLETED_WITH_ERRORS; the committed rows stay", async () => {
        const rows = rowsFor(IMPORT_CHUNK_SIZE + 1);
        const p = await preview(rows);
        await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 0, rows: rows.slice(0, IMPORT_CHUNK_SIZE) });
        const finished = await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(finished.status, "COMPLETED_WITH_ERRORS");
        assert.equal(finished.counts.uncommittedRows, 1);
        assert.equal(await prisma.candidate.count(), IMPORT_CHUNK_SIZE);
        await assert.rejects(commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: 1, rows: rows.slice(IMPORT_CHUNK_SIZE) }), (e) => e.code === "IMPORT_FINISHED");
    });
});

// A client whose transactions fail candidate.createMany for any batch holding `passport` (the
// error a real constraint would raise), to exercise isolation; or fail the first `times` calls.
function withFailingCreate(passport, errorShape, { times = Infinity } = {}) {
    let failures = 0;
    const wrapTx = (tx) => new Proxy(tx, {
        get(target, prop) {
            if (prop === "candidate") {
                return new Proxy(target.candidate, {
                    get(model, method) {
                        if (method === "createMany") {
                            return async (args) => {
                                if (failures < times && (passport === null || args.data.some((d) => d.passportId === passport))) {
                                    failures++;
                                    throw Object.assign(new Error("synthetic constraint failure"), errorShape);
                                }
                                return model.createMany(args);
                            };
                        }
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
            if (prop === "failures") return failures;
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

// ---------------------------------------------------------------- unique IDs

describe("bulk unique-ID allocation", () => {
    test("42. one max() for a whole chunk: the next numbers after the highest numeric ID, zero-padded", async () => {
        await prisma.candidate.createMany({ data: [
            { passportId: "SYNA0001", uniqueId: "0007", firstName: "A" }, { passportId: "SYNA0002", uniqueId: "LEGACY-X", firstName: "B" },
        ] });
        const ids = await prisma.$transaction((tx) => allocateUniqueIds(tx, 3));
        assert.deepEqual(ids, ["0008", "0009", "0010"]);
    });

    test("normal registration and bulk import share the numbering without a collision", async () => {
        await register(1);                                       // 0001
        await importRows(renumber([legacyRow(2), legacyRow(3)])); // 0002, 0003
        await register(4);                                       // 0004 (single registration unchanged)
        await importRows(renumber([legacyRow(5)]));              // 0005
        const ids = (await prisma.candidate.findMany({ select: { uniqueId: true }, orderBy: { uniqueId: "asc" } })).map((c) => c.uniqueId);
        assert.deepEqual(ids, ["0001", "0002", "0003", "0004", "0005"]);
    });

    test("a unique-ID collision (a concurrent registration took a number) is retried with fresh numbers", async () => {
        const rows = rowsFor(2);
        const p = await preview(rows);
        const racing = withFailingCreate(null, { code: "P2002", meta: { target: ["unique_id"] } }, { times: 1 });
        const [result] = await commitAll(p, rows, { db: racing });
        assert.equal(racing.failures, 1, "the first attempt hit the collision");
        assert.equal(result.status, "COMMITTED");
        assert.equal(result.counts.created, 2);
    });
});

// ---------------------------------------------------------------- audit

describe("audit", () => {
    test("46. lifecycle audit entries hold counts only; per-candidate entries name fields, never values", async () => {
        const marker = 4242;
        const { preview: p } = await importRows(renumber([legacyRow(marker, { "CONTACT NUMBER": "0779999999" })]));
        // audit_logs is append-only and shared by the tests: this import's lifecycle entries and its candidate's entries.
        const all = await prisma.auditLog.findMany({ where: { OR: [{ action: { startsWith: "BULK_IMPORT_" } }, { passportId: passportOf(marker) }] } });
        const entries = all.filter((e) => e.passportId === passportOf(marker) || JSON.parse(e.newValue).importId === p.importId);
        const lifecycle = entries.filter((e) => e.action.startsWith("BULK_IMPORT_"));
        assert.deepEqual(lifecycle.map((e) => e.action).sort(), ["BULK_IMPORT_COMPLETED", "BULK_IMPORT_STARTED"]);
        assert.ok(lifecycle.every((e) => e.passportId === null && e.adminId === ADMIN.adminId));
        assert.ok(lifecycle.some((e) => JSON.parse(e.newValue).importId === p.importId && JSON.parse(e.newValue).created === 1));
        // No synthetic value anywhere in the log text (the passport is only the candidate key column).
        const text = JSON.stringify(entries.map(({ passportId, ...rest }) => rest)); // eslint-disable-line no-unused-vars
        for (const value of [passportOf(marker), nicOf(marker), `SYNTHSURNAME${marker}`, `SYNTH GIVEN ${marker}`, "Synthetic Road", "779999999", phoneOf(marker).slice(1)]) {
            assert.ok(!text.includes(value), value);
        }
        const created = entries.find((e) => e.action === "CREATE_CANDIDATE");
        assert.equal(created.passportId, passportOf(marker));
        assert.ok(JSON.parse(created.newValue).fields.includes("otherName"));
    });
});

// ---------------------------------------------------------------- the existing Google Sheet sync

describe("Google Sheet reconcile (existing architecture)", () => {
    function mirror() {
        const env = { SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: "fake-spreadsheet-id", SHEET_TAB_NAME: "Emlynk Candidate Operational Mirror" };
        const config = readSheetSyncConfig(env);
        const sheet = createFakeGoogleSheet({ tabName: env.SHEET_TAB_NAME });
        const engine = createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: createGoogleSheetsAdapter({ config, sheetsClient: sheet.client }) });
        const store = createSheetSyncStore({ db: prisma });
        const worker = createSheetSyncWorker({ store, engine, config, tuning: readSheetSyncTuning(env), log: { log() {}, warn() {}, error() {} }, healthCheck: async () => ({ ok: true }) });
        return { sheet, store, worker };
    }

    test("45/9. import -> existing triggers queue the candidates -> finish requests RECONCILE -> the mirror shows the latest headers and values", async () => {
        const { sheet, store, worker } = mirror();
        const { finished } = await importRows(renumber([legacyRow(1), legacyRow(2)]));
        assert.equal(await prisma.sheetSyncQueue.count({ where: { status: "PENDING" } }), 2, "the existing triggers recorded the changes");
        assert.equal(finished.sync.requested, true);
        const run = await prisma.sheetSyncRun.findUnique({ where: { runId: finished.syncRunId } });
        assert.deepEqual([run.kind, run.status, run.requestedBy], ["RECONCILE", "QUEUED", ADMIN.adminId]);

        await worker.tick();
        const done = await store.getRun(finished.syncRunId);
        assert.equal(done.status, "SUCCEEDED");
        assert.deepEqual(sheet.header(), [...SHEET_HEADERS], "the latest approved headers");
        assert.equal(sheet.dataRows().length, 2);
        const row = sheet.dataRows().find((r) => r[SHEET_COLUMNS.find((c) => c.header === "PASSPORT NUMBER").index] === passportOf(1));
        const at = (header) => row[SHEET_COLUMNS.find((c) => c.header === header).index];
        assert.equal(at("SURNAME"), "SYNTHSURNAME1");
        assert.equal(at("OTHER NAME"), "SYNTH GIVEN 1");
        assert.equal(at("FULL NAME"), "SYNTH GIVEN 1 SYNTHSURNAME1");
        assert.equal(at("NIC NUMBER"), nicOf(1));
        assert.equal(at("JOB ROLE"), "PLASTER");
        assert.equal(at("CIVIL STATUS / MARITAL STATUS"), "SINGLE");
        // System-owned columns come from Emlynk, not from the legacy sheet's ACTIVE STATUS / UNIQUE NUMBER.
        assert.equal(at("ACTIVE STATUS"), "ACTIVE");
        assert.equal(row[SYSTEM_CANDIDATE_ID_INDEX], "0001");
        assert.equal(at("PASSPORT"), "Not Submitted", "documents are never invented");
        assert.equal(at("CANDIDATE DETAILS STATUS"), "INCOMPLETE");
        assert.equal(await prisma.sheetSyncQueue.count({ where: { status: "PENDING" } }), 0, "the reconcile settled the queue");
    });

    test("44. the existing manual sync still works alongside: an active RECONCILE is reused, not duplicated", async () => {
        const store = createSheetSyncStore({ db: prisma });
        const { run } = await store.requestRun({ kind: "RECONCILE", triggerSource: "ADMIN", requestedBy: ADMIN.adminId });
        const { finished } = await importRows(renumber([legacyRow(1)]));
        assert.equal(finished.sync.alreadyActive, true);
        assert.equal(finished.syncRunId, run.runId);
        assert.equal(await prisma.sheetSyncRun.count({ where: { kind: "RECONCILE" } }), 1);
    });

    test("nothing written -> no reconcile requested", async () => {
        const { finished } = await importRows(renumber([legacyRow(1, { "OTHER NAME": "" })]));
        assert.equal(finished.status, "COMPLETED");
        assert.equal(finished.sync.requested, false);
        assert.equal(await prisma.sheetSyncRun.count(), 0);
    });
});

// ---------------------------------------------------------------- regression

describe("existing candidate flows are unchanged", () => {
    test("47/48. registration and the Candidate Details update still work as before after an import", async () => {
        await importRows(renumber([legacyRow(1)]));
        const created = await register(2);
        assert.equal(created.uniqueId, "0002");
        await assert.rejects(register(1), (e) => e.code === "CANDIDATE_EXISTS", "an imported passport can't be registered twice");
        const { values } = parseCandidateBody({ surname: "UPDATED", otherNames: "GIVEN", nic: nicOf(2), jobExperience: "2 years", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01", jobTypes: ["PLASTER"] }, { creating: false });
        const updated = await updateCandidateDetails({ db: prisma, passportId: passportOf(2), values, actor: ADMIN });
        assert.equal(updated.candidate.surname, "UPDATED");
    });
});

// ---------------------------------------------------------------- scale

describe("scale", () => {
    test("43. 1,000 synthetic rows: 10 chunks, every candidate created once, bounded queries per chunk", async () => {
        const rows = rowsFor(1000);
        const { client, counter } = counting();
        const startedAt = Date.now();
        const p = await preview(rows, ADMIN, client);
        const previewOps = counter.operations;
        const chunkOps = [];
        const chunkMs = [];
        for (const [index, chunk] of chunkRows(rows, p.chunkSize).entries()) {
            const before = counter.operations;
            const t = Date.now();
            const result = await commitChunk({ db: client, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunk });
            chunkOps.push(counter.operations - before);
            chunkMs.push(Date.now() - t);
            assert.equal(result.counts.created, 100);
        }
        const finished = await finishImport({ db: client, actor: ADMIN, importId: p.importId });
        assert.equal(finished.counts.created, 1000);
        assert.equal(await prisma.candidate.count(), 1000);
        assert.equal(new Set((await prisma.candidate.findMany({ select: { uniqueId: true } })).map((c) => c.uniqueId)).size, 1000);
        // Constant per chunk, not per row: no N+1.
        assert.ok(previewOps <= 12, `preview operations: ${previewOps}`);
        assert.ok(Math.max(...chunkOps) <= 15, `operations per chunk: ${chunkOps.join(",")}`);
        console.log(JSON.stringify({ event: "candidate_import.scale_1000", previewOps, chunkOps, chunkMs, totalMs: Date.now() - startedAt }));
    });
});

// ---------------------------------------------------------------- API and roles

async function call(method, path, adminId, body) {
    const headers = { Accept: "application/json" };
    if (adminId) headers.Authorization = `Bearer ${tokenFor(adminId)}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}/api/admin/settings/sheet-sync${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("API: roles (the backend is the boundary)", () => {
    const body = () => ({ fileName: "legacy.xlsx", headers: HEADERS, rows: rowsFor(2) });

    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`4/5/34. ${role}: 403 on every Update Sheet endpoint and on the sync settings; nothing recorded`, async () => {
            for (const [method, path, payload] of [["GET", "/import/source-columns"], ["POST", "/import/preview", body()], ["GET", "/status"], ["POST", "/run", {}]]) {
                assert.equal((await call(method, path, `admin-${role}`, payload)).status, 403, `${method} ${path}`);
            }
            assert.equal(await prisma.candidateImport.count(), 0);
        });
    }

    test("1/2/3. ADMIN and MANAGER use Update Sheet over HTTP: preview, commit, finish", async () => {
        for (const [actor, start] of [["admin-ADMIN", 1], ["admin-MANAGER", 10]]) {
            const rows = rowsFor(2, start);
            const columns = await call("GET", "/import/source-columns", actor);
            assert.equal(columns.status, 200);
            assert.ok(columns.body.allowed.includes("SURNAME") && !columns.body.allowed.includes("ACTIVE STATUS"));
            const p = await call("POST", "/import/preview", actor, { fileName: "C:\\fakepath\\legacy.xlsx", headers: HEADERS, rows });
            assert.equal(p.status, 200, JSON.stringify(p.body));
            const c = await call("POST", `/import/${p.body.importId}/chunks/0`, actor, { rows });
            assert.equal(c.status, 200);
            assert.equal(c.body.counts.created, 2);
            const f = await call("POST", `/import/${p.body.importId}/finish`, actor, {});
            assert.equal(f.status, 200);
            assert.equal(f.body.status, "COMPLETED");
        }
        assert.equal(await prisma.candidate.count(), 4);
    });

    test("MANAGER reads the sync status but cannot Test Connection, Sync Now or switch the destination", async () => {
        assert.equal((await call("GET", "/status", "admin-MANAGER")).status, 200);
        assert.equal((await call("POST", "/test", "admin-MANAGER", {})).status, 403);
        assert.equal((await call("POST", "/run", "admin-MANAGER", {})).status, 403);
        assert.equal((await call("PUT", "/destination", "admin-MANAGER", { key: "default" })).status, 403);
        assert.equal(await prisma.sheetSyncRun.count(), 0);
    });

    test("6. unsupported files and malformed requests are refused", async () => {
        for (const fileName of ["legacy.csv", "legacy.xlsm", "legacy.xls", "legacy", ""]) {
            const r = await call("POST", "/import/preview", "admin-ADMIN", { ...body(), fileName });
            assert.equal(r.status, 400, fileName);
        }
        assert.equal((await call("POST", "/import/preview", "admin-ADMIN", { ...body(), rows: [] })).status, 400);
        assert.equal((await call("POST", "/import/preview", "admin-ADMIN", { ...body(), rows: [legacyRow(2), legacyRow(1)] })).status, 400, "row numbers must increase");
        const missing = await call("POST", "/import/preview", "admin-ADMIN", { ...body(), headers: ["PASSPORT NUMBER"] });
        assert.equal(missing.status, 422);
        assert.match(missing.body.message, /SURNAME/);
        assert.equal((await call("POST", "/import/not-a-uuid/finish", "admin-ADMIN", {})).status, 400);
        assert.equal(await prisma.candidateImport.count(), 0);
    });

    test("another user's import is not theirs to commit or read", async () => {
        const rows = rowsFor(1);
        const p = await call("POST", "/import/preview", "admin-ADMIN", { fileName: "legacy.xlsx", headers: HEADERS, rows });
        assert.equal((await call("POST", `/import/${p.body.importId}/chunks/0`, "admin-MANAGER", { rows })).status, 403);
        assert.equal((await call("GET", `/import/${p.body.importId}`, "admin-MANAGER")).status, 404);
        assert.equal(await prisma.candidate.count(), 0);
    });
});
