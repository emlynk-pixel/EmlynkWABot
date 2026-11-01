import type { IconName } from "../components/Icon";
import { ADMIN_ONLY, CANDIDATE_ROLES, CANDIDATE_VIEW_ROLES, DASHBOARD_ROLES, JOB_VIEW_ROLES, MASTER_DATA_ROLES, REPORT_VIEW_ROLES, ALLOCATION_ROLES, type Role } from "../auth/roles";

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
    // Every Candidates role, plus JOB_HANDLER (read only).
    { to: "/candidates", label: "Candidates", icon: "group", roles: CANDIDATE_VIEW_ROLES },
    // Call logs marked as needing attention (every Candidates role).
    { to: "/follow-ups", label: "Need Attention", icon: "flag", roles: CANDIDATE_ROLES },
    // Jobs and the candidates assigned to them (ADMIN, TEAM_LEAD and JOB_HANDLER manage; ANALYST reads their own).
    { to: "/jobs", label: "Jobs", icon: "work", roles: JOB_VIEW_ROLES },
    // The recruiting partners and the employer clients they manage (ADMIN, TEAM_LEAD, JOB_HANDLER). The
    // technical route is /client-management: /clients is the candidate-documents area.
    { to: "/agents", label: "Agents", icon: "support_agent", roles: MASTER_DATA_ROLES },
    { to: "/client-management", label: "Client Management", icon: "apartment", roles: MASTER_DATA_ROLES },
    // Assigning candidates to Analysts (ADMIN and TEAM_LEAD).
    { to: "/work-allocation", label: "Work Allocation", icon: "assignment_ind", roles: ALLOCATION_ROLES },
    { to: "/missing-documents", label: "Missing Documents", icon: "assignment_late", roles: DASHBOARD_ROLES },
    { to: "/police", label: "Police Workflow", icon: "local_police", roles: DASHBOARD_ROLES },
    // The dashboard roles plus TEAM_LEAD.
    { to: "/reports/daily", label: "Daily Report", icon: "summarize", roles: REPORT_VIEW_ROLES },
    { to: "/audit-logs", label: "Audit Logs", icon: "history", roles: ADMIN_ONLY },
    // ADMIN: every tab (Invite User included).
    { to: "/settings", label: "Settings", icon: "settings", roles: ADMIN_ONLY },
];

// Settings' tabs, one URL each (SettingsPage.tsx); the breadcrumb names them too.
// `roles`: who sees and opens the tab (the backend enforces the same per API route).
export const SETTINGS_TABS: readonly { to: string; label: string; roles: readonly Role[] }[] = [
    { to: "/settings/roles", label: "Change Roles", roles: ADMIN_ONLY },
    { to: "/settings/invite", label: "Invite User", roles: ADMIN_ONLY },
    { to: "/settings/sheet-sync", label: "Google Sheet Sync", roles: ADMIN_ONLY },
    { to: "/settings/job-types", label: "Job Types", roles: ADMIN_ONLY },
];
