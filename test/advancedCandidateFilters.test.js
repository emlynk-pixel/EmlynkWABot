// Advanced candidate filters (candidateListFilters.js) on Admin > Candidates (GET /candidates) and
// Work Allocation (GET /work-allocation/candidates): every filter applied in the database before
// paging, AND-ed with each other, the quick search and the user's candidate scope. Real PostgreSQL
// (PGlite, every migration applied), the real Prisma client and the real admin router. Synthetic
// data only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { CANDIDATE_STAGES } from "../src/services/candidateService.js";
import { CANDIDATE_STAGE_KEYS, candidateFilterWhere, parseCandidateFilters } from "../src/services/candidateListFilters.js";

const ROLES = ["ADMIN", "OWNER", "TEAM_LEAD", "ANALYST", "ANALYST2", "REGISTRATION_DESK", "JOB_HANDLER"];
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
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "candidate_form_access";
        DELETE FROM "candidate_allocation"; DELETE FROM "documents"; DELETE FROM "candidate_stages";
        DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent"; DELETE FROM "candidate";
    `);
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

// Registered times are UTC; Sri Lanka is UTC+5:30.
//   C1 Nov 1 07:30 SL   C2 Nov 30 22:30 SL (evening: after UTC midnight's day)   C3 Dec 1 05:30 SL
//   C4 Oct 15           C5 Nov 15
const C = {
    C1: { passportId: "N1000001", uniqueId: "9101", firstName: "KAMAL", otherName: "PERERA", nic: "199012345678", whatsappNumber: "+94771234567", job: "Steel Fixer, Welder", sex: "M", nationality: "Sri Lankan", createdDate: new Date("2026-11-01T02:00:00.000Z") },
    C2: { passportId: "N1000002", uniqueId: "9102", firstName: "NIMAL", otherName: "PERERA", nic: "901234567V", whatsappNumber: "0712345678", job: "Formwork Carpenter", sex: "M", createdDate: new Date("2026-11-30T17:00:00.000Z") },
    C3: { passportId: "P2000003", uniqueId: "9103", firstName: "SAMAN", otherName: "SILVA", nic: "199555555555", job: "Welder", sex: "F", createdDate: new Date("2026-12-01T00:00:00.000Z") },
    C4: { passportId: "PN1234567", uniqueId: "9104", firstName: "ANUSHA", otherName: "PERERA", job: "Steel Fixer", sex: "F", createdDate: new Date("2026-10-15T06:00:00.000Z") },
    C5: { passportId: "N1000005", uniqueId: "9105", firstName: "RUWAN", otherName: "FERNANDO", job: "Pipe Welder", sex: "M", createdDate: new Date("2026-11-15T06:00:00.000Z") },
};
const ID = Object.fromEntries(Object.entries(C).map(([key, row]) => [key, row.passportId]));

// C1: test PASS on Nov 10, Visa submitted (Status VISA_SUBMITTED), on an active job of ACME.
// C3: test PASS on Nov 20. C4: test FAIL (Stopped with Test). C2: on a job no longer active.
// Allocations: C1, C2 -> ANALYST; C3 -> ANALYST2; C4, C5 unallocated.
async function seed() {
    await prisma.candidate.createMany({ data: Object.values(C) });
    await prisma.candidateStage.createMany({ data: [
        { passportId: ID.C1, stage: "TEST_DETAILS", testResult: "PASS", completed: true, completedAt: new Date(), testDate: new Date("2026-11-10") },
        { passportId: ID.C1, stage: "VISA_SUBMISSION", completed: true, completedAt: new Date() },
        { passportId: ID.C3, stage: "TEST_DETAILS", testResult: "PASS", completed: true, completedAt: new Date(), testDate: new Date("2026-11-20") },
        { passportId: ID.C4, stage: "TEST_DETAILS", testResult: "FAIL", completed: true, completedAt: new Date() },
    ] });
    await prisma.candidateAllocation.createMany({ data: [
        { passportId: ID.C1, analystId: USERS.ANALYST.adminId },
        { passportId: ID.C2, analystId: USERS.ANALYST.adminId },
        { passportId: ID.C3, analystId: USERS.ANALYST2.adminId },
    ] });
    const agent = await prisma.agent.create({ data: { name: "Bucharest Agent", countryCode: "RO" } });
    const acme = await prisma.client.create({ data: { name: "ACME", agentLinks: { create: { agentId: agent.id } } } });
    const other = await prisma.client.create({ data: { name: "OTHER", agentLinks: { create: { agentId: agent.id } } } });
    const job = (jobCode, clientId) => prisma.job.create({ data: { jobCode, clientId, responsibleAgentId: agent.id, countryCode: "RO", createdById: USERS.ADMIN.adminId } });
    const j1 = await job("JOB-2026-000101", acme.id);
    const j2 = await job("JOB-2026-000202", other.id);
    await prisma.jobCandidate.createMany({ data: [
        { jobId: j1.id, passportId: ID.C1, assignedBy: USERS.ADMIN.adminId },
        { jobId: j2.id, passportId: ID.C2, assignedBy: USERS.ADMIN.adminId, isActive: false, releasedAt: new Date() },
    ] });
    return { agent, acme, other };
}

const list = (who, query) => api(who, `/candidates?${query}`);
const ids = (body) => body.items.map((item) => item.passportId).sort();
const found = async (query, who = USERS.ADMIN) => {
    const res = await list(who, query);
    assert.equal(res.status, 200, `${query}: ${JSON.stringify(res.body)}`);
    return ids(res.body);
};
const sorted = (...keys) => keys.map((key) => ID[key]).sort();

describe("Candidates: each advanced filter on its own", () => {
    test("FILTER-001 name: every word in the surname or the other names", async () => {
        await seed();
        assert.deepEqual(await found("name=perera"), sorted("C1", "C2", "C4"));
        assert.deepEqual(await found("name=kamal%20perera"), sorted("C1"));
        assert.deepEqual(await found("surname=perera&otherNames=nimal"), sorted("C2"));
    });

    test("FILTER-002 passport: contains, starts with, exact (any case)", async () => {
        await seed();
        assert.deepEqual(await found("passport=PN&passportMatch=startsWith"), sorted("C4"));
        assert.deepEqual(await found("passport=000"), sorted("C1", "C2", "C3", "C5"));
        assert.deepEqual(await found("passport=n1000001&passportMatch=equals"), sorted("C1"));
        assert.deepEqual(await found("passport=N100000&passportMatch=equals"), []);
    });

    test("FILTER-003 NIC: contains and exact (any case)", async () => {
        await seed();
        assert.deepEqual(await found("nic=12345"), sorted("C1", "C2"));
        assert.deepEqual(await found("nic=901234567v&nicMatch=equals"), sorted("C2"));
        assert.deepEqual(await found("nic=1995&nicMatch=startsWith"), sorted("C3"));
    });

    test("FILTER-004 job type: one of the candidate's job types exactly, never a substring", async () => {
        await seed();
        assert.deepEqual(await found("jobType=Welder"), sorted("C1", "C3"), "Pipe Welder is not Welder");
        assert.deepEqual(await found("jobType=steel%20fixer"), sorted("C1", "C4"));
    });

    test("FILTER-005 / 017 registered date: inclusive Sri Lanka days, the whole last day included", async () => {
        await seed();
        assert.deepEqual(await found("registeredFrom=2026-11-01&registeredTo=2026-11-30"), sorted("C1", "C2", "C5"), "C2 registered at 22:30 on Nov 30 in Sri Lanka is in; C3 at 05:30 on Dec 1 is not");
        assert.deepEqual(await found("registeredTo=2026-11-30"), sorted("C1", "C2", "C4", "C5"), "only To");
        assert.deepEqual(await found("registeredFrom=2026-12-01"), sorted("C3"), "only From: 00:00 UTC on Dec 1 is Dec 1 in Sri Lanka");
        assert.deepEqual(await found("registeredFrom=2026-11-30&registeredTo=2026-11-30"), sorted("C2"));
    });

    test("FILTER-006 Status (the list's derived Status)", async () => {
        await seed();
        assert.deepEqual(await found("workflowStatus=VISA_SUBMITTED"), sorted("C1"));
        assert.deepEqual(await found("workflowStatus=STOPPED_WITH_TEST"), sorted("C4"));
    });

    test("FILTER-007 current stage (the first stage not completed)", async () => {
        await seed();
        assert.deepEqual(await found("stage=TEST_DETAILS"), sorted("C2", "C5"));
        assert.deepEqual(await found("stage=JOB_DETAILS"), sorted("C1", "C3", "C4"));
        assert.deepEqual(await found("stage=COMPLETE"), []);
    });

    test("FILTER-008 officer and allocation state", async () => {
        await seed();
        assert.deepEqual(await found(`analystId=${USERS.ANALYST.adminId}`), sorted("C1", "C2"));
        assert.deepEqual(await found(`analystId=${USERS.ANALYST.adminId},${USERS.ANALYST2.adminId}`), sorted("C1", "C2", "C3"));
        assert.deepEqual(await found("allocation=UNALLOCATED"), sorted("C4", "C5"));
        assert.deepEqual(await found("allocation=ALLOCATED"), sorted("C1", "C2", "C3"));
    });

    test("FILTER-008b WhatsApp (any stored form), sex, nationality, test date", async () => {
        await seed();
        assert.deepEqual(await found("whatsapp=0771234567"), sorted("C1"), "0… finds the stored +94…");
        assert.deepEqual(await found("whatsapp=%2B94712&whatsappMatch=startsWith"), sorted("C2"), "+94… finds the stored 0…");
        assert.deepEqual(await found("sex=F"), sorted("C3", "C4"));
        assert.deepEqual(await found("sex=M,F"), sorted("C1", "C2", "C3", "C4", "C5"));
        assert.deepEqual(await found("nationality=sri"), sorted("C1"));
        assert.deepEqual(await found("testFrom=2026-11-10&testTo=2026-11-10"), sorted("C1"), "a DATE column: the day itself, inclusive");
        assert.deepEqual(await found("testFrom=2026-11-11"), sorted("C3"));
    });

    test("FILTER-008c current job: client, agent and job code (an active assignment only)", async () => {
        const { agent, acme, other } = await seed();
        assert.deepEqual(await found(`clientId=${acme.id}`), sorted("C1"));
        assert.deepEqual(await found(`clientId=${other.id}`), [], "C2's job assignment is no longer active");
        assert.deepEqual(await found(`agentId=${agent.id}`), sorted("C1"));
        assert.deepEqual(await found("jobCode=000101"), sorted("C1"));
        assert.deepEqual(await found("jobCode=JOB-2026-000202&jobCodeMatch=equals"), []);
    });
});

describe("Candidates: filters combine (AND), with the quick search, before paging", () => {
    test("FILTER-009 several filters: every returned candidate satisfies all of them", async () => {
        await seed();
        assert.deepEqual(await found("jobType=Steel%20Fixer&registeredFrom=2026-11-01&registeredTo=2026-11-30"), sorted("C1"));
        assert.deepEqual(await found("surname=perera&passport=PN&passportMatch=startsWith&workflowStatus=STOPPED_WITH_TEST"), sorted("C4"));
        assert.deepEqual(await found("surname=perera&passport=PN&passportMatch=startsWith&workflowStatus=VISA_SUBMITTED"), []);
        assert.deepEqual(await found("name=perera&sex=M&allocation=ALLOCATED&stage=TEST_DETAILS"), sorted("C2"));
    });

    test("FILTER-010 quick search AND advanced filters", async () => {
        await seed();
        assert.deepEqual(await found("search=perera&jobType=Formwork%20Carpenter"), sorted("C2"));
        assert.deepEqual(await found("search=perera&workflowStatus=VISA_SUBMITTED&jobType=Welder"), sorted("C1"));
        assert.deepEqual(await found("search=silva&name=perera"), []);
    });

    test("FILTER-011 / 012 pagination after filtering: totals and pages are the filtered list's", async () => {
        await seed();
        const first = await list(USERS.ADMIN, "name=perera&pageSize=2");
        assert.deepEqual([first.body.pagination.total, first.body.pagination.totalPages, first.body.items.length], [3, 2, 2]);
        const second = await list(USERS.ADMIN, "name=perera&pageSize=2&page=2");
        assert.equal(second.body.items.length, 1);
        assert.deepEqual([...ids(first.body), ...ids(second.body)].sort(), sorted("C1", "C2", "C4"), "no candidate twice, none skipped");
        // Newest registered first across the pages.
        assert.deepEqual([...first.body.items, ...second.body.items].map((item) => item.passportId), [ID.C2, ID.C1, ID.C4]);
        // A derived filter pages the same way.
        const derivedFirst = await list(USERS.ADMIN, "jobType=Welder&pageSize=1");
        const derivedSecond = await list(USERS.ADMIN, "jobType=Welder&pageSize=1&page=2");
        assert.deepEqual([derivedFirst.body.pagination.total, derivedFirst.body.pagination.totalPages], [2, 2]);
        assert.deepEqual([derivedFirst.body.items[0].passportId, derivedSecond.body.items[0].passportId], [ID.C3, ID.C1]);
    });

    test("FILTER-011b pagination at scale: 230 candidates, a filter matching 115 gives pages of 100 and 15", async () => {
        const many = Array.from({ length: 230 }, (_, i) => ({
            passportId: `P${String(i).padStart(7, "0")}`, uniqueId: `7${String(i).padStart(4, "0")}`, firstName: `F${i}`, otherName: i % 2 ? "BULKODD" : "BULKEVEN",
            job: "TILER", createdDate: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
        }));
        await prisma.candidate.createMany({ data: many });
        const first = await list(USERS.ADMIN, "surname=bulkodd");
        const second = await list(USERS.ADMIN, "surname=bulkodd&page=2");
        assert.deepEqual([first.body.pagination.total, first.body.pagination.totalPages, first.body.items.length, second.body.items.length], [115, 2, 100, 15]);
        assert.equal(new Set([...ids(first.body), ...ids(second.body)]).size, 115);
    });

    test("FILTER-013 no matches: an empty first page with real totals", async () => {
        await seed();
        const res = await list(USERS.ADMIN, "name=nobody");
        assert.deepEqual(res.body.items, []);
        assert.deepEqual([res.body.pagination.total, res.body.pagination.totalPages], [0, 1]);
        assert.equal(res.body.filters.name, "nobody", "the applied filters are echoed back");
    });

    test("FILTER-016 matching ignores letter case", async () => {
        await seed();
        assert.deepEqual(await found("surname=PeReRa&otherNames=kAmAl"), sorted("C1"));
        assert.deepEqual(await found("jobType=FORMWORK%20carpenter"), sorted("C2"));
    });

    test("FILTER-018 / 019 multi-select: any of the job types, any of the statuses (IN)", async () => {
        await seed();
        assert.deepEqual(await found("jobType=Steel%20Fixer,Formwork%20Carpenter"), sorted("C1", "C2", "C4"));
        assert.deepEqual(await found("workflowStatus=VISA_SUBMITTED,STOPPED_WITH_TEST"), sorted("C1", "C4"));
        assert.deepEqual(await found("stage=TEST_DETAILS,JOB_DETAILS&jobType=Welder,Pipe%20Welder"), sorted("C1", "C3", "C5"));
    });
});

describe("Candidates: validation", () => {
    test("FILTER-014 invalid filters are refused with 400 before anything is read", async () => {
        await seed();
        for (const query of [
            "passport=PN&passportMatch=regex", "name=kamal&nameMatch=equals", "registeredFrom=2026-02-30", "registeredTo=yesterday",
            "registeredFrom=2026-11-30&registeredTo=2026-11-01", "testFrom=2026-13-01", "sex=Q", "workflowStatus=NOPE", "stage=NOPE",
            "analystId=bad!id", "clientId=not-a-uuid", "allocation=MAYBE", "name=a&name=b", `nic=${"1".repeat(101)}`,
            `jobType=${Array.from({ length: 51 }, (_, i) => `T${i}`).join(",")}`,
        ]) {
            const res = await list(USERS.ADMIN, query);
            assert.equal(res.status, 400, query);
            assert.equal(res.body.message, "Invalid query parameters");
        }
    });

    test("FILTER-015 a parameter that is not a filter is ignored (the list convention); field names never reach Prisma", async () => {
        await seed();
        assert.deepEqual(await found("firstName=KAMAL&foo=bar"), sorted("C1", "C2", "C3", "C4", "C5"));
        assert.deepEqual(await found("where%5BpassportId%5D=N1000001"), sorted("C1", "C2", "C3", "C4", "C5"));
        // Only the allow-listed fields produce conditions, each on a fixed column.
        const { filters } = parseCandidateFilters({ passport: "PN", passportMatch: "startsWith", job: "x", createdDate: "y" });
        assert.deepEqual(filters, { passport: "PN", passportMatch: "startsWith" });
        assert.deepEqual(candidateFilterWhere(filters), { passportId: { startsWith: "PN", mode: "insensitive" } });
    });

    test("FILTER-STAGES: the filter module's stage list is the deployment process's", () => {
        assert.deepEqual([...CANDIDATE_STAGE_KEYS], [...CANDIDATE_STAGES]);
    });
});

describe("Candidates: RBAC stays authoritative", () => {
    test("FILTER-020 an ANALYST never reaches another Analyst's (or an unallocated) candidate through a filter", async () => {
        await seed();
        assert.deepEqual(await found("name=silva", USERS.ANALYST), [], "C3 is ANALYST2's");
        assert.deepEqual(await found(`passport=${ID.C3}&passportMatch=equals`, USERS.ANALYST), []);
        assert.deepEqual(await found("passport=PN&passportMatch=startsWith", USERS.ANALYST), [], "C4 is unallocated");
        assert.deepEqual(await found("jobType=Welder", USERS.ANALYST), sorted("C1"), "a derived filter is scoped too");
        assert.deepEqual(await found("workflowStatus=STOPPED_WITH_TEST", USERS.ANALYST), []);
        assert.deepEqual(await found("name=silva", USERS.ANALYST2), sorted("C3"));
    });

    test("FILTER-021 an ANALYST's totals count only their own filtered candidates", async () => {
        await seed();
        const res = await list(USERS.ANALYST, "name=perera");
        assert.deepEqual(ids(res.body), sorted("C1", "C2"));
        assert.equal(res.body.pagination.total, 2, "C4 (unallocated) matches globally but is not counted");
        // The allocation filters are not theirs to use (they see only their own candidates anyway).
        for (const query of [`analystId=${USERS.ANALYST2.adminId}`, "allocation=UNALLOCATED"]) {
            assert.equal((await list(USERS.ANALYST, query)).status, 400, query);
        }
    });

    test("FILTER-022 / 023 TEAM_LEAD, ADMIN and OWNER filter across every candidate, as before", async () => {
        await seed();
        for (const who of [USERS.TEAM_LEAD, USERS.ADMIN, USERS.OWNER]) {
            assert.deepEqual(await found("name=perera", who), sorted("C1", "C2", "C4"), who.role);
            assert.deepEqual(await found(`analystId=${USERS.ANALYST2.adminId}`, who), sorted("C3"), who.role);
            assert.equal((await list(who, "")).body.pagination.total, 5, who.role);
        }
    });

    test("FILTER-024 REGISTRATION_DESK still has no Candidates list (nor its filter options)", async () => {
        await seed();
        assert.equal((await list(USERS.REGISTRATION_DESK, "name=perera")).status, 403);
        assert.equal((await api(USERS.REGISTRATION_DESK, "/candidate-filter-options")).status, 403);
    });

    test("FILTER-025 JOB_HANDLER keeps its read scope: every candidate, job filters yes, allocation filters no", async () => {
        const { acme } = await seed();
        assert.deepEqual(await found("name=perera", USERS.JOB_HANDLER), sorted("C1", "C2", "C4"));
        assert.deepEqual(await found(`clientId=${acme.id}`, USERS.JOB_HANDLER), sorted("C1"));
        assert.equal((await list(USERS.JOB_HANDLER, `analystId=${USERS.ANALYST.adminId}`)).status, 400);
        assert.equal((await list(USERS.ANALYST, `clientId=${acme.id}`)).status, 400, "nor client filters for an ANALYST");
    });

    test("FILTER-OPTIONS: the dropdown choices follow the role", async () => {
        const { acme, other, agent } = await seed();
        const admin = (await api(USERS.ADMIN, "/candidate-filter-options")).body;
        assert.ok(Array.isArray(admin.jobTypes));
        assert.equal(admin.noPreference.code, "NO_PREFERENCE");
        // Active Analysts and Team Leads (both can be allocated candidates).
        assert.deepEqual(admin.officers.map((o) => o.id).sort(), [USERS.ANALYST.adminId, USERS.ANALYST2.adminId, USERS.TEAM_LEAD.adminId].sort());
        assert.deepEqual(admin.clients.map((c) => c.id).sort(), [acme.id, other.id].sort());
        assert.deepEqual(admin.agents.map((a) => a.id), [agent.id]);
        const analyst = (await api(USERS.ANALYST, "/candidate-filter-options")).body;
        assert.deepEqual(Object.keys(analyst).sort(), ["jobTypes", "noPreference"], "no officers, clients or agents for an ANALYST");
        const handler = (await api(USERS.JOB_HANDLER, "/candidate-filter-options")).body;
        assert.equal(handler.officers, undefined);
        assert.ok(handler.clients.length === 2 && handler.agents.length === 1);
    });
});

describe("Work Allocation: the view's condition always holds", () => {
    const allocation = (query) => api(USERS.ADMIN, `/work-allocation/candidates?${query}`);
    const wa = async (query) => {
        const res = await allocation(query);
        assert.equal(res.status, 200, `${query}: ${JSON.stringify(res.body)}`);
        return ids(res.body);
    };

    test("FILTER-026 Unallocated: filters never bring in allocated candidates", async () => {
        await seed();
        assert.deepEqual(await wa("status=UNALLOCATED&name=perera"), sorted("C4"), "C1 and C2 match but are allocated");
        assert.deepEqual(await wa(`status=UNALLOCATED&name=perera&analystId=${USERS.ANALYST.adminId}`), sorted("C4"), "an Analyst filter means nothing here");
        assert.deepEqual(await wa("status=UNALLOCATED&allocation=ALLOCATED"), sorted("C4", "C5"), "the view decides the allocation");
        assert.deepEqual(await wa("status=UNALLOCATED&jobType=Welder,Pipe%20Welder&registeredFrom=2026-11-01"), sorted("C5"));
    });

    test("FILTER-027 Allocated: filters never bring in unallocated candidates", async () => {
        await seed();
        assert.deepEqual(await wa("status=ALLOCATED&name=perera"), sorted("C1", "C2"));
        assert.deepEqual(await wa("status=ALLOCATED&passport=PN&passportMatch=startsWith"), [], "C4 matches but is unallocated");
        assert.deepEqual(await wa("status=ALLOCATED&jobType=Steel%20Fixer&registeredFrom=2026-11-01&registeredTo=2026-11-30"), sorted("C1"));
    });

    test("FILTER-028 Officer filter on Allocated (one or several)", async () => {
        await seed();
        assert.deepEqual(await wa(`status=ALLOCATED&analystId=${USERS.ANALYST2.adminId}`), sorted("C3"));
        assert.deepEqual(await wa(`status=ALLOCATED&analystId=${USERS.ANALYST.adminId},${USERS.ANALYST2.adminId}&jobType=Welder`), sorted("C1", "C3"));
        const res = await allocation(`status=ALLOCATED&analystId=${USERS.ANALYST.adminId}&nic=12345`);
        assert.deepEqual(res.body.filters, {
            status: "ALLOCATED", analystId: USERS.ANALYST.adminId, search: null,
            registeredFrom: null, registeredTo: null, jobType: null, workflowStatus: null, stage: null, nic: "12345",
        });
    });

    test("FILTER-029 filters and allocation pagination together", async () => {
        const many = Array.from({ length: 230 }, (_, i) => ({
            passportId: `P${String(i).padStart(7, "0")}`, uniqueId: `7${String(i).padStart(4, "0")}`, firstName: `F${i}`, otherName: "BULK",
            job: i % 2 ? "PLUMBER" : "TILER", createdDate: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
        }));
        await prisma.candidate.createMany({ data: many });
        await prisma.candidateAllocation.createMany({ data: many.slice(0, 10).map((row) => ({ passportId: row.passportId, analystId: USERS.ANALYST.adminId })) });
        const first = await allocation("surname=bulk&jobType=PLUMBER");
        const second = await allocation("surname=bulk&jobType=PLUMBER&page=2");
        // 115 PLUMBER, 5 of them allocated (odd indexes below 10).
        assert.deepEqual([first.body.pagination.total, first.body.pagination.totalPages, first.body.items.length, second.body.items.length], [110, 2, 100, 10]);
        assert.ok([...first.body.items, ...second.body.items].every((item) => item.analyst === null));
        const allocated = await allocation(`status=ALLOCATED&surname=bulk&jobType=PLUMBER&analystId=${USERS.ANALYST.adminId}`);
        assert.equal(allocated.body.pagination.total, 5);
    });
});
