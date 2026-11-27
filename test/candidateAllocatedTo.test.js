// "Allocated To" on the candidate page (ALLOC-TO-001 to 008): which allocated users each role is sent, on a REAL
// PostgreSQL (PGlite, every migration applied) through the real admin router, by direct API call. The
// names a role may not see must not appear anywhere in the response body.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { canSeeAllocatedTo, visibleAllocatedTo } from "../src/services/candidateAllocationVisibility.js";

const user = (adminId, role, name, n) => ({ adminId, role, name, status: "ACTIVE", email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = {
    ADMIN: user("u-admin", "ADMIN", "Ada Admin", 1),
    OWNER: user("u-owner", "OWNER", "Olive Owner", 2),
    LEAD: user("u-lead", "TEAM_LEAD", "Tara Lead", 3),
    ANN: user("u-ann", "ANALYST", "Ann Analyst", 4),
    BEN: user("u-ben", "ANALYST", "Ben Analyst", 5),
    DESK: user("u-desk", "REGISTRATION_DESK", "Dee Desk", 6),
    HANDLER: user("u-handler", "JOB_HANDLER", "Hal Handler", 7),
    // An Admin who still holds an allocation (an Analyst promoted after being allocated): never a target today.
    PROMOTED: user("u-promoted", "ADMIN", "Pat Promoted", 8),
};
const ON_ANALYST = "P0000001"; // allocated to Ann (Analyst)
const ON_LEAD = "P0000002"; // allocated to Tara (Team Lead)
const ON_ADMIN = "P0000003"; // allocated to Pat (Admin)
const ON_BEN = "P0000004"; // allocated to Ben (Analyst)
const NOBODY = "P0000005";
const NAMES = Object.values(USERS).map((u) => u.name);

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
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    await prisma.candidate.createMany({ data: [ON_ANALYST, ON_LEAD, ON_ADMIN, ON_BEN, NOBODY].map((passportId, i) => ({ passportId, uniqueId: `70${i}`, firstName: "Nimal", otherName: "Perera", nic: `90000000${i}V` })) });
    await prisma.candidateAllocation.createMany({
        data: [[ON_ANALYST, USERS.ANN], [ON_LEAD, USERS.LEAD], [ON_ADMIN, USERS.PROMOTED], [ON_BEN, USERS.BEN]].map(([passportId, u]) => ({ passportId, analystId: u.adminId })),
    });
});

async function api(who, method, path, body) {
    const app = express();
    app.use(express.json());
    const requireAdmin = async (req, res, next) => {
        req.user = await prisma.user.findUnique({ where: { adminId: who.adminId }, select: { adminId: true, authUserId: true, email: true, name: true, role: true, status: true } });
        next();
    };
    app.use("/api/admin", createAdminRouter({ db: prisma, bucket: {}, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, text, body: text ? JSON.parse(text) : null };
    } finally {
        server.close();
    }
}
// The names shown for a candidate, or "hidden" when the response has no Allocated To at all.
const shown = async (who, passportId) => {
    const response = await api(who, "GET", `/candidates/${passportId}`);
    assert.equal(response.status, 200, `${who.role} ${passportId}`);
    return { names: response.body.allocatedTo?.map((u) => u.name), text: response.text, has: Object.hasOwn(response.body, "allocatedTo") };
};
// No name outside `allowed` may be anywhere in the response.
const assertOnly = (result, allowed, label) => {
    for (const name of NAMES) {
        if (!allowed.includes(name)) assert.ok(!result.text.includes(name), `${label}: ${name} must not be sent`);
    }
};

describe("Allocated To: the rule", () => {
    test("ALLOC-TO-001: which roles get it, and which allocated roles each may see", () => {
        for (const role of ["OWNER", "ADMIN", "TEAM_LEAD", "ANALYST"]) assert.equal(canSeeAllocatedTo(role), true, role);
        for (const role of ["REGISTRATION_DESK", "JOB_HANDLER", "VIEWER", undefined]) assert.equal(canSeeAllocatedTo(role), false, String(role));
        const everyone = [{ name: "a", role: "ANALYST" }, { name: "t", role: "TEAM_LEAD" }, { name: "m", role: "ADMIN" }, { name: "o", role: "OWNER" }];
        assert.deepEqual(visibleAllocatedTo("OWNER", everyone).map((u) => u.name), ["a", "t", "m", "o"]);
        assert.deepEqual(visibleAllocatedTo("ADMIN", everyone).map((u) => u.name), ["a", "t", "m", "o"]);
        assert.deepEqual(visibleAllocatedTo("TEAM_LEAD", everyone).map((u) => u.name), ["a", "t"]);
        assert.deepEqual(visibleAllocatedTo("ANALYST", everyone).map((u) => u.name), ["a"], "another Analyst, never a Team Lead, Admin or Owner");
        assert.equal(visibleAllocatedTo("JOB_HANDLER", everyone), undefined);
    });
});

describe("Allocated To: the candidate page, by direct API call", () => {
    test("ALLOC-TO-002: Admin and Owner are sent every allocated user", async () => {
        for (const who of [USERS.ADMIN, USERS.OWNER]) {
            assert.deepEqual((await shown(who, ON_ANALYST)).names, ["Ann Analyst"], who.role);
            assert.deepEqual((await shown(who, ON_LEAD)).names, ["Tara Lead"], who.role);
            assert.deepEqual((await shown(who, ON_ADMIN)).names, ["Pat Promoted"], who.role);
            assert.deepEqual((await shown(who, NOBODY)).names, [], `${who.role}: nothing allocated`);
        }
    });

    test("ALLOC-TO-003: a Team Lead is sent Analysts and Team Leads only; an Admin allocation is never sent", async () => {
        const lead = USERS.LEAD;
        assert.deepEqual((await shown(lead, ON_ANALYST)).names, ["Ann Analyst"]);
        assert.deepEqual((await shown(lead, ON_LEAD)).names, ["Tara Lead"]);
        const onAdmin = await shown(lead, ON_ADMIN);
        assert.deepEqual(onAdmin.names, []);
        assertOnly(onAdmin, [lead.name], "Team Lead on the Admin's candidate");
        assert.deepEqual((await shown(lead, NOBODY)).names, []);
    });

    test("ALLOC-TO-004: an Analyst is sent Analysts only, and still opens only their own candidates", async () => {
        const own = await shown(USERS.ANN, ON_ANALYST);
        assert.deepEqual(own.names, ["Ann Analyst"]);
        assertOnly(own, ["Ann Analyst"], "Analyst on their own candidate");
        for (const other of [ON_LEAD, ON_ADMIN, ON_BEN, NOBODY]) {
            const response = await api(USERS.ANN, "GET", `/candidates/${other}`);
            assert.equal(response.status, 404, `${other}: access is unchanged`);
            assertOnly(response, [], `Analyst refused ${other}`);
        }
    });

    test("ALLOC-TO-005: the Registration Desk and the Job Handler get no Allocated To at all", async () => {
        for (const id of [ON_ANALYST, ON_LEAD, ON_ADMIN]) {
            const desk = await shown(USERS.DESK, id);
            assert.equal(desk.has, false, id);
            assertOnly(desk, [], `Registration Desk ${id}`);
        }
        for (const id of [ON_ANALYST, ON_LEAD, ON_ADMIN]) {
            const handler = await shown(USERS.HANDLER, id);
            assert.equal(handler.has, false, id);
            assertOnly(handler, [], `Job Handler ${id}`);
        }
    });

    test("ALLOC-TO-006: responses that carry the candidate's details after a save apply the same rule", async () => {
        const saved = await api(USERS.LEAD, "PUT", `/candidates/${ON_ADMIN}/stages/CANDIDATE_DETAILS`, { notes: "A note" });
        assert.equal(saved.status, 200);
        assert.deepEqual(saved.body.allocatedTo, []);
        assertOnly(saved, ["Tara Lead"], "stage save as Team Lead");
        const asAdmin = await api(USERS.ADMIN, "PUT", `/candidates/${ON_ADMIN}/stages/CANDIDATE_DETAILS`, { notes: "A note" });
        assert.deepEqual(asAdmin.body.allocatedTo.map((u) => u.name), ["Pat Promoted"]);
        const desk = await api(USERS.DESK, "PUT", `/candidates/${ON_ADMIN}/stages/CANDIDATE_DETAILS`, { notes: "A note" });
        assert.equal(Object.hasOwn(desk.body, "allocatedTo"), false);
    });

    test("ALLOC-TO-007: a reassignment shows on the very next request", async () => {
        assert.deepEqual((await shown(USERS.ADMIN, ON_ANALYST)).names, ["Ann Analyst"]);
        await prisma.candidateAllocation.update({ where: { passportId: ON_ANALYST }, data: { analystId: USERS.BEN.adminId } });
        assert.deepEqual((await shown(USERS.ADMIN, ON_ANALYST)).names, ["Ben Analyst"]);
        assert.equal((await api(USERS.ANN, "GET", `/candidates/${ON_ANALYST}`)).status, 404);
    });
});
