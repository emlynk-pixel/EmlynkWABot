// The application roles and what the admin app shows each one. These
// mirror the backend tiers (src/routes/admin.js); the backend stays the
// authoritative check, this only hides what a role can't use.
export const ROLES = {
    // The system owner (one, set in the database only): every ADMIN permission, plus managing Admin accounts.
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    ANALYST: "ANALYST",
    REGISTRATION_DESK: "REGISTRATION_DESK",
    // Manages Jobs, Agents and Clients; reads Candidates (changes no candidate record).
    JOB_HANDLER: "JOB_HANDLER",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = [ROLES.OWNER, ROLES.ADMIN, ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER];

export const ROLE_LABELS: Record<Role, string> = {
    OWNER: "Owner",
    ADMIN: "Admin",
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

export const DASHBOARD_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.ANALYST];
export const REVIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.ANALYST];
// The Candidates area with its changes (registration, details, stages, documents, call logs).
// Listed explicitly: JOB_HANDLER is NOT here (it only reads candidates: CANDIDATE_VIEW_ROLES).
export const CANDIDATE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.ANALYST, ROLES.REGISTRATION_DESK];
// Opening the Candidates list and a candidate's page (read only for JOB_HANDLER).
export const CANDIDATE_VIEW_ROLES: readonly Role[] = [...CANDIDATE_ROLES, ROLES.JOB_HANDLER];
// Administrators (an OWNER too): user management, Settings, Audit Logs, Work Allocation,
// verification, police-date corrections, confirming Candidate Form values, deleting
// follow-ups, job types and the job-group form link.
export const ADMIN_ONLY: readonly Role[] = [ROLES.ADMIN];
// Registering a new candidate. Not ANALYST: an Analyst works only on the
// candidates allocated to them, and a new candidate is unallocated.
export const REGISTRATION_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.REGISTRATION_DESK];

type WithRole = { role: string } | null | undefined;

// OWNER holds every ADMIN permission: a list that admits ADMIN admits OWNER too (the backend's
// requireRole.js hasRole), so the lists here name ADMIN only.
export const hasRole = (user: WithRole, roles: readonly Role[]): boolean =>
    Boolean(user && ((roles as readonly string[]).includes(user.role) || (user.role === ROLES.OWNER && roles.includes(ROLES.ADMIN))));

// Overview, documents, review queue, clients, police workflow, reports.
export const canViewDashboard = (user: WithRole) => hasRole(user, DASHBOARD_ROLES);
// The whole Candidates area: registration, details, stages, candidate
// documents and call logs (every role but JOB_HANDLER, REGISTRATION_DESK included).
export const canManageCandidates = (user: WithRole) => hasRole(user, CANDIDATE_ROLES);
// Opening Candidates at all (JOB_HANDLER: read only; canManageCandidates decides the changes).
export const canViewCandidates = (user: WithRole) => hasRole(user, CANDIDATE_VIEW_ROLES);
// Review actions and corrections.
export const canReview = (user: WithRole) => hasRole(user, REVIEW_ROLES);
// Setting or correcting a police slip's submitted date: ADMIN only.
export const canCorrectPoliceDates = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Deleting a Priority Follow-Up (flagging and completing: every Candidates role): ADMIN only.
export const canDeleteFollowUps = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Verifying a candidate's details or documents (Candidate details / Document submission): ADMIN only.
export const canVerifyCandidate = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Work Allocation (the page and its API): ADMIN only.
export const canManageAllocations = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Jobs: ADMIN and JOB_HANDLER manage them; an ANALYST reads the jobs holding
// their own candidates (the server scopes the lists). REGISTRATION_DESK: no Jobs area.
export const JOB_VIEW_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.ANALYST, ROLES.JOB_HANDLER];
export const JOB_MANAGE_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.JOB_HANDLER];
// Creating a job type (the New job dialog's "Add job type"): ADMIN only, not JOB_HANDLER.
export const canCreateJobTypes = (user: WithRole) => hasRole(user, ADMIN_ONLY);
export const canViewJobs = (user: WithRole) => hasRole(user, JOB_VIEW_ROLES);
export const canManageJobs = (user: WithRole) => hasRole(user, JOB_MANAGE_ROLES);
// Confirming a candidate-submitted Candidate Form value into the candidate's record (one field at a time):
// ADMIN only. Analysts and the Registration Desk see the submitted change but cannot apply it.
export const canConfirmSubmittedChanges = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// Agents and Client Management (the employer clients): ADMIN and JOB_HANDLER,
// for reading and writing. The other roles get no entry and the API answers 403.
export const MASTER_DATA_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.JOB_HANDLER];
export const canManageMasterData = (user: WithRole) => hasRole(user, MASTER_DATA_ROLES);
// Registering a new candidate.
export const canRegisterCandidates = (user: WithRole) => hasRole(user, REGISTRATION_ROLES);
// User management and Settings (an OWNER too).
export const isAdmin = (user: WithRole) => hasRole(user, ADMIN_ONLY);
export const isOwner = (user: WithRole) => user?.role === ROLES.OWNER;
// Upload in Settings > Google Sheet Sync (the bulk candidate import, src/routes/candidateImport.js):
// ADMIN only, like every Settings tab.
export const canImportCandidates = (user: WithRole) => hasRole(user, ADMIN_ONLY);
// User management (src/middleware/requireRole.js ASSIGNABLE_ROLES): an OWNER changes every account
// and gives, or invites, every role but the Owner's; an ADMIN only the accounts and roles below
// ADMIN (never another Admin). Nobody gives the Owner role or changes an Owner account in the app:
// the Owner is set in the database only. The server enforces all of it.
const BELOW_ADMIN: readonly Role[] = [ROLES.ANALYST, ROLES.REGISTRATION_DESK, ROLES.JOB_HANDLER];
const BELOW_OWNER: readonly Role[] = [ROLES.ADMIN, ...BELOW_ADMIN];
// The roles the user may give in Change Roles, and invite in Invite User.
export const assignableRoles = (user: WithRole): readonly Role[] => (isOwner(user) ? BELOW_OWNER : isAdmin(user) ? BELOW_ADMIN : []);
export const invitableRoles = assignableRoles;
export const canInviteUsers = isAdmin;
// Whether the user may change `target` (its role, its status, a re-invite): never their own
// account, never an Owner's. An account holding a retired role: an OWNER only.
export const canManageUser = (user: (WithRole & { userId?: string }) | null | undefined, target: { userId: string; role: string }) =>
    Boolean(user && user.userId !== target.userId && target.role !== ROLES.OWNER && (isOwner(user) || (assignableRoles(user) as readonly string[]).includes(target.role)));
