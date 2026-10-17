import type { IconName } from "../components/Icon";
import { ADMIN_ONLY, ALLOCATION_ROLES, CANDIDATE_ROLES, DASHBOARD_ROLES, JOB_VIEW_ROLES, type Role } from "../auth/roles";

// Sidebar entries, in the order of the Stitch design, plus Missing Documents
// and Daily Report (Phase 10 scope, same design language), Audit Logs
// (ADMIN only, read-only), and Settings (ADMIN only) last. Settings holds
// Configurations, Change Roles, Invite User and Google Sheet Sync as tabs
// (SettingsPage.tsx); new system settings become tabs or sections there,
// never new sidebar entries.
// `roles`: who sees the entry, the same tiers the backend enforces
// (src/routes/admin.js); the backend remains the authoritative check.
export type NavItem = { to: string; label: string; icon: IconName; end?: boolean; roles: readonly Role[] };

export const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Overview", icon: "dashboard", end: true, roles: DASHBOARD_ROLES },
    { to: "/documents", label: "Documents", icon: "description", roles: DASHBOARD_ROLES },
    { to: "/review", label: "Review Queue", icon: "fact_check", roles: DASHBOARD_ROLES },
    { to: "/candidates", label: "Candidates", icon: "group", roles: CANDIDATE_ROLES },
    // Call logs marked as needing attention (every Candidates role).
    { to: "/follow-ups", label: "Need Attention", icon: "flag", roles: CANDIDATE_ROLES },
    // Jobs and the candidates assigned to them (ADMIN and MANAGER manage; ANALYST reads their own).
    { to: "/jobs", label: "Jobs", icon: "work", roles: JOB_VIEW_ROLES },
    // Assigning candidates to Analysts (ADMIN and MANAGER).
    { to: "/work-allocation", label: "Work Allocation", icon: "assignment_ind", roles: ALLOCATION_ROLES },
    { to: "/missing-documents", label: "Missing Documents", icon: "assignment_late", roles: DASHBOARD_ROLES },
    { to: "/police", label: "Police Workflow", icon: "local_police", roles: DASHBOARD_ROLES },
    { to: "/reports/daily", label: "Daily Report", icon: "summarize", roles: DASHBOARD_ROLES },
    { to: "/audit-logs", label: "Audit Logs", icon: "history", roles: ADMIN_ONLY },
    { to: "/settings", label: "Settings", icon: "settings", roles: ADMIN_ONLY },
];
