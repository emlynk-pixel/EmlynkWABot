// Bulk candidate import with SEVERAL administrators: each administrator has one import committing at a
// time; different administrators import side by side. What they share is protected in the database, not by
// the one-import rule: a chunk's unique IDs are allocated under one advisory lock, a Job group is read and
// written under a per-date advisory lock, and passports, NICs, Client / Agent names and Job-group keys are
// unique constraints. A chunk is read (its snapshot) and written inside ONE transaction, so an import that
// meets what the other one just committed finds it and fills or reuses it instead of duplicating it.
// Real PostgreSQL (PGlite, every migration); SYNTHETIC data only. PGlite is one session, so "at the same
// time" requests queue one behind the other: the tests assert what must hold whichever goes first.
import "./helpers/importLedgerKey.js";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor } from "./helpers/fakeSupabaseAuth.js";
import { IMPORT_CHUNK_SIZE, chunkRows, commitChunk, finishImport, previewImport } from "../src/services/candidateImportService.js";
import { ASSESSMENT, LEDGER_ENTITY as E, LEDGER_OP, assessImportLedger } from "../src/services/candidateImportLedger.js";

const A = { adminId: "admin-A", role: "ADMIN", name: "Admin A" };
const B = { adminId: "admin-B", role: "ADMIN", name: "Admin B" };
const USERS = { "admin-A": ["Admin A", "ADMIN"], "admin-B": ["Admin B", "ADMIN"], "u-john": ["John Silva", "ANALYST"] };
const HEADERS = [
    "PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE", "OFFICER", "VISA STATUS", "INTERVIEW DATE", "INTERVIEW PASS FAIL",
    "COMPANY", "COMPANY NUMBER", "AGENT", "UNIQUE NUMBER", "ADDRESS",
];
const TODAY = new Date("2026-11-04T06:00:00Z");

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const [adminId, [name, role]] of Object.entries(USERS)) {
        await prisma.user.create({ data: { adminId, authUserId: authIdFor(adminId), name, email: `${adminId}@example.invalid`, role, status: "ACTIVE", activatedAt: new Date() } });
    }
    await prisma.jobType.upsert({ where: { code: "PLASTER" }, create: { code: "PLASTER", name: "PLASTER" }, update: {} });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM "candidate_import"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_additional_details";
        DELETE FROM "import_job_group"; DELETE FROM "job_candidate"; DELETE FROM "job_job_type"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "candidate_stages"; DELETE FROM "candidate_verification"; DELETE FROM "documents"; DELETE FROM "candidate";
        DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
});

// ---------------------------------------------------------------- helpers

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N6${pad(i, 6)}`;
function row(i, u = 3100, d = "11.07.2026", overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${620000000 + i}V`,
            "WHATSAPP NUMBER": `074${pad(i, 7)}`, "JOB ROLE": "Plaster", OFFICER: "John", "INTERVIEW DATE": d, "INTERVIEW PASS FAIL": "PASS",
            COMPANY: "Synth Builders", AGENT: "Synth Agency", "UNIQUE NUMBER": u === null ? "" : String(u), ADDRESS: "",
            ...overrides,
        },
    };
}
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
const preview = (actor, rows) => previewImport({ db: prisma, actor, fileName: "legacy.xlsx", headers: HEADERS, rows, now: TODAY });
const commit = (actor, p, rows, index) => commitChunk({ db: prisma, actor, importId: p.importId, chunkIndex: index, rows: chunkRows(rows, p.chunkSize)[index], now: TODAY });
const finish = (actor, p) => finishImport({ db: prisma, actor, importId: p.importId });
const ledgerOf = (p) => prisma.candidateImportChange.findMany({ where: { importId: p.importId } });
const of = (entries, type, op = null) => entries.filter((e) => e.entityType === type && (op === null || e.op === op));
const rejection = (promise) => promise.then(() => assert.fail("expected a rejection"), (error) => error);
const committing = () => prisma.candidateImport.count({ where: { status: "COMMITTING" } });
const TWO_CHUNKS = IMPORT_CHUNK_SIZE + 50;
const many = (count, start, overrides = {}, u = null) => renumber(Array.from({ length: count }, (_, k) => row(start + k, u, "11.07.2026", overrides)));

// ---------------------------------------------------------------- the same administrator

describe("the same administrator cannot run two imports at once", () => {
    test("a second import is refused while the first is committing; nothing of it is written; the first is unaffected", async () => {
        const first = many(TWO_CHUNKS, 1);
        const pa = await preview(A, first);
        await commit(A, pa, first, 0);
        const second = many(3, 5000);
        const pb = await preview(A, second);
        const error = await rejection(commit(A, pb, second, 0));
        assert.deepEqual([error.status, error.code, error.details.importId], [409, "IMPORT_IN_PROGRESS", pa.importId]);
        assert.equal(await prisma.candidate.count({ where: { passportId: passportOf(5000) } }), 0);
        assert.equal(await prisma.candidateImportChange.count({ where: { importId: pb.importId } }), 0, "no ledger entry for the refused import");
        assert.equal((await commit(A, pa, first, 1)).status, "COMMITTED", "the first import carries on");
    });

    test("two first chunks of the same administrator started together: exactly one runs, the database index agrees", async () => {
        const [x, y] = [many(3, 1), many(3, 100)];
        const [px, py] = [await preview(A, x), await preview(A, y)];
        const results = await Promise.allSettled([commit(A, px, x, 0), commit(A, py, y, 0)]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.deepEqual([results.find((r) => r.status === "rejected").reason.code], ["IMPORT_IN_PROGRESS"]);
        assert.equal(await committing(), 1);
        assert.equal(await prisma.candidate.count(), 3);
        await assert.rejects(prisma.candidateImport.update({ where: { importId: (results[0].status === "fulfilled" ? py : px).importId }, data: { status: "COMMITTING" } }), (error) => error.code === "P2002");
    });
});

// ---------------------------------------------------------------- different administrators

describe("two administrators import at the same time", () => {
    test("both imports are COMMITTING together and both complete: no candidate lost or doubled, every unique ID distinct", async () => {
        const rowsA = many(TWO_CHUNKS, 1);
        const rowsB = many(TWO_CHUNKS, 2001, {}, 4100);
        const [pa, pb] = [await preview(A, rowsA), await preview(B, rowsB)];

        await Promise.all([commit(A, pa, rowsA, 0), commit(B, pb, rowsB, 0)]);
        assert.equal(await committing(), 2, "one each");
        await Promise.all([commit(A, pa, rowsA, 1), commit(B, pb, rowsB, 1)]);
        const [fa, fb] = [await finish(A, pa), await finish(B, pb)];
        assert.deepEqual([fa.status, fb.status], ["COMPLETED", "COMPLETED"]);

        assert.equal(await prisma.candidate.count(), 2 * TWO_CHUNKS);
        const ids = (await prisma.candidate.findMany({ select: { uniqueId: true } })).map((c) => c.uniqueId);
        assert.equal(new Set(ids).size, ids.length, "no unique ID handed out twice");
        assert.equal(await committing(), 0);
    });

    test("the other administrator's stopped or running import does not block yours", async () => {
        const rowsA = many(TWO_CHUNKS, 1);
        const pa = await preview(A, rowsA);
        await commit(A, pa, rowsA, 0);
        const rowsB = many(3, 3001, {}, 4100);
        const pb = await preview(B, rowsB);
        assert.equal((await commit(B, pb, rowsB, 0)).status, "COMMITTED");
        assert.equal(await committing(), 2);
    });
});

describe("ledger ownership: every entry belongs to the import that made the change", () => {
    test("two simultaneous imports: each ledger holds only its own entries, for its own candidates, and each is fully reversible on its own", async () => {
        const rowsA = many(TWO_CHUNKS, 1);
        // Different date, company and agent: nothing shared, so nothing of one can depend on the other.
        const rowsB = renumber(Array.from({ length: TWO_CHUNKS }, (_, k) => row(2001 + k, 4100, "12.07.2026", { COMPANY: "Other Builders", AGENT: "Other Agency" })));
        const [pa, pb] = [await preview(A, rowsA), await preview(B, rowsB)];
        for (const index of [0, 1]) await Promise.all([commit(A, pa, rowsA, index), commit(B, pb, rowsB, index)]);
        await finish(A, pa);
        await finish(B, pb);

        const [la, lb] = [await ledgerOf(pa), await ledgerOf(pb)];
        assert.ok(la.every((e) => e.importId === pa.importId) && lb.every((e) => e.importId === pb.importId));
        assert.equal(of(la, E.CANDIDATE).length, TWO_CHUNKS);
        assert.equal(of(lb, E.CANDIDATE).length, TWO_CHUNKS);
        const keysA = new Set(of(la, E.CANDIDATE).map((e) => e.entityKey));
        assert.ok(of(lb, E.CANDIDATE).every((e) => !keysA.has(e.entityKey)), "no candidate in both ledgers");
        assert.equal(await prisma.candidateImportChange.count(), la.length + lb.length, "nothing stored without an owner");

        for (const p of [pa, pb]) {
            const result = await assessImportLedger({ db: prisma, importId: p.importId });
            assert.deepEqual([result.summary.conflicts, result.summary.missing, result.summary.eligible === result.summary.total], [0, 0, true], `import ${p === pa ? "A" : "B"} is untouched by the other`);
        }
    });
});

describe("two administrators importing the same candidate", () => {
    test("started together: one candidate row, one CREATE entry in total, and the other import records nothing for it", async () => {
        const rows = many(3, 1);
        const [pa, pb] = [await preview(A, rows), await preview(B, rows)];
        const results = await Promise.all([commit(A, pa, rows, 0), commit(B, pb, rows, 0)]);
        assert.deepEqual(results.map((r) => r.status), ["COMMITTED", "COMMITTED"]);
        assert.equal(await prisma.candidate.count(), 3, "no duplicate candidate");
        assert.equal(results.reduce((sum, r) => sum + (r.counts.created ?? 0), 0), 3, "created once in total");
        const [la, lb] = [await ledgerOf(pa), await ledgerOf(pb)];
        assert.equal(of(la, E.CANDIDATE, LEDGER_OP.CREATE).length + of(lb, E.CANDIDATE, LEDGER_OP.CREATE).length, 3);
        const loser = of(la, E.CANDIDATE, LEDGER_OP.CREATE).length ? lb : la;
        assert.equal(of(loser, E.CANDIDATE, LEDGER_OP.CREATE).length, 0, "the import that found it already there did not create it");
        assert.equal(await prisma.candidateAllocation.count(), 3, "allocated once");
    });

    test("one after the other, both previewed before either committed: the second finds the candidate and fills only what is blank; the first's entry then shows a conflict", async () => {
        const first = many(2, 1); // no address
        const second = many(2, 1, { ADDRESS: "1 Shared Road" }); // the same candidates, with an address
        const [pa, pb] = [await preview(A, first), await preview(B, second)];
        assert.equal(pb.summary.new, 2, "previewed as new: nothing was there yet");
        await commit(A, pa, first, 0);
        const result = await commit(B, pb, second, 0);
        assert.deepEqual([result.counts.created, result.counts.filled], [0, 2], "the second import found them and filled the blank address");
        assert.equal(await prisma.candidate.count(), 2);

        const [la, lb] = [await ledgerOf(pa), await ledgerOf(pb)];
        assert.equal(of(la, E.CANDIDATE, LEDGER_OP.CREATE).length, 2);
        assert.equal(of(lb, E.CANDIDATE, LEDGER_OP.CREATE).length, 0);
        const fills = of(lb, E.CANDIDATE, LEDGER_OP.FILL);
        assert.equal(fills.length, 2);
        // The first import left the blank address unset (null), and that is exactly what the ledger says was there.
        assert.ok(fills.every((e) => Object.keys(e.changes).includes("address") && e.changes.address.before === null));
        // A's candidate was changed afterwards by someone else (B): A must not delete it.
        const assessedA = (await assessImportLedger({ db: prisma, importId: pa.importId })).entries.filter((e) => e.entityType === E.CANDIDATE);
        assert.ok(assessedA.every((e) => e.state === ASSESSMENT.CONFLICT && e.reasons.includes("CHANGED_AFTER_IMPORT")));
        // B's own change is exactly what B wrote.
        const assessedB = (await assessImportLedger({ db: prisma, importId: pb.importId })).entries.filter((e) => e.entityType === E.CANDIDATE);
        assert.ok(assessedB.every((e) => e.state === ASSESSMENT.ELIGIBLE));
    });
});

describe("two administrators importing candidates of the same Job group", () => {
    test("one Job for the date and block, made by one import; the other joins it; the creator's Job is no longer its own to remove", async () => {
        const rowsA = many(3, 1, {}, 3100);
        const rowsB = many(3, 100, {}, 3101); // same Interview Date, same hundreds block (31), same company
        const [pa, pb] = [await preview(A, rowsA), await preview(B, rowsB)];
        assert.deepEqual([pa.jobGroups[0].state, pb.jobGroups[0].state], ["NEW", "NEW"], "both previews planned to create it");
        await Promise.all([commit(A, pa, rowsA, 0), commit(B, pb, rowsB, 0)]);

        assert.equal(await prisma.job.count(), 1, "one Job");
        assert.equal(await prisma.importJobGroup.count(), 1);
        assert.equal(await prisma.jobCandidate.count(), 6, "all six candidates are on it");
        const [la, lb] = [await ledgerOf(pa), await ledgerOf(pb)];
        const creator = of(la, E.JOB).length ? la : lb;
        const joiner = creator === la ? lb : la;
        assert.equal(of(creator, E.JOB, LEDGER_OP.CREATE).length, 1);
        assert.equal(of(joiner, E.JOB).length + of(joiner, E.JOB_GROUP).length, 0, "the joining import did not create the Job or its group");
        assert.ok(of(creator, E.JOB_CANDIDATE).every((m) => m.jobCreatedByImport === true));
        assert.ok(of(joiner, E.JOB_CANDIDATE).length === 3 && of(joiner, E.JOB_CANDIDATE).every((m) => m.jobCreatedByImport === false && m.relatedJobId));

        // The Client and Agent are shared the same way: created once.
        assert.equal(await prisma.client.count(), 1);
        assert.equal(of(la, E.CLIENT).length + of(lb, E.CLIENT).length, 1);

        // The creator's Job has another import's members: it is a conflict for the creator, and the joiner's memberships are fine.
        const creatorImport = creator === la ? pa : pb;
        const joinerImport = creator === la ? pb : pa;
        const jobEntry = (await assessImportLedger({ db: prisma, importId: creatorImport.importId })).entries.find((e) => e.entityType === E.JOB);
        assert.deepEqual([jobEntry.state, jobEntry.reasons], [ASSESSMENT.CONFLICT, ["HAS_OTHER_MEMBERS"]]);
        const members = (await assessImportLedger({ db: prisma, importId: joinerImport.importId })).entries.filter((e) => e.entityType === E.JOB_CANDIDATE);
        assert.ok(members.every((e) => e.state === ASSESSMENT.ELIGIBLE));
    });

    test("different dates: two Jobs, one each, with no overlap", async () => {
        const rowsA = many(2, 1, {}, 3100);
        const rowsB = renumber([row(100, 3100, "12.07.2026"), row(101, 3101, "12.07.2026")]);
        const [pa, pb] = [await preview(A, rowsA), await preview(B, rowsB)];
        await Promise.all([commit(A, pa, rowsA, 0), commit(B, pb, rowsB, 0)]);
        assert.equal(await prisma.job.count(), 2);
        assert.equal(of(await ledgerOf(pa), E.JOB).length + of(await ledgerOf(pb), E.JOB).length, 2);
    });
});
