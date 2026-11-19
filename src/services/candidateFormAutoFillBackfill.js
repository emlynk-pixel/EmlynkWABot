import { applyAutoFill, autoFillChanges, CONFIRM_SELECT } from "./candidateFormFieldConfirmService.js";

// One-time backfill of the automatic fill (applyAutoFill) for submissions made BEFORE it existed: each
// submitted candidate's EMPTY Additional Details fields take the submitted value, exactly as a new
// submission does now. Fill only: a field with a value is never written (a differing value stays a pending
// change for Confirm / Reject). A field that already has a staff decision (CONFIRMED / REJECTED) is
// skipped, so a rejected value is never brought in. Running it again changes nothing.
//
// Dry run (the default): reads only and reports what WOULD be filled. apply: one transaction per
// candidate (applyAutoFill locks the candidate and details rows and re-checks under the lock, so a staff
// save at the same moment is never overwritten). The report holds counts and field keys only: never a
// passport number, a name or a value.
export const BACKFILL_BATCH_SIZE = 200;

export async function backfillFormAutoFill({ db, apply = false, batchSize = BACKFILL_BATCH_SIZE }) {
    const report = { mode: apply ? "APPLY" : "DRY_RUN", submissionsScanned: 0, candidatesFilled: 0, fieldsFilled: 0, byField: {} };
    let cursor = null;
    for (;;) {
        const responses = await db.candidateFormResponse.findMany({
            orderBy: { passportId: "asc" }, take: batchSize, ...(cursor ? { cursor: { passportId: cursor }, skip: 1 } : {}),
        });
        if (!responses.length) break;
        cursor = responses.at(-1).passportId;
        for (const response of responses) {
            report.submissionsScanned += 1;
            const { passportId } = response;
            const reviewed = new Set((await db.candidateFormFieldReview.findMany({ where: { passportId }, select: { fieldKey: true } })).map((r) => r.fieldKey));
            let fields;
            if (apply) {
                fields = await db.$transaction((tx) => applyAutoFill(tx, passportId, response, { reviewed }));
            } else {
                const details = await db.candidateAdditionalDetails.findUnique({ where: { passportId }, select: CONFIRM_SELECT.details });
                ({ fields } = autoFillChanges({ details, response, reviewed }));
            }
            if (!fields.length) continue;
            report.candidatesFilled += 1;
            report.fieldsFilled += fields.length;
            for (const field of fields) report.byField[field] = (report.byField[field] ?? 0) + 1;
        }
        if (responses.length < batchSize) break;
    }
    return report;
}
