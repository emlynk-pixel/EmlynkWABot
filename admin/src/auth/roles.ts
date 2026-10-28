// The five application roles and what the admin app shows each one. These
// mirror the backend tiers (src/routes/admin.js); the backend stays the
// authoritative check, this only hides what a role can't use.
export const ROLES = {
    ADMIN: "ADMIN",
    MANAGER: "MANAGER",
    ANALYST: "ANALYST",
    REGISTRATION_DESK: "REGISTRATION_DESK",
    // Manages Jobs, Agents and Clients; reads Candidates (changes no candidate record).
    JOB_HANDLER: "JOB_HANDLER",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER];

export const ROLE_LABELS: Record<Role, string> = {
    ADMIN: "Admin",
    MANAGER: "Manager",
    ANALYST: "Analyst",
    REGISTRATION_DESK: "Registration Desk",
    JOB_HANDLER: "Job Handler",
};

export const DASHBOARD_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST];
export const REVIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST];
export const POLICE_DATE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
// The Candidates area with its changes (registration, details, stages, documents, call logs).
// Listed explicitly: JOB_HANDLER is NOT here (it only reads candidates: CANDIDATE_VIEW_ROLES).
export const CANDIDATE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST, ROLES.REGISTRATION_DESK];
// Opening the Candidates list and a candidate's page (read only for JOB_HANDLER).
export const CANDIDATE_VIEW_ROLES: readonly Role[] = [...CANDIDATE_ROLES, ROLES.JOB_HANDLER];
export const ADMIN_ONLY: readonly Role[] = [ROLES.ADMIN];
// Permanently deleting a Priority Follow-Up (the call log is always kept).
export const FOLLOW_UP_DELETE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
// Work Allocation: assigning candidates to Analysts.
export const ALLOCATION_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
// Registering a new candidate. Not ANALYST: an Analyst works only on the
// candidates allocated to them, and a new candidate is unallocated.
export const REGISTRATION_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.REGISTRATION_DESK];

type WithRole = { role: string } | null | undefined;

export const hasRole = (user: WithRole, roles: readonly Role[]): boolean => Boolean(user && (roles as readonly string[]).includes(user.role));

// Overview, documents, review queue, clients, police workflow, reports.
export const canViewDashboard = (user: WithRole) => hasRole(user, DASHBOARD_ROLES);
// The whole Candidates area: registration, details, stages, candidate
// documents and call logs (every role but JOB_HANDLER, REGISTRATION_DESK included).
export const canManageCandidates = (user: WithRole) => hasRole(user, CANDIDATE_ROLES);
// Opening Candidates at all (JOB_HANDLER: read only; canManageCandidates decides the changes).
export const canViewCandidates = (user: WithRole) => hasRole(user, CANDIDATE_VIEW_ROLES);
// Review actions and corrections.
export const canReview = (user: WithRole) => hasRole(user, REVIEW_ROLES);
// Setting or correcting a police slip's submitted date.
export const canCorrectPoliceDates = (user: WithRole) => hasRole(user, POLICE_DATE_ROLES);
// Deleting a Priority Follow-Up (flagging and completing: every Candidates role).
export const canDeleteFollowUps = (user: WithRole) => hasRole(user, FOLLOW_UP_DELETE_ROLES);
// Verifying a candidate's details or documents (Candidate details / Document submission): ADMIN and MANAGER.
export const canVerifyCandidate = (user: WithRole) => hasRole(user, POLICE_DATE_ROLES);
// Work Allocation (the page and its API).
export const canManageAllocations = (user: WithRole) => hasRole(user, ALLOCATION_ROLES);
// Jobs: ADMIN, MANAGER and JOB_HANDLER manage them; an ANALYST reads the jobs holding
// their own candidates (the server scopes the lists). REGISTRATION_DESK: no Jobs area.
export const JOB_VIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST, ROLES.JOB_HANDLER];
export const JOB_MANAGE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.JOB_HANDLER];
// Creating a job type (the New job dialog's "Add job type"): ADMIN and MANAGER, not JOB_HANDLER.
export const JOB_TYPE_CREATE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const canCreateJobTypes = (user: WithRole) => hasRole(user, JOB_TYPE_CREATE_ROLES);
export const canViewJobs = (user: WithRole) => hasRole(user, JOB_VIEW_ROLES);
export const canManageJobs = (user: WithRole) => hasRole(user, JOB_MANAGE_ROLES);
// Confirming a candidate-submitted Candidate Form value into the candidate's record (one field at a time).
// Analysts and the Registration Desk see the submitted change but cannot apply it.
export const CONFIRM_SUBMITTED_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const canConfirmSubmittedChanges = (user: WithRole) => hasRole(user, CONFIRM_SUBMITTED_ROLES);
// Agents and Client Management (the employer clients): ADMIN, MANAGER and JOB_HANDLER,
// for reading and writing. The other roles get no entry and the API answers 403.
export const MASTER_DATA_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.JOB_HANDLER];
export const canManageMasterData = (user: WithRole) => hasRole(user, MASTER_DATA_ROLES);
// Registering a new candidate.
export const canRegisterCandidates = (user: WithRole) => hasRole(user, REGISTRATION_ROLES);
// User management and Settings.
export const isAdmin = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Settings > Google Sheet Sync (src/routes/sheetSyncSettings.js): ADMIN, and MANAGER for the status
// and Update Sheet (the bulk candidate import). Test Connection, Sync Now and the destination stay ADMIN.
// A MANAGER sees no other Settings tab.
export const SHEET_SYNC_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const canOpenSheetSync = (user: WithRole) => hasRole(user, SHEET_SYNC_ROLES);
export const canImportCandidates = (user: WithRole) => hasRole(user, SHEET_SYNC_ROLES);
// Inviting users (src/middleware/requireRole.js INVITABLE_ROLES): ADMIN any role, MANAGER a
// new Job Handler only. The server enforces it.
export const INVITE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const canInviteUsers = (user: WithRole) => hasRole(user, INVITE_ROLES);
export const invitableRoles = (user: WithRole): readonly Role[] => (isAdmin(user) ? ALL_ROLES : hasRole(user, [ROLES.MANAGER]) ? [ROLES.JOB_HANDLER] : []);
