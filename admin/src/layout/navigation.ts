import type { IconName } from "../components/Icon";

// Sidebar entries, in the order of the Stitch design. Settings is left out
// until it exists (not part of Phase 10 Checkpoint 1).
export type NavItem = { to: string; label: string; icon: IconName; end?: boolean };

export const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Overview", icon: "dashboard", end: true },
    { to: "/documents", label: "Documents", icon: "description" },
    { to: "/review", label: "Review Queue", icon: "fact_check" },
    { to: "/clients", label: "Clients", icon: "group" },
    { to: "/police", label: "Police Workflow", icon: "local_police" },
];
