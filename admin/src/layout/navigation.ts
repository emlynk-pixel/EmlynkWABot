import type { IconName } from "../components/Icon";
import { ADMIN_ONLY, CANDIDATE_ROLES, DASHBOARD_ROLES, type Role } from "../auth/roles";

// Sidebar entries, in the order of the Stitch design, plus Missing Documents
// and Daily Report (Phase 10 scope, same design language), and Settings
// (ADMIN only) last. Settings holds sections such as Google Sheet Sync; new
// system settings become sections of that page, never new sidebar entries.
// `roles`: who sees the entry, the same tiers the backend enforces
// (src/routes/admin.js); the backend remains the authoritative check.
export type NavItem = { to: string; label: string; icon: IconName; end?: boolean; roles: readonly Role[] };

export const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Overview", icon: "dashboard", end: true, roles: DASHBOARD_ROLES },
    { to: "/documents", label: "Documents", icon: "description", roles: DASHBOARD_ROLES },
    { to: "/review", label: "Review Queue", icon: "fact_check", roles: DASHBOARD_ROLES },
    { to: "/candidates", label: "Candidates", icon: "group", roles: CANDIDATE_ROLES },
    { to: "/missing-documents", label: "Missing Documents", icon: "assignment_late", roles: DASHBOARD_ROLES },
    { to: "/police", label: "Police Workflow", icon: "local_police", roles: DASHBOARD_ROLES },
    { to: "/reports/daily", label: "Daily Report", icon: "summarize", roles: DASHBOARD_ROLES },
    { to: "/invitations", label: "Invite User", icon: "person_add", roles: ADMIN_ONLY },
    { to: "/roles", label: "Change Roles", icon: "manage_accounts", roles: ADMIN_ONLY },
    { to: "/settings", label: "Settings", icon: "settings", roles: ADMIN_ONLY },
];
