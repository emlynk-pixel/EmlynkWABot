// Agent Management + Client Management (Admin > Agents, Admin > Client Management).
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma
// client, the real services and the real admin router. No Supabase.
// Cases AGENT-001..013, CLIENT-001..014, REL-001..008 (docs/AGENT_CLIENT_MANAGEMENT.md).
// Since 20261026120000_agent_client_many_to_many the Agent <-> Client links are agent_client
// rows (many-to-many; agentClientManyToMany.test.js); the single "agentId" the cases below send
// is still accepted on create and on PATCH …/agent (it means exactly that one agent).
const linked = (agentId, clientId) => prisma.agentClient.count({ where: { agentId, clientId } });
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANALYST: user("u-ann", "ANALYST", 4) };
const pid = (i) => `P000000${i}`;
const NO_SUCH_ID = "11111111-1111-4111-8111-111111111111";

let database;
let prisma;
let pg;
let jobTypeId;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const u of Object.values(USERS)) await prisma.user.create({ data: u });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "rate_limits"; DELETE FROM "job_candidate"; DELETE FROM "job"; DELETE FROM "job_code_counter";
        DELETE FROM "job_type"; DELETE FROM "agent_client"; DELETE FROM "client"; DELETE FROM "agent";
        DELETE FROM "candidate_allocation"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
    `);
    jobTypeId = (await prisma.jobType.create({ data: { code: "WELDER", name: "Welder" } })).id;
});

async function api(who, method, urlPath, body) {
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
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${urlPath}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } finally {
        server.close();
    }
}

const mkAgent = async (extra = {}, who = USERS.ADMIN) => {
    const response = await api(who, "POST", "/agents", { name: "Agent A", countryCode: "LK", ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const mkClient = async (agentId, extra = {}, who = USERS.ADMIN) => {
    const response = await api(who, "POST", "/client-management", { name: "Client 1", agentId, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const mkJob = async (clientId, extra = {}) => api(USERS.MANAGER, "POST", "/jobs", { jobTypeId, clientId, ...extra });
const mkJobOk = async (clientId, extra = {}) => {
    const response = await mkJob(clientId, extra);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
};
const audit = (action) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdDate: "asc" } });

describe("agents: create and roles (AGENT-001 to AGENT-005)", () => {
    test("AGENT-001 / 002: ADMIN and MANAGER create an agent; the id is a system UUID and the contact is normalised", async () => {
        const a = await mkAgent({ contactNumber: "0771234567", whatsappNumber: "+94 77 765 4321", email: " Agent@Example.COM ", address: "Colombo", notes: "n" }, USERS.ADMIN);
        assert.match(a.agentId, /^[0-9a-f-]{36}$/);
        assert.deepEqual([a.name, a.countryCode, a.status, a.contactNumber, a.whatsappNumber, a.email], ["Agent A", "LK", "ACTIVE", "94771234567", "94777654321", "agent@example.com"]);
        const b = await mkAgent({ name: "Agent B", countryCode: "ro" }, USERS.MANAGER);
        assert.equal(b.countryCode, "RO");
        assert.notEqual(a.agentId, b.agentId);
    });

    test("AGENT-003 / 004: ANALYST and REGISTRATION_DESK have no access to the Agents API at all", async () => {
        const agent = await mkAgent();
        for (const who of [USERS.ANALYST, USERS.DESK]) {
            for (const [method, url, body] of [
                ["GET", "/agents"], ["GET", `/agents/${agent.agentId}`],
                ["POST", "/agents", { name: "X", countryCode: "LK" }],
                ["PATCH", `/agents/${agent.agentId}`, { name: "Y" }],
                ["PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" }],
            ]) {
                assert.equal((await api(who, method, url, body)).status, 403, `${who.role} ${method} ${url}`);
            }
        }
        assert.equal((await prisma.agent.count()), 1, "nothing was created or changed");
        assert.equal((await prisma.agent.findFirst()).name, "Agent A");
    });

    test("AGENT-005: name and a valid country are required; bad email / phone / status are refused", async () => {
        for (const [body, field] of [
            [{ countryCode: "LK" }, "name"], [{ name: "  ", countryCode: "LK" }, "name"], [{ name: "A" }, "countryCode"],
            [{ name: "A", countryCode: "XX" }, "countryCode"], [{ name: "A", countryCode: "Sri Lanka" }, "countryCode"],
            [{ name: "A", countryCode: "LK", email: "not-an-email" }, "email"], [{ name: "A", countryCode: "LK", contactNumber: "abc" }, "contactNumber"],
            [{ name: "A", countryCode: "LK", whatsappNumber: "12" }, "whatsappNumber"], [{ name: "A", countryCode: "LK", status: "DELETED" }, "status"],
            [{ name: "x".repeat(121), countryCode: "LK" }, "name"],
        ]) {
            const response = await api(USERS.ADMIN, "POST", "/agents", body);
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.ok(response.body.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(response.body)}`);
        }
        assert.equal((await api(USERS.ADMIN, "POST", "/agents", "nope")).status, 400);
        assert.equal(await prisma.agent.count(), 0);
    });

    test("the same name in the same country is a clean 409 (no Prisma error); the same name elsewhere is allowed", async () => {
        await mkAgent({ name: "Maria" });
        const dup = await api(USERS.ADMIN, "POST", "/agents", { name: " maria ", countryCode: "LK" });
        assert.deepEqual([dup.status, dup.body.code], [409, "DUPLICATE"]);
        assert.doesNotMatch(JSON.stringify(dup.body), /prisma|constraint|unique/i);
        assert.equal((await api(USERS.ADMIN, "POST", "/agents", { name: "Maria", countryCode: "RO" })).status, 201);
    });
});

describe("agents: clients, lists, details (AGENT-006, 010, 011, 012)", () => {
    test("AGENT-006: one agent manages many clients", async () => {
        const agent = await mkAgent();
        const c1 = await mkClient(agent.agentId, { name: "Client 1" });
        const c2 = await mkClient(agent.agentId, { name: "Client 2" });
        assert.equal(await prisma.agentClient.count({ where: { agentId: agent.agentId } }), 2);
        assert.deepEqual([c1.agents.map((a) => a.agentId), c2.agents.map((a) => a.agentId)], [[agent.agentId], [agent.agentId]]);
    });

    test("AGENT-010: the list searches by name and filters by country and status, with real counts", async () => {
        const lk = await mkAgent({ name: "Nimal Perera" });
        const ro = await mkAgent({ name: "Ion Popescu", countryCode: "RO" });
        const off = await mkAgent({ name: "Old Agent" });
        await api(USERS.ADMIN, "PATCH", `/agents/${off.agentId}/status`, { status: "INACTIVE" });
        const names = async (query) => (await api(USERS.MANAGER, "GET", `/agents${query}`)).body.items.map((i) => i.name);
        assert.deepEqual(await names(""), ["Ion Popescu", "Nimal Perera", "Old Agent"]);
        assert.deepEqual(await names("?search=perera"), ["Nimal Perera"]);
        assert.deepEqual(await names("?country=ro"), ["Ion Popescu"]);
        assert.deepEqual(await names("?status=INACTIVE"), ["Old Agent"]);
        assert.deepEqual(await names("?status=ACTIVE&country=LK"), ["Nimal Perera"]);
        assert.deepEqual((await api(USERS.MANAGER, "GET", "/agents")).body.countries, ["LK", "RO"]);
        for (const bad of ["?country=ZZ", "?status=GONE", "?page=0", "?search=" + "x".repeat(101)]) {
            assert.equal((await api(USERS.MANAGER, "GET", `/agents${bad}`)).status, 400, bad);
        }
        void lk; void ro;
    });

    test("AGENT-011 / 012: details show exactly this agent's clients and job counts from the relations", async () => {
        const a = await mkAgent({ name: "Agent A" });
        const other = await mkAgent({ name: "Agent B" });
        const c1 = await mkClient(a.agentId, { name: "Client 1" });
        const c2 = await mkClient(a.agentId, { name: "Client 2" });
        const otherClient = await mkClient(other.agentId, { name: "Other Client" });
        const j1 = await mkJobOk(c1.clientId);
        const j2 = await mkJobOk(c1.clientId);
        const j3 = await mkJobOk(c2.clientId);
        await mkJobOk(otherClient.clientId);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${j2.jobId}/complete`, {})).status, 200);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${j3.jobId}/cancel`, { reason: "Employer withdrew" })).status, 200);

        const detail = (await api(USERS.MANAGER, "GET", `/agents/${a.agentId}`)).body;
        assert.deepEqual(detail.clients.map((c) => [c.name, c.status, c.processingJobs]), [["Client 1", "ACTIVE", 1], ["Client 2", "ACTIVE", 0]]);
        assert.deepEqual([detail.activeClients, detail.processingJobs, detail.completedJobs, detail.cancelledJobs], [2, 1, 1, 1]);
        assert.deepEqual(detail.jobs.processing.map((j) => j.jobId), [j1.jobId]);
        assert.deepEqual(detail.jobs.completed.map((j) => j.jobId), [j2.jobId]);
        assert.deepEqual(detail.jobs.cancelled.map((j) => j.jobId), [j3.jobId]);
        assert.deepEqual([detail.jobs.processing[0].client.name, detail.jobs.processing[0].jobType.name, detail.jobs.processing[0].jobCode], ["Client 1", "Welder", j1.jobCode]);

        const list = (await api(USERS.MANAGER, "GET", "/agents?search=Agent A")).body.items[0];
        assert.deepEqual([list.activeClients, list.processingJobs, list.completedJobs], [2, 1, 1]);
        assert.equal((await api(USERS.MANAGER, "GET", `/agents/${NO_SUCH_ID}`)).status, 404);
        assert.equal((await api(USERS.MANAGER, "GET", "/agents/not-an-id")).status, 404);
    });
});

describe("agents: edit, status, no delete (AGENT-007 to AGENT-009, AGENT-013)", () => {
    test("AGENT-007 / REL-001: editing an agent keeps its id and every relationship; no change is a no-op", async () => {
        const agent = await mkAgent({ name: "Old Name" });
        const client = await mkClient(agent.agentId);
        const job = await mkJobOk(client.clientId);
        const edited = await api(USERS.MANAGER, "PATCH", `/agents/${agent.agentId}`, { name: "New Name", address: "Kandy", email: null });
        assert.equal(edited.status, 200);
        assert.deepEqual([edited.body.agentId, edited.body.name, edited.body.address], [agent.agentId, "New Name", "Kandy"]);
        assert.equal(await linked(agent.agentId, client.clientId), 1);
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).responsibleAgentId, agent.agentId);
        assert.equal((await api(USERS.ADMIN, "GET", `/client-management/${client.clientId}`)).body.agents[0].name, "New Name", "the client shows the new name through the same id");
        const before = (await audit("AGENT_UPDATED")).length;
        await api(USERS.MANAGER, "PATCH", `/agents/${agent.agentId}`, { name: "New Name" });
        assert.equal((await audit("AGENT_UPDATED")).length, before, "an unchanged save writes no audit entry");
        // The id and status cannot be edited here.
        for (const body of [{ agentId: NO_SUCH_ID }, { id: NO_SUCH_ID }, { status: "INACTIVE" }, {}]) {
            assert.equal((await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}`, body)).status, 400, JSON.stringify(body));
        }
    });

    test("an agent's country cannot change while it has PROCESSING jobs; it can afterwards", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        const job = await mkJobOk(client.clientId);
        const blocked = await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}`, { countryCode: "RO" });
        assert.deepEqual([blocked.status, blocked.body.code], [409, "AGENT_HAS_PROCESSING_JOBS"]);
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.equal((await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}`, { countryCode: "RO" })).body.countryCode, "RO");
        assert.equal((await prisma.job.findUnique({ where: { id: job.jobId } })).countryCode, "LK", "the finished job keeps the country it had");
    });

    test("AGENT-008 / CLIENT-006: an inactive agent cannot be given a client, nor create a job; history stays", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        const job = await mkJobOk(client.clientId);
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.equal((await api(USERS.MANAGER, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" })).body.status, "INACTIVE");
        const refused = await api(USERS.MANAGER, "POST", "/client-management", { name: "New", agentId: agent.agentId });
        assert.deepEqual([refused.status, refused.body.code], [409, "AGENT_INACTIVE"]);
        assert.equal(await prisma.client.count(), 1);
        const other = await mkAgent({ name: "Other" });
        const move = await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/agent`, { agentId: agent.agentId });
        assert.equal(move.status, 200, "no-op: it already is this agent's client");
        const toInactive = await api(USERS.MANAGER, "PATCH", `/client-management/${(await mkClient(other.agentId, { name: "C2" })).clientId}/agent`, { agentId: agent.agentId });
        assert.deepEqual([toInactive.status, toInactive.body.code], [409, "AGENT_INACTIVE"]);
        const noJob = await mkJob(client.clientId);
        assert.deepEqual([noJob.status, noJob.body.code], [409, "AGENT_INACTIVE"]);
        // REL-003: the history is all still there.
        assert.equal(await linked(agent.agentId, client.clientId), 1);
        const detail = (await api(USERS.MANAGER, "GET", `/agents/${agent.agentId}`)).body;
        assert.deepEqual([detail.status, detail.clients.length, detail.jobs.completed.length], ["INACTIVE", 1, 1]);
        assert.equal((await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body.responsibleAgent.name, "Agent A");
        assert.equal((await api(USERS.MANAGER, "PATCH", `/agents/${agent.agentId}/status`, { status: "ACTIVE" })).body.status, "ACTIVE");
    });

    test("an agent with PROCESSING jobs cannot be made inactive (clear business error, nothing changes)", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        const job = await mkJobOk(client.clientId);
        const blocked = await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" });
        assert.deepEqual([blocked.status, blocked.body.code], [409, "AGENT_HAS_PROCESSING_JOBS"]);
        assert.match(blocked.body.message, /1 PROCESSING job/);
        assert.equal((await prisma.agent.findUnique({ where: { id: agent.agentId } })).isActive, true);
        assert.equal((await audit("AGENT_STATUS_CHANGED")).length, 0);
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/cancel`, { reason: "No longer needed" });
        assert.equal((await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" })).status, 200);
        // Repeating the same status is harmless and writes no second entry.
        assert.equal((await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" })).status, 200);
        assert.equal((await audit("AGENT_STATUS_CHANGED")).length, 1);
        assert.equal((await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}/status`, { status: "PAUSED" })).status, 400);
    });

    test("AGENT-009: an agent cannot be hard deleted (no route, and the database refuses)", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        for (const who of [USERS.ADMIN, USERS.MANAGER]) {
            assert.ok([404, 405].includes((await api(who, "DELETE", `/agents/${agent.agentId}`)).status));
        }
        await assert.rejects(prisma.agent.delete({ where: { id: agent.agentId } }), "a client still references it (ON DELETE RESTRICT)");
        assert.equal(await prisma.agent.count(), 1);
        void client;
    });

    test("AGENT-013: create, update and status change are audited with actor, entity id and before / after (no contact data)", async () => {
        const agent = await mkAgent({ contactNumber: "0771234567", email: "a@b.co" });
        await api(USERS.MANAGER, "PATCH", `/agents/${agent.agentId}`, { name: "Renamed", contactNumber: "0770000000" });
        await api(USERS.MANAGER, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" });
        const [created] = await audit("AGENT_CREATED");
        const [updated] = await audit("AGENT_UPDATED");
        const [status] = await audit("AGENT_STATUS_CHANGED");
        assert.equal(created.adminId, USERS.ADMIN.adminId);
        assert.equal(JSON.parse(created.newValue).agentId, agent.agentId);
        assert.equal(updated.adminId, USERS.MANAGER.adminId);
        assert.deepEqual(JSON.parse(updated.previousValue), { agentId: agent.agentId, name: "Agent A", contactNumber: "(changed)" });
        assert.deepEqual(JSON.parse(updated.newValue), { agentId: agent.agentId, name: "Renamed", contactNumber: "(changed)" });
        assert.deepEqual([status.previousStatus, status.newStatus], ["ACTIVE", "INACTIVE"]);
        assert.ok(status.createdDate instanceof Date);
        const everything = JSON.stringify(await prisma.auditLog.findMany());
        assert.doesNotMatch(everything, /94771234567|94770000000|a@b\.co/, "no phone number or email is written to the log");
    });
});

describe("clients: create, roles, validation (CLIENT-001 to CLIENT-007)", () => {
    test("CLIENT-001 / 002 / 005 / 007: ADMIN and MANAGER create clients that reference a real agent id; one agent, many clients", async () => {
        const agent = await mkAgent();
        const a = await mkClient(agent.agentId, { name: "Client 1", contactPerson: "Mr Silva", contactNumber: "0771234567", whatsappNumber: "0777654321", email: "Hr@Client.com", address: "Colombo 3" }, USERS.ADMIN);
        const b = await mkClient(agent.agentId, { name: "Client 2" }, USERS.MANAGER);
        assert.deepEqual([a.status, a.countryCodes, a.agents[0].agentId, a.agents[0].name, a.contactPerson, a.email, a.contactNumber], ["ACTIVE", ["LK"], agent.agentId, "Agent A", "Mr Silva", "hr@client.com", "94771234567"]);
        assert.equal(await linked(agent.agentId, b.clientId), 1, "stored as a foreign-key link, not as text");
        assert.equal(await prisma.agentClient.count({ where: { agentId: agent.agentId } }), 2);
        for (const body of [{ name: "C" }, { name: "C", agentId: "Agent A" }, { name: "C", agentId: NO_SUCH_ID }, { agentId: agent.agentId }, { name: "C", agentId: agent.agentId, email: "x" }, { name: "C", agentId: agent.agentId, contactNumber: "zz" }]) {
            const response = await api(USERS.ADMIN, "POST", "/client-management", body);
            assert.ok([400].includes(response.status), JSON.stringify(body) + JSON.stringify(response.body));
        }
        assert.equal(await prisma.client.count(), 2, "none of the invalid ones was created");
    });

    test("CLIENT-003 / 004: ANALYST and REGISTRATION_DESK cannot read, create, edit or change a client", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        for (const who of [USERS.ANALYST, USERS.DESK]) {
            for (const [method, url, body] of [
                ["GET", "/client-management"], ["GET", `/client-management/${client.clientId}`],
                ["POST", "/client-management", { name: "X", agentId: agent.agentId }],
                ["PATCH", `/client-management/${client.clientId}`, { name: "Y" }],
                ["PATCH", `/client-management/${client.clientId}/agent`, { agentId: agent.agentId }],
                ["PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" }],
            ]) {
                assert.equal((await api(who, method, url, body)).status, 403, `${who.role} ${method} ${url}`);
            }
        }
        const stored = await prisma.client.findMany();
        assert.deepEqual(stored.map((c) => [c.name, c.isActive]), [["Client 1", true]]);
    });

    test("an unknown, inactive or malformed agent is refused with a clean error; the same client name is a 409", async () => {
        const agent = await mkAgent();
        await mkClient(agent.agentId, { name: "Acme" });
        const dup = await api(USERS.ADMIN, "POST", "/client-management", { name: " ACME ", agentId: agent.agentId });
        assert.deepEqual([dup.status, dup.body.code], [409, "DUPLICATE"]);
        assert.doesNotMatch(JSON.stringify(dup.body), /prisma|constraint/i);
        const unknown = await api(USERS.ADMIN, "POST", "/client-management", { name: "Zed", agentId: NO_SUCH_ID });
        assert.deepEqual([unknown.status, unknown.body.code], [400, "AGENT_NOT_FOUND"]);
    });
});

describe("clients: lists, details, edit (CLIENT-011 to CLIENT-013, REL-002)", () => {
    test("CLIENT-011: search, agent, country and status filters (server side, paginated)", async () => {
        const lk = await mkAgent({ name: "Lanka Agent" });
        const ro = await mkAgent({ name: "Romania Agent", countryCode: "RO" });
        await mkClient(lk.agentId, { name: "Alpha Builders", contactPerson: "Kamal" });
        await mkClient(lk.agentId, { name: "Beta Foods" });
        const gamma = await mkClient(ro.agentId, { name: "Gamma Logistics" });
        await api(USERS.ADMIN, "PATCH", `/client-management/${gamma.clientId}/status`, { status: "INACTIVE" });
        const names = async (query) => (await api(USERS.MANAGER, "GET", `/client-management${query}`)).body.items.map((i) => i.name);
        assert.deepEqual(await names(""), ["Alpha Builders", "Beta Foods", "Gamma Logistics"]);
        assert.deepEqual(await names("?search=builders"), ["Alpha Builders"]);
        assert.deepEqual(await names("?search=kamal"), ["Alpha Builders"], "contact person is searched too");
        assert.deepEqual(await names(`?agentId=${ro.agentId}`), ["Gamma Logistics"]);
        assert.deepEqual(await names("?country=LK"), ["Alpha Builders", "Beta Foods"]);
        assert.deepEqual(await names("?status=INACTIVE"), ["Gamma Logistics"]);
        assert.deepEqual(await names(`?agentId=${lk.agentId}&status=ACTIVE&search=beta`), ["Beta Foods"]);
        const page = (await api(USERS.MANAGER, "GET", "/client-management?page=2")).body;
        assert.deepEqual([page.items.length, page.pagination.page, page.pagination.total], [0, 2, 3]);
        for (const bad of ["?agentId=nope", "?country=ZZ", "?status=GONE"]) assert.equal((await api(USERS.MANAGER, "GET", `/client-management${bad}`)).status, 400, bad);
    });

    test("CLIENT-012 / 013: details show the responsible agent and exactly this client's jobs by status", async () => {
        const agent = await mkAgent();
        const c1 = await mkClient(agent.agentId, { name: "Client 1" });
        const c2 = await mkClient(agent.agentId, { name: "Client 2" });
        const processing = await mkJobOk(c1.clientId, { companyJobId: "y26 s01" });
        const done = await mkJobOk(c1.clientId);
        const cancelled = await mkJobOk(c1.clientId);
        await mkJobOk(c2.clientId);
        await prisma.candidate.create({ data: { passportId: pid(1), uniqueId: "7001", firstName: "Nimal" } });
        await prisma.candidateStage.create({ data: { passportId: pid(1), stage: "TEST_DETAILS", testResult: "PASS" } });
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${processing.jobId}/candidates`, { passportId: pid(1) })).status, 201);
        await api(USERS.MANAGER, "POST", `/jobs/${done.jobId}/complete`, {});
        await api(USERS.MANAGER, "POST", `/jobs/${cancelled.jobId}/cancel`, { reason: "Employer withdrew" });
        const detail = (await api(USERS.MANAGER, "GET", `/client-management/${c1.clientId}`)).body;
        assert.deepEqual(detail.agents.map((a) => [a.name, a.countryCode, a.status]), [["Agent A", "LK", "ACTIVE"]]);
        assert.deepEqual([detail.processingJobs, detail.completedJobs, detail.cancelledJobs], [1, 1, 1]);
        assert.deepEqual(detail.jobs.processing.map((j) => [j.jobId, j.companyJobId, j.activeCandidates, j.jobType.name, j.responsibleAgent.name]), [[processing.jobId, "Y26 S01", 1, "Welder", "Agent A"]]);
        assert.deepEqual(detail.jobs.completed.map((j) => j.jobId), [done.jobId]);
        assert.deepEqual(detail.jobs.cancelled.map((j) => j.jobId), [cancelled.jobId]);
        const row = (await api(USERS.MANAGER, "GET", "/client-management?search=Client 1")).body.items[0];
        assert.deepEqual([row.processingJobs, row.completedJobs], [1, 1]);
        assert.equal((await api(USERS.MANAGER, "GET", `/client-management/${NO_SUCH_ID}`)).status, 404);
    });

    test("REL-002: renaming a client keeps its id, agent and jobs; agentId and status are not editable here", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId, { name: "Old Co" });
        const job = await mkJobOk(client.clientId);
        const edited = await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}`, { name: "New Co", contactPerson: "Ms Fernando" });
        assert.equal(edited.status, 200);
        assert.deepEqual([edited.body.clientId, edited.body.name, edited.body.agents.map((a) => a.agentId)], [client.clientId, "New Co", [agent.agentId]]);
        const stored = await prisma.job.findUnique({ where: { id: job.jobId } });
        assert.equal(stored.clientId, client.clientId);
        assert.equal((await api(USERS.MANAGER, "GET", `/jobs/${job.jobId}`)).body.client.name, "New Co");
        for (const body of [{ agentId: agent.agentId }, { status: "INACTIVE" }, { clientId: NO_SUCH_ID }, {}]) {
            assert.equal((await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}`, body)).status, 400, JSON.stringify(body));
        }
    });
});

describe("clients: agent change, status, no delete (CLIENT-008 to CLIENT-010, CLIENT-014)", () => {
    test("CLIENT-008: changing a client's agent is an explicit action; existing jobs keep their own agent", async () => {
        const x = await mkAgent({ name: "Agent X" });
        const y = await mkAgent({ name: "Agent Y", countryCode: "RO" });
        const client = await mkClient(x.agentId);
        const old = await mkJobOk(client.clientId);
        const moved = await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/agent`, { agentId: y.agentId });
        assert.equal(moved.status, 200);
        assert.deepEqual([moved.body.agents.map((a) => a.name), moved.body.countryCodes], [["Agent Y"], ["RO"]]);
        const stored = await prisma.job.findUnique({ where: { id: old.jobId } });
        assert.deepEqual([stored.responsibleAgentId, stored.countryCode], [x.agentId, "LK"], "the existing job is not rewritten");
        const fresh = await mkJobOk(client.clientId);
        assert.deepEqual([fresh.responsibleAgent.name, fresh.countryCode], ["Agent Y", "RO"], "new jobs use the new agent");
        // The old agent still cannot be deactivated while its job is PROCESSING.
        assert.equal((await api(USERS.MANAGER, "PATCH", `/agents/${x.agentId}/status`, { status: "INACTIVE" })).status, 409);
        const bad = await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/agent`, { agentId: NO_SUCH_ID });
        assert.deepEqual([bad.status, bad.body.code], [400, "AGENT_NOT_FOUND"]);
        assert.equal((await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/agent`, {})).status, 400);
        const [entry] = await audit("CLIENT_AGENT_CHANGED");
        assert.deepEqual([JSON.parse(entry.previousValue).agentIds, JSON.parse(entry.newValue).agentIds, entry.adminId], [[x.agentId], [y.agentId], USERS.MANAGER.adminId]);
    });

    test("CLIENT-009 / REL-004: an inactive client cannot get a new job and cannot take an existing job; history stays", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        const other = await mkClient(agent.agentId, { name: "Other" });
        const finished = await mkJobOk(client.clientId);
        await api(USERS.MANAGER, "POST", `/jobs/${finished.jobId}/complete`, {});
        const live = await mkJobOk(other.clientId);
        assert.equal((await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" })).body.status, "INACTIVE");
        const refused = await mkJob(client.clientId);
        assert.deepEqual([refused.status, refused.body.code], [409, "CLIENT_INACTIVE"]);
        const moveIn = await api(USERS.MANAGER, "PUT", `/jobs/${live.jobId}`, { clientId: client.clientId });
        assert.deepEqual([moveIn.status, moveIn.body.code], [409, "CLIENT_INACTIVE"]);
        const options = (await api(USERS.MANAGER, "GET", "/job-options")).body;
        assert.deepEqual(options.clients.map((c) => c.name), ["Other"], "an inactive client is not offered");
        const job = (await api(USERS.MANAGER, "GET", `/jobs/${finished.jobId}`)).body;
        assert.deepEqual([job.status, job.client.name, job.responsibleAgent.name], ["COMPLETED", "Client 1", "Agent A"]);
        const detail = (await api(USERS.MANAGER, "GET", `/client-management/${client.clientId}`)).body;
        assert.deepEqual([detail.status, detail.jobs.completed.length], ["INACTIVE", 1]);
    });

    test("a client with PROCESSING jobs cannot be made inactive; activation needs an active agent", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        const job = await mkJobOk(client.clientId);
        const blocked = await api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" });
        assert.deepEqual([blocked.status, blocked.body.code], [409, "CLIENT_HAS_PROCESSING_JOBS"]);
        assert.equal((await prisma.client.findUnique({ where: { id: client.clientId } })).isActive, true);
        await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/complete`, {});
        assert.equal((await api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" })).status, 200);
        assert.equal((await api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" })).status, 200, "repeat is harmless");
        assert.equal((await audit("CLIENT_STATUS_CHANGED")).length, 1);
        await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}/status`, { status: "INACTIVE" });
        const noAgent = await api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}/status`, { status: "ACTIVE" });
        assert.deepEqual([noAgent.status, noAgent.body.code], [409, "AGENT_INACTIVE"]);
        await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}/status`, { status: "ACTIVE" });
        assert.equal((await api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}/status`, { status: "ACTIVE" })).body.status, "ACTIVE");
    });

    test("CLIENT-010: a client cannot be hard deleted", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        const job = await mkJobOk(client.clientId);
        for (const who of [USERS.ADMIN, USERS.MANAGER]) assert.ok([404, 405].includes((await api(who, "DELETE", `/client-management/${client.clientId}`)).status));
        await assert.rejects(prisma.client.delete({ where: { id: client.clientId } }), "its job still references it (ON DELETE RESTRICT)");
        assert.equal(await prisma.client.count(), 1);
        void job;
    });

    test("CLIENT-014: create, update, agent change and status change are audited without contact data", async () => {
        const x = await mkAgent({ name: "Agent X" });
        const y = await mkAgent({ name: "Agent Y" });
        const client = await mkClient(x.agentId, { contactNumber: "0771234567", email: "hr@client.com" });
        await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}`, { name: "Renamed", email: "new@client.com" });
        await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/agent`, { agentId: y.agentId });
        await api(USERS.MANAGER, "PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" });
        for (const action of ["CLIENT_CREATED", "CLIENT_UPDATED", "CLIENT_AGENT_CHANGED", "CLIENT_STATUS_CHANGED"]) {
            const [entry] = await audit(action);
            assert.ok(entry, action);
            assert.ok(entry.reason && entry.createdDate);
            assert.equal(JSON.parse(entry.newValue).clientId, client.clientId, action);
        }
        const [updated] = await audit("CLIENT_UPDATED");
        assert.deepEqual(JSON.parse(updated.previousValue), { clientId: client.clientId, name: "Client 1", email: "(changed)" });
        assert.doesNotMatch(JSON.stringify(await prisma.auditLog.findMany()), /94771234567|hr@client\.com|new@client\.com/);
        const categories = (await api(USERS.ADMIN, "GET", "/audit-logs?category=CLIENT")).body;
        assert.equal(categories.items.length, 4);
    });
});

describe("jobs use the relational Client + Agent (REL-005 to REL-008)", () => {
    test("REL-005: a Client/Agent mismatch is rejected; omitting the agent uses the client's; the server never trusts the form", async () => {
        const x = await mkAgent({ name: "Agent X" });
        const y = await mkAgent({ name: "Agent Y", countryCode: "RO" });
        const client = await mkClient(x.agentId);
        const mismatch = await mkJob(client.clientId, { responsibleAgentId: y.agentId });
        assert.deepEqual([mismatch.status, mismatch.body.code], [409, "CLIENT_AGENT_MISMATCH"]);
        assert.equal(await prisma.job.count(), 0);
        const auto = await mkJobOk(client.clientId);
        assert.deepEqual([auto.responsibleAgent.name, auto.client.name, auto.countryCode], ["Agent X", "Client 1", "LK"]);
        const explicit = await mkJobOk(client.clientId, { responsibleAgentId: x.agentId });
        assert.equal(explicit.responsibleAgent.agentId ?? explicit.responsibleAgent.id, x.agentId);
        // A job cannot be moved to a client of another agent either.
        const yClient = await mkClient(y.agentId, { name: "Y Client" });
        const move = await api(USERS.MANAGER, "PUT", `/jobs/${auto.jobId}`, { clientId: yClient.clientId });
        assert.deepEqual([move.status, move.body.code], [409, "CLIENT_AGENT_MISMATCH"]);
        const sameAgent = await mkClient(x.agentId, { name: "Second X Client" });
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${auto.jobId}`, { clientId: sameAgent.clientId })).body.client.name, "Second X Client");
        for (const body of [{ clientId: NO_SUCH_ID }, { clientId: "Client 1" }]) assert.equal((await mkJob(body.clientId)).status, 400, JSON.stringify(body));
        const legacyField = await api(USERS.MANAGER, "POST", "/jobs", { jobTypeId, companyId: client.clientId });
        assert.equal(legacyField.status, 400, "the old companyId field is gone");
    });

    test("a client with no agent (legacy row) gets a clear error until an agent is assigned", async () => {
        const agent = await mkAgent();
        const orphan = await prisma.client.create({ data: { name: "Legacy Co" } });
        const refused = await mkJob(orphan.id);
        assert.deepEqual([refused.status, refused.body.code], [409, "CLIENT_HAS_NO_AGENT"]);
        assert.equal((await api(USERS.MANAGER, "PATCH", `/client-management/${orphan.id}/agent`, { agentId: agent.agentId })).status, 200);
        assert.equal((await mkJob(orphan.id)).status, 201);
        assert.deepEqual((await api(USERS.MANAGER, "GET", "/client-management?search=Legacy")).body.items[0].agents.map((a) => a.name), ["Agent A"]);
    });

    test("REL-006 / 007 / 008: candidate assignments, job UUIDs and the Work Allocation API are unaffected", async () => {
        const agent = await mkAgent();
        const client = await mkClient(agent.agentId);
        await prisma.candidate.createMany({ data: [1, 2].map((i) => ({ passportId: pid(i), uniqueId: `700${i}`, firstName: `N${i}`, otherName: `S${i}` })) });
        await prisma.candidateStage.createMany({ data: [1, 2].map((i) => ({ passportId: pid(i), stage: "TEST_DETAILS", testResult: "PASS" })) });
        await prisma.candidateAllocation.create({ data: { passportId: pid(1), analystId: USERS.ANALYST.adminId } });
        const job = await mkJobOk(client.clientId, { companyJobId: "Y26S01" });
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId: pid(1) })).status, 201);
        // Renaming everything around the job leaves the job id and its membership alone.
        await api(USERS.ADMIN, "PATCH", `/agents/${agent.agentId}`, { name: "Renamed Agent" });
        await api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}`, { name: "Renamed Client" });
        const stored = await prisma.job.findUnique({ where: { id: job.jobId } });
        assert.deepEqual([stored.id, stored.jobCode, stored.companyJobId], [job.jobId, job.jobCode, "Y26S01"]);
        const members = await prisma.jobCandidate.findMany({ where: { jobId: job.jobId } });
        assert.deepEqual(members.map((m) => [m.passportId, m.isActive]), [[pid(1), true]]);
        // A second PROCESSING job for the same candidate is allowed; the same job twice is not.
        const second = await mkJobOk(client.clientId);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${second.jobId}/candidates`, { passportId: pid(1) })).status, 201);
        assert.equal((await api(USERS.MANAGER, "POST", `/jobs/${job.jobId}/candidates`, { passportId: pid(1) })).body.code, "CANDIDATE_ALREADY_IN_JOB");
        // Work Allocation still works and is unchanged by any of this.
        const allocation = await api(USERS.MANAGER, "GET", "/work-allocation/candidates");
        assert.equal(allocation.status, 200);
        assert.equal((await api(USERS.MANAGER, "GET", "/work-allocation/analysts")).status, 200);
        assert.equal((await prisma.candidateAllocation.count()), 1, "the allocation is untouched");
    });

    test("the legacy candidate-documents /clients API is untouched and unrelated to the employer Client", async () => {
        const agent = await mkAgent();
        await mkClient(agent.agentId, { name: "Employer Co" });
        await prisma.candidate.create({ data: { passportId: pid(1), uniqueId: "7001", firstName: "Nimal", otherName: "Perera" } });
        const legacy = await api(USERS.MANAGER, "GET", "/clients");
        assert.equal(legacy.status, 200);
        assert.deepEqual(JSON.stringify(legacy.body).includes("Employer Co"), false, "employer clients never appear in the candidate list");
        assert.ok(JSON.stringify(legacy.body).includes(pid(1)));
        assert.equal((await api(USERS.MANAGER, "GET", `/clients/${pid(1)}`)).status, 200);
    });
});

describe("job-options and concurrency", () => {
    test("job-options offer only active clients with an active agent, each with its active agent ids; job-types stay creatable", async () => {
        const live = await mkAgent({ name: "Live" });
        const gone = await mkAgent({ name: "Gone" });
        await mkClient(live.agentId, { name: "Offered" });
        await mkClient(gone.agentId, { name: "Not offered" });
        await api(USERS.ADMIN, "PATCH", `/agents/${gone.agentId}/status`, { status: "INACTIVE" });
        const options = (await api(USERS.MANAGER, "GET", "/job-options")).body;
        assert.deepEqual(options.clients.map((c) => [c.name, c.agentIds]), [["Offered", [live.agentId]]]);
        assert.deepEqual(options.agents.map((a) => a.name), ["Live"]);
        assert.equal((await api(USERS.MANAGER, "POST", "/job-types", { name: "Cook" })).status, 201);
        assert.equal((await api(USERS.MANAGER, "POST", "/companies", { name: "Co" })).status, 404, "no company route exists");
    });

    test("concurrent: deactivating a client while a job is created for it never leaves a PROCESSING job on an inactive client", async () => {
        const agent = await mkAgent();
        for (let round = 0; round < 3; round += 1) {
            const client = await mkClient(agent.agentId, { name: `Racer ${round}` });
            await Promise.all([mkJob(client.clientId), api(USERS.ADMIN, "PATCH", `/client-management/${client.clientId}/status`, { status: "INACTIVE" })]);
            const row = await prisma.client.findUnique({ where: { id: client.clientId } });
            const processing = await prisma.job.count({ where: { clientId: client.clientId, status: "PROCESSING" } });
            assert.ok(row.isActive || processing === 0, `round ${round}: inactive client with ${processing} PROCESSING job(s)`);
        }
    });
});

describe("migration 20261019120000_client_management", () => {
    test("renames company to client in place: ids, names, jobs and constraints survive; the agent is backfilled from the newest job; no company table is left", async () => {
        const names = migrationNames();
        const target = names.indexOf("20261019120000_client_management");
        assert.ok(target > 0);
        const old = await createTestDatabase({ upTo: names[target - 1] });
        try {
            await old.pg.exec(`
                INSERT INTO "user" ("admin_id","auth_user_id","name","email","role","status","updated_date") VALUES ('u1', gen_random_uuid(), 'Admin', 'a@x.invalid', 'ADMIN', 'ACTIVE', now());
                INSERT INTO "job_type" ("id","code","name") VALUES ('00000000-0000-4000-8000-0000000000a1','WELDER','Welder');
                INSERT INTO "agent" ("id","name","country_code") VALUES ('00000000-0000-4000-8000-0000000000b1','Old Agent','LK'), ('00000000-0000-4000-8000-0000000000b2','Newer Agent','LK');
                INSERT INTO "company" ("id","name") VALUES ('00000000-0000-4000-8000-0000000000c1','With Jobs'), ('00000000-0000-4000-8000-0000000000c2','No Jobs');
                INSERT INTO "job" ("id","job_code","job_type_id","company_id","responsible_agent_id","country_code","created_by","created_at")
                    VALUES ('00000000-0000-4000-8000-0000000000d1','JOB-2026-000001','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000b1','LK','u1','2026-01-01'),
                           ('00000000-0000-4000-8000-0000000000d2','JOB-2026-000002','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000b2','LK','u1','2026-02-01');`);
            await old.pg.exec(fs.readFileSync(path.join(import.meta.dirname, "..", "prisma", "migrations", names[target], "migration.sql"), "utf8"));
            const q = async (sql) => (await old.pg.query(sql)).rows;
            assert.deepEqual(await q(`SELECT to_regclass('public.company') AS c, to_regclass('public.client') AS k`), [{ c: null, k: "client" }]);
            assert.deepEqual((await q(`SELECT "id","name","agent_id" FROM "client" ORDER BY "name"`)).map((r) => [r.id.slice(-2), r.name, r.agent_id?.slice(-2) ?? null]), [["c2", "No Jobs", null], ["c1", "With Jobs", "b2"]]);
            assert.deepEqual((await q(`SELECT "client_id" FROM "job" ORDER BY "job_code"`)).map((r) => r.client_id.slice(-2)), ["c1", "c1"]);
            assert.equal((await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='job' AND column_name='company_id'`))[0].n, 0);
            assert.equal((await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='job' AND column_name='company_job_id'`))[0].n, 1, "the employer's own job id keeps its name");
            const fks = (await q(`SELECT conname, confrelid::regclass::text AS target FROM pg_constraint WHERE contype='f' AND conrelid IN ('job'::regclass,'client'::regclass) ORDER BY conname`)).map((r) => `${r.conname}->${r.target}`);
            assert.ok(fks.includes("job_client_id_fkey->client") && fks.includes("client_agent_id_fkey->agent"), fks.join());
            const leftover = await q(`SELECT conname FROM pg_constraint WHERE conname LIKE '%company%' AND conname <> 'job_company_job_id_check' AND conname NOT LIKE '%not\_null'`);
            assert.deepEqual(leftover, [], "no constraint still carries the old name");
            assert.ok(!(await q(`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%company%' AND indexname <> 'job_company_job_id_key'`)).length);
            assert.ok((await q(`SELECT 1 FROM pg_class WHERE relname='client' AND relrowsecurity`)).length, "RLS survives the rename");
            await assert.rejects(old.pg.exec(`INSERT INTO "client" ("name") VALUES ('with jobs')`), "the case-insensitive unique name still holds");
            await assert.rejects(old.pg.exec(`DELETE FROM "agent" WHERE "id"='00000000-0000-4000-8000-0000000000b2'`), "agents stay protected");
        } finally {
            await old.close();
        }
    });

    test("only ONE employer table exists; the Candidate Form job-group link still points at job.id", async () => {
        const tables = (await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`)).rows.map((r) => r.table_name);
        assert.ok(tables.includes("client") && !tables.includes("company"));
        const linkFk = (await pg.query(`SELECT ccu.table_name, ccu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.table_name = 'candidate_form_link' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'job_id'`)).rows;
        assert.deepEqual(linkFk, [{ table_name: "job", column_name: "id" }]);
        const columns = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name='job'`)).rows.map((r) => r.column_name);
        assert.ok(!columns.includes("company_id"));
    });
});
