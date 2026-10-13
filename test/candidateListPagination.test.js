// Candidates list: server-side paging (100 a page). On a REAL PostgreSQL
// (PGlite, every migration applied) through the real Prisma client and the
// real admin router, with 247 generated candidates. No Supabase: the
// signed-in user is set by a stand-in for requireActiveUser.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { CANDIDATE_LIST_PAGE_SIZE, listCandidates, parseCandidateListQuery } from "../src/services/candidateService.js";

const TOTAL = 247;
const ADMIN = { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.invalid", role: "ADMIN" };

let database;
let prisma;
let pg;
// Every passport ID in the list's order: newest first, passport ID for ties.
let expectedOrder;

// Candidate i: passport P0000001…, registered one minute after the one
// before, except that every tenth shares its predecessor's time (the
// passport ID then decides the order, so ties are exercised too).
async function seed(count) {
    await pg.exec(`
        DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate"; DELETE FROM "sheet_sync_queue";
        INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "other_name", "job", "created_date", "updated_date")
        SELECT 'P' || lpad(i::text, 7, '0'), lpad(i::text, 4, '0'), 'Given' || i, 'Surname', 'Driver',
               timestamp '2026-01-01 00:00:00' + ((i - (CASE WHEN i % 10 = 0 THEN 1 ELSE 0 END)) * interval '1 minute'), now()
        FROM generate_series(1, ${count}) AS i;
    `);
    const rows = (await pg.query(`SELECT passport_id FROM "candidate" ORDER BY created_date DESC, passport_id ASC`)).rows;
    expectedOrder = rows.map((r) => r.passport_id);
}

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ADMIN });
    await seed(TOTAL);
});
after(async () => database?.close());

async function get(query = "", role = "ADMIN") {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: (req, res, next) => { req.user = { ...ADMIN, role, status: "ACTIVE" }; next(); }, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/candidates${query}`);
        return { status: response.status, body: await response.json() };
    } finally {
        server.close();
    }
}
const ids = (body) => body.items.map((item) => item.passportId);

describe("paging", () => {
    test("1-2. the default request is page 1: the first 100 candidates, newest first", async () => {
        const { status, body } = await get();
        assert.equal(status, 200);
        assert.equal(CANDIDATE_LIST_PAGE_SIZE, 100);
        assert.equal(body.items.length, 100);
        assert.deepEqual(ids(body), expectedOrder.slice(0, 100));
        assert.equal(ids(body)[0], "P0000247", "the newest candidate first");
    });

    test("3-5, 11. page 2 is the next 100, page 3 the remaining 47; no candidate twice, none skipped, same order throughout", async () => {
        const pages = [];
        for (const page of [1, 2, 3]) pages.push((await get(`?page=${page}&pageSize=100`)).body);
        assert.deepEqual(pages.map((p) => p.items.length), [100, 100, 47]);
        assert.deepEqual(ids(pages[1]), expectedOrder.slice(100, 200));
        assert.deepEqual(ids(pages[2]), expectedOrder.slice(200));
        const all = pages.flatMap(ids);
        assert.equal(new Set(all).size, TOTAL, "no candidate on two pages");
        assert.deepEqual(all, expectedOrder, "every candidate once, in the list order");
        // Ties on the registration time are ordered by passport ID.
        assert.ok(all.indexOf("P0000009") < all.indexOf("P0000010"));
    });

    test("6-8. pagination metadata: totals, pages, next / previous", async () => {
        const meta = async (page) => (await get(`?page=${page}`)).body.pagination;
        assert.deepEqual(await meta(1), { page: 1, pageSize: 100, total: 247, totalItems: 247, totalPages: 3, hasNextPage: true, hasPreviousPage: false });
        assert.deepEqual(await meta(2), { page: 2, pageSize: 100, total: 247, totalItems: 247, totalPages: 3, hasNextPage: true, hasPreviousPage: true });
        assert.deepEqual(await meta(3), { page: 3, pageSize: 100, total: 247, totalItems: 247, totalPages: 3, hasNextPage: false, hasPreviousPage: true });
    });

    test("a page past the last one is empty, with the real totals (so the page can go back)", async () => {
        const { status, body } = await get("?page=4");
        assert.equal(status, 200);
        assert.deepEqual(body.items, []);
        assert.equal(body.pagination.totalPages, 3);
        assert.equal(body.pagination.hasNextPage, false);
        assert.equal(body.pagination.hasPreviousPage, true);
    });

    test("9-10. invalid page values and a page size over 100 are refused cleanly (400), nothing is read", async () => {
        for (const query of ["?page=0", "?page=-1", "?page=abc", "?page=1.5", "?page=10001", "?pageSize=101", "?pageSize=1000", "?pageSize=0", "?page=1&page=2"]) {
            const { status, body } = await get(query);
            assert.equal(status, 400, query);
            assert.equal(body.message, "Invalid query parameters");
            assert.ok(body.errors.length > 0, query);
        }
        assert.deepEqual(parseCandidateListQuery({}).params, { page: 1, pageSize: 100 });
        assert.deepEqual(parseCandidateListQuery({ page: "", pageSize: "" }).params, { page: 1, pageSize: 100 }, "blank = default");
        assert.deepEqual(parseCandidateListQuery({ page: "2", pageSize: "25" }).params, { page: 2, pageSize: 25 }, "a smaller page is still allowed");
    });

    test("search pages over the matching candidates only", async () => {
        const { body } = await get("?search=Given24");
        // Given24, Given240 … Given247: newest first.
        assert.deepEqual(ids(body), ["P0000247", "P0000246", "P0000245", "P0000244", "P0000243", "P0000242", "P0000241", "P0000240", "P0000024"]);
        assert.equal(body.pagination.totalItems, 9);
        assert.equal(body.pagination.totalPages, 1);
    });

    test("12. one COUNT and one bounded query (at most 100 rows), never every candidate", async () => {
        const calls = [];
        const counting = new Proxy(prisma, {
            get(target, model) {
                const delegate = target[model];
                if (!delegate || typeof delegate !== "object") return delegate;
                return new Proxy(delegate, {
                    get(d, method) {
                        const fn = d[method];
                        return typeof fn === "function"
                            ? async (...args) => { const result = await fn.apply(d, args); calls.push({ call: `${String(model)}.${String(method)}`, args: args[0], rows: Array.isArray(result) ? result.length : null }); return result; }
                            : fn;
                    },
                });
            },
        });
        await listCandidates({ db: counting, params: { page: 2, pageSize: 100 } });
        assert.deepEqual(calls.map((c) => c.call).sort(), ["candidate.count", "candidate.findMany"]);
        const list = calls.find((c) => c.call === "candidate.findMany");
        assert.equal(list.args.take, 100);
        assert.equal(list.args.skip, 100);
        assert.equal(list.rows, 100, "page 2 reads 100 candidates");
        assert.deepEqual(list.args.orderBy, [{ createdDate: "desc" }, { passportId: "asc" }]);
        // Only what a row shows: no address, dates of birth or other details.
        for (const field of ["address", "dateOfBirth", "placeOfBirth", "contactNumber", "nationality", "sex"]) assert.ok(!(field in list.args.select), field);
        assert.ok(list.args.select.stages && list.args.select.documents, "stages and required documents are loaded with the page");
    });

    test("rows keep their shape: name, NIC, job types and every stage", async () => {
        const { body } = await get();
        const row = body.items.find((item) => item.passportId === "P0000247");
        assert.deepEqual(Object.keys(row).sort(), ["jobTypes", "name", "nic", "passportId", "stages", "uniqueId"]);
        assert.equal(row.name, "Given247 Surname");
        assert.deepEqual(row.jobTypes, ["Driver"]);
        assert.equal(row.stages.length, 7);
        assert.deepEqual(body.filters, { search: null });
    });

    test("13. roles are unchanged: every Candidates role can list; any other role can't", async () => {
        for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) assert.equal((await get("?page=1", role)).status, 200, role);
        for (const role of ["VIEWER", "UNKNOWN"]) assert.equal((await get("?page=1", role)).status, 403, role);
    });
});

describe("search by contact number (server-side, before paging)", () => {
    // Candidates registered long ago sit on pages 2 and 3 of the full list.
    before(async () => {
        await pg.exec(`
            UPDATE "candidate" SET contact_number = '0773344556' WHERE passport_id = 'P0000050';
            UPDATE "candidate" SET contact_number = '94772233445' WHERE passport_id = 'P0000003';
            UPDATE "candidate" SET whatsapp_number = '94775551234', nic = '199012345678' WHERE passport_id = 'P0000010';
        `);
    });

    test("1, 9-10. an exact contact number finds a candidate that is not on page 1 of the full list, as result page 1", async () => {
        const { body: unfiltered } = await get("?page=1");
        assert.ok(!ids(unfiltered).includes("P0000050"), "on page 2, not among the first 100");
        assert.ok(ids((await get("?page=2")).body).includes("P0000050"));
        const { status, body } = await get("?search=0773344556");
        assert.equal(status, 200);
        assert.deepEqual(ids(body), ["P0000050"]);
        assert.deepEqual([body.pagination.page, body.pagination.totalItems, body.pagination.totalPages, body.pagination.pageSize], [1, 1, 1, 100]);
    });

    test("2. a partial contact number matches", async () => {
        assert.deepEqual(ids((await get("?search=3344556")).body), ["P0000050"]);
        assert.deepEqual(ids((await get("?search=77334")).body), ["P0000050"]);
    });

    test("3-4. local and international forms match each other, as for WhatsApp numbers", async () => {
        assert.deepEqual(ids((await get("?search=0772233445")).body), ["P0000003"], "local search, stored 94…");
        assert.deepEqual(ids((await get("?search=94773344556")).body), ["P0000050"], "94… search, stored local");
        assert.deepEqual(ids((await get("?search=%2B94772233445")).body), ["P0000003"], "+94… search");
    });

    test("5-8. WhatsApp number, passport ID, name and NIC searches still work", async () => {
        assert.deepEqual(ids((await get("?search=0775551234")).body), ["P0000010"], "WhatsApp, local form");
        assert.deepEqual(ids((await get("?search=94775551234")).body), ["P0000010"]);
        assert.deepEqual(ids((await get("?search=P0000010")).body), ["P0000010"]);
        const byName = ids((await get("?search=Given10 Surname")).body);
        assert.ok(byName.includes("P0000010") && byName.length === 11, "name: Given10 and Given100-109");
        assert.deepEqual(ids((await get("?search=199012345678")).body), ["P0000010"]);
    });

    test("10. paging still happens on the server: only matches are counted, the rest of the list is untouched", async () => {
        const { body } = await get("?search=Surname&page=3");
        assert.equal(body.pagination.totalItems, 247);
        assert.equal(body.items.length, 47);
        assert.equal((await get("?search=0000000000")).body.pagination.totalItems, 0);
    });
});

describe("edge cases", () => {
    after(async () => seed(TOTAL));

    test("14. no candidates: an empty page 1 of 1", async () => {
        await seed(0);
        const { body } = await get();
        assert.deepEqual(body, { items: [], pagination: { page: 1, pageSize: 100, total: 0, totalItems: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false }, filters: { search: null } });
    });

    test("exactly 100: one page; 101: a second page holding one candidate", async () => {
        await seed(100);
        let { body } = await get();
        assert.equal(body.items.length, 100);
        assert.equal(body.pagination.totalPages, 1);
        assert.equal(body.pagination.hasNextPage, false);

        await seed(101);
        ({ body } = await get());
        assert.equal(body.items.length, 100);
        assert.equal(body.pagination.totalPages, 2);
        assert.equal(body.pagination.hasNextPage, true);
        ({ body } = await get("?page=2"));
        assert.deepEqual(ids(body), ["P0000001"], "the oldest candidate");
    });

    test("removing a candidate can empty the last page: it comes back empty with the new totals", async () => {
        await seed(101);
        await pg.exec(`DELETE FROM "candidate" WHERE passport_id = 'P0000001'`);
        const { body } = await get("?page=2");
        assert.deepEqual(body.items, []);
        assert.equal(body.pagination.totalItems, 100);
        assert.equal(body.pagination.totalPages, 1);
    });
});
