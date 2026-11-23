// Dry run of the Candidates tab Status order (candidateWorkflowStatus.js): how many candidates would
// move from each previous Status to each new one, split by manually created vs sheet-imported.
//
//   node scripts/auditWorkflowStatusTransition.mjs
//
// READ ONLY: everything runs in one READ ONLY transaction, nothing is written. Prints counts of
// "OLD -> NEW" Status codes only: never a passport number, name, unique ID or any other identifier.
// "Imported" = the candidate's unique ID appears in the bulk-import change ledger
// (candidate_import_change, imports since migration 20261112130000); every other candidate is "manual".
//
// Uses DATABASE_URL. Refuses to run with NODE_ENV=production, or against any host other than
// localhost, unless AUDIT_WORKFLOW_STATUS_ACK=READ_ONLY_DRY_RUN is set.

import { pathToFileURL } from "node:url";

import { WORKFLOW_STATUS_SELECT, candidateWorkflowSignals } from "../src/services/candidateService.js";
import { deriveCandidateWorkflowStatus, isCandidateOutcome } from "../src/services/candidateWorkflowStatus.js";

export const ACK_VARIABLE = "AUDIT_WORKFLOW_STATUS_ACK";
export const ACK_VALUE = "READ_ONLY_DRY_RUN";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BATCH = 1000;

// The Status ladder before the Candidates tab order, kept here only to compare with (same signals).
export function previousWorkflowStatusCode(s) {
    if (isCandidateOutcome(s.outcome)) return s.outcome;
    if (s.testResult === "FAIL") return "STOPPED_WITH_TEST";
    if (s.departed) return "DEPARTED";
    if (s.visaApproved) return "VISA_APPROVED";
    if (s.visaSubmitted) return "VISA_SUBMITTED";
    if (s.documentSubmissionCompleted) return "VISA_DOCUMENT_READY";
    if (s.documentsVerified) return "DOCUMENTS_VERIFIED";
    if (s.detailsVerified) return "DETAILS_VERIFIED";
    if (s.formSubmitted) return "FORM_SUBMITTED";
    if (s.hasCurrentJob) return "JOB_ASSIGNED";
    if (s.testResult === "PASS") return "TEST_PASSED";
    return "REGISTERED";
}

// Why the script must not run with this environment (null: it may). Never echoes the URL.
export function refusalReason(env = process.env) {
    if (env[ACK_VARIABLE] === ACK_VALUE) return null;
    if (env.NODE_ENV === "production") return `NODE_ENV is production. Set ${ACK_VARIABLE}=${ACK_VALUE} to run this read-only dry run anyway.`;
    if (!env.DATABASE_URL) return "DATABASE_URL is not set.";
    let host;
    try {
        host = new URL(env.DATABASE_URL).hostname;
    } catch {
        return "DATABASE_URL is not a valid URL.";
    }
    if (!LOCAL_HOSTS.has(host)) return `DATABASE_URL is not a local database. Set ${ACK_VARIABLE}=${ACK_VALUE} to run this read-only dry run against it.`;
    return null;
}

async function importedUniqueIds(tx) {
    const [table] = await tx.$queryRaw`SELECT to_regclass('public.candidate_import_change') IS NOT NULL AS "present"`;
    if (!table?.present) return new Set();
    const rows = await tx.$queryRaw`SELECT DISTINCT "candidate_unique_id" AS "uniqueId" FROM "candidate_import_change" WHERE "candidate_unique_id" IS NOT NULL`;
    return new Set(rows.map((row) => row.uniqueId));
}

// { total, changed, manual: { candidates, changed, transitions }, imported: { ... } } where transitions maps
// "OLD -> NEW" to a count. Codes and counts only.
export async function auditWorkflowStatusTransition(db) {
    return db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const imported = await importedUniqueIds(tx);
        const groups = { manual: { candidates: 0, changed: 0, transitions: {} }, imported: { candidates: 0, changed: 0, transitions: {} } };
        let cursor;
        for (;;) {
            const rows = await tx.candidate.findMany({
                select: WORKFLOW_STATUS_SELECT,
                orderBy: { passportId: "asc" },
                take: BATCH,
                ...(cursor ? { cursor: { passportId: cursor }, skip: 1 } : {}),
            });
            if (!rows.length) break;
            const signals = await candidateWorkflowSignals(tx, rows);
            for (const row of rows) {
                const values = signals.get(row.passportId);
                const before = previousWorkflowStatusCode(values);
                const after = deriveCandidateWorkflowStatus(values).code;
                const group = groups[imported.has(row.uniqueId) ? "imported" : "manual"];
                const key = `${before} -> ${after}`;
                group.candidates += 1;
                if (before !== after) group.changed += 1;
                group.transitions[key] = (group.transitions[key] ?? 0) + 1;
            }
            cursor = rows.at(-1).passportId;
            if (rows.length < BATCH) break;
        }
        for (const group of Object.values(groups)) {
            group.transitions = Object.fromEntries(Object.entries(group.transitions).sort(([a], [b]) => a.localeCompare(b)));
        }
        return {
            total: groups.manual.candidates + groups.imported.candidates,
            changed: groups.manual.changed + groups.imported.changed,
            ...groups,
        };
    }, { timeout: 300_000, maxWait: 30_000 });
}

async function main() {
    await import("dotenv/config");
    const refusal = refusalReason();
    if (refusal) {
        console.error(`Refusing to run: ${refusal}`);
        return 2;
    }
    const { default: prisma } = await import("../src/config/prisma.js");
    try {
        console.log(JSON.stringify(await auditWorkflowStatusTransition(prisma), null, 2));
        return 0;
    } catch (error) {
        console.error(`Workflow status audit failed (${error?.name ?? "Error"}${error?.code ? ` ${error.code}` : ""}).`);
        return 1;
    } finally {
        await prisma.$disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
