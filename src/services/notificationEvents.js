// The notifications: what each one says, who receives it and its dedupe key (one event = one row
// per recipient). Every function here is best-effort (notificationService.js notifyAll never
// throws) and is called AFTER the triggering action's transaction has committed, with the root
// database client. In-app only.
//
//   A1  New Candidates Allocated       the allocated Analyst, once per allocation action (a bulk
//                                      import: once per import, all its chunks together)
//   A4  Candidate Form Submitted       the Analyst the candidate is allocated to, once per submission
//   A5  Job Assigned                   the Analyst the candidate is allocated to, once per assignment
//   B2  Role Updated                   the Registration Desk user whose role was changed
//   C1  New Job Added                  Job Handlers, when unassigned eligible candidates exist
//   C2  Missing Country Information    Job Handlers, for a new Agent without a country
//   E1  Candidate Cancelled            Admins (and Owners), Team Leads; never the user who cancelled
//   E2  Candidate Moved to Need Attention   Admins (and Owners), Team Leads; never the user who flagged it
//   E9  Google Sheet Sync Failed       Admins and Team Leads (exact roles, never an Owner)
//   F1  Google Sheet Sync Error        Owners only (the same event as E9)
//   E10 Candidate Form Link Failed     Admins (and Owners), Team Leads; at most once an hour
//   F2  System Alert                   Owners only; the same issue at most once a business day
//
// The scheduled ones (A2, A3, B1, C3, D1-D4, E3-E8 and the daily F2 health check) are sent by
// notificationScanService.js; their types are listed here too.
//
// Text holds names only where the notification names someone (a candidate's, a user's or an
// Agent's name): never a passport number, NIC, phone number or other identifier. A candidate
// without a name is "a candidate" (A4, A5, E1, E2); which candidate it is travels as candidateId.

import { randomUUID } from "node:crypto";

import { ROLES } from "../middleware/requireRole.js";
import { businessDateOf } from "../utils/businessDay.js";
import { clientName } from "../utils/clientName.js";
import { AUDIENCE } from "./notificationRecipients.js";
import { notify, notifyAll } from "./notificationService.js";

export const NOTIFICATION_TYPE = Object.freeze({
    A1: "A1_NEW_CANDIDATES_ALLOCATED",
    A4: "A4_CANDIDATE_FORM_SUBMITTED",
    A5: "A5_JOB_ASSIGNED",
    B2: "B2_ROLE_UPDATED",
    C1: "C1_NEW_JOB_ADDED",
    C2: "C2_MISSING_COUNTRY_INFORMATION",
    E1: "E1_CANDIDATE_CANCELLED",
    E2: "E2_CANDIDATE_NEED_ATTENTION",
    E9: "E9_GOOGLE_SHEET_SYNC_FAILED",
    E10: "E10_CANDIDATE_FORM_LINK_FAILED",
    F1: "F1_GOOGLE_SHEET_SYNC_ERROR",
    F2: "F2_SYSTEM_ALERT",
    // Scheduled (notificationScanService.js, POST /api/tasks/notification-scan).
    A2: "A2_PENDING_FOLLOW_UPS",
    A3: "A3_PASSWORD_CHANGE_REMINDER",
    B1: "B1_MONTHLY_REGISTRATION_SUMMARY",
    C3: "C3_PASSWORD_CHANGE_REMINDER",
    D1: "D1_UNALLOCATED_CANDIDATES",
    D2: "D2_DAILY_REPORT_UPDATED",
    D3: "D3_NEW_VACANCIES_AVAILABLE",
    D4: "D4_PASSWORD_CHANGE_REMINDER",
    E3: "E3_NEW_CANDIDATES_ADDED",
    E4: "E4_MISSING_DOCUMENTS_OR_INFORMATION",
    E5: "E5_NEED_ATTENTION_FOLLOW_UPS_PENDING",
    E6: "E6_JOBS_STUCK_IN_PROCESSING",
    E7: "E7_DOCUMENTS_AWAITING_REVIEW",
    E8: "E8_STAFF_INACTIVITY",
});

export const ROLE_LABELS = Object.freeze({
    [ROLES.OWNER]: "Owner",
    [ROLES.ADMIN]: "Admin",
    [ROLES.TEAM_LEAD]: "Team Lead",
    [ROLES.ANALYST]: "Analyst",
    [ROLES.REGISTRATION_DESK]: "Registration Desk",
    [ROLES.JOB_HANDLER]: "Job Handler",
});

const hourBucket = (now) => now.toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

// ---------------------------------------------------------------- A1

export const allocationMessage = (count) => `You have received ${count} new candidate${count === 1 ? "" : "s"}.`;

// One allocation action (assign, auto-allocate, a whole bulk import): each Analyst once, with the
// number of candidates newly assigned or reassigned TO them in it. Only users who hold the ANALYST
// role now receive it (a Team Lead or another role receiving candidates does not).
// counts: [{ analystId, count, passportId? }] (the same analyst twice is added up). batchId: the
// action's id, so the same action is sent once per Analyst (a bulk import passes "import:<importId>").
// candidateId is set only when the Analyst received exactly one candidate whose passportId is known
// (a bulk import passes counts only: null).
export async function notifyCandidatesAllocated(db, { counts, batchId = randomUUID() }) {
    const totals = new Map();
    const candidates = new Map();
    for (const { analystId, count, passportId } of counts ?? []) {
        if (!analystId || !(count > 0)) continue;
        totals.set(analystId, (totals.get(analystId) ?? 0) + count);
        if (!candidates.has(analystId)) candidates.set(analystId, new Set());
        if (passportId) candidates.get(analystId).add(passportId);
    }
    if (!totals.size) return { created: 0 };
    return notifyAll(db, [...totals].map(([analystId, count]) => {
        const ids = candidates.get(analystId);
        return {
            type: NOTIFICATION_TYPE.A1, title: "New Candidates Allocated", message: allocationMessage(count),
            dedupeKey: `A1:${batchId}`, userIds: [analystId], requireRoles: [ROLES.ANALYST],
            candidateId: count === 1 && ids.size === 1 ? [...ids][0] : null,
        };
    }));
}

// ---------------------------------------------------------------- A4

// name: the candidate's name, or none ("A candidate").
export const formSubmittedMessage = (name) => `${name || "A candidate"} has submitted the candidate form.`;

// A candidate submitted the public Candidate Form: the Analyst the candidate is allocated to now
// (role exactly ANALYST, ACTIVE), nobody else. An unallocated candidate sends nothing. submittedAt:
// the submission's stored time, so a retried submit request is sent once.
export async function notifyCandidateFormSubmitted(db, { passportId, submittedAt }) {
    if (!passportId || !submittedAt || typeof db?.candidate?.findUnique !== "function") return { created: 0 };
    let candidate;
    try {
        candidate = await db.candidate.findUnique({ where: { passportId }, select: { firstName: true, otherName: true, allocation: { select: { analystId: true } } } });
    } catch {
        return { created: 0, failed: true };
    }
    const analystId = candidate?.allocation?.analystId;
    if (!analystId) return { created: 0 };
    // No name: "A candidate" (never the passport ID); the Analyst opens the candidate through candidateId.
    return notify(db, {
        type: NOTIFICATION_TYPE.A4, title: "Candidate Form Submitted", message: formSubmittedMessage(clientName(candidate)),
        dedupeKey: `A4:${passportId}:${new Date(submittedAt).toISOString()}`, userIds: [analystId], requireRoles: [ROLES.ANALYST],
        candidateId: passportId,
    });
}

// ---------------------------------------------------------------- A5

// name: the candidate's name, or none ("a candidate").
export const jobAssignedMessage = (jobCode, name) => `Job ${jobCode} has been assigned to ${name || "a candidate"}.`;

// A candidate newly put on a job (jobService.js assignCandidate: a new membership, or a released one
// reactivated; never an import): the Analyst the candidate is allocated to now (role exactly
// ANALYST, ACTIVE), nobody else. assignedAt: the membership's assigned_at, so each assignment is sent
// once and a later re-assignment (after a removal) again. Like A4, no name is "a candidate".
export async function notifyJobAssigned(db, { jobId, jobCode, passportId, assignedAt }) {
    if (!jobId || !jobCode || !passportId || !assignedAt || typeof db?.candidate?.findUnique !== "function") return { created: 0 };
    let candidate;
    try {
        candidate = await db.candidate.findUnique({ where: { passportId }, select: { firstName: true, otherName: true, allocation: { select: { analystId: true } } } });
    } catch {
        return { created: 0, failed: true };
    }
    const analystId = candidate?.allocation?.analystId;
    if (!analystId) return { created: 0 };
    return notify(db, {
        type: NOTIFICATION_TYPE.A5, title: "Job Assigned", message: jobAssignedMessage(jobCode, clientName(candidate)),
        dedupeKey: `A5:${jobId}:${passportId}:${new Date(assignedAt).toISOString()}`, userIds: [analystId], requireRoles: [ROLES.ANALYST],
        candidateId: passportId, jobId,
    });
}

// ---------------------------------------------------------------- B2

// A role change of an existing account. Sent to that user when the change involves the
// Registration Desk role (the user was, or now is, Registration Desk), and only when the role
// actually changed. eventId: the change's own id (its audit row), so it is sent once.
export function notifyRoleUpdated(db, { userId, previousRole, newRole, eventId = randomUUID() }) {
    if (!userId || !newRole || previousRole === newRole) return Promise.resolve({ created: 0 });
    if (previousRole !== ROLES.REGISTRATION_DESK && newRole !== ROLES.REGISTRATION_DESK) return Promise.resolve({ created: 0 });
    return notify(db, {
        type: NOTIFICATION_TYPE.B2, title: "Role Updated", message: `Your role has been changed to ${ROLE_LABELS[newRole] ?? newRole}.`,
        dedupeKey: `B2:${eventId}`, userIds: [userId],
    });
}

// ---------------------------------------------------------------- C1

// Candidates a job may take (jobService.js assignCandidate: the Test details result PASS) that are
// on no job at all (no active job_candidate row).
async function unassignedEligibleCandidatesExist(db) {
    if (typeof db?.$queryRaw !== "function") return false;
    const [row] = await db.$queryRaw`
        SELECT EXISTS (
            SELECT 1 FROM "candidate_stages" s
            WHERE s."stage" = 'TEST_DETAILS' AND s."test_result" = 'PASS'
              AND NOT EXISTS (SELECT 1 FROM "job_candidate" jc WHERE jc."passport_id" = s."passport_id" AND jc."is_active")
        ) AS "found"`;
    return row?.found === true;
}

// A new Job (a new Job ID: its job code, as the Jobs pages show it). Sent only when candidates who
// could be put on it are still on no job. jobs: [{ jobId, jobCode }].
export async function notifyNewJobs(db, jobs) {
    const list = (jobs ?? []).filter((job) => job?.jobId && job.jobCode);
    if (!list.length) return { created: 0 };
    try {
        if (!(await unassignedEligibleCandidatesExist(db))) return { created: 0 };
    } catch {
        return { created: 0 };
    }
    return notifyAll(db, list.map((job) => ({
        type: NOTIFICATION_TYPE.C1, title: "New Job Added", message: `A new job has been added. Job ID: ${job.jobCode}. Please review the details.`,
        dedupeKey: `C1:${job.jobId}`, roles: AUDIENCE.JOB_HANDLERS, jobId: job.jobId,
    })));
}

// ---------------------------------------------------------------- C2

// New Agents created without a country (the bulk import creates them so). agents: [{ agentId, name }].
// Clients have no country of their own, so only Agents are reported.
export function notifyAgentsMissingCountry(db, agents) {
    return notifyAll(db, (agents ?? []).filter((agent) => agent?.agentId).map((agent) => ({
        type: NOTIFICATION_TYPE.C2, title: "Missing Country Information",
        message: `Country information is missing for ${agent.name}. Please update the details.`,
        dedupeKey: `C2:${agent.agentId}`, roles: AUDIENCE.JOB_HANDLERS,
    })));
}

// ---------------------------------------------------------------- E1 / E2

async function candidateNames(db, passportIds) {
    if (!passportIds.length || typeof db?.candidate?.findMany !== "function") return new Map();
    const rows = await db.candidate.findMany({ where: { passportId: { in: passportIds } }, select: { passportId: true, firstName: true, otherName: true } });
    return new Map(rows.map((row) => [row.passportId, clientName(row)]));
}

// Candidates marked Cancelled by one user in one action. at: when (the final status's time), so the
// same cancellation is sent once and a later one again. candidates: [passportId]. actorId: the user
// who cancelled them, who is not sent it (whatever their role).
export async function notifyCandidatesCancelled(db, { actorId = null, actorName, passportIds, at = new Date() }) {
    const ids = [...new Set(passportIds ?? [])];
    if (!ids.length) return { created: 0 };
    let names;
    try {
        names = await candidateNames(db, ids);
    } catch {
        names = new Map();
    }
    const stamp = at.toISOString();
    return notifyAll(db, ids.map((passportId) => ({
        type: NOTIFICATION_TYPE.E1, title: "Candidate Cancelled",
        message: `${actorName || "A user"} marked ${names.get(passportId) || "a candidate"} as Cancelled.`,
        dedupeKey: `E1:${passportId}:${stamp}`, roles: AUDIENCE.ADMIN_TEAM, excludeUserIds: actorId ? [actorId] : [],
        candidateId: passportId,
    })));
}

// A candidate moved to Need Attention (a follow-up opened): once per follow-up. actorId: the user
// who opened it, who is not sent it (whatever their role).
export async function notifyNeedAttention(db, { followUpId, passportId, actorId = null }) {
    if (!followUpId) return { created: 0 };
    let name = null;
    try {
        name = (await candidateNames(db, [passportId])).get(passportId) ?? null;
    } catch {
        name = null;
    }
    return notify(db, {
        type: NOTIFICATION_TYPE.E2, title: "Candidate Moved to Need Attention",
        message: `${name || "A candidate"} has been moved to the Need Attention tab.`,
        dedupeKey: `E2:${followUpId}`, roles: AUDIENCE.ADMIN_TEAM, excludeUserIds: actorId ? [actorId] : [],
    });
}

// ---------------------------------------------------------------- E9 / F1

// One Google Sheet sync failure (a failed run, a run abandoned by its workers, dead-lettered rows):
// ADMIN and TEAM_LEAD users get E9, OWNER users get only F1 (exact roles: no inheritance here).
// eventKey identifies the failure (e.g. "run:<runId>"), so it is sent once per recipient.
export function notifySheetSyncFailed(db, { eventKey }) {
    if (!eventKey) return Promise.resolve({ created: 0 });
    return notifyAll(db, [
        {
            type: NOTIFICATION_TYPE.E9, title: "Google Sheet Sync Failed",
            message: "Google Sheet Sync has failed. Please check the connection and synchronization status.",
            dedupeKey: `E9:${eventKey}`, roles: AUDIENCE.SHEET_SYNC_STAFF,
        },
        {
            type: NOTIFICATION_TYPE.F1, title: "Google Sheet Sync Error",
            message: "Google Sheet Sync has encountered an error. Please check the synchronization status.",
            dedupeKey: `F1:${eventKey}`, roles: AUDIENCE.OWNERS,
        },
    ]);
}

// Failures that have no run of their own (dead-lettered queue / form submission rows): one event an hour.
export const sheetSyncHourKey = (source, now = new Date()) => `${source}:${hourBucket(now)}`;

// ---------------------------------------------------------------- E10

// A Candidate Form link could not be generated for a system reason (the form not configured, an
// unexpected server error; never a refusal such as an already submitted form). At most once an hour.
export function notifyFormLinkFailed(db, { now = new Date() } = {}) {
    return notify(db, {
        type: NOTIFICATION_TYPE.E10, title: "Candidate Form Link Failed",
        message: "A Candidate Form link could not be generated. Please check the issue.",
        dedupeKey: `E10:${hourBucket(now)}`, roles: AUDIENCE.ADMIN_TEAM,
    });
}

// Whether a form-link error is a system problem (notified) rather than a refusal of the request.
export const isFormLinkSystemError = (error) => !(typeof error?.status === "number" && error.status < 500);

// ---------------------------------------------------------------- F2

// The issues a System Alert names: generic, never an error message, path or identifier. The daily
// health check (phase 3) adds its own codes here and calls notifySystemAlert with them, so the same
// issue is still sent once per business day whoever detects it.
export const SYSTEM_ISSUE = Object.freeze({
    UNHANDLED_SERVER_ERROR: "Unhandled server error",
    DATABASE_ERROR: "Database error",
    DOCUMENT_PROCESSING_FAILED: "Document processing failed",
    // The daily health check (notificationScanService.js F2).
    DOCUMENT_PROCESSING_DELAYED: "Document processing is delayed",
    SHEET_SYNC_WORKER_STALE: "Sheet sync worker is not responding",
    IMPORT_RECOVERY_NEEDS_ATTENTION: "Bulk import recovery needs attention",
});

// The dedupe key of an issue on a business day (Asia/Colombo).
export const systemAlertDedupeKey = (issue, now = new Date()) => `F2:${issue}:${businessDateOf(now)}`;

// Per process: the issue keys already written (or tried within the last few minutes), so a burst of
// errors costs one insert, and a database that is down is not hit once per failing request.
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const systemAlertsSent = new Map(); // key -> { sent: boolean, at: ms }

export function resetSystemAlertMemory() {
    systemAlertsSent.clear();
}

// issue: a SYSTEM_ISSUE key. Owners only.
export async function notifySystemAlert(db, { issue, now = new Date() }) {
    const description = SYSTEM_ISSUE[issue];
    if (!description) return { created: 0 };
    const dedupeKey = systemAlertDedupeKey(issue, now);
    const seen = systemAlertsSent.get(dedupeKey);
    if (seen && (seen.sent || Date.now() - seen.at < RETRY_AFTER_FAILURE_MS)) return { created: 0, throttled: true };
    if (systemAlertsSent.size > 100) systemAlertsSent.clear();
    systemAlertsSent.set(dedupeKey, { sent: false, at: Date.now() });
    const result = await notify(db, {
        type: NOTIFICATION_TYPE.F2, title: "System Alert", message: `System alert: ${description}. Please check the system status.`,
        dedupeKey, roles: AUDIENCE.OWNERS,
    });
    if (!result.failed) systemAlertsSent.set(dedupeKey, { sent: true, at: Date.now() });
    return result;
}

// An error the API answered with 500 -> its issue: a Prisma error is a database error.
export const systemIssueOf = (error) => (typeof error?.code === "string" && /^P\d{4}$/.test(error.code) ? "DATABASE_ERROR" : "UNHANDLED_SERVER_ERROR");

// For the API's error handler (createApp.js): fire-and-forget, never throws, never awaited by the
// response. getDb: () => the database client (or a promise of it), resolved only when a 500 happens.
export function createSystemAlertReporter({ getDb }) {
    return (error) => {
        Promise.resolve()
            .then(() => getDb())
            .then((db) => notifySystemAlert(db, { issue: systemIssueOf(error) }))
            .catch(() => {});
    };
}
