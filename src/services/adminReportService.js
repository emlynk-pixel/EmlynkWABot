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
import { REVIEW_DOCUMENT_WHERE, REVIEW_PENDING_WHERE } from "./adminReviewService.js";
import { REVIEW_ACTION } from "./adminReviewActionService.js";
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

// ---------------------------------------------------------------- monthly overview

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Written by candidateService.uploadCandidateDocument, one entry per upload.
const ADMIN_UPLOAD_ACTION = "UPLOAD_DOCUMENT";

// GET /api/admin/reports/monthly?month=YYYY-MM (default: this month in Sri Lanka).
// Returns { params } or { errors }.
export function parseMonthlyOverviewQuery(query = {}, { now = new Date() } = {}) {
    const thisMonth = businessDateOf(now).slice(0, 7);
    const value = query.month;
    if (value === undefined || value === "") return { params: { month: thisMonth } };
    if (typeof value !== "string") return { errors: [{ field: "month", message: "must be given once" }] };
    if (!MONTH_PATTERN.test(value)) return { errors: [{ field: "month", message: "must be a month as YYYY-MM" }] };
    if (value < EARLIEST_REPORT_DATE.slice(0, 7)) return { errors: [{ field: "month", message: `must not be before ${EARLIEST_REPORT_DATE.slice(0, 7)}` }] };
    if (value > thisMonth) return { errors: [{ field: "month", message: "must not be in the future" }] };
    return { params: { month: value } };
}

// UTC instants where business month "YYYY-MM" starts and the next one starts.
export function businessMonthRange(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    const next = monthNumber === 12 ? `${year + 1}-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
    return { start: businessDayRange(`${month}-01`).start, end: businessDayRange(`${next}-01`).start };
}

// Counts for one business month, by the date each thing happened in Sri
// Lanka: candidates by registration, submissions by when they were received,
// admin uploads and removals by when the admin did them. Same status
// definitions as the Daily Report and the Overview, so the figures agree.
// Only counts; no candidate or document details.
export async function getMonthlyOverview({ db, month, now = new Date() }) {
    const thisMonth = businessDateOf(now).slice(0, 7);
    const { start, end } = businessMonthRange(month);
    const inMonth = { gte: start, lt: end };

    const [candidatesRegistered, statusGroups, adminUploads, waitingFiles, reviewRequiredDocuments, rejected] = await Promise.all([
        db.user.count({ where: { createdDate: inMonth } }),
        db.temporaryData.groupBy({ by: ["processingStatus"], where: { createdDate: inMonth }, _count: { _all: true } }),
        db.auditLog.count({ where: { action: ADMIN_UPLOAD_ACTION, createdDate: inMonth } }),
        db.temporaryData.count({ where: { AND: [{ createdDate: inMonth }, REVIEW_PENDING_WHERE] } }),
        db.document.count({ where: { AND: [{ receivedDate: inMonth }, REVIEW_DOCUMENT_WHERE] } }),
        db.auditLog.count({ where: { action: REVIEW_ACTION.REMOVE_FROM_REVIEW, createdDate: inMonth } }),
    ]);

    let whatsappSubmissions = 0;
    let whatsappProcessed = 0;
    let pending = 0;
    for (const group of statusGroups) {
        const count = group._count._all;
        whatsappSubmissions += count;
        if (isSuccessfullyProcessed(group.processingStatus)) whatsappProcessed += count;
        if (submissionOutcome(group.processingStatus) === SUBMISSION_OUTCOME.PROCESSING) pending += count;
    }

    return {
        month,
        thisMonth,
        isCurrentMonth: month === thisMonth,
        timeZone: "Asia/Colombo",
        range: { start: start.toISOString(), end: end.toISOString() },
        candidatesRegistered,
        // A WhatsApp file is one temporary_data row (its stored document is
        // not counted again); an admin upload has no temporary_data row.
        documentsSubmitted: whatsappSubmissions + adminUploads,
        // Daily Report rule for WhatsApp files; an admin upload is stored
        // VERIFIED at once.
        successfullyProcessed: whatsappProcessed + adminUploads,
        // Received, processing not finished (or interrupted).
        pending,
        // Removed by an admin from the review queue (REMOVE_FROM_REVIEW).
        rejected,
        // Overview's "Pending review" rule, for files received this month:
        // waiting in pending/ + stored as REVIEW_REQUIRED.
        manualReview: waitingFiles + reviewRequiredDocuments,
        sources: { whatsappSubmissions, adminUploads },
    };
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
