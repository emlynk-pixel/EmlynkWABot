// The English Knowledge backfill (src/services/englishKnowledgeBackfill.js, scripts/backfillEnglishKnowledge.js)
// on a REAL PostgreSQL (PGlite, every migration applied). Synthetic rows only.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { backfillEnglishKnowledge, countEnglishKnowledge } from "../src/services/englishKnowledgeBackfill.js";

let database;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ pg } = database);
});
after(async () => database?.close());

const STORED = ["BASIC", "FAIR", "GOOD", "VERY GOOD", "FLUENT", "NO KNOWLEDGE", "ENGLISH 7", null];
const EXPECTED = ["ENGLISH 6", "ENGLISH 7", "ENGLISH 8", "ENGLISH 9", "ENGLISH 10", "NO KNOWLEDGE", "ENGLISH 7", null];
const passport = (i) => `T00000${String(i).padStart(2, "0")}`;

beforeEach(async () => {
    await pg.exec(`DELETE FROM "candidate_additional_details"; DELETE FROM "candidate_form_response";`);
    // Details rows without candidate rows: foreign keys and triggers are skipped while seeding (the CHECKs still hold).
    await pg.exec(`SET session_replication_role = replica`);
    for (const [i, value] of STORED.entries()) {
        await pg.query(`INSERT INTO "candidate_additional_details" ("passport_id", "english_knowledge", "updated_date") VALUES ($1, $2, '2026-01-01T00:00:00Z')`, [passport(i), value]);
    }
    await pg.query(`INSERT INTO "candidate_form_response" ("passport_id", "english_knowledge") VALUES ($1, 'GOOD')`, [passport(0)]);
    await pg.exec(`SET session_replication_role = origin`);
});

const storedValues = async () => (await pg.query(`SELECT "english_knowledge" AS v FROM "candidate_additional_details" ORDER BY "passport_id"`)).rows.map((r) => r.v);

describe("English Knowledge backfill", () => {
    test("the dry run reports what would change and changes nothing", async () => {
        const report = await backfillEnglishKnowledge({ client: pg, apply: false });
        assert.equal(report.mode, "DRY_RUN");
        assert.deepEqual(report.wouldChange, { "ENGLISH 6": 1, "ENGLISH 7": 1, "ENGLISH 8": 1, "ENGLISH 9": 1, "ENGLISH 10": 1 });
        assert.equal(report.before.counts.GOOD, 1);
        assert.equal(report.after, null);
        assert.deepEqual(await storedValues(), STORED);
    });

    test("--apply maps BASIC..FLUENT to ENGLISH 6..10, keeps NO KNOWLEDGE, ENGLISH n and NULL, and leaves the form's table and updated_date alone", async () => {
        const report = await backfillEnglishKnowledge({ client: pg, apply: true });
        assert.equal(report.rowsChanged, 5);
        assert.deepEqual(await storedValues(), EXPECTED);
        assert.deepEqual(report.after.counts, { ...report.after.counts, "ENGLISH 7": 2, "NO KNOWLEDGE": 1, null: 1, BASIC: 0, FAIR: 0, GOOD: 0, "VERY GOOD": 0, FLUENT: 0, other: 0 });
        assert.equal((await pg.query(`SELECT "english_knowledge" AS v FROM "candidate_form_response"`)).rows[0].v, "GOOD");
        const dates = (await pg.query(`SELECT DISTINCT "updated_date"::text AS d FROM "candidate_additional_details"`)).rows.map((r) => r.d);
        assert.deepEqual(dates, ["2026-01-01 00:00:00"]);
        assert.equal((await pg.query(`SELECT count(*)::int AS n FROM "audit_logs"`)).rows[0].n, 0);
    });

    test("running it again changes nothing", async () => {
        await backfillEnglishKnowledge({ client: pg, apply: true });
        const again = await backfillEnglishKnowledge({ client: pg, apply: true });
        assert.equal(again.rowsChanged, 0);
        assert.deepEqual(again.wouldChange, {});
        assert.deepEqual(await storedValues(), EXPECTED);
    });

    test("counts are by known value only; anything else is 'other'", async () => {
        const { total, counts } = await countEnglishKnowledge(pg, "candidate_form_response");
        assert.equal(total, 1);
        assert.equal(counts.GOOD, 1);
        await assert.rejects(countEnglishKnowledge(pg, "candidate; DROP TABLE x"), /Unknown table/);
    });
});
