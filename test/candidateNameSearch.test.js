// Candidate name search (every word anywhere in the surname or other names, any case, any spacing)
// and the search-box suggestions (GET /candidate-suggestions): scoped exactly like the list.
// Real PostgreSQL (PGlite, every migration applied), the real Prisma client and the real admin
// router. Synthetic data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { SUGGESTION_LIMIT, suggestionRank } from "../src/services/candidateService.js";
import { normalizeSearchText, searchTokens } from "../src/utils/searchText.js";

const ROLES = ["ADMIN", "TEAM_LEAD", "ANALYST", "ANALYST2", "REGISTRATION_DESK", "JOB_HANDLER"];
const user = (key, n) => ({
    adminId: `u-${key.toLowerCase()}`, role: key === "ANALYST2" ? "ANALYST" : key, name: `${key} user`, email: `${key.toLowerCase()}@example.invalid`,
    authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status: "ACTIVE",
});
const USERS = Object.fromEntries(ROLES.map((key, n) => [key, user(key, n + 1)]));

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
    await pg.exec(`DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";`);
});

function app() {
    const server = express();
    server.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.headers["x-test-user"] }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    server.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit }));
    server.use(errorHandler);
    return server;
}
async function api(who, path) {
    const listener = await new Promise((resolve) => { const s = app().listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${listener.address().port}/api/admin${path}`, { headers: { "x-test-user": who.adminId } });
        return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
        listener.close();
    }
}

// first_name holds the other (given) names, other_name the surname. Display: "NIMAL PERERA SILVA".
const C = {
    S1: { passportId: "N1100001", uniqueId: "8101", firstName: "NIMAL PERERA", otherName: "SILVA", nic: "199011111111", whatsappNumber: "+94771234567", job: "WELDER", createdDate: new Date("2026-11-01T04:00:00Z") },
    S2: { passportId: "N1100002", uniqueId: "8102", firstName: "NIMESH", otherName: "FERNANDO", nic: "901111111V", job: "WELDER", createdDate: new Date("2026-11-02T04:00:00Z") },
    S3: { passportId: "N1100003", uniqueId: "8103", firstName: "DINIM", otherName: "PERERA", job: "CAREGIVER", createdDate: new Date("2026-11-03T04:00:00Z") },
    S4: { passportId: "N1100004", uniqueId: "8104", firstName: "KAMAL", otherName: "NIMALASIRI", job: "WELDER", createdDate: new Date("2026-11-04T04:00:00Z") },
    S5: { passportId: "NI1234567", uniqueId: "8105", firstName: "RUWAN", otherName: "BANDARA", job: "WELDER", createdDate: new Date("2026-11-05T04:00:00Z") },
};
const ID = Object.fromEntries(Object.entries(C).map(([key, row]) => [key, row.passportId]));
// S1, S3 -> ANALYST; S2 -> ANALYST2; S4, S5 unallocated.
async function seed() {
    await prisma.candidate.createMany({ data: Object.values(C) });
    await prisma.candidateAllocation.createMany({ data: [
        { passportId: ID.S1, analystId: USERS.ANALYST.adminId },
        { passportId: ID.S3, analystId: USERS.ANALYST.adminId },
        { passportId: ID.S2, analystId: USERS.ANALYST2.adminId },
    ] });
}
const ids = (body) => body.items.map((item) => item.passportId).sort();
const sorted = (...keys) => keys.map((key) => ID[key]).sort();
const search = async (text, who = USERS.ADMIN, extra = "") => {
    const res = await api(who, `/candidates?search=${encodeURIComponent(text)}${extra}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return ids(res.body);
};
const suggest = (q, who = USERS.ADMIN, extra = "") => api(who, `/candidate-suggestions?q=${encodeURIComponent(q)}${extra}`);

describe("search normalisation (one helper)", () => {
    test("NORM: trimmed, spaces collapsed, lowercase; tokens capped", () => {
        assert.equal(normalizeSearchText("  NIMAL   PERERA  "), "nimal perera");
        assert.equal(normalizeSearchText("\tNimal\n Silva "), "nimal silva");
        assert.equal(normalizeSearchText(undefined), "");
        assert.deepEqual(searchTokens("  NIMAL   PERERA  "), ["nimal", "perera"]);
        assert.deepEqual(searchTokens("a b c d e f g"), ["a", "b", "c", "d", "e"]);
        assert.deepEqual(searchTokens("   "), []);
    });
});

describe("quick search: full-name token matching", () => {
    test("NAME-001..003 one part: first name, surname, middle name", async () => {
        await seed();
        assert.deepEqual(await search("nimesh"), sorted("S2"));
        assert.deepEqual(await search("fernando"), sorted("S2"));
        assert.deepEqual(await search("perera"), sorted("S1", "S3"), "PERERA is S1's middle name and S3's surname");
    });

    test("NAME-004..006 two and three parts, across surname and other names, in any order", async () => {
        await seed();
        assert.deepEqual(await search("nimal perera"), sorted("S1"));
        assert.deepEqual(await search("nimal perera silva"), sorted("S1"));
        assert.deepEqual(await search("nimal silva"), sorted("S1"), "nimal in other names, silva in surname");
        assert.deepEqual(await search("Perera Silva"), sorted("S1"));
        assert.deepEqual(await search("silva nimal"), sorted("S1"));
    });

    test("NAME-007..011 any letter case and any spacing", async () => {
        await seed();
        for (const text of ["NIMAL SILVA", "nimal silva", "NiMaL sIlVa", "nimal     silva", "   nimal silva   ", "\tnimal\tsilva "]) {
            assert.deepEqual(await search(text), sorted("S1"), JSON.stringify(text));
        }
    });

    test("NAME-012 no match: every word must match", async () => {
        await seed();
        assert.deepEqual(await search("nimal fernando"), []);
        assert.deepEqual(await search("zzz"), []);
    });

    test("NAME-013 name search AND an advanced filter (and the Full name filter itself)", async () => {
        await seed();
        assert.deepEqual(await search("perera", USERS.ADMIN, "&jobType=CAREGIVER"), sorted("S3"));
        assert.deepEqual(await search("nim", USERS.ADMIN, "&jobType=WELDER&allocation=UNALLOCATED"), sorted("S4"));
        const res = await api(USERS.ADMIN, `/candidates?name=${encodeURIComponent("  NIMAL   silva ")}`);
        assert.deepEqual(ids(res.body), sorted("S1"));
        assert.equal(res.body.filters.name, "NIMAL silva", "echoed trimmed, spaces collapsed, the typed case kept");
    });

    test("NAME-014 name search with pagination: totals and pages cover every match", async () => {
        await prisma.candidate.createMany({ data: Array.from({ length: 130 }, (_, i) => ({
            passportId: `P${String(2000000 + i)}`, uniqueId: String(6000 + i), firstName: `BULK ${i}`, otherName: i % 2 ? "MATCHNAME" : "OTHERNAME",
            createdDate: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
        })) });
        const first = await api(USERS.ADMIN, "/candidates?search=BULK%20%20matchname&pageSize=50");
        const rest = [];
        for (let page = 2; page <= first.body.pagination.totalPages; page++) rest.push(...(await api(USERS.ADMIN, `/candidates?search=bulk%20matchname&pageSize=50&page=${page}`)).body.items);
        assert.deepEqual([first.body.pagination.total, first.body.pagination.totalPages], [65, 2]);
        assert.equal(new Set([...first.body.items, ...rest].map((item) => item.passportId)).size, 65);
    });

    test("NAME-015 passport, NIC and phone search still work", async () => {
        await seed();
        assert.deepEqual(await search("n1100002"), sorted("S2"));
        assert.deepEqual(await search("199011111111"), sorted("S1"));
        assert.deepEqual(await search("0771234567"), sorted("S1"), "0… finds the stored +94…");
        assert.deepEqual(await search("NI1234"), sorted("S5"));
    });

    test("NAME-016 Work Allocation: the same matching, inside the view", async () => {
        await seed();
        const wa = async (query) => ids((await api(USERS.ADMIN, `/work-allocation/candidates?${query}`)).body);
        assert.deepEqual(await wa("status=UNALLOCATED&search=nim"), sorted("S4"));
        assert.deepEqual(await wa("status=ALLOCATED&search=nim"), sorted("S1", "S2", "S3"));
        assert.deepEqual(await wa("status=ALLOCATED&search=%20NIMAL%20%20silva%20"), sorted("S1"));
        assert.deepEqual(await wa("status=UNALLOCATED&search=nimal%20silva"), [], "S1 is allocated");
    });

    test("NAME-017 RBAC: an ANALYST's name search stays within their candidates", async () => {
        await seed();
        assert.deepEqual(await search("nim", USERS.ANALYST), sorted("S1", "S3"));
        assert.deepEqual(await search("nimesh fernando", USERS.ANALYST), [], "S2 is ANALYST2's");
        assert.deepEqual(await search("kamal nimalasiri", USERS.ANALYST), [], "S4 is unallocated");
    });
});

describe("suggestions (GET /candidate-suggestions)", () => {
    test("SUG-015 nothing below two characters (and nothing is read)", async () => {
        await seed();
        for (const q of ["", "n", " n "]) {
            const res = await suggest(q);
            assert.equal(res.status, 200);
            assert.deepEqual(res.body.items, [], JSON.stringify(q));
        }
        assert.deepEqual((await api(USERS.ADMIN, "/candidate-suggestions")).body.items, []);
    });

    test("SUG-016 / 020 partial first name, ranked: name starts > a name word starts > contains", async () => {
        await seed();
        const res = await suggest("nim");
        assert.deepEqual(res.body.items.map((item) => item.passportId), [ID.S1, ID.S2, ID.S4, ID.S3]);
        assert.deepEqual(res.body.items[0], { passportId: ID.S1, name: "NIMAL PERERA SILVA", nic: "199011111111" }, "only name, passport and NIC");
        assert.deepEqual(res.body.items.map((item) => suggestionRank({ passportId: item.passportId, firstName: item.name, otherName: null, nic: item.nic }, "nim")), [0, 0, 1, 3]);
    });

    test("SUG-017 partial surname, and several words", async () => {
        await seed();
        assert.deepEqual((await suggest("fern")).body.items.map((item) => item.passportId), [ID.S2]);
        assert.deepEqual((await suggest("nimal sil")).body.items.map((item) => item.passportId), [ID.S1]);
        assert.deepEqual((await suggest("ni12")).body.items.map((item) => item.passportId), [ID.S5], "passport prefix");
    });

    test("SUG-018 case-insensitive and spacing-tolerant", async () => {
        await seed();
        const expected = (await suggest("nim")).body.items;
        for (const q of ["NIM", "Nim", "  nIm  "]) assert.deepEqual((await suggest(q)).body.items, expected, q);
    });

    test("SUG-019 at most SUGGESTION_LIMIT, and a strong older match is not pushed out by many newer weak ones", async () => {
        await prisma.candidate.createMany({ data: [
            { passportId: "N3000000", uniqueId: "7000", firstName: "NIMAL", otherName: "OLDEST", createdDate: new Date("2020-01-01T00:00:00Z") },
            ...Array.from({ length: 70 }, (_, i) => ({ passportId: `N${3000001 + i}`, uniqueId: String(7001 + i), firstName: `XANIMX${i}`, otherName: "WEAK", createdDate: new Date(Date.UTC(2026, 0, 1) + i * 60_000) })),
        ] });
        const items = (await suggest("nim")).body.items;
        assert.equal(items.length, SUGGESTION_LIMIT);
        assert.equal(items[0].passportId, "N3000000", "the only name that starts with nim comes first");
    });

    test("SUG-021 an ANALYST is suggested only their own candidates", async () => {
        await seed();
        assert.deepEqual(ids((await suggest("nim", USERS.ANALYST)).body), sorted("S1", "S3"));
        assert.deepEqual(ids((await suggest("nim", USERS.ANALYST2)).body), sorted("S2"));
        assert.deepEqual((await suggest("nimesh", USERS.ANALYST)).body.items, []);
        assert.equal((await suggest("nim", USERS.ANALYST, "&allocation=UNALLOCATED")).status, 400, "not their filter");
    });

    test("SUG-022 ADMIN / TEAM_LEAD / JOB_HANDLER: every candidate, as the list; REGISTRATION_DESK: 403", async () => {
        await seed();
        const all = sorted("S1", "S2", "S3", "S4");
        for (const who of [USERS.ADMIN, USERS.TEAM_LEAD, USERS.JOB_HANDLER]) assert.deepEqual(ids((await suggest("nim", who)).body), all, who.role);
        assert.equal((await suggest("nim", USERS.REGISTRATION_DESK)).status, 403);
        assert.equal((await suggest("x".repeat(101))).status, 400);
    });

    test("SUG-023 Work Allocation view: Unallocated never suggests an allocated candidate, and the reverse", async () => {
        await seed();
        assert.deepEqual(ids((await suggest("nim", USERS.ADMIN, "&allocation=UNALLOCATED")).body), sorted("S4"));
        assert.deepEqual(ids((await suggest("nim", USERS.TEAM_LEAD, "&allocation=ALLOCATED")).body), sorted("S1", "S2", "S3"));
        assert.equal((await suggest("nim", USERS.ADMIN, "&allocation=MAYBE")).status, 400);
    });
});
