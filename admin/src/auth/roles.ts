// The four application roles and what the admin app shows each one. These
// mirror the backend tiers (src/routes/admin.js); the backend stays the
// authoritative check, this only hides what a role can't use.
export const ROLES = {
    ADMIN: "ADMIN",
    MANAGER: "MANAGER",
    ANALYST: "ANALYST",
    REGISTRATION_DESK: "REGISTRATION_DESK",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST, ROLES.REGISTRATION_DESK];

export const ROLE_LABELS: Record<Role, string> = {
    ADMIN: "Admin",
    MANAGER: "Manager",
    ANALYST: "Analyst",
    REGISTRATION_DESK: "Registration Desk",
};

export const DASHBOARD_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST];
export const REVIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST];
export const POLICE_DATE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const CANDIDATE_ROLES: readonly Role[] = ALL_ROLES;
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
// documents and call logs (every role, REGISTRATION_DESK included).
export const canManageCandidates = (user: WithRole) => hasRole(user, CANDIDATE_ROLES);
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
// Jobs: ADMIN and MANAGER manage them; an ANALYST reads the jobs holding their
// own candidates (the server scopes the lists). REGISTRATION_DESK: no Jobs area.
export const JOB_VIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.ANALYST];
export const JOB_MANAGE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const canViewJobs = (user: WithRole) => hasRole(user, JOB_VIEW_ROLES);
export const canManageJobs = (user: WithRole) => hasRole(user, JOB_MANAGE_ROLES);
// Agents and Client Management (the employer clients): ADMIN and MANAGER only,
// for reading and writing. The other roles get no entry and the API answers 403.
export const MASTER_DATA_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.MANAGER];
export const canManageMasterData = (user: WithRole) => hasRole(user, MASTER_DATA_ROLES);
// Registering a new candidate.
export const canRegisterCandidates = (user: WithRole) => hasRole(user, REGISTRATION_ROLES);
// User management and Settings.
export const isAdmin = (user: WithRole) => hasRole(user, ADMIN_ONLY);
