// The application roles and what the admin app shows each one. These
// mirror the backend tiers (src/routes/admin.js); the backend stays the
// authoritative check, this only hides what a role can't use.
export const ROLES = {
    // The system owner (one, set in the database only): every ADMIN permission, plus managing Admin accounts.
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    // Exactly seven areas (not every ADMIN permission): Candidates (all of them), Need Attention, Work
    // Allocation, Jobs, Agents, Clients and the standard Daily Report. No ADMIN-only action within them.
    TEAM_LEAD: "TEAM_LEAD",
    ANALYST: "ANALYST",
    // The candidate registration workflow (Add Candidate) only.
    REGISTRATION_DESK: "REGISTRATION_DESK",
    // Manages Jobs, Agents and Clients; reads Candidates (changes no candidate record).
    JOB_HANDLER: "JOB_HANDLER",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = [ROLES.OWNER, ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER];

export const ROLE_LABELS: Record<Role, string> = {
    OWNER: "Owner",
    ADMIN: "Admin",
    TEAM_LEAD: "Team Lead",
    ANALYST: "Analyst",
    REGISTRATION_DESK: "Registration Desk",
    JOB_HANDLER: "Job Handler",
};

// Roles no longer supported (src/middleware/requireRole.js RETIRED_ROLES). Never offered in a role
// list; named only so history (audit entries) and an account not converted yet read clearly.
const RETIRED_ROLE_LABELS: Record<string, string> = {
    MANAGER: "Manager (retired)",
};

// The label for any stored role value: a supported role, a retired one, or the raw value.
export const roleLabel = (role: string): string => ROLE_LABELS[role as Role] ?? RETIRED_ROLE_LABELS[role] ?? role;

// Overview, Documents, Missing Documents, Review Queue, Police Workflow, Monthly overview
// (src/routes/admin.js DASHBOARD_READERS): ADMIN. An ANALYST works only on the candidates
// allocated to them: their workflow and Need Attention, nothing else.
export const DASHBOARD_ROLES: readonly Role[] = [ROLES.ADMIN];
// The Daily Report (src/routes/admin.js REPORT_READERS): ADMIN and TEAM_LEAD.
export const REPORT_VIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD];
export const REVIEW_ROLES: readonly Role[] = [ROLES.ADMIN];
// The Candidates area with its changes (details, stages, documents, call logs; src/routes/admin.js
// CANDIDATE_STAFF). Not REGISTRATION_DESK (registration only) and not JOB_HANDLER (read only).
export const CANDIDATE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.ANALYST];
// Opening the Candidates list and a candidate's page (CANDIDATE_READERS): JOB_HANDLER read only.
export const CANDIDATE_VIEW_ROLES: readonly Role[] = [...CANDIDATE_ROLES, ROLES.JOB_HANDLER];
export const CANDIDATE_LIST_ROLES: readonly Role[] = CANDIDATE_VIEW_ROLES;
// Need Attention: seeing it, and flagging and completing (the Candidates area roles; not
// REGISTRATION_DESK, whose only page is Add Candidate).
export const FOLLOW_UP_VIEW_ROLES: readonly Role[] = CANDIDATE_ROLES;
export const FOLLOW_UP_ROLES: readonly Role[] = CANDIDATE_ROLES;
// The REGISTRATION_DESK's own "Add Candidate" sidebar entry, its only page (the roles with the
// Candidates list reach registration from there and from the header).
export const REGISTRATION_ENTRY_ROLES: readonly Role[] = [ROLES.REGISTRATION_DESK];
// Administrators (an OWNER too): user management, Settings, Audit Logs, police-date
// corrections, job types, verification, deleting
// follow-ups, the job-group form link and Summary by Roles. Never TEAM_LEAD.
export const ADMIN_ONLY: readonly Role[] = [ROLES.ADMIN];
// Work Allocation (src/routes/admin.js ALLOCATION_MANAGERS): ADMIN and TEAM_LEAD.
export const ALLOCATION_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD];
// Registering a new candidate. Not ANALYST: an Analyst works only on the
// candidates allocated to them, and a new candidate is unallocated.
export const REGISTRATION_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.REGISTRATION_DESK];

type WithRole = { role: string } | null | undefined;

// OWNER holds every ADMIN permission: a list that admits ADMIN admits OWNER too (the backend's
// requireRole.js hasRole), so the lists here name ADMIN only. TEAM_LEAD inherits nothing: it is
// in a list only where the list names it.
export const hasRole = (user: WithRole, roles: readonly Role[]): boolean =>
    Boolean(user && ((roles as readonly string[]).includes(user.role) || (user.role === ROLES.OWNER && roles.includes(ROLES.ADMIN))));

// Overview, documents, review queue, clients, police workflow, reports.
export const canViewDashboard = (user: WithRole) => hasRole(user, DASHBOARD_ROLES);
// A candidate's page and its changes: details, stages, candidate documents
// and call logs (not JOB_HANDLER, not REGISTRATION_DESK).
export const canManageCandidates = (user: WithRole) => hasRole(user, CANDIDATE_ROLES);
// Opening a candidate's page (JOB_HANDLER: read only; a link to one is shown only to these roles).
export const canViewCandidates = (user: WithRole) => hasRole(user, CANDIDATE_VIEW_ROLES);
// The Candidates list.
export const canListCandidates = (user: WithRole) => hasRole(user, CANDIDATE_LIST_ROLES);
// Need Attention: opening it, and flagging / completing.
export const canViewFollowUps = (user: WithRole) => hasRole(user, FOLLOW_UP_VIEW_ROLES);
export const canWorkFollowUps = (user: WithRole) => hasRole(user, FOLLOW_UP_ROLES);
// Review actions and corrections.
export const canReview = (user: WithRole) => hasRole(user, REVIEW_ROLES);
// Setting or correcting a police slip's submitted date: ADMIN only.
export const canCorrectPoliceDates = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Deleting a Priority Follow-Up (flagging and completing: every Candidates role): ADMIN only.
export const canDeleteFollowUps = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Verifying a candidate's details or documents (Candidate details / Document submission): ADMIN only.
export const canVerifyCandidate = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Recording a candidate's final status (Departed, Visa Not Going, Cancelled, Rejected) on the candidate page: ADMIN only.
export const canSetFinalStatus = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Work Allocation (the page and its API): ADMIN and TEAM_LEAD.
export const canManageAllocations = (user: WithRole) => hasRole(user, ALLOCATION_ROLES);
// "My allocated" on the Candidates list: a Team Lead sees every candidate, and an ADMIN may allocate
// candidates to them; this narrows the list to their own (the Officer filter, analystId = themselves).
export const canFilterOwnAllocations = (user: WithRole) => hasRole(user, [ROLES.TEAM_LEAD]);
// The standard Daily Report (ADMIN, TEAM_LEAD), and its Summary by Roles view (ADMIN only).
export const canViewDailyReport = (user: WithRole) => hasRole(user, REPORT_VIEW_ROLES);
export const canViewRoleReport = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Jobs: ADMIN, TEAM_LEAD and JOB_HANDLER. No Jobs area for ANALYST or REGISTRATION_DESK.
export const JOB_VIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.JOB_HANDLER];
export const JOB_MANAGE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.JOB_HANDLER];
// Creating a job type (the New job dialog's "Add job type"): ADMIN only, not JOB_HANDLER.
export const canCreateJobTypes = (user: WithRole) => hasRole(user, ADMIN_ONLY);
export const canViewJobs = (user: WithRole) => hasRole(user, JOB_VIEW_ROLES);
// The last two digits of a Job created by the sheet upload (the server also limits an Analyst to a Job
// holding one of their candidates).
export const canEditImportJobSuffix = (user: WithRole) => hasRole(user, [ROLES.ADMIN, ROLES.JOB_HANDLER, ROLES.ANALYST]);
export const canManageJobs = (user: WithRole) => hasRole(user, JOB_MANAGE_ROLES);
// Confirming / rejecting a candidate-submitted Candidate Form value into the candidate's record
// (src/routes/admin.js FORM_REVIEWERS): ADMIN, TEAM_LEAD and ANALYST (an Analyst only on the candidates
// allocated to them, which is all their candidate pages show). JOB_HANDLER sees the change but cannot apply it.
export const FORM_REVIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.ANALYST];
export const canConfirmSubmittedChanges = (user: WithRole) => hasRole(user, FORM_REVIEW_ROLES);
// The job-group Candidate Form link (Share Form > job group): ADMIN only.
export const canShareJobGroupForm = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// "Assign to Job" on the candidate's page: an ADMIN workflow (ADMIN only). Job managers (TEAM_LEAD and
// JOB_HANDLER) assign candidates from the Job's own page, which is the Jobs feature.
export const canAssignJobFromCandidatePage = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Agents and Client Management (the employer clients): ADMIN, TEAM_LEAD and JOB_HANDLER,
// for reading and writing. The other roles get no entry and the API answers 403.
export const MASTER_DATA_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.JOB_HANDLER];
export const canManageMasterData = (user: WithRole) => hasRole(user, MASTER_DATA_ROLES);
// Registering a new candidate.
export const canRegisterCandidates = (user: WithRole) => hasRole(user, REGISTRATION_ROLES);
// What the header's notification bell reads. Every role has the bell. The review queue's role (ADMIN):
// the review queue (GET /review). TEAM_LEAD and ANALYST: their open Need Attention follow-ups (GET
// /follow-ups; an Analyst's are their own candidates'), never the review queue, which they can't
// open. Every other role (REGISTRATION_DESK, JOB_HANDLER): "none", an empty bell that requests
// nothing, until that role has a feed of its own.
export type NotificationSource = "review" | "follow-ups" | "none";
export const FOLLOW_UP_NOTIFICATION_ROLES: readonly Role[] = [ROLES.TEAM_LEAD, ROLES.ANALYST];
export const notificationSource = (user: WithRole): NotificationSource =>
    hasRole(user, REVIEW_ROLES) ? "review" : hasRole(user, FOLLOW_UP_NOTIFICATION_ROLES) ? "follow-ups" : "none";
// Where a signed-in role lands ("/"), and where a page it can't open sends it: the Overview for
// the dashboard roles (null), otherwise its own first area.
export const landingPath = (user: WithRole): string | null =>
    canViewDashboard(user) ? null : hasRole(user, [ROLES.JOB_HANDLER]) ? "/jobs" : hasRole(user, REGISTRATION_ENTRY_ROLES) ? "/candidates/new" : "/candidates";
// User management and Settings (an OWNER too).
export const isAdmin = (user: WithRole) => hasRole(user, ADMIN_ONLY);
export const isOwner = (user: WithRole) => user?.role === ROLES.OWNER;
// Upload in Settings > Google Sheet Sync (the bulk candidate import, src/routes/candidateImport.js):
// ADMIN only, like every Settings tab.
export const canImportCandidates = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// User management (src/middleware/requireRole.js ASSIGNABLE_ROLES): an OWNER changes every account
// and gives, or invites, every role but the Owner's; an ADMIN only the accounts and roles below
// ADMIN (never another Admin). Nobody gives the Owner role or changes an Owner account in the app:
// the Owner is set in the database only. TEAM_LEAD is below ADMIN and manages no account.
// The server enforces all of it.
const BELOW_ADMIN: readonly Role[] = [ROLES.TEAM_LEAD, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER];
const BELOW_OWNER: readonly Role[] = [ROLES.ADMIN, ...BELOW_ADMIN];
// The roles the user may give in Change Roles, and invite in Invite User.
export const assignableRoles = (user: WithRole): readonly Role[] => (isOwner(user) ? BELOW_OWNER : isAdmin(user) ? BELOW_ADMIN : []);
export const invitableRoles = assignableRoles;
export const canInviteUsers = isAdmin;
// Whether the user may change `target`'s NAME (only the name): their own always (the profile); another
// user's when they are an OWNER or ADMIN and the target is not the Owner (an ADMIN may rename another ADMIN).
// The server enforces it (userAccountService.js updateUserName).
export const canRenameUser = (user: (WithRole & { userId?: string }) | null | undefined, target: { userId: string; role: string }) =>
    Boolean(user && (user.userId === target.userId || (isAdmin(user) && target.role !== ROLES.OWNER)));
// Whether the user may change `target` (its role, its status, a re-invite): never their own
// account, never an Owner's. An account holding a retired role: an OWNER only.
export const canManageUser = (user: (WithRole & { userId?: string }) | null | undefined, target: { userId: string; role: string }) =>
    Boolean(user && user.userId !== target.userId && target.role !== ROLES.OWNER && (isOwner(user) || (assignableRoles(user) as readonly string[]).includes(target.role)));
