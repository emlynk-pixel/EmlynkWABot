// Scheduled notifications: one scan (POST /api/tasks/notification-scan, routes/tasks.js) that Cloud
// Scheduler calls every 15 minutes. Each run decides what is due from the Asia/Colombo clock and sends
// it; in-app only, through notificationService.js notifyAll (never throws).
//
//   rule  due (Colombo)  recipients                     dedupe key (one row per recipient and key)
//   F2    06:00          OWNER                          F2:<issue>:<date>   (notificationEvents.js systemAlertDedupeKey)
//   D2    16:00          TEAM_LEAD                      D2:<date>
//   A2    18:00          each ANALYST (own count)       A2:<analystId>:<date>      every day while > 0
//   A3    18:00          each ANALYST, 3 months         A3:<userId>:<password-change time>   once per change
//   C3    18:00          each JOB_HANDLER, 2 months     C3:<userId>:<password-change time>
//   D4    18:00          each TEAM_LEAD, 30 days        D4:<userId>:<password-change time>
//   B1    18:00, last day of the month   each REGISTRATION_DESK (own count)   B1:<userId>:<YYYY-MM>
//   D1    18:00          TEAM_LEAD                      D1:<date>
//   D3    18:00          TEAM_LEAD                      D3:<jobId>                 once per job
//   E3-E7 18:00          OWNER, ADMIN, TEAM_LEAD        E3:<date> ... (see each rule)
//   E8    18:00, working days only   OWNER, ADMIN, TEAM_LEAD   E8:<staffId>:<last activity date | never>
//                                    (about ANALYST and REGISTRATION_DESK staff only)
//
// A rule runs on every scan from its due time to the end of the business day. Idempotency comes ONLY
// from the dedupe keys (UNIQUE (recipient_id, dedupe_key), ON CONFLICT DO NOTHING), never from memory:
// repeated, overlapping or restarted runs add nothing, and a run missed at 18:00 is made up by a later
// run the same day. Previous days are never backfilled. Rules that report "newly crossed" thresholds
// (E4, E6, E7) look at a fixed window, from yesterday's due time to today's, so every crossing falls
// in exactly one day's window whichever run sends it.
//
// Each rule is isolated (one failing rule never stops the others) and the run stops starting new
// rules after RUN_BUDGET_MS. Every query is an aggregate or a small bounded read. A notification
// whose number would be 0 is never sent. Texts name no candidate and hold no identifier (E8 names a
// staff member, as the rule requires).

import { ROLES } from "../middleware/requireRole.js";
import { USER_STATUS } from "../middleware/requireActiveUser.js";
import {
    addBusinessDays,
    addBusinessMonths,
    businessDateOf,
    businessDayRange,
    businessTimeOn,
    isLastDayOfMonth,
    isWorkingDay,
    previousWorkingDay,
} from "../utils/businessDay.js";
import { safePrismaErrorFields } from "../utils/safeLog.js";
import { workAllocationViewWhere } from "./candidateListFilters.js";
import { automaticStageMissing } from "./candidateService.js";
import { notCompletedPlacementWhere } from "./candidateWorkflowStatus.js";
import { DAILY_SUMMARY_LABELS, getDailySummaryCounts } from "./dailyReportService.js";
import { RECOVERY_STATUS } from "./importRecoveryService.js";
import { NOTIFICATION_TYPE, notifySystemAlert } from "./notificationEvents.js";
import { AUDIENCE } from "./notificationRecipients.js";
import { notifyAll } from "./notificationService.js";
import { WORKER_STALE_MS } from "./sheetSyncStatusService.js";
import { STATE_ID } from "./sheetSyncStore.js";
import { RECEIVED_STATUS } from "./statusMapping.js";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

// Stop starting new rules after this (the scheduler's attempt deadline is 60 s).
export const RUN_BUDGET_MS = 40_000;
// Notifications older than this are deleted (once a day, during the 06:00 hour), at most this many a run.
export const NOTIFICATION_RETENTION_DAYS = 90;
const PURGE_BATCH = 5_000;

// "Admin audience": OWNER + ADMIN + TEAM_LEAD (the Admin tier with inheritance, and Team Leads).
export const ADMIN_AUDIENCE = AUDIENCE.ADMIN_TEAM;
const TEAM_LEADS = Object.freeze([ROLES.TEAM_LEAD]);

// The staff E8 watches: Analysts and the Registration Desk only (never an Owner, Admin or Team Lead).
export const E8_STAFF_ROLES = Object.freeze([ROLES.ANALYST, ROLES.REGISTRATION_DESK]);

// Written by candidateService (the same actions the Daily Report reads).
const REGISTRATION_ACTION = "CREATE_CANDIDATE";
const UPLOAD_ACTION = "UPLOAD_DOCUMENT";

const plural = (count, one, many) => (count === 1 ? one : many);
// A JS instant as a PostgreSQL `timestamp` (without time zone, stored as UTC like every
// Prisma DateTime column here), whatever the session's time zone.
const ts = (date) => date.toISOString();

// ---------------------------------------------------------------- texts

export const MESSAGES = Object.freeze({
    A2: (x) => (x === 1
        ? "You have 1 pending follow-up in Need Attention. Please review it."
        : `You have ${x} pending follow-ups in Need Attention. Please review them.`),
    PASSWORD: (period) => `It has been ${period} since your last password change. Please update your password for security.`,
    B1: (x) => `You have registered ${x} ${plural(x, "candidate", "candidates")} this month.`,
    D1: (x) => `You have ${x} unallocated ${plural(x, "candidate", "candidates")} waiting for assignment.`,
    D2: (items) => `The daily report has been updated: ${items.map(([label, count]) => `${label}: ${count}`).join(", ")}. Please review the latest information.`,
    D3: (x, jobCode, y) => {
        const first = `${x} new ${plural(x, "vacancy is", "vacancies are")} available for Job ${jobCode}.`;
        return y > 0 ? `${first} ${y} free ${plural(y, "candidate is", "candidates are")} eligible to be added to this job.` : first;
    },
    E3: (x) => (x === 1 ? "1 new candidate has been added to the system today." : `${x} new candidates have been added to the system today.`),
    E4: (x) => (x === 1
        ? "1 candidate has had missing documents or information for more than 3 days without follow-up. Please review them."
        : `${x} candidates have had missing documents or information for more than 3 days without follow-up. Please review them.`),
    E5: (x, n) => (x === 1
        ? `1 Need Attention follow-up has not been updated for more than ${n} days. Please review it.`
        : `${x} Need Attention follow-ups have not been updated for more than ${n} days. Please review them.`),
    E6: (x) => (x === 1
        ? "1 job has remained in Processing for more than 3 days. Please check its status."
        : `${x} jobs have remained in Processing for more than 3 days. Please check their status.`),
    E7: (x, n) => (x === 1
        ? `1 document has been waiting for review for more than ${n} days. Please review it.`
        : `${x} documents have been waiting for review for more than ${n} days. Please review them.`),
    E8: (name) => `${name} has recorded no calls or documents for the last 2 working days. Please review their activity.`,
});

// ---------------------------------------------------------------- password-change time (A3, C3, D4)

// No column records a password change. The time is Supabase Auth's auth.users.updated_at, read with
// a guarded raw query (the auth schema exists on Supabase only); when the auth row has none, the
// account's activation (else creation) time. ASSUMPTION: updated_at moves on ANY change of the auth
// user, not only a password change (see the Phase 3 report). KNOWN LIMITATION, not verified against a
// real sign-in: if Supabase also moves updated_at on sign-in, the reminders fire late or rarely for
// staff who log in often. Planned upgrade: an app-owned password_changed_at set only on a password change.
// Returns Map adminId -> Date, or null when the auth schema is absent (the rules then send nothing).
async function passwordChangedAt(db, users) {
    if (!users.length) return new Map();
    const [table] = await db.$queryRaw`SELECT to_regclass('auth.users') IS NOT NULL AS "present"`;
    if (!table?.present) return null;
    const ids = users.map((user) => user.authUserId);
    const rows = await db.$queryRaw`
        SELECT "id"::text AS "authUserId", extract(epoch FROM "updated_at")::float8 AS "epoch"
        FROM auth.users WHERE "id" = ANY(${ids}::uuid[])`;
    const epochOf = new Map(rows.filter((row) => row.epoch !== null).map((row) => [row.authUserId.toLowerCase(), Number(row.epoch)]));
    return new Map(users.map((user) => {
        const epoch = epochOf.get(String(user.authUserId).toLowerCase());
        return [user.adminId, epoch !== undefined ? new Date(Math.round(epoch * 1000)) : (user.activatedAt ?? user.createdDate)];
    }));
}

// One password reminder rule: users of `role` whose last change is at least `period` ago
// (calendar months or days, by Colombo date). Once per change: the key holds the change time.
function passwordRule({ code, role, months = 0, days = 0, period }) {
    return async (ctx) => {
        const users = await ctx.db.user.findMany({
            where: { role, status: USER_STATUS.ACTIVE },
            select: { adminId: true, authUserId: true, activatedAt: true, createdDate: true },
        });
        const changed = await passwordChangedAt(ctx.db, users);
        if (!changed) return { specs: [], skipped: "AUTH_SCHEMA_ABSENT" };
        const specs = [];
        for (const user of users) {
            const at = changed.get(user.adminId);
            if (!at) continue;
            const changedOn = businessDateOf(at);
            const dueOn = months ? addBusinessMonths(changedOn, months) : addBusinessDays(changedOn, days);
            if (ctx.today < dueOn) continue;
            specs.push({
                type: NOTIFICATION_TYPE[code], title: "Password Change Reminder", message: MESSAGES.PASSWORD(period),
                dedupeKey: `${code}:${user.adminId}:${at.toISOString()}`, userIds: [user.adminId], requireRoles: [role],
            });
        }
        return { specs };
    };
}

// ---------------------------------------------------------------- the rules

// A2: OPEN follow-ups (the Need Attention list) of the candidates allocated to each Analyst: the
// list's own scope for an Analyst (candidateAccess.js candidateScope: candidate_allocation.analyst_id).
async function pendingFollowUps(ctx) {
    const rows = await ctx.db.callLogFollowUp.findMany({
        where: { status: "OPEN", callLog: { user: { allocation: { isNot: null } } } },
        select: { callLog: { select: { user: { select: { allocation: { select: { analystId: true } } } } } } },
    });
    const counts = new Map();
    for (const row of rows) {
        const analystId = row.callLog?.user?.allocation?.analystId;
        if (analystId) counts.set(analystId, (counts.get(analystId) ?? 0) + 1);
    }
    return {
        specs: [...counts].map(([analystId, count]) => ({
            type: NOTIFICATION_TYPE.A2, title: "Pending Follow-ups", message: MESSAGES.A2(count),
            dedupeKey: `A2:${analystId}:${ctx.today}`, userIds: [analystId], requireRoles: [ROLES.ANALYST],
        })),
    };
}

// B1: on the last day of the month, each Registration Desk user's registrations of the month: the
// candidates created in the business month (candidate.created_date, as the Daily Report counts
// "registered") whose CREATE_CANDIDATE audit entry names that user (the Daily Report's "registered by").
async function monthlyRegistrations(ctx) {
    if (!isLastDayOfMonth(ctx.today)) return { specs: [], skipped: "NOT_LAST_DAY_OF_MONTH" };
    const month = ctx.today.slice(0, 7);
    const desk = await ctx.db.user.findMany({ where: { role: ROLES.REGISTRATION_DESK, status: USER_STATUS.ACTIVE }, select: { adminId: true } });
    if (!desk.length) return { specs: [] };
    const start = businessDayRange(`${month}-01`).start;
    const end = businessDayRange(ctx.today).end;
    const ids = desk.map((user) => user.adminId);
    const rows = await ctx.db.$queryRaw`
        SELECT a."admin_id" AS "adminId", count(DISTINCT c."passport_id")::int AS "count"
        FROM "candidate" c
        JOIN "audit_logs" a ON a."passport_id" = c."passport_id" AND a."action" = ${REGISTRATION_ACTION}
        WHERE c."created_date" >= (${ts(start)}::timestamptz AT TIME ZONE 'UTC')
          AND c."created_date" < (${ts(end)}::timestamptz AT TIME ZONE 'UTC')
          AND a."admin_id" = ANY(${ids})
        GROUP BY a."admin_id"`;
    return {
        specs: rows.filter((row) => Number(row.count) > 0).map((row) => ({
            type: NOTIFICATION_TYPE.B1, title: "Monthly Registration Summary", message: MESSAGES.B1(Number(row.count)),
            dedupeKey: `B1:${row.adminId}:${month}`, userIds: [row.adminId], requireRoles: [ROLES.REGISTRATION_DESK],
        })),
    };
}

// D1: Work Allocation's Unallocated count (no allocation, completed placements left out).
async function unallocatedCandidates(ctx) {
    const count = await ctx.db.candidate.count({ where: workAllocationViewWhere("UNALLOCATED") });
    if (!count) return { specs: [] };
    return { specs: [{ type: NOTIFICATION_TYPE.D1, title: "Unallocated Candidates", message: MESSAGES.D1(count), dedupeKey: `D1:${ctx.today}`, roles: TEAM_LEADS }] };
}

// D2: today's Daily Report Summary figures, only those above 0 (nothing to report: nothing sent).
async function dailyReportUpdated(ctx) {
    const counts = await getDailySummaryCounts({ db: ctx.db, date: ctx.today });
    const items = Object.entries(DAILY_SUMMARY_LABELS).filter(([key]) => counts[key] > 0).map(([key, label]) => [label, counts[key]]);
    if (!items.length) return { specs: [] };
    return { specs: [{ type: NOTIFICATION_TYPE.D2, title: "Daily Report Updated", message: MESSAGES.D2(items), dedupeKey: `D2:${ctx.today}`, roles: TEAM_LEADS }] };
}

// Candidates a job may take (the saved Test details result PASS, jobService assignCandidate) that
// are on no job at all (no active job_candidate): the same set as C1 (notificationEvents.js).
async function freeEligibleCandidates(db) {
    const [row] = await db.$queryRaw`
        SELECT count(*)::int AS "count" FROM "candidate_stages" s
        WHERE s."stage" = 'TEST_DETAILS' AND s."test_result" = 'PASS'
          AND NOT EXISTS (SELECT 1 FROM "job_candidate" jc WHERE jc."passport_id" = s."passport_id" AND jc."is_active")`;
    return Number(row?.count ?? 0);
}

// D3: PROCESSING jobs with vacancies and no active candidate (so never Filled, jobService
// isJobFilled), once per job.
async function newVacancies(ctx) {
    const jobs = await ctx.db.job.findMany({
        where: { status: "PROCESSING", vacancies: { gt: 0 }, candidates: { none: { isActive: true } } },
        select: { id: true, jobCode: true, vacancies: true },
        orderBy: [{ createdAt: "asc" }, { jobCode: "asc" }],
        take: 200,
    });
    if (!jobs.length) return { specs: [] };
    const free = await freeEligibleCandidates(ctx.db);
    return {
        specs: jobs.map((job) => ({
            type: NOTIFICATION_TYPE.D3, title: "New Vacancies Available", message: MESSAGES.D3(job.vacancies, job.jobCode, free),
            dedupeKey: `D3:${job.id}`, roles: TEAM_LEADS,
        })),
    };
}

// E3: candidates created today (candidate.created_date in the business day).
async function newCandidates(ctx) {
    const { start, end } = businessDayRange(ctx.today);
    const count = await ctx.db.candidate.count({ where: { createdDate: { gte: start, lt: end } } });
    if (!count) return { specs: [] };
    return { specs: [{ type: NOTIFICATION_TYPE.E3, title: "New Candidates Added", message: MESSAGES.E3(count), dedupeKey: `E3:${ctx.today}`, roles: ADMIN_AUDIENCE }] };
}

// E4: candidates with missing information or documents (candidateService automaticStageMissing:
// the Candidate details and Document submission stages' missing items) whose last activity (the
// later of their registration, their latest call log and their latest follow-up flag / completion)
// crossed 3 days in today's window. Completed placements (Departed, Cancelled, Rejected) are left out.
async function missingInformation(ctx) {
    const from = new Date(ctx.windowStart.getTime() - 3 * DAY_MS);
    const to = new Date(ctx.windowEnd.getTime() - 3 * DAY_MS);
    const rows = await ctx.db.$queryRaw`
        SELECT t."passportId" FROM (
            SELECT c."passport_id" AS "passportId",
                   GREATEST(
                       c."created_date",
                       COALESCE((SELECT max(l."created_date") FROM "candidate_call_logs" l WHERE l."passport_id" = c."passport_id"), c."created_date"),
                       COALESCE((SELECT max(GREATEST(f."flagged_date", COALESCE(f."completed_date", f."flagged_date")))
                                 FROM "call_log_follow_up" f JOIN "candidate_call_logs" fl ON fl."call_log_id" = f."call_log_id"
                                 WHERE fl."passport_id" = c."passport_id"), c."created_date")
                   ) AS "lastActivity"
            FROM "candidate" c
            WHERE c."created_date" < (${ts(to)}::timestamptz AT TIME ZONE 'UTC')
        ) t
        WHERE t."lastActivity" >= (${ts(from)}::timestamptz AT TIME ZONE 'UTC')
          AND t."lastActivity" < (${ts(to)}::timestamptz AT TIME ZONE 'UTC')`;
    if (!rows.length) return { specs: [] };
    const candidates = await ctx.db.candidate.findMany({
        where: { AND: [{ passportId: { in: rows.map((row) => row.passportId) } }, notCompletedPlacementWhere()] },
        select: {
            firstName: true, otherName: true, nic: true, passportIssueDate: true, passportExpiryDate: true,
            job: true, jobExperience: true, whatsappNumber: true,
            documents: { select: { documentType: true, verificationStatus: true, documentVariant: true } },
        },
    });
    const count = candidates.filter((candidate) => {
        const missing = automaticStageMissing(candidate, candidate.documents);
        return missing.CANDIDATE_DETAILS.length > 0 || missing.DOCUMENT_SUBMISSION.length > 0;
    }).length;
    if (!count) return { specs: [] };
    return { specs: [{ type: NOTIFICATION_TYPE.E4, title: "Missing Documents or Information", message: MESSAGES.E4(count), dedupeKey: `E4:${ctx.today}`, roles: ADMIN_AUDIENCE }] };
}

// E5: OPEN follow-ups not updated for 48 hours or more. Last update = the later of the flag time and
// the candidate's latest call log. Every day while any qualifies.
async function staleFollowUps(ctx) {
    const cutoff = new Date(ctx.now.getTime() - 48 * HOUR_MS);
    const [row] = await ctx.db.$queryRaw`
        SELECT count(*)::int AS "count", extract(epoch FROM min(t."lastUpdate"))::float8 AS "oldest" FROM (
            SELECT GREATEST(f."flagged_date", COALESCE((SELECT max(x."created_date") FROM "candidate_call_logs" x WHERE x."passport_id" = l."passport_id"), f."flagged_date")) AS "lastUpdate"
            FROM "call_log_follow_up" f JOIN "candidate_call_logs" l ON l."call_log_id" = f."call_log_id"
            WHERE f."status" = 'OPEN'
        ) t
        WHERE t."lastUpdate" <= (${ts(cutoff)}::timestamptz AT TIME ZONE 'UTC')`;
    const count = Number(row?.count ?? 0);
    if (!count) return { specs: [] };
    const days = Math.max(2, Math.floor((ctx.now.getTime() - Number(row.oldest) * 1000) / DAY_MS));
    return { specs: [{ type: NOTIFICATION_TYPE.E5, title: "Need Attention Follow-ups Pending", message: MESSAGES.E5(count, days), dedupeKey: `E5:${ctx.today}`, roles: ADMIN_AUDIENCE }] };
}

// E6: PROCESSING jobs that crossed 3 days in Processing in today's window (each job once).
// job.created_at IS the time a job entered Processing, not a proxy: a job is created PROCESSING
// (jobService createJob and the bulk import's importJobGroups, both the only writers) and the
// database refuses any return to it (trigger job_status_transition, migration 20261018120000: a
// COMPLETED or CANCELLED job never changes status again). So no audit_logs read is needed.
async function stuckJobs(ctx) {
    const count = await ctx.db.job.count({
        where: {
            status: "PROCESSING",
            createdAt: { gte: new Date(ctx.windowStart.getTime() - 3 * DAY_MS), lt: new Date(ctx.windowEnd.getTime() - 3 * DAY_MS) },
        },
    });
    if (!count) return { specs: [] };
    return { specs: [{ type: NOTIFICATION_TYPE.E6, title: "Jobs Stuck in Processing", message: MESSAGES.E6(count), dedupeKey: `E6:${ctx.today}`, roles: ADMIN_AUDIENCE }] };
}

// The E7 milestones: 3, 10, 17, ... days.
export const isReviewMilestone = (days) => days >= 3 && (days - 3) % 7 === 0;

// E7: documents still REVIEW_REQUIRED, aged from documents.created_date. That IS the time the
// document became REVIEW_REQUIRED: a document is only ever inserted with that status (the automatic
// OCR store, clientDocumentService storeClientDocument UNCLEAR band, and the Review Queue's Keep as
// version), and no code path updates a document INTO it (updates only set VERIFIED or SUPERSEDED).
// audit_logs could not replace it: the automatic path writes no audit row at all (only Keep as
// version does). A milestone N (3, 10, 17...)
// is reported on the day a still-unreviewed document crosses it (in today's window); X = the
// documents waiting more than N days now. One notification per milestone crossed that day.
async function documentsAwaitingReview(ctx) {
    const docs = await ctx.db.document.findMany({
        where: { verificationStatus: "REVIEW_REQUIRED", createdDate: { lte: new Date(ctx.now.getTime() - 3 * DAY_MS) } },
        select: { createdDate: true },
    });
    const milestones = new Set();
    for (const doc of docs) {
        // The whole-day age this document reached in the window (the window is one day long): the
        // first k with created + k days >= the window's start.
        const created = doc.createdDate.getTime();
        const days = Math.ceil((ctx.windowStart.getTime() - created) / DAY_MS);
        const reachedAt = created + days * DAY_MS;
        if (reachedAt < ctx.windowEnd.getTime() && isReviewMilestone(days)) milestones.add(days);
    }
    const specs = [];
    for (const days of [...milestones].sort((a, b) => a - b)) {
        const cutoff = ctx.now.getTime() - days * DAY_MS;
        const count = docs.filter((doc) => doc.createdDate.getTime() <= cutoff).length;
        if (!count) continue;
        specs.push({ type: NOTIFICATION_TYPE.E7, title: "Documents Awaiting Review", message: MESSAGES.E7(count, days), dedupeKey: `E7:N${days}:${ctx.today}`, roles: ADMIN_AUDIENCE });
    }
    return { specs };
}

// E8: ACTIVE Analysts and Registration Desk users (E8_STAFF_ROLES) with no call and no staff upload
// (the Daily Report's own attribution: candidate_call_logs.admin_id, UPLOAD_DOCUMENT audit entries) on
// the last 2 working days (today and the previous working day, up to now; Saturday and Sunday are
// not working days, there is no holiday list). Working days only. A staff member whose
// account was activated (else created) after the start of that window is not judged yet. Once per
// inactivity spell: the key holds the date of their latest activity ever ("never" if none).
async function staffInactivity(ctx) {
    if (!isWorkingDay(ctx.today)) return { specs: [], skipped: "NOT_A_WORKING_DAY" };
    const since = businessDayRange(previousWorkingDay(ctx.today)).start;
    const staff = await ctx.db.user.findMany({
        where: { role: { in: [...E8_STAFF_ROLES] }, status: USER_STATUS.ACTIVE },
        select: { adminId: true, name: true, activatedAt: true, createdDate: true },
        orderBy: [{ name: "asc" }, { adminId: "asc" }],
    });
    const judged = staff.filter((user) => (user.activatedAt ?? user.createdDate) < since);
    if (!judged.length) return { specs: [] };
    const ids = judged.map((user) => user.adminId);
    const window = { gte: since, lte: ctx.now };
    const [calls, uploads] = await Promise.all([
        ctx.db.candidateCallLog.groupBy({ by: ["adminId"], where: { adminId: { in: ids }, createdDate: window }, _count: { _all: true } }),
        ctx.db.auditLog.groupBy({ by: ["adminId"], where: { action: UPLOAD_ACTION, adminId: { in: ids }, createdDate: window }, _count: { _all: true } }),
    ]);
    const active = new Set([...calls, ...uploads].map((group) => group.adminId));
    const inactive = judged.filter((user) => !active.has(user.adminId));
    if (!inactive.length) return { specs: [] };
    const inactiveIds = inactive.map((user) => user.adminId);
    const [lastCalls, lastUploads] = await Promise.all([
        ctx.db.candidateCallLog.groupBy({ by: ["adminId"], where: { adminId: { in: inactiveIds } }, _max: { createdDate: true } }),
        ctx.db.auditLog.groupBy({ by: ["adminId"], where: { action: UPLOAD_ACTION, adminId: { in: inactiveIds } }, _max: { createdDate: true } }),
    ]);
    const last = new Map();
    for (const group of [...lastCalls, ...lastUploads]) {
        const at = group._max.createdDate;
        if (at && (!last.has(group.adminId) || at > last.get(group.adminId))) last.set(group.adminId, at);
    }
    return {
        specs: inactive.map((user) => ({
            type: NOTIFICATION_TYPE.E8, title: "Staff Inactivity", message: MESSAGES.E8(user.name),
            dedupeKey: `E8:${user.adminId}:${last.has(user.adminId) ? businessDateOf(last.get(user.adminId)) : "never"}`, roles: ADMIN_AUDIENCE,
        })),
    };
}

// F2: the daily health check (Owners only, notificationEvents.js notifySystemAlert: the same issue
// is sent at most once a business day, whoever detects it). Issue texts are generic.
export const SUBMISSION_DELAY_MS = 60 * 60_000; // a received file still waiting after an hour (lease 10 min x 3 attempts)
async function healthCheck(ctx) {
    const db = ctx.db;
    const since = new Date(ctx.now.getTime() - DAY_MS);
    const [failed, delayed, state, needsAttention] = await Promise.all([
        db.temporaryData.count({ where: { processingStatus: "FAILED", createdDate: { gte: since } } }),
        db.temporaryData.count({ where: { processingStatus: RECEIVED_STATUS, createdDate: { lt: new Date(ctx.now.getTime() - SUBMISSION_DELAY_MS) } } }),
        db.sheetSyncState.findUnique({ where: { stateId: STATE_ID }, select: { configured: true, workerHeartbeatAt: true } }),
        db.candidateImport.count({ where: { recoveryStatus: RECOVERY_STATUS.NEEDS_ATTENTION } }),
    ]);
    const issues = [];
    if (failed > 0) issues.push("DOCUMENT_PROCESSING_FAILED");
    if (delayed > 0) issues.push("DOCUMENT_PROCESSING_DELAYED");
    if (state?.configured === true && (!state.workerHeartbeatAt || ctx.now.getTime() - state.workerHeartbeatAt.getTime() > WORKER_STALE_MS)) issues.push("SHEET_SYNC_WORKER_STALE");
    if (needsAttention > 0) issues.push("IMPORT_RECOVERY_NEEDS_ATTENTION");
    let created = 0;
    let failedWrite = false;
    for (const issue of issues) {
        const result = await notifySystemAlert(db, { issue, now: ctx.now });
        created += result.created ?? 0;
        if (result.failed) failedWrite = true;
    }
    return { sent: { notifications: issues.length, created, failed: failedWrite }, issues };
}

// Deletes notifications older than the retention, during the 06:00 hour only (up to four scans a
// day; the first deletes, the rest find nothing). Bounded; safe to repeat or overlap.
async function purgeOldNotifications(ctx) {
    if (ctx.now.getTime() >= businessTimeOn(ctx.today, "07:00").getTime()) return { specs: [], skipped: "OUTSIDE_PURGE_HOUR" };
    const cutoff = new Date(ctx.now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
    const deleted = await ctx.db.$executeRaw`
        DELETE FROM "notification" WHERE "id" IN (
            SELECT "id" FROM "notification" WHERE "created_at" < ${ts(cutoff)}::timestamptz LIMIT ${PURGE_BATCH}
        )`;
    return { purged: Number(deleted) };
}

// The rules, in the order they run. due: "HH:MM" Asia/Colombo.
export const SCAN_RULES = Object.freeze([
    { code: "F2", due: "06:00", run: healthCheck },
    { code: "PURGE", due: "06:00", run: purgeOldNotifications },
    { code: "D2", due: "16:00", run: dailyReportUpdated },
    { code: "A2", due: "18:00", run: pendingFollowUps },
    { code: "A3", due: "18:00", run: passwordRule({ code: "A3", role: ROLES.ANALYST, months: 3, period: "3 months" }) },
    { code: "C3", due: "18:00", run: passwordRule({ code: "C3", role: ROLES.JOB_HANDLER, months: 2, period: "2 months" }) },
    { code: "D4", due: "18:00", run: passwordRule({ code: "D4", role: ROLES.TEAM_LEAD, days: 30, period: "30 days" }) },
    { code: "B1", due: "18:00", run: monthlyRegistrations },
    { code: "D1", due: "18:00", run: unallocatedCandidates },
    { code: "D3", due: "18:00", run: newVacancies },
    { code: "E3", due: "18:00", run: newCandidates },
    { code: "E4", due: "18:00", run: missingInformation },
    { code: "E5", due: "18:00", run: staleFollowUps },
    { code: "E6", due: "18:00", run: stuckJobs },
    { code: "E7", due: "18:00", run: documentsAwaitingReview },
    { code: "E8", due: "18:00", run: staffInactivity },
]);

function logLine(log, level, fields) {
    try {
        log[level](JSON.stringify(fields));
    } catch {
        // Logging never breaks the scan.
    }
}

// One scan. now: injectable (tests). Returns counts and codes only:
// { businessDate, databaseReachable, rules: [{ rule, status, notifications, created, ... }] }
//   status  NOT_DUE | DONE | SKIPPED (the rule's own condition, e.g. not the last day of the month)
//           | FAILED | OUT_OF_TIME
export async function runNotificationScan(db, { now = new Date(), log = console, rules = SCAN_RULES, budgetMs = RUN_BUDGET_MS } = {}) {
    const started = Date.now();
    const today = businessDateOf(now);
    const summary = { businessDate: today, databaseReachable: true, rules: [] };

    try {
        await db.$queryRaw`SELECT 1`;
    } catch (error) {
        // Nothing can be written (not even the F2 alert): log only.
        summary.databaseReachable = false;
        logLine(log, "error", { event: "notification_scan.database_unreachable", errorClass: error?.name ?? "Error", ...safePrismaErrorFields(error) });
        return summary;
    }

    for (const rule of rules) {
        const dueAt = businessTimeOn(today, rule.due);
        if (now < dueAt) {
            summary.rules.push({ rule: rule.code, status: "NOT_DUE" });
            continue;
        }
        if (Date.now() - started > budgetMs) {
            summary.rules.push({ rule: rule.code, status: "OUT_OF_TIME" });
            continue;
        }
        const ctx = { db, now, today, windowStart: businessTimeOn(addBusinessDays(today, -1), rule.due), windowEnd: dueAt };
        try {
            const result = await rule.run(ctx);
            if (result.skipped) {
                summary.rules.push({ rule: rule.code, status: "SKIPPED", reason: result.skipped });
                continue;
            }
            if (result.purged !== undefined) {
                summary.rules.push({ rule: rule.code, status: "DONE", purged: result.purged });
                continue;
            }
            const sent = result.sent ?? { notifications: result.specs.length, ...(result.specs.length ? await notifyAll(db, result.specs) : { created: 0 }) };
            const entry = { rule: rule.code, status: sent.failed ? "FAILED" : "DONE", notifications: sent.notifications, created: sent.created ?? 0 };
            if (result.issues) entry.issues = result.issues;
            summary.rules.push(entry);
        } catch (error) {
            summary.rules.push({ rule: rule.code, status: "FAILED" });
            logLine(log, "error", { event: "notification_scan.rule_failed", rule: rule.code, errorClass: error?.name ?? "Error", ...safePrismaErrorFields(error) });
        }
    }
    return summary;
}

