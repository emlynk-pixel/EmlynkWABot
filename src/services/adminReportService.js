// Daily report (proposal §22 "Daily Summary", §27 GET /reports/daily, §35).
// Read-only; calculated from the core tables every time (no report table).
//
// Two kinds of figures, never mixed:
// - daily:   what happened on the selected business day in Sri Lanka
//            (00:00-24:00 Asia/Colombo), from the submissions received that
//            day (temporary_data.created_date) and the admin actions taken
//            that day (audit_logs.created_date);
// - current: the state right now (client completeness, police reports due).
//            There is no history of these, so a past date shows today's
//            state, labelled as such; they are never presented as that day's.

import { businessDateOf, businessDayRange, isValidBusinessDate } from "../utils/businessDay.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { REVIEW_PENDING_WHERE } from "./adminReviewService.js";
import { clientCompletenessCounts } from "./adminClientService.js";
import { policeDueCounts } from "./adminPoliceService.js";
import { SUBMISSION_OUTCOME, UNCLEAR_STATUSES, isSuccessfullyProcessed, submissionOutcome } from "./statusMapping.js";

export const EARLIEST_REPORT_DATE = "2000-01-01";

// GET /api/admin/reports/daily?date=YYYY-MM-DD (default: today in Sri Lanka).
// A real calendar date from 2000-01-01 up to today. Returns { params } or { errors }.
export function parseDailyReportQuery(query = {}, { now = new Date() } = {}) {
    const today = businessDateOf(now);
    const value = query.date;
    if (value === undefined || value === "") return { params: { date: today } };
    if (typeof value !== "string") return { errors: [{ field: "date", message: "must be given once" }] };
    if (!isValidBusinessDate(value)) return { errors: [{ field: "date", message: "must be a real date as YYYY-MM-DD" }] };
    if (value < EARLIEST_REPORT_DATE) return { errors: [{ field: "date", message: `must not be before ${EARLIEST_REPORT_DATE}` }] };
    if (value > today) return { errors: [{ field: "date", message: "must not be in the future" }] };
    return { params: { date: value } };
}

const REPORTED_TYPES = [DOCUMENT_TYPES.PASSPORT, DOCUMENT_TYPES.POLICE_SLIP, DOCUMENT_TYPES.POLICE_REPORT, DOCUMENT_TYPES.MEDICAL, DOCUMENT_TYPES.UNKNOWN];

export async function getDailyReport({ db, date, now = new Date() }) {
    const today = businessDateOf(now);
    const { start, end } = businessDayRange(date);
    const receivedThatDay = { createdDate: { gte: start, lt: end } };

    const [statusGroups, typeGroups, stillWaiting, actionGroups, clients, police] = await Promise.all([
        db.temporaryData.groupBy({ by: ["processingStatus"], where: receivedThatDay, _count: { _all: true } }),
        db.temporaryData.groupBy({ by: ["documentType"], where: receivedThatDay, _count: { _all: true } }),
        db.temporaryData.count({ where: { AND: [receivedThatDay, REVIEW_PENDING_WHERE] } }),
        db.auditLog.groupBy({ by: ["action"], where: { createdDate: { gte: start, lt: end } }, _count: { _all: true } }),
        clientCompletenessCounts({ db }),
        policeDueCounts({ db, today }),
    ]);

    const byStatus = Object.fromEntries(statusGroups.map((g) => [g.processingStatus, g._count._all]));
    const byOutcome = Object.fromEntries(Object.values(SUBMISSION_OUTCOME).map((outcome) => [outcome, 0]));
    let totalReceived = 0;
    let successfullyProcessed = 0;
    let unclear = 0;
    for (const [status, count] of Object.entries(byStatus)) {
        totalReceived += count;
        byOutcome[submissionOutcome(status)] += count;
        if (isSuccessfullyProcessed(status)) successfullyProcessed += count;
        if (UNCLEAR_STATUSES.includes(status)) unclear += count;
    }
    const byType = Object.fromEntries(REPORTED_TYPES.map((type) => [type, 0]));
    for (const group of typeGroups) byType[group.documentType] = (byType[group.documentType] ?? 0) + group._count._all;

    return {
        businessDate: date,
        today,
        isToday: date === today,
        timeZone: "Asia/Colombo",
        range: { start: start.toISOString(), end: end.toISOString() },
        daily: {
            totalReceived,
            successfullyProcessed,
            failed: byOutcome[SUBMISSION_OUTCOME.FAILED],
            // Received that day, processing not finished (or interrupted).
            stillProcessing: byOutcome[SUBMISSION_OUTCOME.PROCESSING],
            storedInClientFolder: byOutcome[SUBMISSION_OUTCOME.STORED],
            heldForReview: byOutcome[SUBMISSION_OUTCOME.NEEDS_REVIEW],
            duplicates: byOutcome[SUBMISSION_OUTCOME.DUPLICATE],
            unclear,
            // Received that day and still waiting in pending/ (not yet in a client folder).
            temporary: stillWaiting,
            byType,
            byStatus,
            // Admin actions taken that day (audit log).
            adminActions: Object.fromEntries(actionGroups.map((g) => [g.action, g._count._all])),
        },
        current: {
            asOf: now.toISOString(),
            clients,
            police,
        },
    };
}
