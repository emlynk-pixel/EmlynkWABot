// Read-only audit of candidate stages and statuses, to run BEFORE deploying migration
// 20261109120000_candidate_status_cleanup (which deletes the retired stages). Prints counts only:
// no candidate is named. Never writes (READ ONLY transaction, rolled back).
// Usage: node scripts/auditCandidateStages.js
import "dotenv/config";
import pg from "pg";

const KEPT = ["TEST_DETAILS", "JOB_DETAILS", "CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION", "VISA_SUBMISSION", "VISA_APPROVAL"];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
    await client.query("BEGIN READ ONLY");
    const byStage = await client.query(`
        SELECT stage, count(*)::int AS rows, count(*) FILTER (WHERE completed)::int AS completed,
               count(*) FILTER (WHERE notes IS NOT NULL AND btrim(notes) <> '')::int AS with_notes
        FROM candidate_stages GROUP BY stage ORDER BY stage`);
    const toDelete = byStage.rows.filter((row) => !KEPT.includes(row.stage));
    const candidates = await client.query(
        `SELECT count(DISTINCT passport_id)::int AS n FROM candidate_stages WHERE NOT (stage = ANY($1::text[]))`, [KEPT]);
    const departed = await client.query(`SELECT count(*)::int AS n FROM candidate WHERE departed_at IS NOT NULL`);
    const outcome = await client.query(`SELECT to_regclass('public.candidate') IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'candidate' AND column_name = 'outcome') AS present`);
    await client.query("ROLLBACK");
    console.log(JSON.stringify({
        stagesInDatabase: byStage.rows,
        willBeDeleted: { stages: toDelete, rows: toDelete.reduce((sum, row) => sum + row.rows, 0), candidatesAffected: candidates.rows[0].n },
        departedCandidates: departed.rows[0].n,
        outcomeColumnPresent: outcome.rows[0].present,
    }, null, 2));
} finally {
    await client.end();
}
