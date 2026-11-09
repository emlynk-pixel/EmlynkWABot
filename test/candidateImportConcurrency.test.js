// Bulk candidate import: duplicate-upload protection (candidateImportService.js, migration
// 20261112120000_import_hardening) on a real PostgreSQL (PGlite, every migration). SYNTHETIC rows only.
//
// Covered: the same chunk sent twice, a repeated / retried preview (Idempotency-Key), the same file
// previewed again while it is being committed, only one import committing at a time (service + the
// database index), stale imports and who may abort them, finish and abort being safe to repeat, and the
// API (GET /active, POST /abort, 409 details, roles).
// PGlite is one session, so "at the same time" requests are queued one behind the other: the tests
// assert the invariants that must hold in either order.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import {
    CandidateImportError, IMPORT_CHUNK_SIZE, IMPORT_STALE_MS, abortImport, chunkRows, commitChunk, finishImport, getActiveImport, previewImport,
} from "../src/services/candidateImportService.js";

const ROLES = ["ADMIN", "ADMIN2", "ANALYST"];
const actorOf = (name) => ({ adminId: `admin-${name}`, role: name === "ANALYST" ? "ANALYST" : "ADMIN" });
const ADMIN = actorOf("ADMIN");
const ADMIN2 = actorOf("ADMIN2");
const HEADERS = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "FULL NAME", "NIC NUMBER", "WHATSAPP NUMBER", "Job Role"];

let database;
let prisma;
let pg;
let server;
let baseUrl;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const name of ROLES) {
        await prisma.user.create({ data: { adminId: `admin-${name}`, authUserId: authIdFor(`admin-${name}`), name, email: `${name.toLowerCase()}@example.invalid`, role: name === "ANALYST" ? "ANALYST" : "ADMIN", status: "ACTIVE" } });
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
        DELETE FROM "job_type" WHERE "name" LIKE 'ZZZ%';
    `);
});

// ---------------------------------------------------------------- synthetic rows

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N9${pad(i, 6)}`;
function legacyRow(i, role = "Plaster") {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "FULL NAME": `SYNTH GIVEN ${i} SYNTHSURNAME${i}`,
            "NIC NUMBER": `${800000000 + i}V`, "WHATSAPP NUMBER": `077${pad(i, 7)}`, "Job Role": role,
        },
    };
}
const rowsFor = (count, start = 1, role = "Plaster") => Array.from({ length: count }, (_, k) => legacyRow(start + k, role));

const preview = (rows, { actor = ADMIN, idempotencyKey = null, now } = {}) => previewImport({ db: prisma, actor, fileName: "legacy.xlsx", headers: HEADERS, rows, idempotencyKey, ...(now ? { now } : {}) });
const commit = (p, rows, index, { actor = ADMIN, now } = {}) => commitChunk({ db: prisma, actor, importId: p.importId, chunkIndex: index, rows: chunkRows(rows, p.chunkSize)[index], ...(now ? { now } : {}) });
const finish = (p, { actor = ADMIN } = {}) => finishImport({ db: prisma, actor, importId: p.importId });
const rejection = async (promise) => promise.then(() => assert.fail("expected a rejection"), (error) => error);
const candidates = () => prisma.candidate.count();
const importRow = (p) => prisma.candidateImport.findUnique({ where: { importId: p.importId } });
const audits = (importId, action) => prisma.auditLog.count({ where: { action, reason: { contains: importId } } });

const TWO_CHUNKS = IMPORT_CHUNK_SIZE + 50;

describe("the same chunk sent twice (double click, retry, two tabs)", () => {
    test("written once: both requests succeed, one reports alreadyCommitted, no duplicate candidates, one STARTED audit entry", async () => {
        const rows = rowsFor(5);
        const p = await preview(rows);
        const [a, b] = await Promise.all([commit(p, rows, 0), commit(p, rows, 0)]);
        assert.deepEqual([a.status, b.status], ["COMMITTED", "COMMITTED"]);
        assert.equal([a, b].filter((r) => r.alreadyCommitted).length, 1);
        assert.equal(await candidates(), 5);
        assert.equal(await audits(p.importId, "BULK_IMPORT_STARTED"), 1);
    });
});

describe("Idempotency-Key: a repeated or retried preview is the same import", () => {
    test("the same key and file return the same importId; only one import row exists", async () => {
        const rows = rowsFor(3);
        const first = await preview(rows, { idempotencyKey: "key-aaaaaaaa-1" });
        const again = await preview(rows, { idempotencyKey: "key-aaaaaaaa-1" });
        assert.equal(again.importId, first.importId);
        assert.equal(again.chunkCount, first.chunkCount);
        assert.equal(await prisma.candidateImport.count(), 1);
    });

    test("two previews with the same key at the same moment still make one import", async () => {
        const rows = rowsFor(3);
        const [a, b] = await Promise.all([preview(rows, { idempotencyKey: "key-bbbbbbbb-2" }), preview(rows, { idempotencyKey: "key-bbbbbbbb-2" })]);
        assert.equal(a.importId, b.importId);
        assert.equal(await prisma.candidateImport.count(), 1);
    });

    test("the key is per admin: another admin's identical key is a different import", async () => {
        const rows = rowsFor(3);
        const mine = await preview(rows, { idempotencyKey: "key-cccccccc-3" });
        const theirs = await preview(rows, { actor: ADMIN2, idempotencyKey: "key-cccccccc-3" });
        assert.notEqual(mine.importId, theirs.importId);
    });

    test("a repeated preview keeps the Job IDs the admin already chose", async () => {
        const rows = rowsFor(3);
        const first = await preview(rows, { idempotencyKey: "key-dddddddd-4" });
        await prisma.candidateImport.update({ where: { importId: first.importId }, data: { jobGroups: [{ key: "2026-01-01|0", interviewDate: "2026-01-01", block: 0, from: 0, to: 99, prefix: "JOB-2026-0101", suffix: "07", jobCode: "JOB-2026-010107", state: "NEW", codes: [], candidates: 0, passed: 0, edited: true }] } });
        const again = await preview(rows, { idempotencyKey: "key-dddddddd-4" });
        assert.equal(again.importId, first.importId);
        assert.deepEqual(again.jobGroups.map((g) => g.suffix), ["07"]);
    });

    test("the same key with a different file is refused (IDEMPOTENCY_KEY_REUSED); a malformed key is a 400", async () => {
        await preview(rowsFor(3), { idempotencyKey: "key-eeeeeeee-5" });
        const reused = await rejection(preview(rowsFor(4, 50), { idempotencyKey: "key-eeeeeeee-5" }));
        assert.ok(reused instanceof CandidateImportError);
        assert.deepEqual([reused.status, reused.code], [409, "IDEMPOTENCY_KEY_REUSED"]);
        const bad = await rejection(preview(rowsFor(3), { idempotencyKey: "short" }));
        assert.deepEqual([bad.status, bad.code], [400, "INVALID_IDEMPOTENCY_KEY"]);
    });

    test("the key of an import that already ran is refused as finished, never reused", async () => {
        const rows = rowsFor(3);
        const p = await preview(rows, { idempotencyKey: "key-ffffffff-6" });
        await commit(p, rows, 0);
        await finish(p);
        const error = await rejection(preview(rows, { idempotencyKey: "key-ffffffff-6" }));
        assert.deepEqual([error.status, error.code], [409, "IMPORT_ALREADY_FINISHED"]);
    });
});

describe("the same file previewed again while it is being committed", () => {
    test("refused with IMPORT_ALREADY_ACTIVE and the details to resume; allowed once the import is finished", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const error = await rejection(preview(rows));
        assert.deepEqual([error.status, error.code], [409, "IMPORT_ALREADY_ACTIVE"]);
        assert.equal(error.details.importId, p.importId);
        assert.deepEqual([error.details.chunkCount, error.details.committedChunks], [2, [0]]);
        assert.equal(await prisma.candidateImport.count(), 1, "no second import was recorded");

        // Resume: the second chunk of the SAME import, then finish.
        await commit(p, rows, 1);
        await finish(p);
        const next = await preview(rows);
        assert.notEqual(next.importId, p.importId);
    });

    test("another admin may preview the same file (nothing is written by a preview)", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const theirs = await preview(rows, { actor: ADMIN2 });
        assert.notEqual(theirs.importId, p.importId);
    });
});

describe("only one import commits at a time", () => {
    test("a second import cannot start while the first is committing: nothing written, no job type created", async () => {
        const a = rowsFor(TWO_CHUNKS);
        const pa = await preview(a);
        await commit(pa, a, 0);
        const b = rowsFor(3, 1000, "ZZZ Blocked Role");
        const pb = await preview(b);
        const before = await candidates();
        const error = await rejection(commit(pb, b, 0));
        assert.deepEqual([error.status, error.code], [409, "IMPORT_IN_PROGRESS"]);
        assert.equal(error.details.importId, pa.importId);
        assert.equal(error.details.ownedByYou, true);
        assert.equal(await candidates(), before, "no candidate of the blocked import");
        assert.equal(await prisma.jobType.count({ where: { name: { startsWith: "ZZZ" } } }), 0, "no job type created for the blocked import");
        assert.equal((await importRow(pb)).status, "PREVIEWED");
    });

    test("after the first is finished (or aborted) the second can start", async () => {
        const a = rowsFor(TWO_CHUNKS);
        const pa = await preview(a);
        await commit(pa, a, 0);
        const b = rowsFor(3, 1000);
        const pb = await preview(b);
        await abortImport({ db: prisma, actor: ADMIN, importId: pa.importId });
        assert.equal((await commit(pb, b, 0)).status, "COMMITTED");
    });

    test("the database index is the backstop: a second COMMITTING import cannot exist", async () => {
        const a = rowsFor(TWO_CHUNKS);
        const pa = await preview(a);
        await commit(pa, a, 0);
        const pb = await preview(rowsFor(3, 1000));
        await assert.rejects(prisma.candidateImport.update({ where: { importId: pb.importId }, data: { status: "COMMITTING" } }), (error) => error.code === "P2002");
    });

    test("two imports starting at the same moment: exactly one commits, the other is told IMPORT_IN_PROGRESS", async () => {
        const a = rowsFor(3, 1);
        const b = rowsFor(3, 100);
        const [pa, pb] = [await preview(a), await preview(b)];
        const results = await Promise.allSettled([commit(pa, a, 0), commit(pb, b, 0, { actor: ADMIN })]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const failed = results.find((r) => r.status === "rejected").reason;
        assert.deepEqual([failed.status, failed.code], [409, "IMPORT_IN_PROGRESS"]);
        assert.equal(await candidates(), 3, "only the winner's candidates exist");
        assert.equal(await prisma.candidateImport.count({ where: { status: "COMMITTING" } }), 1);
    });
});

describe("stale imports", () => {
    const later = (ms) => new Date(Date.now() + ms);

    test("an idle COMMITTING import is reported stale after 15 minutes, and visible to every ADMIN", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const fresh = (await getActiveImport({ db: prisma, actor: ADMIN2 })).active;
        assert.deepEqual([fresh.importId, fresh.ownedByYou, fresh.stale, fresh.committedChunks], [p.importId, false, false, [0]]);
        const stale = (await getActiveImport({ db: prisma, actor: ADMIN, now: later(IMPORT_STALE_MS + 60_000) })).active;
        assert.deepEqual([stale.ownedByYou, stale.stale], [true, true]);
        assert.deepEqual(await getActiveImport({ db: prisma, actor: ADMIN }).then(async () => (await getActiveImport({ db: prisma, actor: ADMIN })).active.fileName), "legacy.xlsx");
    });

    test("another admin cannot abort a running import, but can abort a stale one; the audit entry says so", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const refused = await rejection(abortImport({ db: prisma, actor: ADMIN2, importId: p.importId }));
        assert.deepEqual([refused.status, refused.code], [403, "NOT_YOUR_IMPORT"]);
        const aborted = await abortImport({ db: prisma, actor: ADMIN2, importId: p.importId, now: later(IMPORT_STALE_MS + 60_000) });
        assert.equal(aborted.status, "ABORTED");
        assert.equal(await prisma.auditLog.count({ where: { action: "BULK_IMPORT_ABORTED", reason: { contains: "aborted by another administrator" } } }), 1);
        assert.equal((await getActiveImport({ db: prisma, actor: ADMIN })).active, null);
    });

    test("the owner of a stale import can resume it: the next chunk is accepted", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const result = await commit(p, rows, 1, { now: later(IMPORT_STALE_MS + 60_000) });
        assert.equal(result.status, "COMMITTED");
        assert.equal(await candidates(), TWO_CHUNKS);
    });
});

describe("finish and abort are safe to repeat", () => {
    test("finish twice at the same moment: one audit entry, one sync request, the same result", async () => {
        const rows = rowsFor(5);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const [a, b] = await Promise.all([finish(p), finish(p)]);
        assert.deepEqual([a.status, b.status], ["COMPLETED", "COMPLETED"]);
        assert.equal([a, b].filter((r) => r.alreadyFinished).length, 1);
        assert.equal(await audits(p.importId, "BULK_IMPORT_COMPLETED"), 1);
        assert.equal(await prisma.sheetSyncRun.count({ where: { kind: "RECONCILE" } }), 1);
        assert.equal(a.syncRunId ?? b.syncRunId, (await importRow(p)).syncRunId);
    });

    test("abort keeps the rows already imported, requests the sync, and refuses further chunks", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        const aborted = await abortImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(aborted.status, "ABORTED");
        assert.deepEqual([aborted.counts.created, aborted.counts.uncommittedChunks, aborted.counts.uncommittedRows], [IMPORT_CHUNK_SIZE, 1, 50]);
        assert.equal(aborted.sync.requested, true);
        assert.equal(await candidates(), IMPORT_CHUNK_SIZE, "the imported rows are kept");
        const late = await rejection(commit(p, rows, 1));
        assert.deepEqual([late.status, late.code], [409, "IMPORT_FINISHED"]);
        assert.equal(await candidates(), IMPORT_CHUNK_SIZE);
        const twice = await abortImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.equal(twice.alreadyFinished, true);
        assert.equal(await audits(p.importId, "BULK_IMPORT_ABORTED"), 1);
        assert.equal(await prisma.sheetSyncRun.count({ where: { kind: "RECONCILE" } }), 1);
    });

    test("aborting an import that never started writes nothing and requests no sync", async () => {
        const p = await preview(rowsFor(3));
        const aborted = await abortImport({ db: prisma, actor: ADMIN, importId: p.importId });
        assert.deepEqual([aborted.status, aborted.sync.requested], ["ABORTED", false]);
        assert.equal(await prisma.sheetSyncRun.count(), 0);
    });

    test("finishing an import that is already aborted reports it as finished (no second audit entry)", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await preview(rows);
        await commit(p, rows, 0);
        await abortImport({ db: prisma, actor: ADMIN, importId: p.importId });
        const result = await finish(p);
        assert.deepEqual([result.status, result.alreadyFinished], ["ABORTED", true]);
        assert.equal(await audits(p.importId, "BULK_IMPORT_COMPLETED"), 0);
    });
});

describe("API", () => {
    async function call(method, path, adminName, body, extraHeaders = {}) {
        const headers = { Accept: "application/json", ...extraHeaders };
        if (adminName) headers.Authorization = `Bearer ${tokenFor(`admin-${adminName}`)}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(`${baseUrl}/api/admin/settings/sheet-sync/import${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json().catch(() => null) };
    }
    const previewBody = (rows) => ({ fileName: "legacy.xlsx", headers: HEADERS, rows });

    test("the Idempotency-Key header makes a repeated preview return the same import; a bad key is 400", async () => {
        const rows = rowsFor(3);
        const first = await call("POST", "/preview", "ADMIN", previewBody(rows), { "Idempotency-Key": "api-key-aaaa-1" });
        const again = await call("POST", "/preview", "ADMIN", previewBody(rows), { "Idempotency-Key": "api-key-aaaa-1" });
        assert.deepEqual([first.status, again.status, again.body.importId === first.body.importId], [200, 200, true]);
        const bad = await call("POST", "/preview", "ADMIN", previewBody(rows), { "Idempotency-Key": "no" });
        assert.deepEqual([bad.status, bad.body.code], [400, "INVALID_IDEMPOTENCY_KEY"]);
    });

    test("409 answers carry code and details; GET /active and POST /abort work; nothing leaks row data", async () => {
        const rows = rowsFor(TWO_CHUNKS);
        const p = await call("POST", "/preview", "ADMIN", previewBody(rows));
        const chunk = await call("POST", `/${p.body.importId}/chunks/0`, "ADMIN", { rows: rows.slice(0, IMPORT_CHUNK_SIZE) });
        assert.equal(chunk.status, 200);

        const again = await call("POST", "/preview", "ADMIN", previewBody(rows));
        assert.deepEqual([again.status, again.body.code, again.body.details.importId, again.body.details.committedChunks], [409, "IMPORT_ALREADY_ACTIVE", p.body.importId, [0]]);

        const active = await call("GET", "/active", "ADMIN2");
        assert.equal(active.status, 200);
        assert.deepEqual([active.body.active.importId, active.body.active.ownedByYou], [p.body.importId, false]);
        assert.doesNotMatch(JSON.stringify(active.body), /N9\d{6}|SYNTH/);

        const denied = await call("POST", `/${p.body.importId}/abort`, "ADMIN2");
        assert.deepEqual([denied.status, denied.body.code], [403, "NOT_YOUR_IMPORT"]);
        const aborted = await call("POST", `/${p.body.importId}/abort`, "ADMIN");
        assert.deepEqual([aborted.status, aborted.body.status], [200, "ABORTED"]);
        assert.equal((await call("GET", "/active", "ADMIN")).body.active, null);
        assert.equal((await call("POST", "/not-a-uuid/abort", "ADMIN")).status, 400);
    });

    test("an ANALYST gets 403 from the new endpoints too", async () => {
        assert.equal((await call("GET", "/active", "ANALYST")).status, 403);
        assert.equal((await call("POST", "/00000000-0000-4000-8000-000000000000/abort", "ANALYST")).status, 403);
    });
});
