// The Overview tab (GET /api/admin/overview): role-scoped work counts, read-only.
//
// Which candidates the figures are about (the base set B) is decided here from
// the signed-in user (req.user, loaded from the database on every request),
// never from the client:
//   system  ADMIN / OWNER: every candidate (the `view` parameter is ignored)
//   full    TEAM_LEAD with view=full: every candidate allocated to anyone
//   mine    TEAM_LEAD (the default) and ANALYST (always): the candidates
//           allocated to the user (candidate_allocation.analyst_id); a user
//           without an adminId has none, so every figure is 0
// This is the Overview's own scope, not candidateAccess.candidateScope (which
// leaves a TEAM_LEAD unrestricted).
//
// Only counts: one count query per figure, run together, never a candidate list.

import { ROLES, hasRole } from "../middleware/requireRole.js";
import { businessDateOf, businessDayRange } from "../utils/businessDay.js";
import { andWhere } from "./candidateAccess.js";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";
import { notCompletedPlacementWhere } from "./candidateWorkflowStatus.js";

export const OVERVIEW_VIEW = Object.freeze({ MINE: "mine", FULL: "full", SYSTEM: "system" });
const REQUESTABLE_VIEWS = Object.freeze([OVERVIEW_VIEW.MINE, OVERVIEW_VIEW.FULL]);

// The Police Report variants a candidate needs (candidateService.automaticStageMissing).
export const REQUIRED_POLICE_REPORT_VARIANTS = Object.freeze(["ROMANIA", "SL_VERIFIED"]);

// Stages completed by an admin (the other two, CANDIDATE_DETAILS and DOCUMENT_SUBMISSION, are
// derived from the record and never count as someone's action).
const MANUAL_STAGES = Object.freeze(["TEST_DETAILS", "JOB_DETAILS", "VISA_SUBMISSION", "VISA_APPROVAL"]);

// Matches no candidate: a passport ID is never empty.
const NO_CANDIDATE = Object.freeze({ passportId: { in: [] } });

// GET /api/admin/overview?view=mine|full. Absent: the role's default. Returns { params } or { errors }.
export function parseOverviewQuery(query = {}) {
    const value = query.view;
    if (value === undefined || value === "") return { params: { view: null } };
    if (typeof value !== "string") return { errors: [{ field: "view", message: "must be given once" }] };
    if (!REQUESTABLE_VIEWS.includes(value)) return { errors: [{ field: "view", message: `must be one of: ${REQUESTABLE_VIEWS.join(", ")}` }] };
    return { params: { view: value } };
}

// The view served to `user` for the requested one: { view, canChooseView }, or { forbidden: true }
// when an Analyst asks for the full view (never another user's figures).
export function resolveOverviewView(user, requested = null) {
    if (hasRole(user?.role, [ROLES.ADMIN])) return { view: OVERVIEW_VIEW.SYSTEM, canChooseView: false };
    if (user?.role === ROLES.TEAM_LEAD) return { view: requested === OVERVIEW_VIEW.FULL ? OVERVIEW_VIEW.FULL : OVERVIEW_VIEW.MINE, canChooseView: true };
    if (user?.role === ROLES.ANALYST) {
        if (requested === OVERVIEW_VIEW.FULL) return { forbidden: true };
        return { view: OVERVIEW_VIEW.MINE, canChooseView: false };
    }
    return { forbidden: true };
}

// The base set B as a Prisma `where` on public.candidate ({} = every candidate).
export function overviewBaseWhere(view, adminId) {
    if (view === OVERVIEW_VIEW.SYSTEM) return {};
    if (view === OVERVIEW_VIEW.FULL) return { allocation: { isNot: null } };
    return adminId ? { allocation: { is: { analystId: adminId } } } : NO_CANDIDATE;
}

const onRecord = { verificationStatus: { not: VERIFICATION_STATUS.SUPERSEDED } };
// The current job: an active assignment (job_candidate.is_active, i.e. on a PROCESSING job), as the
// workflow Status and the candidate filters read it.
const HAS_CURRENT_JOB = Object.freeze({ jobAssignments: { some: { isActive: true } } });
const HAS_ALLOCATION = Object.freeze({ allocation: { isNot: null } });
// A text column automaticStageMissing reads as blank (it trims; stored values are saved trimmed, so
// NULL or "" is the database form). firstName is NOT NULL, so only "".
const blank = (field) => ({ OR: [{ [field]: null }, { [field]: "" }] });

// candidateService.automaticStageMissing's CANDIDATE_DETAILS rule as a `where` (that rule runs in
// memory on a loaded candidate; no database form of it existed): the stage is incomplete when any
// required detail or an on-record passport is missing. The job type list is blank when job is NULL
// or "" (a value of only commas is not told apart here).
export function candidateDetailsIncompleteWhere() {
    return {
        OR: [
            blank("otherName"),
            { firstName: "" },
            blank("nic"),
            { passportIssueDate: null },
            { passportExpiryDate: null },
            blank("job"),
            blank("jobExperience"),
            blank("whatsappNumber"),
            { documents: { none: { documentType: "PASSPORT", ...onRecord } } },
        ],
    };
}

// No manual work recorded yet: no call, no Additional Details, no verification, and no admin-entered
// value on a manually completed stage (completion, a note, test details or the job details date).
export function noManualActionWhere() {
    return {
        callLogs: { none: {} },
        additionalDetails: { is: null },
        verification: { is: null },
        stages: {
            none: {
                stage: { in: [...MANUAL_STAGES] },
                OR: [
                    { completed: true },
                    { notes: { not: null } },
                    { testAgentName: { not: null } },
                    { testId: { not: null } },
                    { testResult: { not: null } },
                    { testDate: { not: null } },
                    { jobDetailsDate: { not: null } },
                ],
            },
        },
    };
}

const emptyOverview = () => ({
    activeAllocated: 0,
    jobAllocated: 0,
    policeReportsYetToReceive: { total: 0, byVariant: Object.fromEntries(REQUIRED_POLICE_REPORT_VARIANTS.map((v) => [v, 0])) },
    agreementsYetToReceive: 0,
    detailsNotCompleted: 0,
    newlyAllocated: 0,
    visaSubmissionCompleted: 0,
});

// view: from resolveOverviewView; adminId: req.user.adminId (the "mine" view and its calls).
export async function getOverview({ db, view, canChooseView = false, adminId = null, now = new Date() }) {
    const businessDate = businessDateOf(now);
    const header = { businessDate, view, canChooseView };
    if (view === OVERVIEW_VIEW.MINE && !adminId) {
        return { ...header, overview: emptyOverview(), daily: { formSubmissions: 0, newlyAllocated: 0, callsTaken: 0 } };
    }

    const { start, end } = businessDayRange(businessDate);
    const today = { gte: start, lt: end };
    const base = overviewBaseWhere(view, adminId);
    // Active: not a completed placement (Departed, Cancelled, Rejected).
    const active = andWhere(base, notCompletedPlacementWhere());
    const count = (...parts) => db.candidate.count({ where: andWhere(...parts) });

    const [
        activeAllocated, jobAllocated, policeCounts, agreementsYetToReceive, detailsNotCompleted, newlyAllocated,
        visaSubmissionCompleted, formSubmissions, allocatedToday, callsTaken,
    ] = await Promise.all([
        count(active, HAS_ALLOCATION),
        count(base, HAS_CURRENT_JOB),
        // Per required variant: without an on-record Police Report of that variant.
        Promise.all(REQUIRED_POLICE_REPORT_VARIANTS.map((variant) => count(active, { documents: { none: { documentType: "POLICE_REPORT", documentVariant: variant, ...onRecord } } }))),
        // The Agreement is in the SCAN document, which can only be uploaded once the candidate has a
        // Job: only job-allocated candidates are waiting for one.
        count(active, HAS_CURRENT_JOB, { documents: { none: { documentType: "SCAN", ...onRecord } } }),
        count(active, { OR: [candidateDetailsIncompleteWhere(), { additionalDetails: { is: null } }] }),
        count(active, HAS_ALLOCATION, noManualActionWhere()),
        // Completed placements included.
        count(base, { stages: { some: { stage: "VISA_SUBMISSION", completed: true } } }),
        count(base, { formResponse: { is: { submittedAt: today } } }),
        count(base, { allocation: { is: { assignedDate: today } } }),
        // Calls are the staff member's own work in the mine view; every call otherwise.
        db.candidateCallLog.count({ where: view === OVERVIEW_VIEW.MINE ? { adminId, createdDate: today } : { createdDate: today } }),
    ]);

    return {
        ...header,
        overview: {
            activeAllocated,
            jobAllocated,
            policeReportsYetToReceive: {
                total: policeCounts.reduce((sum, n) => sum + n, 0),
                byVariant: Object.fromEntries(REQUIRED_POLICE_REPORT_VARIANTS.map((variant, i) => [variant, policeCounts[i]])),
            },
            agreementsYetToReceive,
            detailsNotCompleted,
            newlyAllocated,
            visaSubmissionCompleted,
        },
        daily: { formSubmissions, newlyAllocated: allocatedToday, callsTaken },
    };
}
