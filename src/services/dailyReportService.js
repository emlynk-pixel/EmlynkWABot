// Daily Report: Summary and Summary by Roles (Admin > Daily Report).
// Read-only; calculated from the core tables on each request (no report
// table). Business day = 00:00-24:00 Asia/Colombo (businessDayRange), never
// the server's or UTC's day.
//
// Two kinds of figures, never mixed:
// - daily (history): what happened on the selected day, from timestamps that
//   are stored when it happens:
//     calls taken          candidate_call_logs.created_date (the call time)
//     documents submitted  WhatsApp: temporary_data.created_date (every file
//                          received); manual: UPLOAD_DOCUMENT audit entries
//                          (the staff upload, with its uploader)
//     visa completed       candidate_stages.completed_at of VISA_APPROVAL
//     candidates completed candidate_stages.completed_at of FINALIZING_JOB,
//                          the final stage (a candidate's own completion has
//                          no timestamp: two stages complete automatically
//                          from data), with whether every stage is complete now
// - current (snapshot): incomplete candidates by stage and reason, police
//   report status. No history of them is kept, so a past date shows today's
//   state, labelled as such.
//
// Roles: a call or a manual upload is attributed to the staff member who
// made it (admin_id). WhatsApp files have no staff member and are never
// attributed to a role. A staff member's role is their CURRENT role (role
// history is not stored).

import { businessDayRange } from "../utils/businessDay.js";
import { clientName } from "../utils/clientName.js";
import { ALL_ROLES } from "../middleware/requireRole.js";
import { getDailyReport } from "./adminReportService.js";
import { DOCUMENT_TYPES } from "./documentClassificationService.js";
import { CANDIDATE_DOCUMENT_TYPES, CANDIDATE_STAGES, REQUIRED_SUBMISSION_DOCUMENTS, automaticStageMissing, stageList } from "./candidateService.js";

// Written by candidateService.storeCandidateDocument, one per staff upload.
const UPLOAD_ACTION = "UPLOAD_DOCUMENT";
// Detailed lists are bounded; totals are always exact.
export const DAILY_LIST_LIMIT = 200;
export const INCOMPLETE_PAGE_SIZE = 25;
const MAX_ROLE_ROWS = 1000;

// Candidate fields a row shows and automaticStageMissing reads.
const CANDIDATE_FIELDS = {
    passportId: true, uniqueId: true, firstName: true, otherName: true, nic: true, job: true, jobExperience: true,
    whatsappNumber: true, passportIssueDate: true, passportExpiryDate: true,
};
// Stages and required documents, as the candidate page's stage rules read them.
const PROGRESS_FIELDS = {
    stages: { select: { stage: true, completed: true, testResult: true } },
    documents: { where: { documentType: { in: REQUIRED_SUBMISSION_DOCUMENTS } }, select: { documentType: true, verificationStatus: true, documentVariant: true } },
};

// Document types in the report: the candidate document types (ONE SCAN),
// then WhatsApp's unclassified files (shown only when there are any).
const REPORT_TYPES = [...Object.keys(CANDIDATE_DOCUMENT_TYPES), DOCUMENT_TYPES.UNKNOWN];

// ------------------------------------------------------------------ queries

export function parseRoleQuery(query = {}) {
    const value = query.role;
    if (typeof value !== "string" || !ALL_ROLES.includes(value)) {
        return { errors: [{ field: "role", message: `must be one of ${ALL_ROLES.join(", ")}` }] };
    }
    return { params: { role: value } };
}

export function parseIncompleteQuery(query = {}) {
    const errors = [];
    const stage = query.stage;
    if (typeof stage !== "string" || !CANDIDATE_STAGES.includes(stage)) errors.push({ field: "stage", message: "must be a candidate stage" });
    let page = 1;
    if (query.page !== undefined && query.page !== "") {
        if (typeof query.page !== "string" || !/^\d{1,5}$/.test(query.page) || Number(query.page) < 1) errors.push({ field: "page", message: "must be a whole number from 1" });
        else page = Number(query.page);
    }
    return errors.length ? { errors } : { params: { stage, page } };
}

// ------------------------------------------------------------------ incomplete reasons

// automaticStageMissing's items, as reasons.
const MISSING_LABELS = {
    surname: "Surname missing",
    "other names": "Other names missing",
    NIC: "NIC missing",
    "passport issue date": "Passport issue date missing",
    "passport expiry date": "Passport expiry date missing",
    "job type": "Job type missing",
    "job experience": "Job experience missing",
    "WhatsApp number": "WhatsApp number missing",
    "passport document": "Passport document missing",
    medical: "Medical missing",
    "sl verified police report": "SL Verified police report missing",
    "romania police report": "Romania police report missing",
    scans: "Scan missing",
};

// Why a stage is not complete, from the candidate's real data. Stages are
// independent: an incomplete stage is never inferred from another one.
function stageReasons(entry, row) {
    if (entry.automatic) return entry.missing.map((item) => MISSING_LABELS[item] ?? `${item} missing`);
    if (entry.stage === "TEST_DETAILS") {
        if (row?.testResult === "FAIL") return ["Test failed"];
        if (!row?.testResult) return ["No test result recorded"];
    }
    return ["Not marked complete"];
}

// Every incomplete stage of a candidate: [{ stage, reasons }].
function incompleteStages(candidate) {
    const rows = new Map(candidate.stages.map((s) => [s.stage, s]));
    return stageList(candidate.stages, automaticStageMissing(candidate, candidate.documents))
        .filter((entry) => !entry.completed)
        .map((entry) => ({ stage: entry.stage, reasons: stageReasons(entry, rows.get(entry.stage)) }));
}

const allStagesComplete = (candidate) => incompleteStages(candidate).length === 0;

// Current snapshot of every candidate: one query with their stages and
// required documents, evaluated with the candidate page's stage rules.
async function readProgress(db) {
    return db.candidate.findMany({
        select: { ...CANDIDATE_FIELDS, createdDate: true, ...PROGRESS_FIELDS },
        orderBy: [{ createdDate: "desc" }, { passportId: "asc" }],
    });
}

function incompleteSummary(candidates, now) {
    const byStage = new Map(CANDIDATE_STAGES.map((stage) => [stage, { stage, count: 0, reasons: new Map() }]));
    let incompleteCandidates = 0;
    for (const candidate of candidates) {
        const stages = incompleteStages(candidate);
        if (stages.length) incompleteCandidates += 1;
        for (const { stage, reasons } of stages) {
            const bucket = byStage.get(stage);
            bucket.count += 1;
            for (const reason of reasons) bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
        }
    }
    return {
        asOf: now.toISOString(),
        totalCandidates: candidates.length,
        incompleteCandidates,
        completeCandidates: candidates.length - incompleteCandidates,
        byStage: [...byStage.values()].map(({ stage, count, reasons }) => ({
            stage,
            count,
            reasons: [...reasons].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
        })),
    };
}

// GET /api/admin/reports/daily/incomplete?stage=&page= : the candidates whose
// stage is incomplete now, with the reasons (current snapshot), paged.
export async function getIncompleteCandidates({ db, stage, page, pageSize = INCOMPLETE_PAGE_SIZE, now = new Date() }) {
    const candidates = await readProgress(db);
    const rows = [];
    for (const candidate of candidates) {
        const found = incompleteStages(candidate).find((s) => s.stage === stage);
        if (found) rows.push({ passportId: candidate.passportId, name: clientName(candidate), reasons: found.reasons });
    }
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    return {
        stage,
        asOf: now.toISOString(),
        items: rows.slice((page - 1) * pageSize, page * pageSize),
        pagination: { page, pageSize, total: rows.length, totalPages },
    };
}

// ------------------------------------------------------------------ summary

const callView = (row) => ({
    callLogId: row.callLogId,
    calledAt: row.createdDate,
    passportId: row.passportId,
    candidateName: row.user ? clientName(row.user) : null,
    handledBy: row.admin?.name ?? null,
    role: row.admin?.role ?? null,
});

// GET /api/admin/reports/daily/summary?date=YYYY-MM-DD
export async function getDailySummary({ db, date, now = new Date() }) {
    const { start, end } = businessDayRange(date);
    const inDay = { gte: start, lt: end };
    const finalWhere = { stage: "FINALIZING_JOB", completed: true, completedAt: inDay };

    const [base, calls, callTotal, uploadGroups, finalized, finalizedTotal, visaCompleted, candidates] = await Promise.all([
        // WhatsApp files received that day, their processing outcomes and
        // types; admin actions; police status (current).
        getDailyReport({ db, date, now }),
        db.candidateCallLog.findMany({
            where: { createdDate: inDay },
            select: { callLogId: true, createdDate: true, passportId: true, admin: { select: { name: true, role: true } }, user: { select: { firstName: true, otherName: true } } },
            orderBy: [{ createdDate: "desc" }, { callLogId: "asc" }],
            take: DAILY_LIST_LIMIT,
        }),
        db.candidateCallLog.count({ where: { createdDate: inDay } }),
        db.auditLog.groupBy({ by: ["documentType"], where: { action: UPLOAD_ACTION, createdDate: inDay }, _count: { _all: true } }),
        db.candidateStage.findMany({
            where: finalWhere,
            select: { completedAt: true, user: { select: { ...CANDIDATE_FIELDS, ...PROGRESS_FIELDS } } },
            orderBy: [{ completedAt: "desc" }, { passportId: "asc" }],
            take: DAILY_LIST_LIMIT,
        }),
        db.candidateStage.count({ where: finalWhere }),
        db.candidateStage.count({ where: { stage: "VISA_APPROVAL", completed: true, completedAt: inDay } }),
        readProgress(db),
    ]);

    // Documents: WhatsApp files received + staff uploads, by type.
    const whatsappByType = base.daily.byType;
    const manualByType = Object.fromEntries(uploadGroups.map((g) => [g.documentType ?? DOCUMENT_TYPES.UNKNOWN, g._count._all]));
    const types = [...REPORT_TYPES, ...new Set([...Object.keys(whatsappByType), ...Object.keys(manualByType)].filter((t) => !REPORT_TYPES.includes(t)))];
    const byType = types
        .map((type) => {
            const whatsapp = whatsappByType[type] ?? 0;
            const manual = manualByType[type] ?? 0;
            return { type, total: whatsapp + manual, whatsapp, manual };
        })
        // Unclassified (or any type outside the candidate types) only when present.
        .filter((row) => row.total > 0 || Object.keys(CANDIDATE_DOCUMENT_TYPES).includes(row.type));
    const manual = Object.values(manualByType).reduce((sum, n) => sum + n, 0);
    const whatsapp = base.daily.totalReceived;

    return {
        businessDate: base.businessDate,
        today: base.today,
        isToday: base.isToday,
        timeZone: base.timeZone,
        range: base.range,
        summary: {
            candidatesCompleted: finalizedTotal,
            visaCompleted,
            callsTaken: callTotal,
            documentsSubmitted: whatsapp + manual,
        },
        documents: { total: whatsapp + manual, whatsapp, manual, byType },
        // How the WhatsApp files received that day were processed (as before).
        whatsappProcessing: {
            received: base.daily.totalReceived,
            successfullyProcessed: base.daily.successfullyProcessed,
            storedInCandidateFolder: base.daily.storedInClientFolder,
            heldForReview: base.daily.heldForReview,
            duplicates: base.daily.duplicates,
            failed: base.daily.failed,
            stillProcessing: base.daily.stillProcessing,
            unclear: base.daily.unclear,
            temporary: base.daily.temporary,
        },
        adminActions: base.daily.adminActions,
        calls: { total: callTotal, items: calls.map(callView), truncated: callTotal > calls.length },
        completedCandidates: {
            total: finalizedTotal,
            items: finalized.map((row) => ({
                passportId: row.user.passportId,
                name: clientName(row.user),
                completedAt: row.completedAt,
                allStagesComplete: allStagesComplete(row.user),
            })),
            truncated: finalizedTotal > finalized.length,
        },
        current: {
            asOf: now.toISOString(),
            incomplete: incompleteSummary(candidates, now),
            police: base.current.police,
        },
    };
}

// ------------------------------------------------------------------ summary by roles

// GET /api/admin/reports/daily/roles?date=YYYY-MM-DD&role=ROLE (ADMIN, MANAGER).
// Calls and staff document uploads that day by staff members whose current
// role is `role`. WhatsApp files are never attributed to staff.
export async function getDailyRoleSummary({ db, date, role }) {
    const { start, end } = businessDayRange(date);
    const inDay = { gte: start, lt: end };
    const staff = await db.user.findMany({ where: { role }, select: { adminId: true, name: true, status: true }, orderBy: [{ name: "asc" }, { adminId: "asc" }] });
    const ids = staff.map((s) => s.adminId);

    const [calls, uploads] = ids.length
        ? await Promise.all([
            db.candidateCallLog.findMany({
                where: { createdDate: inDay, adminId: { in: ids } },
                select: { callLogId: true, createdDate: true, passportId: true, adminId: true, user: { select: { firstName: true, otherName: true } } },
                orderBy: [{ createdDate: "desc" }, { callLogId: "asc" }],
                take: MAX_ROLE_ROWS,
            }),
            db.auditLog.findMany({
                where: { action: UPLOAD_ACTION, createdDate: inDay, adminId: { in: ids } },
                select: { auditId: true, createdDate: true, adminId: true, passportId: true, documentType: true, newValue: true },
                orderBy: [{ createdDate: "desc" }, { auditId: "asc" }],
                take: MAX_ROLE_ROWS,
            }),
        ])
        : [[], []];

    // Candidate names for the uploads, in one query.
    const uploadIds = [...new Set(uploads.map((u) => u.passportId).filter(Boolean))];
    const candidates = uploadIds.length
        ? await db.candidate.findMany({ where: { passportId: { in: uploadIds } }, select: { passportId: true, firstName: true, otherName: true } })
        : [];
    const nameOf = new Map(candidates.map((c) => [c.passportId, clientName(c)]));
    const staffName = new Map(staff.map((s) => [s.adminId, s.name]));

    const byType = Object.keys(CANDIDATE_DOCUMENT_TYPES).map((type) => ({ type, count: uploads.filter((u) => u.documentType === type).length }));
    const perStaff = staff
        .map((s) => ({
            adminId: s.adminId,
            name: s.name,
            status: s.status,
            calls: calls.filter((c) => c.adminId === s.adminId).length,
            documents: uploads.filter((u) => u.adminId === s.adminId).length,
        }))
        .sort((a, b) => (b.calls + b.documents) - (a.calls + a.documents) || a.name.localeCompare(b.name));

    const activity = [
        ...calls.map((c) => ({ kind: "CALL", at: c.createdDate, staff: staffName.get(c.adminId) ?? null, passportId: c.passportId, candidateName: c.user ? clientName(c.user) : null, documentType: null, variant: null })),
        ...uploads.map((u) => ({ kind: "DOCUMENT_UPLOAD", at: u.createdDate, staff: staffName.get(u.adminId) ?? null, passportId: u.passportId, candidateName: nameOf.get(u.passportId) ?? null, documentType: u.documentType ?? null, variant: u.newValue ?? null })),
    ].sort((a, b) => b.at - a.at);

    return {
        businessDate: date,
        timeZone: "Asia/Colombo",
        range: { start: start.toISOString(), end: end.toISOString() },
        role,
        staffCount: staff.length,
        callsTaken: calls.length,
        documentsUploaded: uploads.length,
        documentsByType: byType,
        staff: perStaff,
        activity: activity.slice(0, DAILY_LIST_LIMIT),
        activityTotal: activity.length,
        truncated: activity.length > DAILY_LIST_LIMIT || calls.length === MAX_ROLE_ROWS || uploads.length === MAX_ROLE_ROWS,
    };
}
