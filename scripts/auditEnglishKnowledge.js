// Read-only audit of the stored English Knowledge levels, for the ENGLISH 6..10 scale
// (migration 20261124130000_english_knowledge_levels, src/services/englishKnowledgeLevels.js).
// Prints counts only: no candidate is named, no value other than the known levels is printed.
// Never writes (READ ONLY transaction, rolled back).
// Usage: node scripts/auditEnglishKnowledge.js
import "dotenv/config";
import pg from "pg";

import { ENGLISH_KNOWLEDGE_LEVELS } from "../src/services/englishKnowledgeLevels.js";
import { countEnglishKnowledge } from "../src/services/englishKnowledgeBackfill.js";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
    await client.query("BEGIN READ ONLY");
    const details = await countEnglishKnowledge(client, "candidate_additional_details");
    const responses = await countEnglishKnowledge(client, "candidate_form_response");
    const check = await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'candidate_additional_details_english_knowledge_check'`);
    await client.query("ROLLBACK");
    console.log(JSON.stringify({
        candidateAdditionalDetails: details,
        candidateFormResponse: responses,
        detailsCheckAllowsNewLevels: check.rows.length ? ENGLISH_KNOWLEDGE_LEVELS.every((level) => check.rows[0].definition.includes(`'${level}'`)) : null,
    }, null, 2));
} finally {
    await client.end();
}
