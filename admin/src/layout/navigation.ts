import type { IconName } from "../components/Icon";

// Sidebar entries, in the order of the Stitch design, plus Missing Documents
// and Daily Report (Phase 10 scope, same design language), and Settings
// (ADMIN only) last. Settings holds sections such as Google Sheet Sync; new
// system settings become sections of that page, never new sidebar entries.
export type NavItem = { to: string; label: string; icon: IconName; end?: boolean; adminOnly?: boolean };

export const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Overview", icon: "dashboard", end: true },
    { to: "/documents", label: "Documents", icon: "description" },
    { to: "/review", label: "Review Queue", icon: "fact_check" },
    { to: "/candidates", label: "Candidates", icon: "group" },
    { to: "/missing-documents", label: "Missing Documents", icon: "assignment_late" },
    { to: "/police", label: "Police Workflow", icon: "local_police" },
    { to: "/reports/daily", label: "Daily Report", icon: "summarize" },
    // AUDIT-004: Invitations was only reachable via the header button;
    // added here so the sidebar links ADMIN-role users to the full page.
    // adminOnly: true hides this entry from VIEW_ONLY-role users.
    { to: "/invitations", label: "Invite Admin", icon: "person_add", adminOnly: true },
    { to: "/roles", label: "Change Roles", icon: "manage_accounts", adminOnly: true },
    { to: "/settings", label: "Settings", icon: "settings", adminOnly: true },
];
