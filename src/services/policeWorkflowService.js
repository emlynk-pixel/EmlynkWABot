import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { POLICE_DATE_STATUS } from "./policeReportDateService.js";

// What a stored police document means for the police workflow (proposal
// §20-21). Pure: the event itself is not saved. Since Phase 10 Checkpoint 5
// a slip's submitted date is stored on the document and the status is
// calculated from the documents (policeCountdownService.js):
//   POLICE_SLIP_RECEIVED   -> the countdown runs from submittedDate
//   POLICE_REPORT_RECEIVED -> a VERIFIED report completes the workflow
// Reminders and alerts are not built (Phase 11).

export const POLICE_REPORT_DUE_DAYS = 21;

export const POLICE_WORKFLOW_EVENT = Object.freeze({
    SLIP_RECEIVED: "POLICE_SLIP_RECEIVED",
    REPORT_RECEIVED: "POLICE_REPORT_RECEIVED",
});

// submittedDate (YYYY-MM-DD) + 21 days, as YYYY-MM-DD.
export function policeReportDueDate(submittedDate) {
    const due = new Date(`${submittedDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + POLICE_REPORT_DUE_DAYS);
    return due.toISOString().slice(0, 10);
}

// Only documents filed under the client count. A slip counts only with a
// resolved submitted date (never a guessed one); anything in pending/ waits
// for a person first.
export function policeWorkflowEvent({ documentType, policeDate, placement }) {
    if (placement !== "CLIENT") {
        return null;
    }
    if (documentType === DOCUMENT_TYPES.POLICE_SLIP && policeDate?.status === POLICE_DATE_STATUS.RESOLVED) {
        return {
            event: POLICE_WORKFLOW_EVENT.SLIP_RECEIVED,
            submittedDate: policeDate.date,
            dueDate: policeReportDueDate(policeDate.date),
        };
    }
    if (documentType === DOCUMENT_TYPES.POLICE_REPORT) {
        return { event: POLICE_WORKFLOW_EVENT.REPORT_RECEIVED };
    }
    return null;
}
