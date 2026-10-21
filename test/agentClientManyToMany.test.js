// Agent <-> Client MANY-TO-MANY (agent_client; migration 20261026120000_agent_client_many_to_many):
// the relationship rules, replacement edits, validation, roles, concurrency, Job integrity and
// the To Country, plus the migration rehearsal (an older database with real one-to-many data is
// upgraded; nothing is lost; running it again changes nothing).
// On a REAL PostgreSQL (PGlite, every migration applied) through the real Prisma client, the real
// services and the real admin router. Cases M2M REL-001..015, COUNTRY-REL-001..002.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

const MIGRATION = "20261026120000_agent_client_many_to_many";
const user = (adminId, role, n) => ({ adminId, role, name: `${role} ${n}`, email: `${adminId}@example.invalid`, authUserId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });
const USERS = { ADMIN: user("u-admin", "ADMIN", 1), MANAGER: user("u-manager", "MANAGER", 2), DESK: user("u-desk", "REGISTRATION_DESK", 3), ANALYST: user("u-ann", "ANALYST", 4) };
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

const ok = (response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body;
};
const mkAgent = async (name, countryCode = "LK", extra = {}) => ok(await api(USERS.ADMIN, "POST", "/agents", { name, countryCode, ...extra }), 201);
const mkClient = async (name, agentIds, extra = {}) => ok(await api(USERS.ADMIN, "POST", "/client-management", { name, agentIds, ...extra }), 201);
const editClient = (clientId, body, who = USERS.MANAGER) => api(who, "PATCH", `/client-management/${clientId}`, body);
const editAgent = (agentId, body, who = USERS.MANAGER) => api(who, "PATCH", `/agents/${agentId}`, body);
const mkJob = (clientId, extra = {}) => api(USERS.MANAGER, "POST", "/jobs", { jobTypeId, clientId, ...extra });
const agentsOf = async (clientId) => (await prisma.agentClient.findMany({ where: { clientId }, select: { agentId: true } })).map((r) => r.agentId).sort();
const clientsOf = async (agentId) => (await prisma.agentClient.findMany({ where: { agentId }, select: { clientId: true } })).map((r) => r.clientId).sort();
const sorted = (ids) => [...ids].sort();

describe("the relationship (M2M REL-001 to REL-004, REL-012)", () => {
    test("REL-001: one Agent works with several Clients", async () => {
        const a = await mkAgent("Agent A");
        const c1 = await mkClient("Client 1", [a.agentId]);
        const c2 = await mkClient("Client 2", [a.agentId]);
        const c3 = await mkClient("Client 3", [a.agentId]);
        assert.deepEqual(await clientsOf(a.agentId), sorted([c1.clientId, c2.clientId, c3.clientId]));
        const detail = ok(await api(USERS.MANAGER, "GET", `/agents/${a.agentId}`));
        assert.deepEqual(detail.clients.map((c) => c.name), ["Client 1", "Client 2", "Client 3"]);
        assert.equal(detail.activeClients, 3);
    });

    test("REL-002: one Client works with several Agents (also in different countries); all of them are shown, none is primary", async () => {
        const lk = await mkAgent("Lanka Agent", "LK");
        const ro = await mkAgent("Romania Agent", "RO");
        const client = await mkClient("Shared Co", [ro.agentId, lk.agentId]);
        assert.deepEqual(client.agents.map((a) => a.name), ["Lanka Agent", "Romania Agent"], "sorted by name, every agent");
        assert.deepEqual(client.countryCodes, ["LK", "RO"]);
        assert.equal(client.agent, undefined, "there is no single 'responsible agent' field any more");
        assert.deepEqual(await agentsOf(client.clientId), sorted([lk.agentId, ro.agentId]));
        // Each agent lists it; the list filters find it through either agent and either country.
        for (const agent of [lk, ro]) assert.deepEqual(ok(await api(USERS.MANAGER, "GET", `/agents/${agent.agentId}`)).clients.map((c) => c.name), ["Shared Co"]);
        const names = async (query) => ok(await api(USERS.MANAGER, "GET", `/client-management${query}`)).items.map((c) => c.name);
        assert.deepEqual(await names(`?agentId=${lk.agentId}`), ["Shared Co"]);
        assert.deepEqual(await names(`?agentId=${ro.agentId}`), ["Shared Co"]);
        assert.deepEqual(await names("?country=RO"), ["Shared Co"]);
        assert.equal(ok(await api(USERS.MANAGER, "GET", "/client-management")).items.length, 1, "a client with two agents is listed once");
    });

    test("REL-003: a duplicate Agent/Client pair cannot exist (request de-duplicated; database primary key refuses it)", async () => {
        const a = await mkAgent("Agent A");
        const client = await mkClient("Client 1", [a.agentId, a.agentId, a.agentId.toUpperCase()]);
        assert.deepEqual(await agentsOf(client.clientId), [a.agentId]);
        ok(await editClient(client.clientId, { agentIds: [a.agentId, a.agentId] }));
        assert.equal(await prisma.agentClient.count(), 1);
        await assert.rejects(pg.exec(`INSERT INTO "agent_client" ("agent_id","client_id") VALUES ('${a.agentId}','${client.clientId}')`), /duplicate|unique|pkey/i);
    });

    test("REL-012: removing a link deletes only the link: the Agent and the Client remain; the database refuses to delete a linked Agent or Client", async () => {
        const a = await mkAgent("Agent A");
        const b = await mkAgent("Agent B");
        const client = await mkClient("Client 1", [a.agentId, b.agentId]);
        ok(await editClient(client.clientId, { agentIds: [b.agentId] }));
        assert.deepEqual(await agentsOf(client.clientId), [b.agentId]);
        assert.equal(await prisma.agent.count({ where: { id: a.agentId } }), 1, "the agent itself is still there");
        assert.equal(await prisma.client.count({ where: { id: client.clientId } }), 1);
        await assert.rejects(prisma.agent.delete({ where: { id: b.agentId } }), "RESTRICT: a linked agent cannot be deleted");
        await assert.rejects(prisma.client.delete({ where: { id: client.clientId } }), "RESTRICT: a linked client cannot be deleted");
    });
});

describe("editing the links (M2M REL-005 to REL-009, REL-011)", () => {
    test("REL-005 / 006: editing a Client adds a new Agent, then removes only the deselected one (replacement), audited", async () => {
        const [a, b, c] = [await mkAgent("Agent A"), await mkAgent("Agent B"), await mkAgent("Agent C")];
        const client = await mkClient("Client 1", [a.agentId, b.agentId]);
        const other = await mkClient("Other", [a.agentId]);
        const added = ok(await editClient(client.clientId, { agentIds: [a.agentId, b.agentId, c.agentId] }));
        assert.deepEqual(added.agents.map((x) => x.name), ["Agent A", "Agent B", "Agent C"]);
        const removed = ok(await editClient(client.clientId, { agentIds: [a.agentId, c.agentId] }));
        assert.deepEqual(removed.agents.map((x) => x.name), ["Agent A", "Agent C"], "only B was removed; A and C kept");
        assert.deepEqual(await agentsOf(other.clientId), [a.agentId], "another client of A is untouched");
        const entries = await prisma.auditLog.findMany({ where: { action: "CLIENT_AGENT_CHANGED" }, orderBy: { createdDate: "asc" } });
        assert.deepEqual(entries.map((e) => [JSON.parse(e.newValue).added.length, JSON.parse(e.newValue).removed.length]), [[1, 0], [0, 1]]);
        // The same set again changes nothing and writes no entry; other fields are kept.
        ok(await editClient(client.clientId, { agentIds: [c.agentId, a.agentId], contactPerson: "Ms Silva" }));
        assert.equal(await prisma.auditLog.count({ where: { action: "CLIENT_AGENT_CHANGED" } }), 2);
        assert.equal((await prisma.client.findUnique({ where: { id: client.clientId } })).name, "Client 1");
        // A Client keeps at least one Agent.
        const empty = await editClient(client.clientId, { agentIds: [] });
        assert.equal(empty.status, 400);
        assert.deepEqual(await agentsOf(client.clientId), sorted([a.agentId, c.agentId]));
    });

    test("REL-007: editing an Agent adds and removes Clients (replacement); a Client is never left without an Agent", async () => {
        const a = await mkAgent("Agent A");
        const b = await mkAgent("Agent B");
        const shared = await mkClient("Shared", [a.agentId, b.agentId]);
        const onlyA = await mkClient("Only A", [a.agentId]);
        const free = await mkClient("Free", [b.agentId]);
        const edited = ok(await editAgent(a.agentId, { clientIds: [onlyA.clientId, free.clientId] }));
        assert.deepEqual(edited.clients.map((c) => c.name), ["Free", "Only A"], "Free added, Shared removed");
        assert.deepEqual(await agentsOf(shared.clientId), [b.agentId], "Shared still has B");
        assert.deepEqual(await agentsOf(free.clientId), sorted([a.agentId, b.agentId]));
        const orphan = await editAgent(a.agentId, { clientIds: [free.clientId] });
        assert.deepEqual([orphan.status, orphan.body.code], [409, "CLIENT_NEEDS_AGENT"]);
        assert.match(orphan.body.message, /Only A/);
        assert.deepEqual(await clientsOf(a.agentId), sorted([onlyA.clientId, free.clientId]), "refused: nothing was saved");
        // Created with clients in one step; all fields and links together.
        const fresh = await mkAgent("Agent C", "RO", { clientIds: [shared.clientId, onlyA.clientId] });
        assert.deepEqual(fresh.clients.map((c) => c.name), ["Only A", "Shared"]);
        assert.equal(await prisma.auditLog.count({ where: { action: "AGENT_CLIENTS_CHANGED" } }), 1, "the edit is audited (creation is the CREATED entry)");
    });

    test("REL-008: an invalid Agent id is refused (malformed 400, unknown 400, inactive 409) and nothing is saved", async () => {
        const a = await mkAgent("Agent A");
        const off = await mkAgent("Off");
        ok(await api(USERS.ADMIN, "PATCH", `/agents/${off.agentId}/status`, { status: "INACTIVE" }));
        for (const agentIds of [["not-an-id"], "abc", [123], [a.agentId, NO_SUCH_ID]]) {
            const response = await api(USERS.ADMIN, "POST", "/client-management", { name: "X", agentIds });
            assert.equal(response.status, 400, JSON.stringify(agentIds));
        }
        assert.deepEqual((await api(USERS.ADMIN, "POST", "/client-management", { name: "X", agentIds: [a.agentId, off.agentId] })).body.code, "AGENT_INACTIVE");
        assert.equal(await prisma.client.count(), 0, "no client, no partial link");
        const client = await mkClient("Client 1", [a.agentId]);
        const bad = await editClient(client.clientId, { agentIds: [a.agentId, NO_SUCH_ID], name: "Renamed" });
        assert.deepEqual([bad.status, bad.body.code], [400, "AGENT_NOT_FOUND"]);
        assert.equal((await prisma.client.findUnique({ where: { id: client.clientId } })).name, "Client 1", "the name was not saved either");
        // An agent that became inactive may stay linked; it just cannot be newly added.
        const b = await mkAgent("Agent B");
        ok(await editClient(client.clientId, { agentIds: [a.agentId, b.agentId] }));
        ok(await api(USERS.ADMIN, "PATCH", `/agents/${b.agentId}/status`, { status: "INACTIVE" }));
        ok(await editClient(client.clientId, { agentIds: [a.agentId, b.agentId], name: "Kept" }));
    });

    test("REL-009: an invalid Client id is refused and nothing is saved", async () => {
        const a = await mkAgent("Agent A");
        const client = await mkClient("Client 1", [a.agentId]);
        for (const clientIds of [["nope"], { id: 1 }, [client.clientId, NO_SUCH_ID]]) {
            const response = await editAgent(a.agentId, { clientIds, name: "Renamed" });
            assert.equal(response.status, 400, JSON.stringify(clientIds));
        }
        assert.equal((await api(USERS.ADMIN, "POST", "/agents", { name: "New", countryCode: "LK", clientIds: [NO_SUCH_ID] })).status, 400);
        assert.equal(await prisma.agent.count(), 1, "the new agent was not created");
        assert.equal((await prisma.agent.findUnique({ where: { id: a.agentId } })).name, "Agent A");
        assert.deepEqual(await clientsOf(a.agentId), [client.clientId]);
        // An inactive agent cannot be given clients.
        const off = await api(USERS.ADMIN, "POST", "/agents", { name: "Off", countryCode: "LK", status: "INACTIVE", clientIds: [client.clientId] });
        assert.deepEqual([off.status, off.body.code], [409, "AGENT_INACTIVE"]);
    });

    test("REL-011: concurrent link edits never create a duplicate and never leave a Client without an Agent", async () => {
        const [a, b, c] = [await mkAgent("Agent A"), await mkAgent("Agent B"), await mkAgent("Agent C")];
        const client = await mkClient("Client 1", [a.agentId]);
        // The same addition from both sides at once.
        const results = await Promise.all([
            editClient(client.clientId, { agentIds: [a.agentId, b.agentId] }),
            editAgent(b.agentId, { clientIds: [client.clientId] }),
            editClient(client.clientId, { agentIds: [a.agentId, b.agentId] }),
        ]);
        assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
        assert.deepEqual(await agentsOf(client.clientId), sorted([a.agentId, b.agentId]));
        assert.equal(await prisma.agentClient.count({ where: { clientId: client.clientId, agentId: b.agentId } }), 1);
        // Two agents each removing the client at once: one may go, never both.
        ok(await editClient(client.clientId, { agentIds: [a.agentId, b.agentId, c.agentId] }));
        await Promise.all([editAgent(a.agentId, { clientIds: [] }), editAgent(b.agentId, { clientIds: [] }), editAgent(c.agentId, { clientIds: [] })]);
        assert.ok((await agentsOf(client.clientId)).length >= 1, "the client kept at least one agent");
    });
});

describe("roles (M2M REL-010)", () => {
    test("REL-010: ANALYST and REGISTRATION_DESK cannot read or change links; ADMIN and MANAGER can", async () => {
        const a = await mkAgent("Agent A");
        const b = await mkAgent("Agent B");
        const client = await mkClient("Client 1", [a.agentId]);
        for (const who of [USERS.ANALYST, USERS.DESK]) {
            assert.equal((await editClient(client.clientId, { agentIds: [b.agentId] }, who)).status, 403);
            assert.equal((await editAgent(b.agentId, { clientIds: [client.clientId] }, who)).status, 403);
            assert.equal((await api(who, "POST", "/client-management", { name: "X", agentIds: [a.agentId] })).status, 403);
            assert.equal((await api(who, "POST", "/agents", { name: "X", countryCode: "LK", clientIds: [client.clientId] })).status, 403);
            assert.equal((await api(who, "GET", "/client-options")).status, 403);
        }
        assert.deepEqual(ok(await api(USERS.MANAGER, "GET", "/client-options")).clients, [{ clientId: client.clientId, name: "Client 1", status: "ACTIVE" }]);
        assert.deepEqual(await agentsOf(client.clientId), [a.agentId]);
        ok(await editClient(client.clientId, { agentIds: [a.agentId, b.agentId] }, USERS.ADMIN));
        ok(await editAgent(b.agentId, { clientIds: [] }, USERS.MANAGER));
    });
});

describe("Jobs stay with their Client (M2M REL-013, REL-014, COUNTRY-REL-001, COUNTRY-REL-002)", () => {
    test("REL-013 / COUNTRY-REL-002: link changes never touch a Job's Client, responsible Agent or To Country", async () => {
        const lk = await mkAgent("Lanka Agent", "LK");
        const ro = await mkAgent("Romania Agent", "RO");
        const client = await mkClient("Client 1", [lk.agentId]);
        const job = ok(await mkJob(client.clientId), 201);
        assert.deepEqual([job.client.name, job.responsibleAgent.name, job.countryCode], ["Client 1", "Lanka Agent", "LK"]);
        ok(await editClient(client.clientId, { agentIds: [ro.agentId] }));
        const stored = await prisma.job.findUnique({ where: { id: job.jobId } });
        assert.deepEqual([stored.clientId, stored.responsibleAgentId, stored.countryCode], [client.clientId, lk.agentId, "LK"], "the job keeps its own record");
        assert.deepEqual(ok(await api(USERS.MANAGER, "GET", `/client-management/${client.clientId}`)).jobs.processing.map((j) => [j.jobId, j.responsibleAgent.name]), [[job.jobId, "Lanka Agent"]]);
        // The former agent still sees its job (by responsible agent), though no longer linked.
        assert.deepEqual(ok(await api(USERS.MANAGER, "GET", `/agents/${lk.agentId}`)).jobs.processing.map((j) => j.jobId), [job.jobId]);
        // A new job uses a CURRENT agent of the client.
        assert.equal(ok(await mkJob(client.clientId), 201).countryCode, "RO");
    });

    test("REL-014: an Agent's Jobs are listed once each, however many Clients it shares", async () => {
        const a = await mkAgent("Agent A");
        const b = await mkAgent("Agent B");
        const c1 = await mkClient("Client 1", [a.agentId, b.agentId]);
        const c2 = await mkClient("Client 2", [a.agentId, b.agentId]);
        const jobs = [
            ok(await mkJob(c1.clientId, { responsibleAgentId: a.agentId }), 201),
            ok(await mkJob(c1.clientId, { responsibleAgentId: a.agentId }), 201),
            ok(await mkJob(c2.clientId, { responsibleAgentId: a.agentId }), 201),
            ok(await mkJob(c2.clientId, { responsibleAgentId: b.agentId }), 201),
        ];
        const detail = ok(await api(USERS.MANAGER, "GET", `/agents/${a.agentId}`));
        const ids = detail.jobs.processing.map((j) => j.jobId);
        assert.equal(ids.length, 3);
        assert.equal(new Set(ids).size, 3, "no job is repeated");
        assert.deepEqual(sorted(ids), sorted(jobs.slice(0, 3).map((j) => j.jobId)));
        assert.equal(detail.processingJobs, 3);
        const client = ok(await api(USERS.MANAGER, "GET", `/client-management/${c1.clientId}`));
        assert.equal(client.jobs.processing.length, 2, "the client's jobs are listed once each too");
        const list = ok(await api(USERS.MANAGER, "GET", "/jobs"));
        assert.equal(list.items.length, 4);
        assert.equal(new Set(list.items.map((j) => j.jobId)).size, 4);
    });

    test("COUNTRY-REL-001: with several Agents the responsible Agent must be chosen; the To Country is that Agent's, never a guess", async () => {
        const lk = await mkAgent("Lanka Agent", "LK");
        const ro = await mkAgent("Romania Agent", "RO");
        const outsider = await mkAgent("Outsider", "DE");
        const client = await mkClient("Shared Co", [lk.agentId, ro.agentId]);
        const unchosen = await mkJob(client.clientId);
        assert.deepEqual([unchosen.status, unchosen.body.code], [409, "AGENT_REQUIRED"]);
        assert.equal(await prisma.job.count(), 0, "no job and no job code used");
        assert.equal(ok(await mkJob(client.clientId, { responsibleAgentId: ro.agentId }), 201).countryCode, "RO");
        assert.equal(ok(await mkJob(client.clientId, { responsibleAgentId: lk.agentId }), 201).countryCode, "LK");
        assert.equal((await mkJob(client.clientId, { responsibleAgentId: outsider.agentId })).body.code, "CLIENT_AGENT_MISMATCH");
        // job-options give the client's active agents; the browser chooses, the server re-checks.
        const options = ok(await api(USERS.MANAGER, "GET", "/job-options"));
        assert.deepEqual(sorted(options.clients.find((c) => c.name === "Shared Co").agentIds), sorted([lk.agentId, ro.agentId]));
        // An inactive linked agent is not offered and cannot be chosen.
        await prisma.job.updateMany({ where: { responsibleAgentId: ro.agentId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "test" } });
        ok(await api(USERS.ADMIN, "PATCH", `/agents/${ro.agentId}/status`, { status: "INACTIVE" }));
        assert.deepEqual(ok(await api(USERS.MANAGER, "GET", "/job-options")).clients.find((c) => c.name === "Shared Co").agentIds, [lk.agentId]);
        assert.equal((await mkJob(client.clientId, { responsibleAgentId: ro.agentId })).body.code, "AGENT_INACTIVE");
    });

    test("moving a Job to another Client needs its responsible Agent to work with that Client", async () => {
        const a = await mkAgent("Agent A");
        const b = await mkAgent("Agent B");
        const c1 = await mkClient("Client 1", [a.agentId]);
        const c2 = await mkClient("Client 2", [a.agentId, b.agentId]);
        const c3 = await mkClient("Client 3", [b.agentId]);
        const job = ok(await mkJob(c1.clientId), 201);
        assert.equal(ok(await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { clientId: c2.clientId })).client.name, "Client 2");
        assert.equal((await api(USERS.MANAGER, "PUT", `/jobs/${job.jobId}`, { clientId: c3.clientId })).body.code, "CLIENT_AGENT_MISMATCH");
    });
});

describe(`migration ${MIGRATION} (M2M REL-004, REL-015)`, () => {
    const names = migrationNames();
    const previous = names[names.indexOf(MIGRATION) - 1];
    const sql = fs.readFileSync(path.join(import.meta.dirname, "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
    const id = (prefix, n) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(11, "0")}`;

    test("fresh database: the whole chain applies, the table, keys, indexes and RLS exist; client.agent_id stays (deprecated)", async () => {
        const q = async (text) => (await pg.query(text)).rows;
        assert.deepEqual((await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_client' ORDER BY ordinal_position`)).map((r) => r.column_name), ["agent_id", "client_id", "created_at"]);
        const constraints = (await q(`SELECT conname, contype, confdeltype FROM pg_constraint WHERE conrelid = 'agent_client'::regclass AND contype IN ('p', 'f') ORDER BY conname`)).map((r) => [r.conname, r.contype, r.confdeltype]);
        assert.deepEqual(constraints, [["agent_client_agent_id_fkey", "f", "r"], ["agent_client_client_id_fkey", "f", "r"], ["agent_client_pkey", "p", " "]], "RESTRICT on both sides");
        assert.ok((await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'agent_client_client_id_idx'`)).length);
        assert.ok((await q(`SELECT 1 FROM pg_class WHERE relname = 'agent_client' AND relrowsecurity`)).length);
        assert.ok((await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'client' AND column_name = 'agent_id'`)).length, "the old column is kept for a staged removal");
    });

    test("REL-004 / REL-015: an existing one-to-many database is upgraded with every Agent, Client, Job and link kept; running it again changes nothing", async () => {
        const old = await createTestDatabase({ upTo: previous });
        try {
            // Representative data: agent 1 with clients 1-3, agent 2 with client 4, client 5 with no agent
            // (legacy), agent 3 with no client; jobs (one with a former agent, still on client 1),
            // a candidate on a job, and the history.
            await old.pg.exec(`
                INSERT INTO "user" ("admin_id","auth_user_id","name","email","role","status","updated_date") VALUES ('u1', gen_random_uuid(), 'Admin', 'a@x.invalid', 'ADMIN', 'ACTIVE', now());
                INSERT INTO "job_type" ("id","code","name") VALUES ('${id("a", 1)}','QA_WELDER','QA Welder');
                INSERT INTO "agent" ("id","name","country_code") VALUES ('${id("b", 1)}','Agent One','LK'), ('${id("b", 2)}','Agent Two','RO'), ('${id("b", 3)}','Agent Three','DE');
                INSERT INTO "client" ("id","name","agent_id") VALUES
                    ('${id("c", 1)}','Client One','${id("b", 1)}'), ('${id("c", 2)}','Client Two','${id("b", 1)}'), ('${id("c", 3)}','Client Three','${id("b", 1)}'),
                    ('${id("c", 4)}','Client Four','${id("b", 2)}'), ('${id("c", 5)}','Legacy Five',NULL);
                INSERT INTO "job" ("id","job_code","job_type_id","client_id","responsible_agent_id","country_code","from_country_code","status","created_by","completed_at") VALUES
                    ('${id("d", 1)}','JOB-2026-000001','${id("a", 1)}','${id("c", 1)}','${id("b", 1)}','LK','RO','PROCESSING','u1',NULL),
                    ('${id("d", 2)}','JOB-2026-000002','${id("a", 1)}','${id("c", 1)}','${id("b", 2)}','RO',NULL,'COMPLETED','u1',now()),
                    ('${id("d", 3)}','JOB-2026-000003','${id("a", 1)}','${id("c", 4)}','${id("b", 2)}','RO','RO','PROCESSING','u1',NULL);
                INSERT INTO "candidate" ("passport_id","unique_id","first_name","updated_date") VALUES ('QA000001','9001','Nimal',now());
                INSERT INTO "job_candidate" ("job_id","passport_id","assigned_by") VALUES ('${id("d", 1)}','QA000001','u1');`);
            const q = async (text) => (await old.pg.query(text)).rows;
            const counts = async () => (await q(`SELECT (SELECT count(*) FROM "agent")::int AS agents, (SELECT count(*) FROM "client")::int AS clients, (SELECT count(*) FROM "job")::int AS jobs, (SELECT count(*) FROM "job_candidate")::int AS members, (SELECT count(*) FROM "client" WHERE "agent_id" IS NOT NULL)::int AS links`))[0];
            const jobs = async () => q(`SELECT "id","client_id","responsible_agent_id","country_code","from_country_code","status" FROM "job" ORDER BY "id"`);
            const before = await counts();
            const jobsBefore = await jobs();
            assert.deepEqual(before, { agents: 3, clients: 5, jobs: 3, members: 1, links: 4 });

            await old.pg.exec(sql);
            const links = async () => (await q(`SELECT "agent_id","client_id" FROM "agent_client" ORDER BY "client_id"`)).map((r) => [r.agent_id.slice(-1), r.client_id.slice(-1)]);
            assert.deepEqual(await links(), [["1", "1"], ["1", "2"], ["1", "3"], ["2", "4"]], "exactly the current associations; the former agent of a job and the legacy client add nothing");
            const after = await counts();
            assert.deepEqual(after, before, "no Agent, Client, Job, membership or old link lost");
            assert.deepEqual(await jobs(), jobsBefore, "every job keeps its client, agent, To / From Country and status");
            assert.equal((await q(`SELECT count(*)::int AS n FROM "client" c WHERE c."agent_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agent_client" ac WHERE ac."client_id" = c."id" AND ac."agent_id" = c."agent_id")`))[0].n, 0);

            // Re-run (idempotency): nothing changes, nothing fails.
            await old.pg.exec(sql);
            assert.deepEqual(await links(), [["1", "1"], ["1", "2"], ["1", "3"], ["2", "4"]]);
            assert.deepEqual(await counts(), before);
        } finally {
            await old.close();
        }
    });
});
