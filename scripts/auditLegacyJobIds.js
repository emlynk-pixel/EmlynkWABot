// Read-only audit of the legacy free-text candidate_stages.job_id values
// (Docs/JOB_MANAGEMENT_IMPLEMENTATION.md, section "Migration"). Prints counts
// and the distinct values only (a job reference is not personal data); no
// candidate is named. Never writes. Usage: node scripts/auditLegacyJobIds.js
import "dotenv/config";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
    await client.query("BEGIN READ ONLY");
    const total = await client.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE job_id IS NOT NULL AND btrim(job_id) <> '')::int AS with_job_id FROM candidate_stages`);
    const stages = await client.query(`SELECT stage, count(*)::int AS n FROM candidate_stages WHERE job_id IS NOT NULL AND btrim(job_id) <> '' GROUP BY stage`);
    const distinct = await client.query(`
        SELECT job_id, count(*)::int AS candidates,
               (job_id <> btrim(job_id)) AS has_outer_space,
               (job_id ~ '^JOB-[0-9]{4}-[0-9]{6}$') AS looks_like_job_code
        FROM candidate_stages WHERE job_id IS NOT NULL AND btrim(job_id) <> ''
        GROUP BY job_id ORDER BY candidates DESC, job_id`);
    const caseDupes = await client.query(`
        SELECT upper(btrim(job_id)) AS normalized, count(DISTINCT job_id)::int AS spellings
        FROM candidate_stages WHERE job_id IS NOT NULL AND btrim(job_id) <> ''
        GROUP BY 1 HAVING count(DISTINCT job_id) > 1`);
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ stageRows: total.rows[0], stagesWithJobId: stages.rows, distinctValues: distinct.rows, spellingVariants: caseDupes.rows }, null, 2));
} finally {
    await client.end();
}
