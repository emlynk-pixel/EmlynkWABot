// Candidate additional details: the migration, the one-to-one table, the
// GET / PUT API, validation, suggestions from the candidate record, audit
// entries and roles. On a REAL PostgreSQL (PGlite, every migration applied)
// through the real Prisma client. No Supabase: the signed-in user is set by
// a stand-in for requireActiveUser.
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { noRateLimit } from "./helpers/fakeAdminDb.js";
import { createAdminRouter } from "../src/routes/admin.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createCandidate, parseCandidateBody } from "../src/services/candidateService.js";
import { parseAdditionalDetailsBody } from "../src/services/candidateAdditionalDetailsService.js";

const MIGRATION = "20261009150000_candidate_additional_details";
const USERS = {
    ADMIN: { adminId: "user-admin", authUserId: "00000000-0000-4000-8000-000000000001", name: "Ada Admin", email: "ada@example.invalid", role: "ADMIN" },
    REGISTRATION_DESK: { adminId: "user-desk", authUserId: "00000000-0000-4000-8000-000000000004", name: "Dee Desk", email: "dee@example.invalid", role: "REGISTRATION_DESK" },
};
const REGISTRATION = {
    passportId: "N1023757", surname: "De Soysa", otherNames: "Anusha", nic: "965404378V", address: "Negombo, Sri Lanka",
    dateOfBirth: "1996-02-23", whatsappNumber: "+94771234567", jobTypes: ["Caregiver"], jobExperience: "2 years",
};
const FULL = {
    nameAsInPassport: "ANUSHA DE SOYSA",
    permanentAddress: "12 Galle Road, Negombo",
    birthday: "1996-02-23",
    tshirtSize: "M",
    pantSize: "32",
    shoeSize: "9.5",
    fatherAlive: true,
    fatherFullName: "Sunil De Soysa",
    fatherBirthday: "1965-05-01",
    motherAlive: false,
    maritalStatus: "MARRIED",
    wifeFullName: "Kumari De Soysa",
    wifeBirthday: "1998-07-12",
    child1Name: "Nimal",
    child2Name: "Kamala",
    otherJobSkills: "Forklift licence, basic welding",
};

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
        DELETE FROM "candidate_additional_details"; DELETE FROM "documents"; DELETE FROM "candidate_stages"; DELETE FROM "candidate";
        DELETE FROM "sheet_sync_queue";
    `);
    const { values } = parseCandidateBody(REGISTRATION, { creating: true });
    await createCandidate({ db: prisma, values });
});

async function withServer(role, work) {
    const app = express();
    app.use(express.json());
    const requireAdmin = (req, res, next) => { req.user = { ...(USERS[role] ?? USERS.ADMIN), role, status: "ACTIVE" }; next(); };
    app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin, apiLimiter: noRateLimit }));
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/admin/candidates`;
    try {
        return await work(async (path, { method = "GET", body } = {}) => {
            const response = await fetch(`${base}${path}`, {
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

const auditRows = () => prisma.auditLog.findMany({ where: { action: { contains: "ADDITIONAL" } }, orderBy: [{ createdDate: "asc" }, { auditId: "asc" }] });
const candidateRow = () => prisma.candidate.findUnique({ where: { passportId: "N1023757" } });

describe("migration", () => {
    test("adds one table with a one-to-one foreign key, RLS on, and leaves candidate untouched", async () => {
        assert.equal(migrationNames().at(-1), MIGRATION, "the newest migration");
        const sql = fs.readFileSync(path.join("prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
        const statements = sql.replace(/--.*$/gm, "");
        assert.doesNotMatch(statements, /^\s*(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+")|ALTER TABLE "candidate"\s|ALTER COLUMN|DROP COLUMN/im, "additive only");
        assert.deepEqual(statements.match(/CREATE TABLE "\w+"/g), ['CREATE TABLE "candidate_additional_details"']);

        const constraints = (await pg.query(`
            SELECT con.contype, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname = 'candidate_additional_details' AND con.contype IN ('p', 'f', 'u', 'c') ORDER BY con.contype
        `)).rows;
        assert.deepEqual(constraints.map((c) => c.contype).sort(), ["f", "p"]);
        assert.match(constraints.find((c) => c.contype === "p").def, /PRIMARY KEY \(passport_id\)/);
        assert.match(constraints.find((c) => c.contype === "f").def, /FOREIGN KEY \(passport_id\) REFERENCES candidate\(passport_id\) ON UPDATE CASCADE ON DELETE CASCADE/);
        const rls = (await pg.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'candidate_additional_details'`)).rows[0];
        assert.equal(rls.relrowsecurity, true);
    });

    test("existing candidates stay valid: applied over a database with candidates, nothing else changes", async () => {
        const names = migrationNames();
        const older = await createTestDatabase({ upTo: names[names.indexOf(MIGRATION) - 1] });
        try {
            const columns = async () => (await older.pg.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'candidate' ORDER BY column_name`)).rows;
            await older.pg.exec(`INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "updated_date") VALUES ('OLD12345', '0001', 'Legacy', now())`);
            const before = await columns();
            await older.pg.exec(fs.readFileSync(path.join("prisma", "migrations", MIGRATION, "migration.sql"), "utf8"));
            assert.deepEqual(await columns(), before, "candidate columns unchanged");
            assert.equal((await older.pg.query(`SELECT count(*)::int AS n FROM "candidate"`)).rows[0].n, 1);
            assert.equal((await older.pg.query(`SELECT count(*)::int AS n FROM "candidate_additional_details"`)).rows[0].n, 0, "no details until saved");
        } finally {
            await older.close();
        }
    });

    test("one row per candidate, only for a real candidate, removed with it", async () => {
        await prisma.candidateAdditionalDetails.create({ data: { passportId: "N1023757", tshirtSize: "M" } });
        await assert.rejects(prisma.candidateAdditionalDetails.create({ data: { passportId: "N1023757" } }), /Unique constraint/);
        await assert.rejects(prisma.candidateAdditionalDetails.create({ data: { passportId: "NOPE0000" } }), /Foreign key constraint/);
        await pg.exec(`DELETE FROM "candidate" WHERE "passport_id" = 'N1023757'`);
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0);
    });
});

describe("GET / PUT additional details", () => {
    test("nothing saved yet: no details, and the candidate's name, address and birthday as suggestions", async () => {
        await withServer("ADMIN", async (call) => {
            const { status, body } = await call("/N1023757/additional-details");
            assert.equal(status, 200);
            assert.equal(body.passportId, "N1023757");
            assert.equal(body.details, null);
            assert.deepEqual(body.suggested, { nameAsInPassport: "Anusha De Soysa", permanentAddress: "Negombo, Sri Lanka", birthday: "1996-02-23" });
        });
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0, "reading never creates a row");
    });

    test("a passport ID in another case resolves to the existing candidate; an unknown one is 404 and creates nothing", async () => {
        await withServer("ADMIN", async (call) => {
            assert.equal((await call("/n1023757/additional-details")).body.passportId, "N1023757");
            const saved = await call("/n1023757/additional-details", { method: "PUT", body: { tshirtSize: "L" } });
            assert.equal(saved.status, 200);
            assert.equal(saved.body.passportId, "N1023757");
            assert.equal((await call("/X9999999/additional-details")).status, 404);
            assert.equal((await call("/X9999999/additional-details", { method: "PUT", body: { tshirtSize: "L" } })).status, 404);
        });
        assert.equal(await prisma.candidate.count(), 1, "never a second candidate");
        assert.deepEqual((await prisma.candidateAdditionalDetails.findMany()).map((r) => r.passportId), ["N1023757"]);
    });

    test("saving stores the details, returns them, and never changes the candidate record", async () => {
        const before = await candidateRow();
        await withServer("ADMIN", async (call) => {
            const { status, body } = await call("/N1023757/additional-details", { method: "PUT", body: { ...FULL, passportId: "OTHER123" } });
            assert.equal(status, 200);
            assert.equal(body.passportId, "N1023757", "the passport ID comes from the URL, never the body");
            assert.equal(body.details.birthday, "1996-02-23");
            assert.equal(body.details.fatherFullName, "Sunil De Soysa");
            assert.equal(body.details.motherFullName, null);
            assert.equal(body.details.child3Name, null);
            assert.equal(body.details.shoeSize, "9.5");
            assert.ok(body.updatedDate);
            assert.deepEqual((await call("/N1023757/additional-details")).body.details, body.details);
        });
        const afterSave = await candidateRow();
        assert.deepEqual({ ...afterSave, updatedDate: null }, { ...before, updatedDate: null }, "candidate row unchanged");
        assert.equal(afterSave.address, "Negombo, Sri Lanka");
    });

    test("a save replaces every field: one left out is cleared", async () => {
        await withServer("ADMIN", async (call) => {
            await call("/N1023757/additional-details", { method: "PUT", body: FULL });
            const { body } = await call("/N1023757/additional-details", { method: "PUT", body: { ...FULL, otherJobSkills: undefined, child2Name: "" } });
            assert.equal(body.details.otherJobSkills, null);
            assert.equal(body.details.child2Name, null);
            assert.equal(body.details.child1Name, "Nimal");
        });
    });
});

describe("audit", () => {
    test("the first save is CREATE_ADDITIONAL_DETAILS with the fields given, by req.user", async () => {
        await withServer("REGISTRATION_DESK", async (call) => {
            await call("/N1023757/additional-details", { method: "PUT", body: { tshirtSize: "M", fatherAlive: true, fatherFullName: "Sunil De Soysa" } });
        });
        const [row] = await auditRows();
        assert.equal(row.action, "CREATE_ADDITIONAL_DETAILS");
        assert.equal(row.adminId, USERS.REGISTRATION_DESK.adminId);
        assert.equal(row.passportId, "N1023757");
        assert.deepEqual([row.previousStatus, row.newStatus], ["NONE", "CREATED"]);
        assert.deepEqual(JSON.parse(row.previousValue), { tshirtSize: null, fatherAlive: null, fatherFullName: null });
        assert.deepEqual(JSON.parse(row.newValue), { tshirtSize: "M", fatherAlive: true, fatherFullName: "Sunil De Soysa" });
    });

    test("an update records only the changed fields; the same save again, or an empty form with nothing saved, writes nothing", async () => {
        await withServer("ADMIN", async (call) => {
            await call("/N1023757/additional-details", { method: "PUT", body: {} });
            assert.equal(await prisma.candidateAdditionalDetails.count(), 0, "an empty form creates no row");
            await call("/N1023757/additional-details", { method: "PUT", body: FULL });
            await call("/N1023757/additional-details", { method: "PUT", body: FULL });
            await call("/N1023757/additional-details", { method: "PUT", body: { ...FULL, tshirtSize: "L", birthday: "1996-02-24" } });
        });
        const rows = await auditRows();
        assert.deepEqual(rows.map((r) => r.action), ["CREATE_ADDITIONAL_DETAILS", "UPDATE_ADDITIONAL_DETAILS"]);
        assert.deepEqual(JSON.parse(rows[1].previousValue), { birthday: "1996-02-23", tshirtSize: "M" });
        assert.deepEqual(JSON.parse(rows[1].newValue), { birthday: "1996-02-24", tshirtSize: "L" });
        assert.deepEqual([rows[1].previousStatus, rows[1].newStatus], ["CREATED", "UPDATED"]);
    });

    test("the Audit Logs API lists it under Candidate with the changed fields", async () => {
        await withServer("ADMIN", async (call) => {
            await call("/N1023757/additional-details", { method: "PUT", body: { shoeSize: "10" } });
        });
        const app = express();
        app.use("/api/admin", createAdminRouter({ db: prisma, requireAdmin: (req, res, next) => { req.user = { ...USERS.ADMIN, status: "ACTIVE" }; next(); }, apiLimiter: noRateLimit }));
        const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/audit-logs?action=CREATE_ADDITIONAL_DETAILS`);
            const { items } = await response.json();
            assert.equal(items.length, 1);
            assert.equal(items[0].category, "CANDIDATE");
            assert.deepEqual(items[0].changes, [{ field: "shoeSize", from: null, to: "10" }]);
            assert.equal(items[0].candidate.passportId, "N1023757");
        } finally {
            server.close();
        }
    });
});

describe("roles", () => {
    for (const role of ["ADMIN", "MANAGER", "ANALYST", "REGISTRATION_DESK"]) {
        test(`${role} can read and save`, async () => {
            await withServer(role, async (call) => {
                assert.equal((await call("/N1023757/additional-details")).status, 200);
                assert.equal((await call("/N1023757/additional-details", { method: "PUT", body: { tshirtSize: "S" } })).status, 200);
            });
        });
    }

    test("any other role is refused and nothing is written", async () => {
        await withServer("VIEWER", async (call) => {
            assert.equal((await call("/N1023757/additional-details")).status, 403);
            assert.equal((await call("/N1023757/additional-details", { method: "PUT", body: { tshirtSize: "S" } })).status, 403);
        });
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0);
    });
});

describe("validation", () => {
    const now = new Date("2026-10-09T06:00:00Z");
    const fields = (body) => parseAdditionalDetailsBody(body, { now }).errors?.map((e) => e.field) ?? [];

    test("every field is optional, and a full valid form passes", () => {
        assert.deepEqual(fields({}), []);
        assert.deepEqual(fields(FULL), []);
        const { values } = parseAdditionalDetailsBody({ tshirtSize: " xl ", maritalStatus: "single" }, { now });
        assert.equal(values.tshirtSize, "XL");
        assert.equal(values.maritalStatus, "SINGLE");
        assert.equal(values.nameAsInPassport, null);
    });

    test("sizes: T-shirt from the list; pant and shoe a preset or a short custom value", () => {
        assert.deepEqual(fields({ tshirtSize: "XXXL" }), ["tshirtSize"]);
        for (const ok of ["28", "46", "31", "9.5", "EU 43", "10/11"]) assert.deepEqual(fields({ pantSize: ok, shoeSize: ok }), [], ok);
        for (const bad of ["<script>", "x".repeat(11), "-5"]) assert.deepEqual(fields({ pantSize: bad }), ["pantSize"], bad);
    });

    test("dates must be real, from 1900, and not in the future", () => {
        assert.deepEqual(fields({ birthday: "1996-02-30" }), ["birthday"]);
        assert.deepEqual(fields({ birthday: "23/02/1996" }), ["birthday"]);
        assert.deepEqual(fields({ birthday: "1899-12-31" }), ["birthday"]);
        assert.deepEqual(fields({ birthday: "2026-10-10" }), ["birthday"]);
        assert.deepEqual(fields({ birthday: "2026-10-09" }), []);
    });

    test("father / mother: the name is required when alive; details only when alive", () => {
        assert.deepEqual(fields({ fatherAlive: true }), ["fatherFullName"]);
        assert.deepEqual(fields({ fatherAlive: false, fatherFullName: "Sunil" }), ["fatherFullName"]);
        assert.deepEqual(fields({ fatherBirthday: "1960-01-01" }), ["fatherBirthday"], "no answer: no details");
        assert.deepEqual(fields({ motherAlive: true }), ["motherFullName"]);
        assert.deepEqual(fields({ motherAlive: false, motherBirthday: "1960-01-01" }), ["motherBirthday"]);
        assert.deepEqual(fields({ motherAlive: "yes" }), ["motherAlive"]);
    });

    test("the wife's name is required when married; her details only when married", () => {
        assert.deepEqual(fields({ maritalStatus: "MARRIED" }), ["wifeFullName"]);
        assert.deepEqual(fields({ maritalStatus: "SINGLE", wifeFullName: "Kumari" }), ["wifeFullName"]);
        assert.deepEqual(fields({ wifeBirthday: "1990-01-01" }), ["wifeBirthday"]);
        assert.deepEqual(fields({ maritalStatus: "ENGAGED" }), ["maritalStatus"]);
    });

    test("children in order; text length limits; a non-object body", () => {
        assert.deepEqual(fields({ child2Name: "Kamala" }), ["child2Name"]);
        assert.deepEqual(fields({ child1Name: "Nimal", child3Name: "Sunil" }), ["child3Name"]);
        assert.deepEqual(fields({ nameAsInPassport: "x".repeat(151), permanentAddress: "x".repeat(501), otherJobSkills: "x".repeat(1001) }), ["nameAsInPassport", "permanentAddress", "otherJobSkills"]);
        assert.deepEqual(fields({ nameAsInPassport: 42 }), ["nameAsInPassport"]);
        assert.deepEqual(parseAdditionalDetailsBody([], { now }).errors.map((e) => e.field), ["body"]);
    });

    test("the API answers 400 with the fields to fix and writes nothing", async () => {
        await withServer("ADMIN", async (call) => {
            const { status, body } = await call("/N1023757/additional-details", { method: "PUT", body: { maritalStatus: "MARRIED", tshirtSize: "XXXL" } });
            assert.equal(status, 400);
            assert.deepEqual(body.errors.map((e) => e.field).sort(), ["tshirtSize", "wifeFullName"]);
        });
        assert.equal(await prisma.candidateAdditionalDetails.count(), 0);
        assert.equal((await auditRows()).length, 0);
    });
});

describe("two people editing the same details", () => {
    const put = (call, body) => call("/N1023757/additional-details", { method: "PUT", body });

    test("a form opened on an older version is refused (409) and nothing is overwritten or audited", async () => {
        await withServer("ADMIN", async (call) => {
            const first = (await put(call, { ...FULL })).body;
            const second = await put(call, { ...FULL, tshirtSize: "L", expectedUpdatedDate: first.updatedDate });
            assert.equal(second.status, 200);
            assert.notEqual(second.body.updatedDate, first.updatedDate, "a real change moves the version");

            // The first person still has the old form open: it says tshirtSize M and has no idea of "L".
            const stale = await put(call, { ...FULL, pantSize: "36", expectedUpdatedDate: first.updatedDate });
            assert.equal(stale.status, 409);
            assert.equal(stale.body.code, "DETAILS_CHANGED");
            assert.match(stale.body.message, /changed by someone else/);

            const current = (await call("/N1023757/additional-details")).body;
            assert.equal(current.details.tshirtSize, "L", "the other person's change survives");
            assert.equal(current.details.pantSize, "32", "and the stale form's change was not applied");
            assert.equal(current.updatedDate, second.body.updatedDate);
        });
        assert.deepEqual((await auditRows()).map((r) => r.action), ["CREATE_ADDITIONAL_DETAILS", "UPDATE_ADDITIONAL_DETAILS"]);
    });

    test("saving with the current version works, and the response carries the new one to use next", async () => {
        await withServer("ADMIN", async (call) => {
            const created = await put(call, { ...FULL, expectedUpdatedDate: null });
            assert.equal(created.status, 200, "a form that had nothing saved sends null");
            const next = await put(call, { ...FULL, shoeSize: "10", expectedUpdatedDate: created.body.updatedDate });
            assert.equal(next.status, 200);
            const after = await put(call, { ...FULL, shoeSize: "11", expectedUpdatedDate: next.body.updatedDate });
            assert.equal(after.status, 200);
            assert.equal(after.body.details.shoeSize, "11");
        });
    });

    test("a form that had nothing saved is refused when someone saved in the meantime", async () => {
        await withServer("ADMIN", async (call) => {
            await put(call, { tshirtSize: "S" });
            const late = await put(call, { tshirtSize: "XL", expectedUpdatedDate: null });
            assert.equal(late.status, 409);
            assert.equal((await call("/N1023757/additional-details")).body.details.tshirtSize, "S");
        });
    });

    test("a stale form whose values equal the stored ones is a harmless no-op, not an error", async () => {
        await withServer("ADMIN", async (call) => {
            const first = (await put(call, { ...FULL })).body;
            await put(call, { ...FULL, tshirtSize: "L", expectedUpdatedDate: first.updatedDate });
            const same = await put(call, { ...FULL, tshirtSize: "L", expectedUpdatedDate: first.updatedDate });
            assert.equal(same.status, 200);
            assert.equal(same.body.details.tshirtSize, "L");
        });
        assert.equal((await auditRows()).length, 2, "no entry for it");
    });

    test("two saves at once: one wins, the other is refused; the audit shows only the winner", async () => {
        await withServer("ADMIN", async (call) => {
            const first = (await put(call, { ...FULL })).body;
            const [a, b] = await Promise.all([
                put(call, { ...FULL, tshirtSize: "S", expectedUpdatedDate: first.updatedDate }),
                put(call, { ...FULL, tshirtSize: "XL", expectedUpdatedDate: first.updatedDate }),
            ]);
            assert.deepEqual([a.status, b.status].sort(), [200, 409]);
            const winner = a.status === 200 ? "S" : "XL";
            assert.equal((await call("/N1023757/additional-details")).body.details.tshirtSize, winner);
        });
        const updates = (await auditRows()).filter((r) => r.action === "UPDATE_ADDITIONAL_DETAILS");
        assert.equal(updates.length, 1);
        assert.deepEqual(JSON.parse(updates[0].previousValue), { tshirtSize: "M" });
    });

    test("two first saves at once: one creates, the other is refused (never a duplicate row, never a 500)", async () => {
        await withServer("ADMIN", async (call) => {
            const [a, b] = await Promise.all([
                put(call, { tshirtSize: "S", expectedUpdatedDate: null }),
                put(call, { tshirtSize: "XL", expectedUpdatedDate: null }),
            ]);
            assert.deepEqual([a.status, b.status].sort(), [200, 409]);
        });
        assert.equal(await prisma.candidateAdditionalDetails.count(), 1);
        assert.deepEqual((await auditRows()).map((r) => r.action), ["CREATE_ADDITIONAL_DETAILS"]);
    });

    test("the version is optional (older callers) and checked for shape", async () => {
        await withServer("ADMIN", async (call) => {
            assert.equal((await put(call, { tshirtSize: "S" })).status, 200, "no version: no check");
            assert.equal((await put(call, { tshirtSize: "M" })).status, 200);
            const bad = await put(call, { tshirtSize: "L", expectedUpdatedDate: "yesterday" });
            assert.equal(bad.status, 400);
            assert.deepEqual(bad.body.errors.map((e) => e.field), ["expectedUpdatedDate"]);
            assert.equal((await put(call, { tshirtSize: "L", expectedUpdatedDate: 12345 })).status, 400);
        });
    });
});

describe("dates use the business day (Sri Lanka), not the UTC day", () => {
    // 2026-10-09 20:00 UTC is already 2026-10-10 01:30 in Sri Lanka.
    const now = new Date("2026-10-09T20:00:00Z");
    const fields = (birthday) => parseAdditionalDetailsBody({ birthday }, { now }).errors?.map((e) => e.field) ?? [];

    test("today in Sri Lanka is allowed, tomorrow is not", () => {
        assert.deepEqual(fields("2026-10-09"), []);
        assert.deepEqual(fields("2026-10-10"), [], "the form allows it, so the server must too");
        assert.deepEqual(fields("2026-10-11"), ["birthday"]);
    });
});
