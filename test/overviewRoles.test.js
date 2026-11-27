// The role-scoped Overview (GET /api/admin/overview?view=mine|full, overviewService.js):
//   ADMIN / OWNER      always the whole system (view ignored)
//   TEAM_LEAD          mine (default) or full (every allocated candidate)
//   ANALYST            mine only; view=full is 403
//   REGISTRATION_DESK, JOB_HANDLER   403
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client, the real
// service and the real admin router. Synthetic data only.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createFakeAuthAdmin } from "./helpers/fakeSupabaseAuth.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { getOverview, parseOverviewQuery, resolveOverviewView } from "../src/services/overviewService.js";
import { businessDateOf, businessDayRange } from "../src/utils/businessDay.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, status: "ACTIVE" });
const USERS = {
    OWNER: user("u-owner", "OWNER", 1),
    ADMIN: user("u-admin", "ADMIN", 2),
    TL: user("u-tl", "TEAM_LEAD", 3),
    A: user("u-ana", "ANALYST", 4),
    B: user("u-anb", "ANALYST", 5),
    DESK: user("u-desk", "REGISTRATION_DESK", 6),
    JH: user("u-jh", "JOB_HANDLER", 7),
    IDLE: user("u-idle", "ANALYST", 8), // an Analyst with no candidates
};

// Today and yesterday in Sri Lanka (business days), whatever the time the test runs.
const { start: TODAY_START } = businessDayRange(businessDateOf(new Date()));
const TODAY = new Date(TODAY_START.getTime() + 1000);
const YESTERDAY = new Date(TODAY_START.getTime() - 1000);

// [passportId, holder, facts]. Every candidate's details are incomplete unless `complete`.
//   A1  Analyst A, allocated today, no action (a blank VISA_APPROVAL row and the registration note only)
//   A2  Analyst A, on a job without a SCAN, ROMANIA report only, A's calls today and yesterday
//   A3  Analyst A, details complete (Additional Details), on a job with a SCAN, SL_VERIFIED report
//       (its ROMANIA report SUPERSEDED), Visa submission completed, Candidate Form submitted today
//   A4  Analyst A, Departed (a completed placement), Visa submission completed, form yesterday
//   B1  Analyst B, allocated today, no action, on a job without a SCAN
//   B2  Analyst B, a Test details result (an action), form today, B's call yesterday
//   T1  the Team Lead, allocated today, no action
//   U1  unallocated, on a job without a SCAN, Visa submission completed, form today, ADMIN's and TL's
//       calls today (the Team Lead's "mine" calls are the calls they took, on any candidate)
const CANDIDATES = {
    A1: { holder: "A", allocatedAt: TODAY },
    A2: { holder: "A", allocatedAt: YESTERDAY, job: true, police: ["ROMANIA"], calls: [["A", TODAY], ["A", YESTERDAY]] },
    A3: { holder: "A", allocatedAt: YESTERDAY, job: true, scan: true, complete: true, police: ["SL_VERIFIED"], supersededPolice: ["ROMANIA"], visaSubmitted: true, formAt: TODAY },
    A4: { holder: "A", allocatedAt: YESTERDAY, departed: true, visaSubmitted: true, formAt: YESTERDAY },
    B1: { holder: "B", allocatedAt: TODAY, job: true },
    B2: { holder: "B", allocatedAt: YESTERDAY, testResult: "PASS", formAt: TODAY, calls: [["B", YESTERDAY]] },
    T1: { holder: "TL", allocatedAt: TODAY },
    U1: { holder: null, job: true, visaSubmitted: true, formAt: TODAY, calls: [["ADMIN", TODAY], ["TL", TODAY]] },
};
const pid = (key) => `OV00000${key}`;

let database;
let prisma;
let server;
let baseUrl;

async function seed() {
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
    const agent = await prisma.agent.create({ data: { name: "Ion Popescu", countryCode: "RO" } });
    const client = await prisma.client.create({ data: { name: "Acme Construction", agentLinks: { create: { agentId: agent.id } } } });
    const job = await prisma.job.create({ data: { jobCode: "JOB-2026-000001", clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", createdById: USERS.ADMIN.adminId } });

    let docNumber = 0;
    const doc = (passportId, documentType, documentVariant = null, verificationStatus = "VERIFIED") => {
        docNumber += 1;
        const n = String(docNumber).padStart(12, "0");
        return prisma.document.create({ data: {
            documentId: `00000000-0000-4000-8000-${n}`, passportId, documentType, documentVariant, originalFilename: "file.pdf", storedFilename: "file.pdf",
            storagePath: `clients/${passportId}/${documentType.toLowerCase()}/${n}.pdf`, mimeType: "application/pdf", fileSize: 10n, receivedDate: YESTERDAY,
            processingStatus: "STORED", verificationStatus, fileSha256: n.padStart(64, "0"),
        } });
    };
    let callNumber = 0;
    for (const [key, c] of Object.entries(CANDIDATES)) {
        const passportId = pid(key);
        const details = c.complete
            ? { otherName: "Perera", nic: `19901234${key}`, passportIssueDate: new Date("2024-01-01"), passportExpiryDate: new Date("2034-01-01"), job: "Welder", jobExperience: "5 years", whatsappNumber: `9477${passportId.slice(-4)}` }
            : { otherName: "Perera" };
        await prisma.candidate.create({ data: { passportId, uniqueId: `U${key}`, firstName: `Given ${key}`, ...details, ...(c.departed ? { departedAt: YESTERDAY } : {}) } });
        // The registration note on Candidate Details (an automatic stage: never an action).
        await prisma.candidateStage.create({ data: { passportId, stage: "CANDIDATE_DETAILS", notes: "Registered at the desk" } });
        if (c.holder) await prisma.candidateAllocation.create({ data: { passportId, analystId: USERS[c.holder].adminId, assignedDate: c.allocatedAt } });
        if (c.job) await prisma.jobCandidate.create({ data: { jobId: job.id, passportId, assignedBy: USERS.ADMIN.adminId } });
        if (c.complete) {
            await doc(passportId, "PASSPORT");
            await prisma.candidateAdditionalDetails.create({ data: { passportId, tshirtSize: "M" } });
        }
        if (c.scan) await doc(passportId, "SCAN");
        for (const variant of c.police ?? []) await doc(passportId, "POLICE_REPORT", variant);
        for (const variant of c.supersededPolice ?? []) await doc(passportId, "POLICE_REPORT", variant, "SUPERSEDED");
        if (c.visaSubmitted) await prisma.candidateStage.create({ data: { passportId, stage: "VISA_SUBMISSION", completed: true, completedAt: YESTERDAY } });
        if (c.testResult) await prisma.candidateStage.create({ data: { passportId, stage: "TEST_DETAILS", testResult: c.testResult } });
        if (key === "A1") await prisma.candidateStage.create({ data: { passportId, stage: "VISA_APPROVAL", completed: false } });
        if (c.formAt) await prisma.candidateFormResponse.create({ data: { passportId, fullName: `Given ${key} Perera`, submittedAt: c.formAt } });
        for (const [who, at] of c.calls ?? []) {
            callNumber += 1;
            await prisma.candidateCallLog.create({ data: { callLogId: `call-${callNumber}`, passportId, adminId: USERS[who].adminId, note: "Spoke to the candidate", createdDate: at } });
        }
    }
}

before(async () => {
    database = await createTestDatabase();
    ({ prisma } = database);
    await seed();
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: req.get("x-test-user") }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        if (!req.user) return res.status(401).json({ message: "Invalid or Expired Token" });
        return next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, authAdmin: createFakeAuthAdmin(), apiLimiter: noRateLimit }));
    app.use(errorHandler);
    await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => {
    server?.close();
    await database?.close();
});

async function overview(who, query = "") {
    const response = await fetch(`${baseUrl}/overview${query}`, { headers: { "x-test-user": who.adminId } });
    return { status: response.status, body: await response.json().catch(() => null) };
}
const ok = (response) => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
};
const figures = ({ active, job, romania, slVerified, agreements, details, newly, visa, forms, allocatedToday, calls }) => ({
    overview: {
        activeAllocated: active,
        jobAllocated: job,
        policeReportsYetToReceive: { total: romania + slVerified, byVariant: { ROMANIA: romania, SL_VERIFIED: slVerified } },
        agreementsYetToReceive: agreements,
        detailsNotCompleted: details,
        newlyAllocated: newly,
        visaSubmissionCompleted: visa,
    },
    daily: { formSubmissions: forms, newlyAllocated: allocatedToday, callsTaken: calls },
});
const counts = (body) => ({ overview: body.overview, daily: body.daily });

// Analyst A: A1-A4 (A4 a completed placement, so out of every Active figure).
const ANALYST_A = figures({ active: 3, job: 2, romania: 2, slVerified: 2, agreements: 1, details: 2, newly: 1, visa: 2, forms: 1, allocatedToday: 1, calls: 1 });
const ANALYST_B = figures({ active: 2, job: 1, romania: 2, slVerified: 2, agreements: 1, details: 2, newly: 1, visa: 0, forms: 1, allocatedToday: 1, calls: 0 });
const TEAM_LEAD_MINE = figures({ active: 1, job: 0, romania: 1, slVerified: 1, agreements: 0, details: 1, newly: 1, visa: 0, forms: 0, allocatedToday: 1, calls: 1 });
// Every allocated candidate (not U1); calls: every call today (A's, ADMIN's and TL's).
const TEAM_LEAD_FULL = figures({ active: 6, job: 3, romania: 5, slVerified: 5, agreements: 2, details: 5, newly: 3, visa: 2, forms: 2, allocatedToday: 3, calls: 3 });
// Every candidate (U1 too: unallocated, so never in activeAllocated or newlyAllocated).
const SYSTEM = figures({ active: 6, job: 4, romania: 6, slVerified: 6, agreements: 3, details: 6, newly: 3, visa: 3, forms: 3, allocatedToday: 3, calls: 3 });
const ZERO = figures({ active: 0, job: 0, romania: 0, slVerified: 0, agreements: 0, details: 0, newly: 0, visa: 0, forms: 0, allocatedToday: 0, calls: 0 });

describe("GET /overview: an Analyst sees only their own figures", () => {
    test("Analyst A: mine, A's candidates and A's calls only", async () => {
        const body = ok(await overview(USERS.A));
        assert.equal(body.businessDate, businessDateOf(new Date()));
        assert.deepEqual([body.view, body.canChooseView], ["mine", false]);
        assert.deepEqual(counts(body), ANALYST_A);
        assert.deepEqual(counts(ok(await overview(USERS.A, "?view=mine"))), ANALYST_A, "view=mine is the same");
    });

    test("Analyst B: another Analyst's candidates never count", async () => {
        assert.deepEqual(counts(ok(await overview(USERS.B))), ANALYST_B);
    });

    test("an Analyst with no allocated candidates: all zeros", async () => {
        assert.deepEqual(counts(ok(await overview(USERS.IDLE))), ZERO);
    });

    test("view=full is 403 for an Analyst, never another user's data", async () => {
        const result = await overview(USERS.A, "?view=full");
        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { message: "Forbidden" });
    });
});

describe("GET /overview: a Team Lead chooses mine or full", () => {
    test("default and view=mine: the Team Lead's own allocations and calls", async () => {
        for (const query of ["", "?view=mine"]) {
            const body = ok(await overview(USERS.TL, query));
            assert.deepEqual([body.view, body.canChooseView], ["mine", true], query);
            assert.deepEqual(counts(body), TEAM_LEAD_MINE, query);
        }
    });

    test("view=full: every allocated candidate (the unallocated one excluded), every call today", async () => {
        const body = ok(await overview(USERS.TL, "?view=full"));
        assert.deepEqual([body.view, body.canChooseView], ["full", true]);
        assert.deepEqual(counts(body), TEAM_LEAD_FULL);
    });
});

describe("GET /overview: ADMIN and OWNER always get the system view", () => {
    for (const who of ["ADMIN", "OWNER"]) {
        test(`${who}: system, whatever view is asked for`, async () => {
            for (const query of ["", "?view=mine", "?view=full"]) {
                const body = ok(await overview(USERS[who], query));
                assert.deepEqual([body.view, body.canChooseView], ["system", false], query);
                assert.deepEqual(counts(body), SYSTEM, `${who} ${query}`);
            }
        });
    }
});

describe("GET /overview: refusals", () => {
    test("Registration Desk and Job Handler: 403", async () => {
        for (const who of [USERS.DESK, USERS.JH]) {
            for (const query of ["", "?view=mine"]) assert.equal((await overview(who, query)).status, 403, `${who.role} ${query}`);
        }
    });

    test("an invalid view, or view given twice: 400 with the field", async () => {
        for (const query of ["?view=system", "?view=all", "?view=MINE", "?view=mine&view=full"]) {
            const result = await overview(USERS.ADMIN, query);
            assert.equal(result.status, 400, query);
            assert.equal(result.body.message, "Invalid query parameters");
            assert.equal(result.body.errors[0].field, "view");
        }
        assert.equal((await overview(USERS.A, "?view=bogus")).status, 400);
    });
});

describe("overviewService", () => {
    test("parseOverviewQuery", () => {
        assert.deepEqual(parseOverviewQuery({}), { params: { view: null } });
        assert.deepEqual(parseOverviewQuery({ view: "" }), { params: { view: null } });
        assert.deepEqual(parseOverviewQuery({ view: "full" }), { params: { view: "full" } });
        assert.ok(parseOverviewQuery({ view: ["mine", "full"] }).errors);
        assert.ok(parseOverviewQuery({ view: "system" }).errors);
    });

    test("resolveOverviewView: decided by the role, never by the request", () => {
        assert.deepEqual(resolveOverviewView({ role: "OWNER" }, "mine"), { view: "system", canChooseView: false });
        assert.deepEqual(resolveOverviewView({ role: "ADMIN" }, null), { view: "system", canChooseView: false });
        assert.deepEqual(resolveOverviewView({ role: "TEAM_LEAD" }, null), { view: "mine", canChooseView: true });
        assert.deepEqual(resolveOverviewView({ role: "TEAM_LEAD" }, "full"), { view: "full", canChooseView: true });
        assert.deepEqual(resolveOverviewView({ role: "ANALYST" }, "mine"), { view: "mine", canChooseView: false });
        assert.deepEqual(resolveOverviewView({ role: "ANALYST" }, "full"), { forbidden: true });
        for (const role of ["REGISTRATION_DESK", "JOB_HANDLER", "MANAGER", undefined]) assert.deepEqual(resolveOverviewView({ role }, null), { forbidden: true });
    });

    test("mine without an adminId: all zeros, nothing queried", async () => {
        const db = new Proxy({}, { get: () => { throw new Error("no query expected"); } });
        const body = await getOverview({ db, view: "mine", adminId: null });
        assert.deepEqual(counts(body), ZERO);
    });

    test("count queries only, a fixed number, never a candidate list", async () => {
        const calls = [];
        const model = (name) => new Proxy({}, { get: (target, method) => async (args) => { calls.push(`${name}.${String(method)}`); return method === "count" ? 0 : []; } });
        const db = { candidate: model("candidate"), candidateCallLog: model("candidateCallLog") };
        for (const [view, adminId] of [["system", "u-admin"], ["full", "u-tl"], ["mine", "u-ana"]]) {
            calls.length = 0;
            await getOverview({ db, view, adminId });
            assert.deepEqual([...new Set(calls)].sort(), ["candidate.count", "candidateCallLog.count"], view);
            assert.equal(calls.length, 11, view);
        }
    });
});
