// One-time backfill: older English Knowledge levels in candidate_additional_details to ENGLISH 6..10
// (src/services/englishKnowledgeBackfill.js). Needs migration 20261124130000_english_knowledge_levels.
//
//   npm run db:backfill-english-knowledge                 dry run: counts and what would change; changes nothing
//   npm run db:backfill-english-knowledge -- --apply      updates them (one transaction)
//
// NO KNOWLEDGE, empty values and ENGLISH 6..10 are never changed; the Candidate Form's tables are never
// touched. Running it again changes nothing. Prints the database host and counts only. Run the dry run
// first in each environment, then --apply. Needs DATABASE_URL (server only).
import "dotenv/config";
import { parseArgs } from "node:util";
import pg from "pg";

import { backfillEnglishKnowledge } from "../src/services/englishKnowledgeBackfill.js";

function databaseHost() {
    try {
        return new URL(process.env.DATABASE_URL).host;
    } catch {
        return "(DATABASE_URL not set or not a URL)";
    }
}

let exitCode = 0;
let client;
try {
    const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } }, strict: true });
    console.log(`Database: ${databaseHost()}`);
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const report = await backfillEnglishKnowledge({ client, apply: values.apply });
    console.log(JSON.stringify(report, null, 2));
    if (!values.apply) console.log("Dry run: nothing changed. Re-run with --apply to update these values.");
} catch (error) {
    const message = error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? error.message : `Failed (${error?.name ?? "Error"}${error?.code ? ` ${error.code}` : ""})`;
    console.error(`Stopped: ${message}. Nothing was changed (one transaction, rolled back).`);
    exitCode = 1;
} finally {
    await client?.end().catch(() => {});
}
process.exit(exitCode);
