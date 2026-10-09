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
// User management and Settings.
export const isAdmin = (user: WithRole) => hasRole(user, ADMIN_ONLY);
