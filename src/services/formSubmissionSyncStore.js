// Candidate Form -> Google Sheet submission sync: the durable PostgreSQL side (the outbox
// candidate_form_sheet_sync, see formSubmissionSync.js). The counterpart of sheetSyncStore.js's
// queue, for the "Candidate Form Submissions" tab.
//
// A row is inserted by submitCandidateForm in the same transaction as the submission. Every claim
// is a compare-and-swap (a row is claimed only if it is still in the state it was read in), a claim
// is a lease (a crashed worker's rows are claimed again once it runs out), and every settlement is
// fenced on the claim (status, lease owner, attempt number), so a worker that lost its claim changes
// nothing. Only codes are stored (error class, HTTP status / Google status code, result names):
// never candidate data, Google message text or tokens. Nothing here calls Google.
// Completed rows are kept: they hold the submission's stable ID.

export const FORM_SYNC_STATUS = Object.freeze({ PENDING: "PENDING", PROCESSING: "PROCESSING", COMPLETED: "COMPLETED", FAILED: "FAILED" });

const later = (now, ms) => new Date(now.getTime() + ms);

export function createFormSubmissionSyncStore({ db } = {}) {
    if (!db?.candidateFormSheetSync) throw new Error("A database client with the candidate_form_sheet_sync table is required");
    const table = db.candidateFormSheetSync;

    // Up to `limit` due rows (PENDING whose next attempt is due, or PROCESSING whose lease ran
    // out), claimed for `owner`. attempts counts claims, so a row that crashes the worker every
    // time still reaches a bound.
    async function claimBatch({ owner, now, leaseMs, limit }) {
        const due = await table.findMany({
            where: {
                OR: [
                    { status: FORM_SYNC_STATUS.PENDING, nextAttemptAt: { lte: now } },
                    { status: FORM_SYNC_STATUS.PROCESSING, leaseExpiresAt: { lt: now } },
                ],
            },
            orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
            take: limit,
        });
        const claimed = [];
        for (const row of due) {
            const data = { status: FORM_SYNC_STATUS.PROCESSING, leaseOwner: owner, leaseExpiresAt: later(now, leaseMs), attempts: row.attempts + 1, updatedAt: now };
            const { count } = await table.updateMany({ where: { submissionId: row.submissionId, status: row.status, attempts: row.attempts }, data });
            if (count === 1) claimed.push({ ...row, ...data });
        }
        return claimed;
    }

    const ownedBy = (row) => ({ submissionId: row.submissionId, status: FORM_SYNC_STATUS.PROCESSING, leaseOwner: row.leaseOwner, attempts: row.attempts });

    // In the Sheet (APPENDED, UPDATED) or nothing to put there (NOT_IN_DATABASE).
    async function complete(row, { result, now }) {
        const { count } = await table.updateMany({
            where: ownedBy(row),
            data: { status: FORM_SYNC_STATUS.COMPLETED, lastResult: result, completedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null, lastErrorClass: null, lastErrorCode: null },
        });
        return count === 1;
    }

    // Back to PENDING at nextAttemptAt. countAttempt=false (a configuration problem, the writer
    // busy) gives the claim back without using up an attempt.
    async function retry(row, { nextAttemptAt, errorClass = null, errorCode = null, countAttempt = true, now }) {
        const { count } = await table.updateMany({
            where: ownedBy(row),
            data: {
                status: FORM_SYNC_STATUS.PENDING, nextAttemptAt, attempts: countAttempt ? row.attempts : Math.max(0, row.attempts - 1),
                lastErrorClass: errorClass, lastErrorCode: errorCode, updatedAt: now, leaseOwner: null, leaseExpiresAt: null,
            },
        });
        return count === 1;
    }

    // Dead letter (permanent errors only): no more automatic attempts.
    async function fail(row, { errorClass, errorCode = null, now }) {
        const { count } = await table.updateMany({
            where: ownedBy(row),
            data: { status: FORM_SYNC_STATUS.FAILED, lastErrorClass: errorClass, lastErrorCode: errorCode, updatedAt: now, leaseOwner: null, leaseExpiresAt: null },
        });
        return count === 1;
    }

    // For the operator: put a dead-lettered submission back in the queue.
    async function requeueFailed({ now }) {
        const { count } = await table.updateMany({
            where: { status: FORM_SYNC_STATUS.FAILED },
            data: { status: FORM_SYNC_STATUS.PENDING, attempts: 0, nextAttemptAt: now, updatedAt: now },
        });
        return count;
    }

    async function counts() {
        const groups = await table.groupBy({ by: ["status"], _count: { _all: true } });
        return Object.fromEntries(Object.values(FORM_SYNC_STATUS).map((status) => [status, groups.find((g) => g.status === status)?._count._all ?? 0]));
    }

    return Object.freeze({ claimBatch, complete, retry, fail, requeueFailed, counts });
}
