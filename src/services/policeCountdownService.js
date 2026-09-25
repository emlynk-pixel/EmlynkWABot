// Police Workflow countdown (Phase 10, Checkpoint 5; minimal Phase 9 data).
// Proposal §20-21, §23: the status is calculated from the stored documents
// every time; nothing about it is saved and there are no reminders here.
//
//   due date   = police slip submitted date + 21 days
//   days left  = due date - today, in Sri Lanka calendar days
//
// Status, checked in this order:
//   COMPLETED     the client has a VERIFIED police report (whenever it came,
//                 even before the slip); the countdown stops
//   PENDING       more than 7 days left
//   DUE_SOON      1-7 days left
//   DUE_TODAY     0 days left
//   OVERDUE       the due date has passed
//   DATE_MISSING  a slip exists (stored, or waiting in pending/) but no
//                 submitted date is known yet
//   NOT_UPLOADED  no police slip at all

import { businessDateOf, isValidBusinessDate } from "../utils/businessDay.js";
import { POLICE_REPORT_DUE_DAYS, policeReportDueDate } from "./policeWorkflowService.js";

export const POLICE_STATUS = Object.freeze({
    COMPLETED: "COMPLETED",
    PENDING: "PENDING",
    DUE_SOON: "DUE_SOON",
    DUE_TODAY: "DUE_TODAY",
    OVERDUE: "OVERDUE",
    DATE_MISSING: "DATE_MISSING",
    NOT_UPLOADED: "NOT_UPLOADED",
});

// "Due soon" is 1 to this many days left.
export const DUE_SOON_DAYS = 7;

// Most urgent first; used to sort the Police Workflow list.
export const POLICE_STATUS_ORDER = Object.freeze([
    POLICE_STATUS.OVERDUE,
    POLICE_STATUS.DUE_TODAY,
    POLICE_STATUS.DUE_SOON,
    POLICE_STATUS.PENDING,
    POLICE_STATUS.DATE_MISSING,
    POLICE_STATUS.NOT_UPLOADED,
    POLICE_STATUS.COMPLETED,
]);

const VERIFIED = "VERIFIED";
const DAY_MS = 86_400_000;

// A DATE column comes back from Prisma as a Date at UTC midnight.
export function toYmd(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    return isValidBusinessDate(value) ? value : null;
}

// For writing a DATE column: "YYYY-MM-DD" -> Date at UTC midnight.
export function ymdToDate(ymd) {
    return new Date(`${ymd}T00:00:00.000Z`);
}

// Whole calendar days from `fromYmd` to `toYmd` (negative when earlier).
export function daysBetween(fromYmd, toYmdValue) {
    return Math.round((Date.parse(`${toYmdValue}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY_MS);
}

export function statusForDaysLeft(daysLeft) {
    if (daysLeft < 0) return POLICE_STATUS.OVERDUE;
    if (daysLeft === 0) return POLICE_STATUS.DUE_TODAY;
    if (daysLeft <= DUE_SOON_DAYS) return POLICE_STATUS.DUE_SOON;
    return POLICE_STATUS.PENDING;
}

const newestFirst = (a, b) => (toIso(b.receivedDate) > toIso(a.receivedDate) ? 1 : toIso(b.receivedDate) < toIso(a.receivedDate) ? -1 : 0);
const toIso = (value) => (value instanceof Date ? value.toISOString() : value ?? "");

// One client's police status.
//   slips:   stored POLICE_SLIP documents ({ documentId, verificationStatus,
//            policeSubmittedDate, receivedDate }) - VERIFIED or REVIEW_REQUIRED
//   reports: stored POLICE_REPORT documents ({ documentId, verificationStatus, receivedDate })
//   pendingSlips: police slips of this client waiting in pending/
//   today:   "YYYY-MM-DD" in Sri Lanka (defaults to now)
export function policeCountdown({ slips = [], reports = [], pendingSlips = 0, today = businessDateOf() } = {}) {
    // The slip whose countdown counts: the latest submitted date among the
    // stored slips that have one (a REVIEW_REQUIRED slip with a readable
    // date counts too).
    const dated = slips
        .map((slip) => ({ ...slip, submitted: toYmd(slip.policeSubmittedDate) }))
        .filter((slip) => slip.submitted)
        .sort((a, b) => (a.submitted === b.submitted ? newestFirst(a, b) : a.submitted < b.submitted ? 1 : -1));
    const slip = dated[0] ?? null;
    const latestSlip = slip ?? [...slips].sort(newestFirst)[0] ?? null;
    const finalReport = reports.filter((report) => report.verificationStatus === VERIFIED).sort(newestFirst)[0] ?? null;

    const submittedDate = slip?.submitted ?? null;
    const dueDate = submittedDate ? policeReportDueDate(submittedDate) : null;
    const daysRemaining = dueDate ? daysBetween(today, dueDate) : null;

    let status;
    if (finalReport) status = POLICE_STATUS.COMPLETED;
    else if (dueDate) status = statusForDaysLeft(daysRemaining);
    else if (slips.length || pendingSlips > 0) status = POLICE_STATUS.DATE_MISSING;
    else status = POLICE_STATUS.NOT_UPLOADED;

    return {
        status,
        submittedDate,
        dueDate,
        // Only while the countdown runs; a completed workflow has none.
        daysRemaining: status === POLICE_STATUS.COMPLETED ? null : daysRemaining,
        slip: latestSlip ? { documentId: latestSlip.documentId, verificationStatus: latestSlip.verificationStatus, receivedDate: toIso(latestSlip.receivedDate) || null } : null,
        report: finalReport ? { documentId: finalReport.documentId, receivedDate: toIso(finalReport.receivedDate) || null } : null,
        // No stored slip yet, but one is waiting for review in pending/.
        slipAwaitingReview: slips.length === 0 && pendingSlips > 0,
    };
}

export { POLICE_REPORT_DUE_DAYS };
