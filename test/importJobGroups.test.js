// Jobs from the Google Sheet upload (importJobGroups.js): Interview Date + the UNIQUE NUMBER's hundreds
// block -> one Job JOB-YYYY-MMDDNN. Pure rules first, then end to end on PostgreSQL (PGlite, every
// migration) with SYNTHETIC candidates, Clients and Agents only.
import "./helpers/importLedgerKey.js";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { authIdFor, fakeVerifyAccessToken, tokenFor } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { createRequireActiveUser } from "../src/middleware/requireActiveUser.js";
import { chunkRows, commitChunk, finishImport, previewImport, updateImportJobGroups } from "../src/services/candidateImportService.js";
import { normalizeUniqueNumber } from "../src/services/candidateImportNormalizers.js";
import {
    GROUP_STATE, applySuffixEdits, buildJobGroupPlan, hundredsBlock, importJobCode, isValidSuffix, jobMembership,
} from "../src/services/importJobGroups.js";

// ---------------------------------------------------------------- pure rules

describe("hundreds block", () => {
    test("floor(n / 100), from any starting value", () => {
        const table = [[0, 0], [99, 0], [100, 1], [199, 1], [200, 2], [299, 2], [300, 3], [999, 9], [1000, 10], [3100, 31], [3150, 31], [3199, 31], [3200, 32], [3225, 32], [3299, 32], [3300, 33]];
        for (const [n, block] of table) assert.equal(hundredsBlock(n), block, String(n));
    });

    test("UNIQUE NUMBER must be a whole number from 0", () => {
        for (const [raw, value] of [["3100", 3100], [" 3100 ", 3100], ["3100.0", 3100], ["0", 0]]) assert.deepEqual(normalizeUniqueNumber(raw), { value }, raw);
        for (const raw of ["-5", "31.5", "abc", "1e3"]) assert.deepEqual(normalizeUniqueNumber(raw), { value: null, warning: "INVALID_UNIQUE_NUMBER" }, raw);
        assert.deepEqual(normalizeUniqueNumber(""), { value: null });
    });

    test("the code: JOB-YYYY-MMDD + two digits; a suffix is 01-99", () => {
        assert.equal(importJobCode("2026-07-11", "01"), "JOB-2026-071101");
        assert.equal(importJobCode(new Date("2027-01-03T00:00:00Z"), "05"), "JOB-2027-010305");
        for (const ok of ["01", "05", "99"]) assert.equal(isValidSuffix(ok), true, ok);
        for (const bad of ["00", "1", "001", "ab", "1a", 5, null]) assert.equal(isValidSuffix(bad), false, String(bad));
    });
});

// A classified row as planRows makes it (only what the plan reads).
const member = (date, uniqueNumber, { pass = true, company = "ACME", agent = "AG", n = 0 } = {}) => ({
    rowNumber: n, org: {}, codes: [], issues: [],
    job: jobMembership({ testDate: new Date(`${date}T00:00:00Z`), uniqueNumber, pass, passportId: `P${n}`, values: { company, agent, jobRole: "PLASTER" } }),
});
const suffixes = (groups) => Object.fromEntries(groups.map((g) => [`${g.interviewDate} ${g.from}-${g.to}`, g.suffix]));

describe("suffixes per date (the plan)", () => {
    test("the spec's example: per date, distinct blocks in ascending order get 01, 02, 03; every date starts at 01; row order is irrelevant", () => {
        const rows = [
            member("2026-07-11", 3300), member("2026-07-11", 3100), member("2026-07-11", 3225), member("2026-07-11", 3150), member("2026-07-11", 3350),
            member("2026-07-11", 3125), member("2026-07-11", 3200), member("2026-07-11", 3250),
            member("2026-07-12", 3250), member("2026-07-12", 3100), member("2026-07-12", 3200), member("2026-07-12", 3150),
        ];
        const plan = buildJobGroupPlan(rows);
        assert.deepEqual(suffixes(plan), {
            "2026-07-11 3100-3199": "01", "2026-07-11 3200-3299": "02", "2026-07-11 3300-3399": "03",
            "2026-07-12 3100-3199": "01", "2026-07-12 3200-3299": "02",
        });
        assert.deepEqual(plan.map((g) => g.jobCode), ["JOB-2026-071101", "JOB-2026-071102", "JOB-2026-071103", "JOB-2026-071201", "JOB-2026-071202"]);
        assert.deepEqual(plan.map((g) => g.candidates), [3, 3, 2, 2, 2]);
        assert.deepEqual(suffixes(buildJobGroupPlan([...rows].reverse())), suffixes(plan), "the same whatever the row order");
    });

    test("missing intermediate blocks never leave gaps: 31, 33, 35 -> 01, 02, 03", () => {
        assert.deepEqual(Object.values(suffixes(buildJobGroupPlan([member("2026-07-11", 3510), member("2026-07-11", 3100), member("2026-07-11", 3399)]))), ["01", "02", "03"]);
    });

    test("an existing group keeps its Job and suffix (also an edited one); a new block on that date takes the lowest unused suffix, reported", () => {
        const existing = [
            { interviewDate: "2026-07-11", block: 31, suffix: "01", jobId: "j1", jobCode: "JOB-2026-071101", jobStatus: "PROCESSING", clientName: "Acme" },
            { interviewDate: "2026-07-11", block: 33, suffix: "05", jobId: "j2", jobCode: "JOB-2026-071105", jobStatus: "PROCESSING", clientName: "Acme" },
        ];
        const plan = buildJobGroupPlan([member("2026-07-11", 3100), member("2026-07-11", 3300), member("2026-07-11", 3200)], { existing });
        const byFrom = Object.fromEntries(plan.map((g) => [g.from, g]));
        assert.deepEqual([byFrom[3100].state, byFrom[3100].jobCode], [GROUP_STATE.EXISTING, "JOB-2026-071101"]);
        assert.deepEqual([byFrom[3300].state, byFrom[3300].jobCode], [GROUP_STATE.EXISTING, "JOB-2026-071105"], "the edited suffix stays");
        assert.deepEqual([byFrom[3200].state, byFrom[3200].suffix], [GROUP_STATE.NEW, "02"]);
        assert.ok(byFrom[3200].codes.includes("JOB_GROUP_ADDED_LATER"));
    });

    test("a suffix whose full code is already used by any Job is skipped", () => {
        const plan = buildJobGroupPlan([member("2026-07-11", 3100)], { takenCodes: new Set(["JOB-2026-071101"]) });
        assert.equal(plan[0].suffix, "02");
    });

    test("problems: different companies -> ERROR; nobody passed -> SKIPPED (no Job yet); another client on an existing Job -> ERROR", () => {
        const conflict = buildJobGroupPlan([member("2026-07-11", 3100, { company: "ACME" }), member("2026-07-11", 3150, { company: "Other" })]);
        assert.deepEqual([conflict[0].state, conflict[0].codes], [GROUP_STATE.ERROR, ["JOB_GROUP_COMPANY_CONFLICT"]]);
        const skipped = buildJobGroupPlan([member("2026-07-11", 3100, { pass: false })]);
        assert.deepEqual([skipped[0].state, skipped[0].suffix], [GROUP_STATE.SKIPPED, null]);
        const existing = [{ interviewDate: "2026-07-11", block: 31, suffix: "01", jobId: "j1", jobCode: "JOB-2026-071101", jobStatus: "PROCESSING", clientName: "Other Co" }];
        assert.equal(buildJobGroupPlan([member("2026-07-11", 3100)], { existing })[0].state, GROUP_STATE.ERROR);
    });

    test("edits: two digits, NEW groups only, unique within the upload and against existing codes; nothing applied on an error", () => {
        const plan = buildJobGroupPlan([member("2026-07-11", 3100), member("2026-07-11", 3200)]);
        const [first, second] = plan;
        assert.equal(applySuffixEdits(plan, { [first.key]: "05" }).groups[0].jobCode, "JOB-2026-071105");
        assert.match(applySuffixEdits(plan, { [first.key]: "5" }).errors[0].message, /two digits/);
        assert.match(applySuffixEdits(plan, { [first.key]: "02" }).errors[0].message, /another group/);
        assert.match(applySuffixEdits(plan, { [second.key]: "07" }, { takenCodes: new Set(["JOB-2026-071107"]) }).errors[0].message, /already exists/);
        assert.ok(applySuffixEdits(plan, { "2026-07-11|99": "05" }).errors);
    });
});

// ---------------------------------------------------------------- end to end

const ADMIN = { adminId: "admin-ADMIN", role: "ADMIN", name: "Admin User" };
const USERS = {
    "admin-ADMIN": ["Admin User", "ADMIN"], "u-john": ["John Silva", "ANALYST"], "u-anna": ["Anna Other", "ANALYST"],
    "u-jay": ["Jay Handler", "JOB_HANDLER"], "u-tim": ["Tim Lead", "TEAM_LEAD"], "u-rita": ["Rita Desk", "REGISTRATION_DESK"],
};
const HEADERS = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "JOB ROLE", "OFFICER",
    "INTERVIEW DATE", "INTERVIEW PASS FAIL", "COMPANY", "AGENT", "UNIQUE NUMBER"];
const TODAY = new Date("2026-11-04T06:00:00Z");

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
    app.use(express.json());
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
        DELETE FROM "candidate_stages"; DELETE FROM "candidate"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";
    `);
});

const pad = (n, width) => String(n).padStart(width, "0");
const passportOf = (i) => `N7${pad(i, 6)}`;
// i: the row; u: its UNIQUE NUMBER; d: the INTERVIEW DATE (DD.MM.YYYY).
function row(i, u, d = "11.07.2026", overrides = {}) {
    return {
        rowNumber: i + 1,
        values: {
            "PASSPORT NUMBER": passportOf(i), SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`, "NIC NUMBER": `${710000000 + i}V`,
            "WHATSAPP NUMBER": `075${pad(i, 7)}`, "JOB ROLE": "Plaster", OFFICER: "John", "INTERVIEW DATE": d, "INTERVIEW PASS FAIL": "PASS",
            COMPANY: "Synth Builders", AGENT: "Synth Agency", "UNIQUE NUMBER": u === null ? "" : String(u),
            ...overrides,
        },
    };
}
const renumber = (rows) => rows.map((r, k) => ({ ...r, rowNumber: k + 2 }));
const preview = (rows) => previewImport({ db: prisma, actor: ADMIN, fileName: "legacy.xlsx", headers: HEADERS, rows, now: TODAY });
async function commitAll(p, rows) {
    const chunks = [];
    for (const [index, chunk] of chunkRows(rows, p.chunkSize).entries()) chunks.push(await commitChunk({ db: prisma, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunk, now: TODAY }));
    await finishImport({ db: prisma, actor: ADMIN, importId: p.importId });
    return chunks;
}
async function importRows(rows) {
    const p = await preview(rows);
    return { preview: p, chunks: await commitAll(p, rows) };
}
const jobsByCode = async () => Object.fromEntries((await prisma.job.findMany({ select: { jobCode: true, id: true, countryCode: true, candidates: { where: { isActive: true }, select: { passportId: true } } } }))
    .map((j) => [j.jobCode, j]));
const membersOf = async (code) => (await jobsByCode())[code]?.candidates.map((c) => c.passportId).sort() ?? [];
async function api(adminId, method, path, body) {
    const response = await fetch(`${baseUrl}/api/admin${path}`, { method, headers: { Authorization: `Bearer ${tokenFor(adminId)}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}

describe("sheet upload -> Jobs (end to end)", () => {
    test("the spec's example: one Job per date and hundreds block, codes JOB-YYYY-MMDDNN, every PASS candidate on it", async () => {
        const rows = renumber([
            row(1, 3300), row(2, 3100), row(3, 3225), row(4, 3150), row(5, 3350), row(6, 3125), row(7, 3200), row(8, 3250),
            row(9, 3250, "12.07.2026"), row(10, 3100, "12.07.2026"), row(11, 3200, "12.07.2026"), row(12, 3150, "12.07.2026"),
        ]);
        const { preview: p, chunks } = await importRows(rows);
        assert.deepEqual(p.jobGroups.map((g) => [g.jobCode, g.from, g.to, g.candidates, g.state]), [
            ["JOB-2026-071101", 3100, 3199, 3, "NEW"], ["JOB-2026-071102", 3200, 3299, 3, "NEW"], ["JOB-2026-071103", 3300, 3399, 2, "NEW"],
            ["JOB-2026-071201", 3100, 3199, 2, "NEW"], ["JOB-2026-071202", 3200, 3299, 2, "NEW"],
        ]);
        assert.equal(p.summary.jobsToCreate, 5);
        assert.equal(chunks[0].counts.jobsCreated, 5);
        assert.equal(chunks[0].counts.jobAssignments, 12);
        assert.deepEqual(await membersOf("JOB-2026-071101"), [2, 4, 6].map(passportOf).sort());
        assert.deepEqual(await membersOf("JOB-2026-071103"), [1, 5].map(passportOf).sort());
        assert.deepEqual(await membersOf("JOB-2026-071202"), [9, 11].map(passportOf).sort());
        const job = await prisma.job.findUnique({ where: { jobCode: "JOB-2026-071101" }, select: { countryCode: true, fromCountryCode: true, status: true, client: { select: { name: true } }, responsibleAgent: { select: { name: true } }, jobTypes: { select: { jobType: { select: { name: true } } } } } });
        assert.deepEqual([job.status, job.client.name, job.responsibleAgent.name, job.jobTypes.map((t) => t.jobType.name)], ["PROCESSING", "Synth Builders", "Synth Agency", ["PLASTER"]]);
        assert.deepEqual([job.countryCode, job.fromCountryCode], ["RO", "RO"], "the new Agent has no country: To Country RO");
        assert.equal(await prisma.auditLog.count({ where: { action: "CREATE_JOB" } }), 5);
        assert.equal(await prisma.auditLog.count({ where: { action: "ADD_CANDIDATE_TO_JOB" } }), 12);
        assert.equal(await prisma.jobCodeCounter.count(), 0, "the manual Job counter is never used");
    });

    test("re-upload: the same groups reuse their Jobs (no duplicate); an edited suffix stays; a new block gets the next free suffix", async () => {
        await importRows(renumber([row(1, 3100), row(2, 3200)]));
        const second = (await jobsByCode())["JOB-2026-071102"];
        assert.equal((await api("admin-ADMIN", "PATCH", `/jobs/${second.id}/import-suffix`, { suffix: "05" })).status, 200);
        const { preview: p, chunks } = await importRows(renumber([row(1, 3100), row(3, 3150), row(4, 3260), row(5, 3420)]));
        assert.deepEqual(p.jobGroups.map((g) => [g.jobCode, g.state]), [["JOB-2026-071101", "EXISTING"], ["JOB-2026-071105", "EXISTING"], ["JOB-2026-071102", "NEW"]]);
        assert.ok(p.jobGroups[2].codes.includes("JOB_GROUP_ADDED_LATER"));
        assert.equal(chunks[0].counts.jobsCreated, 1);
        assert.deepEqual(Object.keys(await jobsByCode()).sort(), ["JOB-2026-071101", "JOB-2026-071102", "JOB-2026-071105"]);
        assert.deepEqual(await membersOf("JOB-2026-071101"), [1, 3].map(passportOf).sort(), "row 1 again: not added twice");
        assert.deepEqual(await membersOf("JOB-2026-071105"), [2, 4].map(passportOf).sort());
    });

    test("only PASS candidates are put on the Job; FAIL ones are imported and reported", async () => {
        const { preview: p } = await importRows(renumber([row(1, 3100), row(2, 3110, "11.07.2026", { "INTERVIEW PASS FAIL": "FAIL" })]));
        assert.deepEqual(await membersOf("JOB-2026-071101"), [passportOf(1)]);
        assert.ok(p.rowIssues.find((r) => r.rowNumber === 3).warnings.includes("Test result is not PASS: imported, but not put on its Job"));
        assert.ok(await prisma.candidate.findUnique({ where: { passportId: passportOf(2) } }));
    });

    test("a group whose rows name different companies gets no Job; its rows are imported and told why", async () => {
        const { preview: p } = await importRows(renumber([row(1, 3100), row(2, 3150, "11.07.2026", { COMPANY: "Other Co" })]));
        assert.deepEqual([p.jobGroups[0].state, p.jobGroups[0].codes], ["ERROR", ["JOB_GROUP_COMPANY_CONFLICT"]]);
        assert.equal(await prisma.job.count(), 0);
        assert.equal(await prisma.candidate.count(), 2);
        assert.ok(p.rowIssues.find((r) => r.rowNumber === 2).warnings.includes("Its Job group has a problem (see Jobs from this upload): not put on a Job"));
    });

    test("an invalid or missing UNIQUE NUMBER (with an Interview date) puts nobody on a Job, reported", async () => {
        const { preview: p } = await importRows(renumber([row(1, null), row(2, null, "11.07.2026", { "UNIQUE NUMBER": "abc" })]));
        assert.equal(await prisma.job.count(), 0);
        assert.match(p.rowIssues.find((r) => r.rowNumber === 2).warnings.join(" "), /Unique number is missing/);
        assert.match(p.rowIssues.find((r) => r.rowNumber === 3).warnings.join(" "), /Unique number is not a whole number/);
    });

    test("preview edits: the last two digits of a NEW Job are chosen before the import, checked again, and used", async () => {
        const rows = renumber([row(1, 3100), row(2, 3200)]);
        const p = await preview(rows);
        const [first, second] = p.jobGroups;
        await assert.rejects(updateImportJobGroups({ db: prisma, actor: ADMIN, importId: p.importId, suffixes: { [first.key]: "02" }, now: TODAY }), { code: "JOB_GROUP_SUFFIX_INVALID" });
        await assert.rejects(updateImportJobGroups({ db: prisma, actor: ADMIN, importId: p.importId, suffixes: { [first.key]: "7" }, now: TODAY }), { code: "JOB_GROUP_SUFFIX_INVALID" });
        const saved = await updateImportJobGroups({ db: prisma, actor: ADMIN, importId: p.importId, suffixes: { [second.key]: "09" }, now: TODAY });
        assert.deepEqual(saved.jobGroups.map((g) => [g.jobCode, g.edited]), [["JOB-2026-071101", false], ["JOB-2026-071109", true]]);
        await commitAll(p, rows);
        assert.deepEqual(Object.keys(await jobsByCode()).sort(), ["JOB-2026-071101", "JOB-2026-071109"]);
        await assert.rejects(updateImportJobGroups({ db: prisma, actor: ADMIN, importId: p.importId, suffixes: { [second.key]: "08" }, now: TODAY }), (e) => ["IMPORT_STARTED", "IMPORT_FINISHED"].includes(e.code));
    });

    test("two uploads previewed before either commits: the second reuses the group the first created (never a duplicate Job)", async () => {
        const rowsA = renumber([row(1, 3100)]);
        const rowsB = renumber([row(2, 3150)]);
        const pA = await preview(rowsA);
        const pB = await preview(rowsB);
        assert.equal(pB.jobGroups[0].state, "NEW", "both planned it as new");
        await commitAll(pA, rowsA);
        await commitAll(pB, rowsB);
        assert.equal(await prisma.job.count(), 1);
        assert.deepEqual(await membersOf("JOB-2026-071101"), [1, 2].map(passportOf).sort());
    });
});

describe("editing the last two digits after the import (PATCH /jobs/:jobId/import-suffix)", () => {
    test("ADMIN, JOB_HANDLER and an Analyst for their own candidates' Job may; TEAM_LEAD, REGISTRATION_DESK and another Analyst may not", async () => {
        await importRows(renumber([row(1, 3100)])); // OFFICER John: allocated to u-john
        const job = (await jobsByCode())["JOB-2026-071101"];
        const edit = (who, suffix) => api(who, "PATCH", `/jobs/${job.id}/import-suffix`, { suffix });
        assert.equal((await edit("u-tim", "02")).status, 403);
        assert.equal((await edit("u-rita", "02")).status, 403);
        assert.equal((await edit("u-anna", "02")).status, 404, "an Analyst without a candidate on it does not see it");
        const byAnalyst = await edit("u-john", "03");
        assert.deepEqual([byAnalyst.status, byAnalyst.body.jobCode], [200, "JOB-2026-071103"]);
        assert.equal((await edit("u-jay", "04")).body.jobCode, "JOB-2026-071104");
        assert.equal((await edit("admin-ADMIN", "06")).body.jobCode, "JOB-2026-071106");
        const audits = await prisma.auditLog.findMany({ where: { action: "UPDATE_JOB", newValue: { contains: job.id } }, orderBy: { createdDate: "asc" } });
        assert.deepEqual(audits.map((a) => [a.previousStatus, a.newStatus]), [["JOB-2026-071101", "JOB-2026-071103"], ["JOB-2026-071103", "JOB-2026-071104"], ["JOB-2026-071104", "JOB-2026-071106"]]);
    });

    test("two digits only; a code already used is refused; a manual Job has no editable digits", async () => {
        await importRows(renumber([row(1, 3100), row(2, 3200)]));
        const jobs = await jobsByCode();
        const edit = (id, suffix) => api("admin-ADMIN", "PATCH", `/jobs/${id}/import-suffix`, { suffix });
        for (const bad of ["1", "001", "00", "ab", null]) assert.equal((await edit(jobs["JOB-2026-071101"].id, bad)).status, 400, String(bad));
        const taken = await edit(jobs["JOB-2026-071101"].id, "02");
        assert.deepEqual([taken.status, taken.body.code], [409, "JOB_CODE_TAKEN"]);
        await pg.exec(`INSERT INTO "job" ("id","job_code","client_id","responsible_agent_id","country_code","created_by","updated_at")
            SELECT gen_random_uuid(), 'JOB-2026-000001', "client_id", "responsible_agent_id", 'RO', 'admin-ADMIN', now() FROM "job" LIMIT 1`);
        const manual = (await jobsByCode())["JOB-2026-000001"];
        assert.deepEqual([(await edit(manual.id, "05")).status, (await edit(manual.id, "05")).body.code], [409, "NOT_AN_IMPORT_JOB"]);
    });
});

describe("performance (synthetic)", () => {
    // One upload, chunk by chunk, counting every database operation.
    async function measure(rows, headers) {
        let operations = 0;
        const counted = prisma.$extends({ query: { async $allOperations({ args, query }) { operations += 1; return query(args); } } });
        const p = await previewImport({ db: counted, actor: ADMIN, fileName: "big.xlsx", headers, rows, now: TODAY });
        const previewOps = operations;
        const perChunk = [];
        for (const [index, chunk] of chunkRows(rows, p.chunkSize).entries()) {
            const before = operations;
            const result = await commitChunk({ db: counted, actor: ADMIN, importId: p.importId, chunkIndex: index, rows: chunk, now: TODAY });
            assert.equal(result.counts.failed, 0);
            perChunk.push(operations - before);
        }
        return { p, previewOps, perChunk };
    }

    test("1,000 rows over 2 dates and 10 groups: the Jobs add a few operations per GROUP in a chunk, never per row", async () => {
        const rows = renumber(Array.from({ length: 1000 }, (_, k) => row(k + 1, 3100 + (k % 500), k % 2 ? "11.07.2026" : "12.07.2026")));
        const noUniqueNumber = rows.map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).filter(([header]) => header !== "UNIQUE NUMBER")) }));
        const withoutJobs = await measure(noUniqueNumber, HEADERS.filter((h) => h !== "UNIQUE NUMBER"));
        await pg.exec(`DELETE FROM "candidate_import"; DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";`);
        const started = performance.now();
        const withJobs = await measure(rows, HEADERS);
        const extra = withJobs.perChunk.map((ops, i) => ops - withoutJobs.perChunk[i]);
        console.log(JSON.stringify({
            event: "import_job_groups.performance", rows: 1000, groups: withJobs.p.jobGroups.length,
            previewOpsAdded: withJobs.previewOps - withoutJobs.previewOps, maxChunkOpsAddedByJobs: Math.max(...extra), ms: Math.round(performance.now() - started),
        }));
        assert.equal(withJobs.p.jobGroups.length, 10);
        assert.equal(await prisma.job.count(), 10);
        assert.equal(await prisma.jobCandidate.count({ where: { isActive: true } }), 1000);
        assert.ok(withJobs.previewOps - withoutJobs.previewOps <= 3, "the preview reads the stored groups and the codes once");
        // A chunk here touches 2 groups (one per date): a NEW group about 15 operations, an existing one about 6.
        assert.ok(Math.max(...extra) <= 2 * 16, `operations added per chunk ${Math.max(...extra)}`);
    });
});
