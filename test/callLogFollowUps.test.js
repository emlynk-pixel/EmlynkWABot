// Priority Follow-Ups (callLogFollowUpService.js) and the current document
// status shown with call logs. On a REAL PostgreSQL (PGlite, every migration
// applied) through the real Prisma client and the real admin router: the
// partial unique index, CHECK constraints, foreign keys and the append-only
// audit log are the database's own. No Supabase: the signed-in user is set
// by a stand-in for requireActiveUser.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
    addCallLog, CANDIDATE_DOCUMENT_TYPES, createCandidate, documentStatusOf, listCallLogs, parseCandidateBody, updateCandidateDetails, updateStage,
} from "../src/services/candidateService.js";
import { FOLLOW_UP_STATUS, listFollowUps } from "../src/services/callLogFollowUpService.js";

const MIGRATION = "20261011120000_call_log_follow_up";
const USERS = {
    ADMIN: { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.invalid", role: "ADMIN" },
    MANAGER: { adminId: "user-manager", authUserId: "00000000-0000-4000-8000-000000000002", name: "Max Manager", email: "max@example.invalid", role: "MANAGER" },
    ANALYST: { adminId: "user-analyst", authUserId: "00000000-0000-4000-8000-000000000003", name: "Ann Analyst", email: "ann@example.invalid", role: "ANALYST" },
    REGISTRATION_DESK: { adminId: "user-desk", authUserId: "00000000-0000-4000-8000-000000000004", name: "Dee Desk", email: "dee@example.invalid", role: "REGISTRATION_DESK" },
};
const STAFF_ROLES = ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"];
const BASE = {
    surname: "De Soysa", otherNames: "Anusha", address: "Negombo, Sri Lanka", dateOfBirth: "1996-02-23",
    jobTypes: ["Caregiver"], jobExperience: "2 years", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14",
};
const A = "N1023757";
const B = "P2222222";

let database;
let prisma;
let pg;

before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    for (const user of Object.values(USERS)) await prisma.user.create({ data: user });
});
after(async () => database?.close());

beforeEach(async () => {
    // audit_logs is append-only; this throwaway database lifts its triggers
    // just to start each test empty.
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "call_log_follow_up"; DELETE FROM "candidate_call_logs";
        DELETE FROM "candidate_additional_details"; DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue";
    `);
    for (const [passportId, nic, whatsappNumber, otherNames] of [[A, "965404378V", "+94771234567", "Anusha"], [B, "199012345678", "+94777654321", "Kamal"]]) {
        const { values } = parseCandidateBody({ ...BASE, passportId, nic, whatsappNumber, otherNames }, { creating: true });
        await createCandidate({ db: prisma, values });
    }
});

async function withServer(role, work) {
    const app = express();
    app.use(express.json());
    const requireAdmin = (req, res, next) => { req.user = { ...(USERS[role] ?? USERS.ADMIN), role, status: "ACTIVE" }; next(); };
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    try {
        return await work(async (urlPath, { method = "GET", body } = {}) => {
            const response = await fetch(`${base}${urlPath}`, {
                method,
                headers: { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        });
    } finally {
        server.close();
    }
}
const as = (role, urlPath, options) => withServer(role, (call) => call(urlPath, options));

// A call log through the real service; returns its ID.
async function logCall(passportId, note, calledAt = null, admin = USERS.ADMIN) {
    const { items } = await addCallLog({ db: prisma, admin, passportId, values: { note, calledAt: calledAt ? new Date(calledAt) : null } });
    return items.find((item) => item.note === note).callLogId;
}
const flag = (role, passportId, callLogId) => as(role, `/candidates/${passportId}/call-logs/${callLogId}/follow-up`, { method: "POST" });
const complete = (role, followUpId) => as(role, `/follow-ups/${followUpId}/complete`, { method: "POST" });
const remove = (role, followUpId) => as(role, `/follow-ups/${followUpId}`, { method: "DELETE" });
const list = (role = "ADMIN", status) => as(role, `/follow-ups${status ? `?status=${status}` : ""}`);

async function flagged(passportId, note, role = "ADMIN") {
    const callLogId = await logCall(passportId, note);
    const response = await flag(role, passportId, callLogId);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { callLogId, followUpId: response.body.followUp.followUpId };
}

async function addDocument(passportId, documentType, { variant = null, status = "VERIFIED", receivedDate = new Date() } = {}) {
    const documentId = crypto.randomUUID();
    await prisma.document.create({
        data: {
            documentId, passportId, documentType, documentVariant: variant,
            originalFilename: `${documentType.toLowerCase()}.pdf`, storedFilename: `${documentId}.pdf`, storagePath: `clients/${passportId}/${documentId}.pdf`,
            mimeType: "application/pdf", receivedDate, processingStatus: "STORED", verificationStatus: status,
        },
    });
    return documentId;
}
const statusOf = (documentStatus, documentType, variant = null) => documentStatus.find((d) => d.documentType === documentType && d.variant === variant);
const callLogRow = (callLogId) => prisma.candidateCallLog.findUnique({ where: { callLogId } });
const followUpRow = (followUpId) => prisma.callLogFollowUp.findUnique({ where: { followUpId } });
const followUpAudit = () => prisma.auditLog.findMany({ where: { action: { endsWith: "FOLLOW_UP" } }, orderBy: [{ createdDate: "asc" }, { auditId: "asc" }] });

describe("migration", () => {
    test("adds one table: foreign keys to the call log and the users, a partial unique index, CHECKs and RLS; additive only", async () => {
        assert.ok(migrationNames().includes(MIGRATION));
        const sql = fs.readFileSync(path.join("prisma", "migrations", MIGRATION, "migration.sql"), "utf8").replace(/--.*$/gm, "");
        assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+")|ALTER TABLE "(candidate|candidate_call_logs|documents|user)"\s|ALTER COLUMN|DROP COLUMN/im, "additive only");
        assert.deepEqual(sql.match(/CREATE TABLE "\w+"/g), ['CREATE TABLE "call_log_follow_up"']);

        const constraints = (await pg.query(`
            SELECT con.contype, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname = 'call_log_follow_up' ORDER BY con.conname
        `)).rows;
        const defs = constraints.map((c) => c.def);
        assert.ok(defs.some((d) => /FOREIGN KEY \(call_log_id\) REFERENCES candidate_call_logs\(call_log_id\) ON UPDATE CASCADE ON DELETE CASCADE/.test(d)));
        assert.ok(defs.some((d) => /FOREIGN KEY \(flagged_by\) REFERENCES "user"\(admin_id\) ON UPDATE CASCADE ON DELETE RESTRICT/.test(d)));
        assert.ok(defs.some((d) => /FOREIGN KEY \(completed_by\) REFERENCES "user"\(admin_id\) ON UPDATE CASCADE ON DELETE RESTRICT/.test(d)));
        assert.equal(constraints.filter((c) => c.contype === "c").length, 2, "status and completion CHECKs");
        const index = (await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'call_log_follow_up_one_open_per_call_log'`)).rows[0];
        assert.match(index.indexdef, /UNIQUE INDEX .* \(call_log_id\) WHERE \(status = 'OPEN'::text\)/);
        assert.equal((await pg.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'call_log_follow_up'`)).rows[0].relrowsecurity, true);
    });

    test("applied over a database with call logs: every call log is kept, unchanged, with no follow-up", async () => {
        const names = migrationNames();
        const older = await createTestDatabase({ upTo: names[names.indexOf(MIGRATION) - 1] });
        try {
            await older.pg.exec(`
                INSERT INTO "user" ("admin_id", "auth_user_id", "name", "email", "role", "updated_date") VALUES ('u1', '00000000-0000-4000-8000-0000000000aa', 'U', 'u@example.invalid', 'ADMIN', now());
                INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "updated_date") VALUES ('OLD12345', '0001', 'Legacy', now());
                INSERT INTO "candidate_call_logs" ("call_log_id", "passport_id", "admin_id", "note", "created_date") VALUES ('c1', 'OLD12345', 'u1', 'Passport not uploaded', '2026-09-01T10:00:00Z');
            `);
            const before = (await older.pg.query(`SELECT * FROM "candidate_call_logs"`)).rows;
            await older.pg.exec(fs.readFileSync(path.join("prisma", "migrations", MIGRATION, "migration.sql"), "utf8"));
            assert.deepEqual((await older.pg.query(`SELECT * FROM "candidate_call_logs"`)).rows, before);
            assert.equal((await older.pg.query(`SELECT count(*)::int AS n FROM "call_log_follow_up"`)).rows[0].n, 0);
        } finally {
            await older.close();
        }
    });
});

describe("flagging a call log", () => {
    test("1-3. every call log role can flag; the follow-up references the original call log, which is unchanged", async () => {
        for (const role of STAFF_ROLES) {
            const callLogId = await logCall(A, `Passport not uploaded (${role})`);
            const before = await callLogRow(callLogId);
            const response = await flag(role, A, callLogId);
            assert.equal(response.status, 201, role);
            assert.equal(response.body.followUp.callLogId, callLogId);
            assert.equal(response.body.followUp.status, "OPEN");

            const row = await followUpRow(response.body.followUp.followUpId);
            assert.equal(row.callLogId, callLogId, "references the original call log");
            assert.equal(row.flaggedById, USERS[role].adminId);
            assert.equal(row.status, "OPEN");
            assert.equal(row.completedById, null);
            assert.equal(row.completedDate, null);
            assert.deepEqual(await callLogRow(callLogId), before, "the call log is not changed");
        }
        assert.equal(await prisma.candidateCallLog.count(), 4, "no call log added or removed");
    });

    test("the follow-up copies none of the call log: no note, call time or candidate column", async () => {
        const columns = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'call_log_follow_up' ORDER BY column_name`)).rows.map((r) => r.column_name);
        assert.deepEqual(columns, ["call_log_id", "completed_by", "completed_date", "flagged_by", "flagged_date", "follow_up_id", "status"]);
    });

    test("4. a second active follow-up for the same call is refused (409), in sequence and at the same moment", async () => {
        const { callLogId } = await flagged(A, "Medical pending");
        const again = await flag("ANALYST", A, callLogId);
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "FOLLOW_UP_EXISTS");

        const other = await logCall(A, "Police report pending");
        const both = await Promise.all([flag("ADMIN", A, other), flag("MANAGER", A, other)]);
        assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
        assert.equal(await prisma.callLogFollowUp.count({ where: { callLogId: other, status: "OPEN" } }), 1);
        // The database enforces it too, whatever the API checks.
        await assert.rejects(prisma.callLogFollowUp.create({ data: { followUpId: crypto.randomUUID(), callLogId, flaggedById: USERS.ADMIN.adminId } }), (e) => e.code === "P2002");
    });

    test("a completed follow-up is history: the call can be flagged again", async () => {
        const { callLogId, followUpId } = await flagged(A, "Scan pending");
        assert.equal((await complete("ADMIN", followUpId)).status, 200);
        assert.equal((await flag("ANALYST", A, callLogId)).status, 201);
        assert.deepEqual((await prisma.callLogFollowUp.findMany({ where: { callLogId } })).map((r) => r.status).sort(), ["COMPLETED", "OPEN"]);
    });

    test("the call log must exist and be this candidate's; IDs are validated; unknown roles are refused", async () => {
        const callLogId = await logCall(A, "Asked about the medical");
        assert.equal((await flag("ADMIN", B, callLogId)).status, 404, "another candidate's call");
        assert.equal((await flag("ADMIN", A, crypto.randomUUID())).status, 404);
        assert.equal((await flag("ADMIN", "NOPE9999", callLogId)).status, 404);
        assert.equal((await flag("ADMIN", A, "not-a-uuid")).status, 400);
        assert.equal((await flag("UNKNOWN", A, callLogId)).status, 403);
        assert.equal((await list("UNKNOWN")).status, 403);
        assert.equal(await prisma.callLogFollowUp.count(), 0);
    });

    test("the call log shows its follow-up state: none, OPEN, then COMPLETED", async () => {
        const callLogId = await logCall(A, "Will send the police report");
        const state = async () => (await as("REGISTRATION_DESK", `/candidates/${A}/call-logs`)).body.items.find((i) => i.callLogId === callLogId).followUp;
        assert.equal(await state(), null);
        const { body } = await flag("REGISTRATION_DESK", A, callLogId);
        assert.equal((await state()).status, "OPEN");
        assert.equal((await state()).followUpId, body.followUp.followUpId);
        await complete("REGISTRATION_DESK", body.followUp.followUpId);
        assert.equal((await state()).status, "COMPLETED");
    });
});

describe("listing Priority Follow-Ups", () => {
    test("5-8. only flagged calls are listed, grouped by candidate: one group per candidate, each with its own follow-ups", async () => {
        await logCall(A, "Not flagged");
        const a1 = await flagged(A, "Passport not uploaded");
        const a2 = await flagged(A, "Medical not uploaded");
        const b1 = await flagged(B, "Police report pending");

        const { status, body } = await list("ANALYST");
        assert.equal(status, 200);
        assert.equal(body.status, "OPEN");
        assert.equal(body.total, 3);
        assert.equal(body.groups.length, 2, "one group per candidate");
        const groupA = body.groups.find((g) => g.candidate.passportId === A);
        const groupB = body.groups.find((g) => g.candidate.passportId === B);
        assert.deepEqual(groupA.followUps.map((f) => f.followUpId).sort(), [a1.followUpId, a2.followUpId].sort());
        assert.deepEqual(groupB.followUps.map((f) => f.followUpId), [b1.followUpId]);
        assert.ok(!body.groups.flatMap((g) => g.followUps).some((f) => f.callLog.note === "Not flagged"));

        assert.equal(groupA.candidate.name, "Anusha De Soysa");
        assert.equal(groupA.candidate.whatsappNumber, (await prisma.candidate.findUnique({ where: { passportId: A } })).whatsappNumber);
        assert.match(groupA.candidate.whatsappNumber, /94771234567$/);
        assert.ok(groupA.candidate.uniqueId);
        const entry = groupA.followUps.find((f) => f.followUpId === a1.followUpId);
        assert.equal(entry.callLog.callLogId, a1.callLogId);
        assert.equal(entry.callLog.note, "Passport not uploaded", "the note comes from the call log");
        assert.equal(entry.callLog.adminName, "Ada Admin", "the caller");
        assert.equal(entry.flaggedByName, "Ada Admin");
        assert.ok(entry.callLog.calledAt && entry.flaggedAt);
        assert.ok(Array.isArray(groupA.documentStatus) && groupA.documentStatus.length > 0);
    });

    test("6, 17. the default (OPEN) list leaves completed follow-ups out; ?status=COMPLETED lists them", async () => {
        const open = await flagged(A, "Open one");
        const done = await flagged(B, "Done one");
        await complete("ADMIN", done.followUpId);

        const active = (await list("ADMIN")).body;
        assert.deepEqual(active.groups.flatMap((g) => g.followUps.map((f) => f.followUpId)), [open.followUpId]);
        const completed = (await list("ADMIN", "COMPLETED")).body;
        assert.equal(completed.status, "COMPLETED");
        assert.deepEqual(completed.groups.flatMap((g) => g.followUps.map((f) => f.followUpId)), [done.followUpId]);
        assert.equal(completed.groups[0].followUps[0].completedByName, "Ada Admin");
        assert.equal((await list("ADMIN", "bogus")).status, 400);
    });

    test("9. order: candidates by their newest follow-up; follow-ups newest first", async () => {
        const a1 = await flagged(A, "A oldest");
        const b1 = await flagged(B, "B middle");
        const a2 = await flagged(A, "A newest");
        const at = (followUpId, iso) => prisma.callLogFollowUp.update({ where: { followUpId }, data: { flaggedDate: new Date(iso) } });
        await at(a1.followUpId, "2026-10-01T08:00:00Z");
        await at(b1.followUpId, "2026-10-02T08:00:00Z");
        await at(a2.followUpId, "2026-10-03T08:00:00Z");

        const { groups } = (await list()).body;
        assert.deepEqual(groups.map((g) => g.candidate.passportId), [A, B]);
        assert.deepEqual(groups[0].followUps.map((f) => f.callLog.note), ["A newest", "A oldest"]);

        await at(b1.followUpId, "2026-10-04T08:00:00Z");
        assert.deepEqual((await list()).body.groups.map((g) => g.candidate.passportId), [B, A]);
    });

    test("an empty list is an empty list", async () => {
        assert.deepEqual((await list("REGISTRATION_DESK")).body, { status: "OPEN", total: 0, truncated: false, groups: [] });
    });

    test("34. a fixed number of queries whatever the number of follow-ups and candidates (no N+1)", async () => {
        const calls = [];
        const counting = new Proxy(prisma, {
            get(target, model) {
                const delegate = target[model];
                if (!delegate || typeof delegate !== "object") return delegate;
                return new Proxy(delegate, {
                    get(d, method) {
                        const fn = d[method];
                        return typeof fn === "function" ? (...args) => { calls.push(`${String(model)}.${String(method)}`); return fn.apply(d, args); } : fn;
                    },
                });
            },
        });
        await flagged(A, "one");
        await listFollowUps({ db: counting, params: { status: "OPEN" } });
        const forOne = [...calls];

        for (let i = 0; i < 4; i++) await flagged(A, `A ${i}`);
        for (let i = 0; i < 4; i++) await flagged(B, `B ${i}`);
        calls.length = 0;
        const result = await listFollowUps({ db: counting, params: { status: "OPEN" } });
        assert.equal(result.total, 9);
        assert.deepEqual(calls, forOne, "the same queries for 1 follow-up as for 9 over two candidates");
        assert.ok(calls.length <= 3, calls.join(", "));
    });
});

describe("completing a follow-up", () => {
    for (const role of STAFF_ROLES) {
        test(`10-18. ${role} can complete: status, completed date and completer are stored; the call log stays`, async () => {
            const { callLogId, followUpId } = await flagged(A, `Medical pending (${role})`);
            const callBefore = await callLogRow(callLogId);
            const before = Date.now();
            const response = await complete(role, followUpId);
            assert.equal(response.status, 200);
            assert.equal(response.body.followUp.status, "COMPLETED");
            assert.equal(response.body.followUp.completedByName, USERS[role].name);

            const row = await followUpRow(followUpId);
            assert.equal(row.status, "COMPLETED", "persisted");
            assert.ok(row.completedDate.getTime() >= before - 1000, "completed date stored");
            assert.equal(row.completedById, USERS[role].adminId, "completer stored");
            assert.equal(row.callLogId, callLogId, "the row is kept");
            assert.deepEqual((await list(role)).body.groups, [], "leaves the active list");
            assert.deepEqual(await callLogRow(callLogId), callBefore, "the call log is unchanged");
        });
    }

    test("completing twice is refused (409) and changes nothing; an unknown follow-up is 404", async () => {
        const { followUpId } = await flagged(A, "x");
        await complete("ANALYST", followUpId);
        const first = await followUpRow(followUpId);
        const again = await complete("ADMIN", followUpId);
        assert.equal(again.status, 409);
        assert.equal(again.body.code, "FOLLOW_UP_COMPLETED");
        assert.deepEqual(await followUpRow(followUpId), first);
        assert.equal((await complete("ADMIN", crypto.randomUUID())).status, 404);
        assert.equal((await complete("ADMIN", "nope")).status, 400);
    });

    test("the database refuses an inconsistent completion (CHECK)", async () => {
        const { followUpId } = await flagged(A, "x");
        await assert.rejects(prisma.callLogFollowUp.update({ where: { followUpId }, data: { status: "COMPLETED" } }));
        await assert.rejects(prisma.callLogFollowUp.update({ where: { followUpId }, data: { status: "DONE" } }));
    });
});

describe("deleting a follow-up", () => {
    async function snapshot() {
        return {
            callLogs: await prisma.candidateCallLog.findMany({ orderBy: { callLogId: "asc" } }),
            candidates: await prisma.candidate.findMany({ orderBy: { passportId: "asc" } }),
            documents: await prisma.document.findMany({ orderBy: { documentId: "asc" } }),
        };
    }

    for (const role of ["ADMIN", "MANAGER"]) {
        test(`19-20, 23-26. ${role} deletes the follow-up row only: the call log, candidate and documents stay`, async () => {
            await addDocument(A, "PASSPORT");
            const { callLogId, followUpId } = await flagged(A, "Passport not uploaded", "ANALYST");
            const other = await flagged(A, "Another call");
            const before = await snapshot();

            const response = await remove(role, followUpId);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, { deleted: true, followUpId });
            assert.equal(await followUpRow(followUpId), null, "the follow-up row is removed");
            assert.ok(await followUpRow(other.followUpId), "other follow-ups stay");
            assert.deepEqual(await snapshot(), before, "call logs, candidates and documents unchanged");
            assert.ok(await callLogRow(callLogId), "the original call log still exists");
            const calls = (await as(role, `/candidates/${A}/call-logs`)).body.items;
            assert.ok(calls.some((c) => c.callLogId === callLogId && c.note === "Passport not uploaded" && c.followUp === null), "still in the call history");
            assert.ok(!(await list(role)).body.groups.flatMap((g) => g.followUps).some((f) => f.followUpId === followUpId));
        });
    }

    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`21-22. ${role} cannot delete (403), and nothing is removed`, async () => {
            const { followUpId } = await flagged(A, "x", role);
            const response = await remove(role, followUpId);
            assert.equal(response.status, 403);
            assert.deepEqual(response.body, { message: "Insufficient permissions" });
            assert.ok(await followUpRow(followUpId));
        });
    }

    test("the role comes from the signed-in user, never the request", async () => {
        const { followUpId } = await flagged(A, "x");
        const response = await withServer("ANALYST", (call) => call(`/follow-ups/${followUpId}?role=ADMIN`, { method: "DELETE", body: { role: "ADMIN" } }));
        assert.equal(response.status, 403);
        assert.ok(await followUpRow(followUpId));
    });

    test("a completed follow-up can be deleted too; an unknown one is 404", async () => {
        const { followUpId } = await flagged(A, "x");
        await complete("ANALYST", followUpId);
        assert.equal((await remove("MANAGER", followUpId)).status, 200);
        assert.equal(await followUpRow(followUpId), null);
        assert.equal((await remove("MANAGER", followUpId)).status, 404);
        assert.equal((await remove("MANAGER", "nope")).status, 400);
    });
});

describe("audit", () => {
    test("flag, complete and delete are each written once, by the signed-in user, with the candidate", async () => {
        const { followUpId } = await flagged(A, "x", "REGISTRATION_DESK");
        await complete("ANALYST", followUpId);
        await remove("MANAGER", followUpId);
        const rows = await followUpAudit();
        assert.deepEqual(rows.map((r) => [r.action, r.adminId, r.passportId, r.previousStatus, r.newStatus]), [
            ["FLAG_FOLLOW_UP", USERS.REGISTRATION_DESK.adminId, A, "NONE", "OPEN"],
            ["COMPLETE_FOLLOW_UP", USERS.ANALYST.adminId, A, "OPEN", "COMPLETED"],
            ["DELETE_FOLLOW_UP", USERS.MANAGER.adminId, A, "COMPLETED", "DELETED"],
        ]);
    });

    test("a refused action writes nothing", async () => {
        const { callLogId, followUpId } = await flagged(A, "x");
        await flag("ADMIN", A, callLogId);
        await remove("ANALYST", followUpId);
        assert.deepEqual((await followUpAudit()).map((r) => r.action), ["FLAG_FOLLOW_UP"]);
    });
});

describe("current document status", () => {
    test("27-28. a current document is uploaded; a missing one is not", async () => {
        await addDocument(A, "PASSPORT");
        const { documentStatus } = await listCallLogs({ db: prisma, passportId: A });
        assert.equal(statusOf(documentStatus, "PASSPORT").uploaded, true);
        assert.equal(statusOf(documentStatus, "PASSPORT").verificationStatus, "VERIFIED");
        assert.equal(statusOf(documentStatus, "MEDICAL").uploaded, false);
        assert.equal(statusOf(documentStatus, "MEDICAL").verificationStatus, null);
    });

    test("29. a document uploaded AFTER the call shows on that old call log (current state, not a snapshot)", async () => {
        const { callLogId } = await flagged(A, "Passport not uploaded");
        const callBefore = await callLogRow(callLogId);
        const before = (await as("ADMIN", `/candidates/${A}/call-logs`)).body;
        assert.equal(statusOf(before.documentStatus, "PASSPORT").uploaded, false);

        await addDocument(A, "PASSPORT");

        const later = (await as("ANALYST", `/candidates/${A}/call-logs`)).body;
        assert.equal(statusOf(later.documentStatus, "PASSPORT").uploaded, true);
        assert.equal(later.items.find((i) => i.callLogId === callLogId).note, "Passport not uploaded", "the note is unchanged");
        const group = (await list("ANALYST")).body.groups.find((g) => g.candidate.passportId === A);
        assert.equal(statusOf(group.documentStatus, "PASSPORT").uploaded, true, "Priority Follow-Ups too");
        assert.deepEqual(await callLogRow(callLogId), callBefore);
    });

    test("30. the existing current-document rule: SUPERSEDED never counts, VERIFIED wins over review, variants are separate", async () => {
        await addDocument(A, "MEDICAL", { status: "SUPERSEDED" });
        await addDocument(A, "SCAN", { status: "REVIEW_REQUIRED" });
        await addDocument(A, "NIC", { status: "VERIFIED", receivedDate: new Date("2026-09-01") });
        await addDocument(A, "NIC", { status: "REVIEW_REQUIRED", receivedDate: new Date("2026-10-01") });
        await addDocument(A, "POLICE_REPORT", { variant: "SL_VERIFIED" });
        const { documentStatus } = await listCallLogs({ db: prisma, passportId: A });
        assert.equal(statusOf(documentStatus, "MEDICAL").uploaded, false, "SUPERSEDED only = missing");
        assert.deepEqual([statusOf(documentStatus, "SCAN").uploaded, statusOf(documentStatus, "SCAN").verificationStatus], [true, "REVIEW_REQUIRED"]);
        assert.equal(statusOf(documentStatus, "NIC").verificationStatus, "VERIFIED", "the newest VERIFIED, as currentOf");
        assert.equal(statusOf(documentStatus, "POLICE_REPORT", "SL_VERIFIED").uploaded, true);
        assert.equal(statusOf(documentStatus, "POLICE_REPORT", "ROMANIA").uploaded, false);
        assert.equal(statusOf(documentStatus, "POLICE_REPORT", "SL_NORMAL").uploaded, false);
        assert.equal(statusOf(documentStatus, "POLICE_REPORT", null), undefined, "no untyped report: not listed");

        await addDocument(A, "POLICE_REPORT");
        assert.equal(statusOf((await listCallLogs({ db: prisma, passportId: A })).documentStatus, "POLICE_REPORT", null).uploaded, true, "an untyped report is listed when there is one");
    });

    test("31. reading call logs and follow-ups never changes a document", async () => {
        await addDocument(A, "PASSPORT");
        await addDocument(A, "PASSPORT", { status: "SUPERSEDED" });
        await flagged(A, "x");
        const before = await prisma.document.findMany({ orderBy: { documentId: "asc" } });
        await as("ADMIN", `/candidates/${A}/call-logs`);
        await list("ADMIN");
        await list("ADMIN", "COMPLETED");
        assert.deepEqual(await prisma.document.findMany({ orderBy: { documentId: "asc" } }), before);
    });

    test("32-33. one SCAN entry; only the supported document types; no Agreement, Affidavit or Contract", async () => {
        await addDocument(A, "SCAN", { status: "SUPERSEDED" });
        await addDocument(A, "SCAN");
        const { documentStatus } = await listCallLogs({ db: prisma, passportId: A });
        assert.equal(documentStatus.filter((d) => d.documentType === "SCAN").length, 1, "ONE SCAN");
        const types = new Set(documentStatus.map((d) => d.documentType));
        assert.deepEqual([...types].sort(), Object.keys(CANDIDATE_DOCUMENT_TYPES).sort());
        for (const unsupported of ["AGREEMENT", "AFFIDAVIT", "CONTRACT"]) assert.ok(!types.has(unsupported), unsupported);
        assert.deepEqual(documentStatusOf([{ documentType: "AFFIDAVIT", verificationStatus: "VERIFIED", receivedDate: new Date(), createdDate: new Date() }]).filter((d) => d.uploaded), [], "an unsupported row is ignored");
    });
});

describe("candidate history (activity with the call logs)", () => {
    const history = async (passportId = A, role = "ADMIN") => {
        const response = await as(role, `/candidates/${passportId}/call-logs`);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body;
    };
    const whatsappSubmission = async (passportId, documentType) => {
        const temporaryId = crypto.randomUUID();
        await prisma.temporaryData.create({
            data: { temporaryId, passportId, whatsappNumber: "+94771234567", documentType, temporaryStoragePath: `temp/${temporaryId}.pdf`, processingStatus: "STORED" },
        });
        return temporaryId;
    };
    const staffUpload = async (passportId, documentType, { variant = null, admin = USERS.ANALYST, receivedDate = new Date() } = {}) => {
        const documentId = await addDocument(passportId, documentType, { variant, receivedDate });
        await prisma.auditLog.create({
            data: { auditId: crypto.randomUUID(), adminId: admin.adminId, action: "UPLOAD_DOCUMENT", documentId, passportId, previousStatus: "NONE", newStatus: "VERIFIED", documentType, newValue: variant },
        });
        return documentId;
    };

    test("5, 9-11. documents: a staff upload names the uploader; a WhatsApp document says WhatsApp, never a staff member; an older one says neither", async () => {
        await staffUpload(A, "PASSPORT", { receivedDate: new Date("2026-10-03T05:00:00Z") });
        await staffUpload(A, "POLICE_REPORT", { variant: "SL_VERIFIED", receivedDate: new Date("2026-10-04T05:00:00Z") });
        const documentId = crypto.randomUUID();
        await prisma.document.create({
            data: {
                documentId, passportId: A, documentType: "MEDICAL", originalFilename: "m.pdf", storedFilename: "m.pdf", storagePath: `clients/${A}/m.pdf`,
                receivedDate: new Date("2026-10-05T05:00:00Z"), processingStatus: "STORED", verificationStatus: "REVIEW_REQUIRED", temporaryId: await whatsappSubmission(A, "MEDICAL"),
            },
        });
        await addDocument(A, "NIC", { receivedDate: new Date("2026-10-02T05:00:00Z") });

        const documents = (await history()).activity.filter((a) => a.kind === "DOCUMENT_RECEIVED");
        assert.deepEqual(documents.map((a) => [a.documentType, a.variant, a.source, a.actorName]), [
            ["MEDICAL", null, "WHATSAPP", null],
            ["POLICE_REPORT", "SL_VERIFIED", "STAFF", USERS.ANALYST.name],
            ["PASSPORT", null, "STAFF", USERS.ANALYST.name],
            ["NIC", null, null, null],
        ]);
    });

    test("12. ONE SCAN: a replaced scan is two receipts of the same Scan type; unsupported types never appear", async () => {
        await addDocument(A, "SCAN", { status: "SUPERSEDED", receivedDate: new Date("2026-10-01T05:00:00Z") });
        await addDocument(A, "SCAN", { receivedDate: new Date("2026-10-02T05:00:00Z") });
        await addDocument(A, "AFFIDAVIT");
        await addDocument(A, "AGREEMENT");
        const types = (await history()).activity.map((a) => a.documentType).filter(Boolean);
        assert.deepEqual(types, ["SCAN", "SCAN"]);
    });

    test("14. a details update lists the changed fields' names only, never their values", async () => {
        const { values, errors } = parseCandidateBody({ ...BASE, nic: "965404378V", whatsappNumber: "+94771234567", address: "12 Temple Road, Kandy", contactNumber: "0711111111" }, { creating: false });
        assert.equal(errors, undefined, JSON.stringify(errors));
        await updateCandidateDetails({ db: prisma, passportId: A, values, actor: USERS.MANAGER });
        const body = await history();
        const update = body.activity.find((a) => a.kind === "DETAILS_UPDATED");
        assert.equal(update.actorName, USERS.MANAGER.name);
        assert.deepEqual(update.fields.sort(), ["address", "contactNumber"]);
        assert.doesNotMatch(JSON.stringify(body.activity), /Temple Road|0711111111/);
    });

    test("13, 15. stage completion by an admin shows with who did it, once; a completion saved before stages were audited shows without one; automatic stages are not invented", async () => {
        await updateStage({ db: prisma, passportId: A, stage: "IVS_INTERVIEW", values: { completed: true }, actor: USERS.ADMIN });
        await updateStage({ db: prisma, passportId: A, stage: "VISA_APPROVAL", values: { notes: "Waiting for the embassy" }, actor: USERS.ADMIN });
        await prisma.candidateStage.create({ data: { passportId: A, stage: "FINALIZING_JOB", completed: true, completedAt: new Date("2026-09-01T05:00:00Z") } });

        const stages = (await history()).activity.filter((a) => a.stage);
        assert.deepEqual(stages.map((a) => [a.kind, a.stage, a.actorName]), [
            ["STAGE_UPDATED", "VISA_APPROVAL", USERS.ADMIN.name],
            ["STAGE_COMPLETED", "IVS_INTERVIEW", USERS.ADMIN.name],
            ["STAGE_COMPLETED", "FINALIZING_JOB", null],
        ]);
        assert.doesNotMatch(JSON.stringify(stages), /embassy/, "stage notes are not repeated here");
        assert.ok(!stages.some((a) => ["CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION"].includes(a.stage)));
    });

    test("6. newest first across every source, call logs stay separate items", async () => {
        await staffUpload(A, "PASSPORT", { receivedDate: new Date("2020-01-01T05:00:00Z") });
        await updateStage({ db: prisma, passportId: A, stage: "IVS_INTERVIEW", values: { completed: true }, actor: USERS.ADMIN });
        await logCall(A, "Called");
        const body = await history();
        const times = body.activity.map((a) => new Date(a.occurredAt).getTime());
        assert.deepEqual(times, [...times].sort((x, y) => y - x));
        assert.equal(body.activity.at(-1).documentType, "PASSPORT");
        assert.deepEqual(body.items.map((i) => i.note), ["Called"]);
        assert.equal(body.activityTruncated, false);
    });

    test("8, 19. never another candidate's events", async () => {
        await staffUpload(B, "PASSPORT");
        await updateStage({ db: prisma, passportId: B, stage: "IVS_INTERVIEW", values: { completed: true }, actor: USERS.ADMIN });
        await logCall(B, "B only");
        const body = await history(A);
        assert.deepEqual(body.activity, []);
        assert.deepEqual(body.items, []);
        assert.equal((await history(B)).activity.length, 2);
    });

    test("33. reading the history changes nothing", async () => {
        await staffUpload(A, "PASSPORT");
        await logCall(A, "x");
        const snapshot = async () => Promise.all([
            prisma.document.findMany({ orderBy: { documentId: "asc" } }),
            prisma.auditLog.count(),
            prisma.candidate.findUnique({ where: { passportId: A } }),
            prisma.candidateCallLog.findMany({ orderBy: { callLogId: "asc" } }),
        ]);
        const before = await snapshot();
        await history(A, "REGISTRATION_DESK");
        assert.deepEqual(await snapshot(), before);
    });
});

describe("adding a call with Need Attention", () => {
    const add = (body, role = "ANALYST") => as(role, `/candidates/${A}/call-logs`, { method: "POST", body });

    test("22. without it: one call, no follow-up", async () => {
        const response = await add({ note: "Called about the medical" });
        assert.equal(response.status, 201);
        assert.equal(response.body.items[0].followUp, null);
        assert.equal(await prisma.callLogFollowUp.count(), 0);
        assert.deepEqual(await followUpAudit(), []);
    });

    test("23-24. with it: one call, one OPEN follow-up and its audit entry; shown in Priority Follow-Ups", async () => {
        const response = await add({ note: "Passport missing", needsAttention: true });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(await prisma.candidateCallLog.count({ where: { passportId: A } }), 1, "no duplicate call");
        const [call] = response.body.items;
        assert.equal(call.followUp.status, "OPEN");
        const rows = await prisma.callLogFollowUp.findMany();
        assert.deepEqual(rows.map((r) => [r.callLogId, r.status, r.flaggedById]), [[call.callLogId, "OPEN", USERS.ANALYST.adminId]]);
        assert.deepEqual((await followUpAudit()).map((r) => [r.action, r.passportId, r.adminId]), [["FLAG_FOLLOW_UP", A, USERS.ANALYST.adminId]]);
        const group = (await list("ANALYST")).body.groups.find((g) => g.candidate.passportId === A);
        assert.deepEqual(group.followUps.map((f) => f.callLog.note), ["Passport missing"]);
    });

    test("an invalid needsAttention is refused and writes nothing", async () => {
        const response = await add({ note: "x", needsAttention: "yes" });
        assert.equal(response.status, 400);
        assert.equal(await prisma.candidateCallLog.count(), 0);
        assert.equal(await prisma.callLogFollowUp.count(), 0);
    });

    test("32. the same roles as before: every Candidates-area role can add one; others can't", async () => {
        for (const role of STAFF_ROLES) assert.equal((await add({ note: `by ${role}`, needsAttention: true }, role)).status, 201, role);
        assert.equal((await add({ note: "x", needsAttention: true }, "VIEWER")).status, 403);
    });
});

describe("integrity", () => {
    test("35-36. foreign keys: no follow-up for a missing call log or user; removing a candidate removes its call logs and follow-ups (no orphans); a user who flagged can't be deleted", async () => {
        await assert.rejects(prisma.callLogFollowUp.create({ data: { followUpId: crypto.randomUUID(), callLogId: crypto.randomUUID(), flaggedById: USERS.ADMIN.adminId } }));
        const callLogId = await logCall(B, "x");
        await assert.rejects(prisma.callLogFollowUp.create({ data: { followUpId: crypto.randomUUID(), callLogId, flaggedById: "no-such-user" } }));

        const { followUpId } = await flagged(B, "Police report pending");
        await assert.rejects(prisma.user.delete({ where: { adminId: USERS.ADMIN.adminId } }), "Restrict");

        await pg.exec(`DELETE FROM "candidate_stages" WHERE passport_id = '${B}'; DELETE FROM "candidate" WHERE passport_id = '${B}'`);
        assert.equal(await prisma.candidateCallLog.count({ where: { passportId: B } }), 0);
        assert.equal(await followUpRow(followUpId), null);
        const orphans = (await pg.query(`SELECT count(*)::int AS n FROM "call_log_follow_up" f LEFT JOIN "candidate_call_logs" c ON c.call_log_id = f.call_log_id WHERE c.call_log_id IS NULL`)).rows[0].n;
        assert.equal(orphans, 0);
    });

    test("FOLLOW_UP_STATUS is OPEN and COMPLETED only", () => {
        assert.deepEqual(Object.values(FOLLOW_UP_STATUS), ["OPEN", "COMPLETED"]);
    });
});
