import type { AdminNotification } from "../api/notifications";
import {
    canListCandidates,
    canManageAllocations,
    canManageMasterData,
    canRegisterCandidates,
    canViewCandidates,
    canViewDailyReport,
    canViewDashboard,
    canViewFollowUps,
    canViewJobs,
    isAdmin,
} from "../auth/roles";

// Where a notification opens when it is clicked: ONE table, by the server's type (NOTIFICATION_TYPE in
// src/services/notificationEvents.js). The page guards (App.tsx) and the server stay the authority;
// this only avoids sending a user to a page their role cannot open.

type WithRole = { role: string } | null | undefined;
type Page = { to: string; canOpen: (user: WithRole) => boolean };
type Rule = {
    // The record's own page when the notification names one (candidateId / jobId).
    detail?: (item: AdminNotification) => Page | null;
    // The section page, then any further pages tried in order when the role cannot open it.
    pages: readonly Page[];
};

const CANDIDATES: Page = { to: "/candidates", canOpen: canListCandidates };
const ADD_CANDIDATE: Page = { to: "/candidates/new", canOpen: canRegisterCandidates };
const FOLLOW_UPS: Page = { to: "/follow-ups", canOpen: canViewFollowUps };
const WORK_ALLOCATION: Page = { to: "/work-allocation", canOpen: canManageAllocations };
const DAILY_REPORT: Page = { to: "/reports/daily", canOpen: canViewDailyReport };
const JOBS: Page = { to: "/jobs", canOpen: canViewJobs };
const AGENTS: Page = { to: "/agents", canOpen: canManageMasterData };
const MISSING_DOCUMENTS: Page = { to: "/missing-documents", canOpen: canViewDashboard };
const REVIEW: Page = { to: "/review", canOpen: canViewDashboard };
const SHEET_SYNC: Page = { to: "/settings/sheet-sync", canOpen: isAdmin };

const candidatePage = (item: AdminNotification): Page | null =>
    item.candidateId ? { to: `/candidates/${encodeURIComponent(item.candidateId)}`, canOpen: canViewCandidates } : null;
const jobPage = (item: AdminNotification): Page | null =>
    item.jobId ? { to: `/jobs/${encodeURIComponent(item.jobId)}`, canOpen: canViewJobs } : null;

const candidate: Rule = { detail: candidatePage, pages: [CANDIDATES] };
const job: Rule = { detail: jobPage, pages: [JOBS] };

// null: the notification has no page to open (password reminders, a role change, a system alert, a
// candidate form link failure). Clicking it only marks it read.
export const NOTIFICATION_TARGETS: Readonly<Record<string, Rule | null>> = {
    A1_NEW_CANDIDATES_ALLOCATED: candidate,
    A4_CANDIDATE_FORM_SUBMITTED: candidate,
    A5_JOB_ASSIGNED: candidate,
    E1_CANDIDATE_CANCELLED: candidate,
    A2_PENDING_FOLLOW_UPS: { pages: [FOLLOW_UPS] },
    E2_CANDIDATE_NEED_ATTENTION: { pages: [FOLLOW_UPS] },
    E5_NEED_ATTENTION_FOLLOW_UPS_PENDING: { pages: [FOLLOW_UPS] },
    D1_UNALLOCATED_CANDIDATES: { pages: [WORK_ALLOCATION] },
    D2_DAILY_REPORT_UPDATED: { pages: [DAILY_REPORT] },
    E8_STAFF_INACTIVITY: { pages: [DAILY_REPORT] },
    C1_NEW_JOB_ADDED: job,
    D3_NEW_VACANCIES_AVAILABLE: job,
    E6_JOBS_STUCK_IN_PROCESSING: job,
    C2_MISSING_COUNTRY_INFORMATION: { pages: [AGENTS] },
    // Missing Documents and Review are ADMIN only; a Team Lead (who receives these too) gets the Candidates list.
    E4_MISSING_DOCUMENTS_OR_INFORMATION: { pages: [MISSING_DOCUMENTS, CANDIDATES] },
    E7_DOCUMENTS_AWAITING_REVIEW: { pages: [REVIEW, CANDIDATES] },
    E3_NEW_CANDIDATES_ADDED: { pages: [CANDIDATES] },
    // B1 goes to the Registration Desk, which has no Candidates list: its own Add Candidate page.
    B1_MONTHLY_REGISTRATION_SUMMARY: { pages: [CANDIDATES, ADD_CANDIDATE] },
    E9_GOOGLE_SHEET_SYNC_FAILED: { pages: [SHEET_SYNC] },
    F1_GOOGLE_SHEET_SYNC_ERROR: { pages: [SHEET_SYNC] },
    F2_SYSTEM_ALERT: null,
    E10_CANDIDATE_FORM_LINK_FAILED: null,
    A3_PASSWORD_CHANGE_REMINDER: null,
    B2_ROLE_UPDATED: null,
    C3_PASSWORD_CHANGE_REMINDER: null,
    D4_PASSWORD_CHANGE_REMINDER: null,
};

// "open": go to `to` (`record`: it is a candidate's or job's own page, which may no longer exist).
// "none": nothing to open (or a type this app does not know). "denied": the role can open none of
// the pages; the user stays where they are and is told so.
export type NotificationTarget =
    | { kind: "open"; to: string; record: boolean }
    | { kind: "none" }
    | { kind: "denied" };

export function notificationTarget(item: AdminNotification, user: WithRole): NotificationTarget {
    const rule = Object.prototype.hasOwnProperty.call(NOTIFICATION_TARGETS, item.type) ? NOTIFICATION_TARGETS[item.type] : null;
    if (!rule) return { kind: "none" };
    const detail = rule.detail?.(item);
    if (detail?.canOpen(user)) return { kind: "open", to: detail.to, record: true };
    const page = rule.pages.find((candidate) => candidate.canOpen(user));
    return page ? { kind: "open", to: page.to, record: false } : { kind: "denied" };
}

export const NO_ACCESS_MESSAGE = "You don't have access to the page for this notification.";

// The navigation state a notification click leaves on a record's page, so the page can send the user
// on to its section with a message when the record is gone.
export type NotificationNavState = { fromNotification?: boolean; notificationNotice?: string };

export const isFromNotification = (state: unknown): boolean => Boolean((state as NotificationNavState | null)?.fromNotification);

export const RECORD_GONE = {
    candidate: "This candidate is no longer available. It may have been removed, or you may no longer have access to it.",
    job: "This job is no longer available. It may have been removed, or you may no longer have access to it.",
} as const;
