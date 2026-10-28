// Candidate unique ID allocation through candidate_unique_id_seq (migration
// 20261105120000_candidate_unique_id_sequence; candidateService.js createCandidate).
// Real PostgreSQL (PGlite, every migration), the real Prisma client and service. Synthetic data.
//
// PGlite is ONE session, so "concurrent" registrations below are interleaved by the event loop
// rather than run on separate connections; the multi-connection proof is the REG-02 load test on
// real PostgreSQL. What these tests prove is the allocator's contract: nextval-based, no
// candidate-table scan, no collision retry in normal operation, correct format and initial value.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestDatabase, migrationNames } from "./helpers/pgliteDatabase.js";
import { CandidateError, createCandidate, formatUniqueId, parseCandidateBody } from "../src/services/candidateService.js";

const MIGRATION = "20261105120000_candidate_unique_id_sequence";
const MIGRATION_SQL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
const ACTOR = { adminId: "u-admin", role: "ADMIN", name: "ADMIN 1", email: "u-admin@example.invalid", authUserId: "00000000-0000-4000-8000-000000000001" };

// A registration body as POST /api/admin/candidates receives it; n keeps every identity unique.
const body = (n) => ({
    passportId: `P8${String(n).padStart(6, "0")}`, surname: "SEQTEST", otherNames: `REG${n}`,
    nic: `98${String(n).padStart(10, "0")}`, whatsappNumber: `+9498${String(n).padStart(7, "0")}`, jobTypes: ["Caregiver"],
});
const valuesOf = (n) => {
    const { values, errors } = parseCandidateBody(body(n), { creating: true });
    assert.equal(errors, undefined);
    return values;
};
const insertRaw = (pg, passportId, uniqueId) => pg.query(
    `INSERT INTO "candidate" ("passport_id", "unique_id", "first_name", "updated_date") VALUES ($1, $2, 'LEGACY', now())`, [passportId, uniqueId]);
const nextValue = async (pg) => {
    const { rows: [row] } = await pg.query(`SELECT last_value::int AS last, is_called FROM "candidate_unique_id_seq"`);
    return row.is_called ? row.last + 1 : row.last;
};

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: ACTOR });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`
        ALTER TABLE "audit_logs" DISABLE TRIGGER USER; TRUNCATE "audit_logs"; ALTER TABLE "audit_logs" ENABLE TRIGGER USER;
        DELETE FROM "candidate_stages"; DELETE FROM "candidate"; DELETE FROM "sheet_sync_queue";
        SELECT setval('"candidate_unique_id_seq"', 1, false);
    `);
});

describe("candidate unique ID allocation (candidate_unique_id_seq)", () => {
    test("sequential registrations get 0001, 0002, 0003, and the response shape is unchanged", async () => {
        const results = [];
        for (const n of [1, 2, 3]) results.push(await createCandidate({ db: prisma, values: valuesOf(n), actor: ACTOR }));
        assert.deepEqual(results.map((r) => r.uniqueId), ["0001", "0002", "0003"]);
        assert.deepEqual(Object.keys(results[0]).sort(), ["passportId", "uniqueId"]);
        assert.equal(results[0].passportId, "P8000001");
        // Business behaviour unchanged: one audit entry and one queued Sheet sync per registration.
        assert.equal(await prisma.auditLog.count({ where: { action: "CREATE_CANDIDATE" } }), 3);
        assert.equal(await prisma.sheetSyncQueue.count({ where: { status: "PENDING" } }), 3);
    });

    test("10 simultaneous registrations: all succeed, 10 distinct IDs, no TRY_AGAIN and no collision retry", async () => {
        const start = await nextValue(pg);
        const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => createCandidate({ db: prisma, values: valuesOf(100 + i), actor: ACTOR })));
        assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => r.reason?.code ?? r.reason?.message), []);
        const ids = results.map((r) => r.value.uniqueId);
        assert.equal(new Set(ids).size, 10, "no duplicate uniqueIds");
        assert.deepEqual([...ids].sort(), Array.from({ length: 10 }, (_, i) => formatUniqueId(start + i)), "exactly 10 numbers drawn: no retry");
        assert.equal(await prisma.candidate.count(), 10);
    });

    test("registration never scans the candidate table for an ID (no where-less candidate.findMany)", async () => {
        const unscoped = [];
        const spy = new Proxy(prisma, {
            get(target, property) {
                const value = Reflect.get(target, property);
                if (property !== "candidate") return typeof value === "function" ? value.bind(target) : value;
                return new Proxy(value, {
                    get(delegate, method) {
                        const fn = Reflect.get(delegate, method);
                        if (method !== "findMany") return typeof fn === "function" ? fn.bind(delegate) : fn;
                        return (args = {}) => { if (!args.where) unscoped.push(args); return fn.call(delegate, args); };
                    },
                });
            },
        });
        await insertRaw(pg, "N7000001", "LT00001");
        await createCandidate({ db: spy, values: valuesOf(200), actor: ACTOR });
        assert.deepEqual(unscoped, [], "the old allocator read every candidate's unique_id");
    });

    test("formatting: at least 4 digits, zero-padded, and longer numbers kept whole", async () => {
        await pg.query(`SELECT setval('"candidate_unique_id_seq"', 9999, false)`);
        const a = await createCandidate({ db: prisma, values: valuesOf(300), actor: ACTOR });
        const b = await createCandidate({ db: prisma, values: valuesOf(301), actor: ACTOR });
        assert.deepEqual([a.uniqueId, b.uniqueId], ["9999", "10000"]);
        assert.deepEqual([1, 42, 9999, 123456].map(formatUniqueId), ["0001", "0042", "9999", "123456"]);
    });

    test("an ID taken outside the allocator is skipped: the sequence catches up once, no TRY_AGAIN", async () => {
        const next = await nextValue(pg);
        // A block of numeric IDs written directly (e.g. an import), starting exactly at the next value.
        for (let i = 0; i < 20; i++) await insertRaw(pg, `N71000${String(i).padStart(2, "0")}`, formatUniqueId(next + i));
        const result = await createCandidate({ db: prisma, values: valuesOf(400), actor: ACTOR });
        assert.equal(result.uniqueId, formatUniqueId(next + 20), "one collision, then past the highest numeric ID");
        // And from then on, no further collision.
        assert.equal((await createCandidate({ db: prisma, values: valuesOf(401), actor: ACTOR })).uniqueId, formatUniqueId(next + 21));
    });

    test("rollback safety: a registration that fails inside its transaction leaves nothing behind; the next one succeeds", async () => {
        await pg.exec(`
            CREATE FUNCTION "test_fail_candidate"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW."passport_id" = 'P8000500' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$;
            CREATE TRIGGER "test_fail_candidate" BEFORE INSERT ON "candidate" FOR EACH ROW EXECUTE FUNCTION "test_fail_candidate"();
        `);
        try {
            const first = await createCandidate({ db: prisma, values: valuesOf(499), actor: ACTOR });
            await assert.rejects(createCandidate({ db: prisma, values: valuesOf(500), actor: ACTOR }), (error) => !(error instanceof CandidateError) || error.code !== "TRY_AGAIN");
            assert.equal(await prisma.candidate.count({ where: { passportId: "P8000500" } }), 0);
            assert.equal(await prisma.auditLog.count({ where: { passportId: "P8000500" } }), 0);
            assert.equal(await prisma.sheetSyncQueue.count(), 1, "only the first registration was queued");
            const next = await createCandidate({ db: prisma, values: valuesOf(501), actor: ACTOR });
            assert.ok(Number(next.uniqueId) > Number(first.uniqueId), "a drawn number may be skipped (a gap), never reused");
        } finally {
            await pg.exec(`DROP TRIGGER "test_fail_candidate" ON "candidate"; DROP FUNCTION "test_fail_candidate"();`);
        }
    });

    test("duplicate passport / NIC / WhatsApp still answer their own 409s (business rules unchanged)", async () => {
        await createCandidate({ db: prisma, values: valuesOf(600), actor: ACTOR });
        const dup = (overrides) => createCandidate({ db: prisma, values: { ...valuesOf(601), ...overrides }, actor: ACTOR });
        await assert.rejects(dup({ passportId: "P8000600" }), (e) => e.code === "CANDIDATE_EXISTS" && e.status === 409);
        await assert.rejects(dup({ nic: valuesOf(600).nic }), (e) => e.code === "NIC_EXISTS");
        await assert.rejects(dup({ whatsappNumber: valuesOf(600).whatsappNumber }), (e) => e.code === "WHATSAPP_EXISTS");
    });
});

describe(`migration ${MIGRATION}`, () => {
    const previousMigration = () => {
        const names = migrationNames();
        return names[names.indexOf(MIGRATION) - 1];
    };

    test("additive only: one sequence, its start value and its grants; no candidate row is changed", () => {
        const sql = MIGRATION_SQL.replace(/--.*$/gm, "");
        assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER TABLE|RENAME)\b/i);
        assert.deepEqual(sql.match(/CREATE \w+/g), ["CREATE SEQUENCE"]);
    });

    test("on existing data: starts after the highest NUMERIC unique_id; legacy IDs (LT00001, ...) are ignored and untouched", async () => {
        const old = await createTestDatabase({ upTo: previousMigration() });
        try {
            for (const [passportId, uniqueId] of [["N7200001", "0009"], ["N7200002", "0071"], ["N7200003", "LT00100"], ["N7200004", "LT99999"], ["N7200005", "ABC"], ["N7200006", "12"]]) {
                await insertRaw(old.pg, passportId, uniqueId);
            }
            const before = (await old.pg.query(`SELECT * FROM "candidate" ORDER BY "passport_id"`)).rows;
            await old.pg.exec(MIGRATION_SQL);
            assert.deepEqual((await old.pg.query(`SELECT * FROM "candidate" ORDER BY "passport_id"`)).rows, before, "no candidate row changed");
            await old.prisma.user.create({ data: ACTOR });
            assert.equal((await createCandidate({ db: old.prisma, values: valuesOf(700), actor: ACTOR })).uniqueId, "0072", "as the old allocator would have chosen");
        } finally {
            await old.close();
        }
    });

    test("on an empty candidate table (or only legacy IDs): the first ID is 0001", async () => {
        const old = await createTestDatabase({ upTo: previousMigration() });
        try {
            await insertRaw(old.pg, "N7300001", "LT00001");
            await old.pg.exec(MIGRATION_SQL);
            await old.prisma.user.create({ data: ACTOR });
            assert.equal((await createCandidate({ db: old.prisma, values: valuesOf(800), actor: ACTOR })).uniqueId, "0001");
        } finally {
            await old.close();
        }
    });

    test("the Supabase public API roles cannot use the sequence", async () => {
        const { rows } = await pg.query(`SELECT has_sequence_privilege('anon', 'candidate_unique_id_seq', 'USAGE') AS anon, has_sequence_privilege('authenticated', 'candidate_unique_id_seq', 'USAGE') AS auth`);
        assert.deepEqual(rows[0], { anon: false, auth: false });
    });
});
