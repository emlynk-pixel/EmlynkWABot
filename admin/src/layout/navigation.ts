import type { IconName } from "../components/Icon";

// Sidebar entries, in the order of the Stitch design, plus Missing Documents
// and Daily Report (Phase 10 scope, same design language). There is no
// Settings page.
export type NavItem = { to: string; label: string; icon: IconName; end?: boolean };

export const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Overview", icon: "dashboard", end: true },
    { to: "/documents", label: "Documents", icon: "description" },
    { to: "/review", label: "Review Queue", icon: "fact_check" },
    { to: "/clients", label: "Clients", icon: "group" },
    { to: "/missing-documents", label: "Missing Documents", icon: "assignment_late" },
    { to: "/police", label: "Police Workflow", icon: "local_police" },
    { to: "/reports/daily", label: "Daily Report", icon: "summarize" },
];
