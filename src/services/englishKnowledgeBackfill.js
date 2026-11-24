// One-time backfill of candidate_additional_details.english_knowledge to the ENGLISH 6..10 scale
// (englishKnowledgeLevels.js): BASIC -> ENGLISH 6 ... FLUENT -> ENGLISH 10. NO KNOWLEDGE, NULL and
// ENGLISH 6..10 are left as they are. The Candidate Form's own tables (candidate_form_response,
// candidate_form_prefill_snapshot) keep the form's answers and are never touched.
//
// Reads keep working without it (older levels are translated when read); it only makes the stored
// values match. Runs on a node-postgres style client ({ query(text, params) -> { rows } }):
//   dry run (default)  READ ONLY transaction, rolled back: the counts and what WOULD change
//   apply              one transaction: counts, one UPDATE, counts again, COMMIT
// Running it again changes nothing. Like the other system backfills, no audit_logs entry is written
// (the value's meaning does not change) and updated_date is not touched, so a staff page open at the
// same time is not refused. Reports counts only: never a passport number, a name or another value.

import { ENGLISH_KNOWLEDGE_VALUES, LEGACY_ENGLISH_KNOWLEDGE } from "./englishKnowledgeLevels.js";

const OLD_LEVELS = ["NO KNOWLEDGE", ...Object.keys(LEGACY_ENGLISH_KNOWLEDGE)];
const KNOWN = [...new Set([...OLD_LEVELS, ...ENGLISH_KNOWLEDGE_VALUES])];
export const ENGLISH_KNOWLEDGE_BUCKETS = Object.freeze(["null", "blank", ...KNOWN, "other"]);
const TABLES = new Set(["candidate_additional_details", "candidate_form_response", "candidate_form_prefill_snapshot"]);
// Case and spacing ignored, in SQL, so no stored text leaves the database.
const NORMALIZED = `upper(regexp_replace(btrim("english_knowledge"), '\\s+', ' ', 'g'))`;

// { total, counts: { bucket: n } }; an unexpected value is only ever counted as "other".
export async function countEnglishKnowledge(client, table) {
    if (!TABLES.has(table)) throw new Error("Unknown table");
    const { rows } = await client.query(`
        SELECT CASE
                   WHEN "english_knowledge" IS NULL THEN 'null'
                   WHEN btrim("english_knowledge") = '' THEN 'blank'
                   WHEN ${NORMALIZED} = ANY($1::text[]) THEN ${NORMALIZED}
                   ELSE 'other'
               END AS bucket,
               count(*)::int AS n
        FROM "${table}" GROUP BY 1`, [KNOWN]);
    const counts = Object.fromEntries(ENGLISH_KNOWLEDGE_BUCKETS.map((bucket) => [bucket, 0]));
    for (const row of rows) counts[row.bucket] = row.n;
    return { total: rows.reduce((sum, row) => sum + row.n, 0), counts };
}

const legacyPairs = () => [Object.keys(LEGACY_ENGLISH_KNOWLEDGE), Object.values(LEGACY_ENGLISH_KNOWLEDGE)];

export async function backfillEnglishKnowledge({ client, apply = false }) {
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    try {
        const before = await countEnglishKnowledge(client, "candidate_additional_details");
        const pending = await client.query(`
            SELECT m.level, count(*)::int AS n
            FROM "candidate_additional_details" d JOIN unnest($1::text[], $2::text[]) AS m(legacy, level)
              ON upper(regexp_replace(btrim(d."english_knowledge"), '\\s+', ' ', 'g')) = m.legacy
            GROUP BY m.level`, legacyPairs());
        const wouldChange = Object.fromEntries(pending.rows.map((row) => [row.level, row.n]));
        const report = { mode: apply ? "APPLY" : "DRY_RUN", before, wouldChange, rowsChanged: 0, after: null };
        if (!apply) {
            await client.query("ROLLBACK");
            return report;
        }
        const updated = await client.query(`
            UPDATE "candidate_additional_details" d SET "english_knowledge" = m.level
            FROM unnest($1::text[], $2::text[]) AS m(legacy, level)
            WHERE upper(regexp_replace(btrim(d."english_knowledge"), '\\s+', ' ', 'g')) = m.legacy`, legacyPairs());
        report.rowsChanged = updated.affectedRows ?? updated.rowCount ?? 0;
        report.after = await countEnglishKnowledge(client, "candidate_additional_details");
        await client.query("COMMIT");
        return report;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    }
}
