// Candidate Form submissions -> the "Candidate Form Submissions" tab of the Google Sheet.
//
//   candidate submits -> candidate_form_response + one candidate_form_sheet_sync row, in the SAME
//   transaction (candidateFormDataService.js submitCandidateForm) -> the sheet-sync worker, every
//   tick, takes the due rows and puts each submission in the tab.
//
// Everything about it is separate from the operational mirror: its own outbox table, its own tab,
// its own schema and adapter. Only the spreadsheet (the active Sync Destination's), the Google
// client and credentials, the SHEET_SYNC_ENABLED write gate and the writer lease are shared. The
// mirror's reconciliation, its queue and its integration state are never read or changed here.
//
// The public submit never waits for or depends on Google: the outbox row is plain database work,
// and this runs later in the worker process. A Sheet that is down, a tab that is missing or
// renamed, or a write that fails changes nothing for the candidate: the row simply stays queued
// and is tried again.
//
// Duplicates: the key is the submission's stable ID (_SUBMISSION_ID), never the passport or NIC.
//   - the outbox has at most one row per submission (passport_id is unique; a candidate submits once);
//   - before writing, the tab's _SUBMISSION_ID column is read: a submission already there is
//     REWRITTEN in place, never appended again. So a retry after a write that succeeded but was
//     not recorded (a crash, a lost response) ends with the one row.
// Failures (classifySyncError), by rows, never by halting the mirror:
//   RETRYABLE (429, 5xx, network, header moved mid-run)   exponential backoff, no limit
//   CONFIG / DATA_INTEGRITY (access, tab, header columns)  checked again every 15 minutes, no limit,
//                     attempts not used up: fixing the Sheet is enough
//   anything else (a bug, an unexpected error)            backoff; after 5 attempts FAILED (dead letter)
// Logs: JSON lines, event names sheet_sync.form_*, with counts and codes only. Never names,
// passport numbers, NICs, phone numbers, cell values, Google message text or tokens.

import { classifySyncError } from "./sheetSyncWorker.js";
import { backoffDelayMs } from "./sheetSyncStore.js";
import { buildSubmissionCells } from "./formSubmissionSheetSchema.js";

export const FORM_SYNC_TIMINGS = Object.freeze({
    leaseMs: 2 * 60_000,
    batchSize: 25,
    configRetryMs: 15 * 60_000,
    busyRetryMs: 30_000,
    permanentMaxAttempts: 5,
});

const later = (now, ms) => new Date(now.getTime() + ms);

// db: the Prisma client (reads the submission). store: createFormSubmissionSyncStore. adapterFor:
// (destination, tabName) -> a createFormSubmissionSheetsAdapter for that spreadsheet.
// tabName: the Candidate Form Submissions tab (config/sheetSync.js readFormSubmissionSheetConfig).
export function createFormSubmissionSync({ db, store, adapterFor, tabName, buildCells = buildSubmissionCells, clock = () => new Date(), log = console, timings = FORM_SYNC_TIMINGS, random = Math.random } = {}) {
    if (!db || !store || typeof adapterFor !== "function" || !tabName) {
        throw new Error("db, store, adapterFor and tabName are required");
    }

    const emit = (level, event, fields = {}) => {
        const line = JSON.stringify({ event, ...fields });
        (level === "error" ? log.error : level === "warn" ? (log.warn ?? log.log) : log.log).call(log, line);
    };

    // The submission as it is now: { candidate, response }, or null when it is gone.
    async function load(row) {
        const [response, candidate] = await Promise.all([
            db.candidateFormResponse.findUnique({ where: { passportId: row.passportId } }),
            db.candidate.findUnique({ where: { passportId: row.passportId }, select: { uniqueId: true, passportId: true, firstName: true, otherName: true, whatsappNumber: true } }),
        ]);
        return response && candidate ? { candidate, response } : null;
    }

    // What happens to claimed rows after an error (see the header).
    async function settleFailure(rows, error, summary, settled) {
        const classified = classifySyncError(error);
        const now = clock();
        for (const row of rows) {
            settled.add(row.submissionId);
            const base = { errorClass: classified.errorClass, errorCode: classified.errorCode, now };
            if (classified.kind === "DISABLED") {
                await store.retry(row, { ...base, nextAttemptAt: later(now, timings.busyRetryMs), countAttempt: false });
                summary.retried += 1;
            } else if (classified.kind === "CONFIG" || classified.kind === "DATA_INTEGRITY") {
                await store.retry(row, { ...base, nextAttemptAt: later(now, timings.configRetryMs), countAttempt: false });
                summary.retried += 1;
            } else if (classified.kind === "RETRYABLE" || row.attempts < timings.permanentMaxAttempts) {
                await store.retry(row, { ...base, nextAttemptAt: later(now, backoffDelayMs(row.attempts, { random })) });
                summary.retried += 1;
            } else {
                await store.fail(row, base);
                summary.failed += 1;
            }
        }
        emit(classified.kind === "RETRYABLE" || classified.kind === "DISABLED" ? "warn" : "error", "sheet_sync.form_submissions_failed", {
            kind: classified.kind, errorClass: classified.errorClass, errorCode: classified.errorCode, rows: rows.length,
        });
    }

    // Writes the claimed rows (one read of the tab, one write) and settles them.
    async function syncClaimed(claimed, destination, summary, settled) {
        const adapter = adapterFor(destination, tabName);
        const layout = await adapter.readLayout({ initialize: true });
        const { ids, duplicates } = await adapter.readSubmissionIds(layout);
        if (duplicates > 0) emit("warn", "sheet_sync.form_duplicate_rows", { copies: duplicates });

        const updates = [];
        const appends = [];
        const results = [];
        for (const row of claimed) {
            try {
                const record = await load(row);
                if (!record) {
                    await store.complete(row, { result: "NOT_IN_DATABASE", now: clock() });
                    settled.add(row.submissionId);
                    summary.notInDatabase += 1;
                    continue;
                }
                const cells = buildCells({ submissionId: row.submissionId, ...record });
                const rowNumber = ids.get(row.submissionId);
                if (rowNumber) updates.push({ rowNumber, cells });
                else appends.push(cells);
                results.push({ row, result: rowNumber ? "UPDATED" : "APPENDED" });
            } catch (error) {
                // One submission that can't be built does not hold up the others.
                await settleFailure([row], error, summary, settled);
            }
        }
        if (!results.length) return;
        await adapter.writeRows({ updates, appends }, layout);
        const now = clock();
        for (const { row, result } of results) {
            await store.complete(row, { result, now });
            settled.add(row.submissionId);
            if (result === "APPENDED") summary.appended += 1;
            else summary.updated += 1;
        }
    }

    // One pass over the rows that are due. destination: the active Sync Destination (its
    // spreadsheet is the target; the tab is ours). withWriterLease: the worker's, so only one
    // process writes to the Sheet at a time. Never throws for a Sheet problem.
    async function processDue({ owner, destination, withWriterLease }) {
        if (!destination) return { claimed: 0, reason: "NO_DESTINATION" };
        if (destination.tabName === tabName) {
            // The mirror's tab is this tab: nothing may be written there.
            emit("error", "sheet_sync.form_tab_conflict", { errorClass: "FORM_TAB_IS_MIRROR_TAB" });
            return { claimed: 0, reason: "TAB_CONFLICT" };
        }
        const now = clock();
        const claimed = await store.claimBatch({ owner, now, leaseMs: timings.leaseMs, limit: timings.batchSize });
        if (!claimed.length) return { claimed: 0 };
        const summary = { claimed: claimed.length, appended: 0, updated: 0, notInDatabase: 0, retried: 0, failed: 0 };
        const settled = new Set();
        try {
            const outcome = await withWriterLease(() => syncClaimed(claimed, destination, summary, settled));
            if (outcome.busy) {
                for (const row of claimed) await store.retry(row, { nextAttemptAt: later(clock(), timings.busyRetryMs), countAttempt: false, now: clock() });
                summary.retried = claimed.length;
                emit("info", "sheet_sync.form_submissions_skipped", { reason: "WRITER_BUSY", rows: claimed.length });
                return summary;
            }
        } catch (error) {
            // Only the rows not settled yet (a row already completed or settled one by one is left as it is).
            await settleFailure(claimed.filter((row) => !settled.has(row.submissionId)), error, summary, settled);
            return summary;
        }
        emit("info", "sheet_sync.form_submissions_synced", { destinationKey: destination.key ?? null, ...summary });
        return summary;
    }

    return Object.freeze({ processDue, batchSize: timings.batchSize });
}
