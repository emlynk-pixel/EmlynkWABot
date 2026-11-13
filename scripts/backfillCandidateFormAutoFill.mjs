// One-time backfill: fill the EMPTY Additional Details fields of candidates who submitted the
// Candidate Form before the automatic fill existed (src/services/candidateFormAutoFillBackfill.js).
//
//   npm run form:backfill-autofill                  dry run: reports what would be filled; changes nothing
//   npm run form:backfill-autofill -- --apply       fills them (one transaction per candidate)
//
// Fill only: a field with a value is never written, and a field with a staff decision (Confirmed or
// Rejected) is skipped. Running it again changes nothing. Prints the database host, counts and field keys
// only: never a passport number, a name or a value. Run the dry run first in each environment, then
// --apply. Needs DATABASE_URL (server only).

import "dotenv/config";
import { parseArgs } from "node:util";

import { backfillFormAutoFill } from "../src/services/candidateFormAutoFillBackfill.js";

function databaseHost() {
    try {
        return new URL(process.env.DATABASE_URL).host;
    } catch {
        return "(DATABASE_URL not set or not a URL)";
    }
}

let exitCode = 0;
const { default: prisma } = await import("../src/config/prisma.js");
try {
    const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } }, strict: true });
    console.log(`Database: ${databaseHost()}`);
    const report = await backfillFormAutoFill({ db: prisma, apply: values.apply });
    console.log(JSON.stringify(report, null, 2));
    if (!values.apply) console.log("Dry run: nothing changed. Re-run with --apply to fill these fields.");
} catch (error) {
    const message = error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? error.message : `Failed (${error?.name ?? "Error"})`;
    console.error(`Stopped: ${message}. Candidates already processed with --apply keep their fill (each is its own transaction); running it again continues safely.`);
    exitCode = 1;
} finally {
    await prisma.$disconnect();
}
process.exit(exitCode);
