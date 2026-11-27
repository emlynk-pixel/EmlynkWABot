// Recalculates the Test details and Job details completion of every existing candidate by the automatic
// rule (src/services/stageCompletion.js, src/services/stageCompletionBackfill.js).
//
//   npm run stages:backfill-completion                          dry run (the default): the report; nothing is written
//   npm run stages:backfill-completion -- --apply               after approval: writes ONLY completed / completed_at and an EMPTY
//                                                               Job details date (from the Job's assigned day), after saving a record file
//   npm run stages:backfill-completion -- --apply --batch-size 100   candidates per transaction (1 to 1000, default 200)
//   npm run stages:backfill-completion -- --revert <file>       puts the previous values back from that record
//
// The dry run also reports how many Google Sheet sync queue items the apply would create.
// Known limitation: the sheet upload's Job groups assign Jobs without a Job details date, so run this
// again after sheet imports (it only touches what still differs).

// The record file (stage-completion-backfill-<time>.json, git-ignored) lists passport IDs and the previous
// values: keep it private, and keep it until the change is confirmed. The report itself holds counts only.
// Needs DATABASE_URL (server only). Run the dry run first in each environment.

import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";

import { applyStageCompletionBackfill, parseBatchSize, planStageCompletionBackfill, revertStageCompletionBackfill } from "../src/services/stageCompletionBackfill.js";

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
    const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, revert: { type: "string" }, "batch-size": { type: "string" } }, strict: true });
    const batchSize = parseBatchSize(values["batch-size"]);
    console.log(`Database: ${databaseHost()}`);
    if (values.revert) {
        const record = JSON.parse(fs.readFileSync(values.revert, "utf8"));
        console.log(JSON.stringify(await revertStageCompletionBackfill({ db: prisma, record, batchSize }), null, 2));
    } else if (values.apply) {
        const file = `stage-completion-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        const result = await applyStageCompletionBackfill({ db: prisma, batchSize, writeRecord: async (record) => fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: "wx" }) });
        console.log(JSON.stringify(result, null, 2));
        console.log(`Record of the previous values: ${file}`);
    } else {
        const { changes, report } = await planStageCompletionBackfill({ db: prisma });
        console.log(JSON.stringify({ mode: "DRY_RUN", stagesToChange: changes.length, ...report }, null, 2));
        console.log("Dry run: nothing changed. Re-run with --apply, after approval, to write these changes.");
    }
} catch (error) {
    // The Prisma error code (for example P2028: transaction timed out) is safe to show; its details can hold values, so they are not.
    const message = error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error instanceof RangeError ? error.message : `Failed (${error?.name ?? "Error"}${error?.code ? ` ${error.code}` : ""})`;
    console.error(`Stopped: ${message}. With --apply, each batch is its own transaction and the record file already lists every planned change; running it again continues safely.`);
    exitCode = 1;
} finally {
    await prisma.$disconnect();
}
process.exit(exitCode);
