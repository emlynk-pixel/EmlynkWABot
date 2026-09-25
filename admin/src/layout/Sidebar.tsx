import { NavLink } from "react-router";
import { Icon } from "../components/Icon";
import { NAV_ITEMS } from "./navigation";

type SidebarProps = {
    collapsed: boolean;
    mobileOpen: boolean;
    onToggleCollapsed: () => void;
    onNavigate: () => void;
};

// Dark workspace sidebar (Stitch: 240px, collapsible to a 64px icon rail).
// Below md it becomes an off-canvas drawer opened from the header.
export function Sidebar({ collapsed, mobileOpen, onToggleCollapsed, onNavigate }: SidebarProps) {
    const railOnly = collapsed && !mobileOpen;

    return (
        <aside
            id="admin-sidebar"
            className={[
                "fixed inset-y-0 left-0 z-50 flex flex-col bg-sidebar text-sidebar-text transition-[width,transform] duration-200",
                mobileOpen ? "w-sidebar translate-x-0" : "-translate-x-full md:translate-x-0",
                railOnly ? "md:w-sidebar-rail" : "md:w-sidebar",
            ].join(" ")}
        >
            <div className="flex h-header shrink-0 items-center gap-3 border-b border-sidebar-hover px-4">
                <span className="flex size-8 shrink-0 items-center justify-center rounded bg-primary font-semibold text-on-primary">E</span>
                {!railOnly && (
                    <div className="min-w-0">
                        <p className="truncate text-label-md text-sidebar-text-active">EmlynkWABot</p>
                        <p className="text-label-caps uppercase text-sidebar-text">Admin Console</p>
                    </div>
                )}
            </div>

            <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2 py-3">
                <ul className="space-y-1">
                    {NAV_ITEMS.map((item) => (
                        <li key={item.to}>
                            <NavLink
                                to={item.to}
                                end={item.end}
                                onClick={onNavigate}
                                title={railOnly ? item.label : undefined}
                                className={({ isActive }) =>
                                    [
                                        "relative flex h-9 items-center gap-3 rounded px-3 text-label-md transition-colors",
                                        isActive
                                            ? "bg-sidebar-hover text-sidebar-text-active before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded before:bg-primary"
                                            : "hover:bg-sidebar-hover hover:text-sidebar-text-active",
                                        railOnly ? "justify-center px-0" : "",
                                    ].join(" ")
                                }
                            >
                                <Icon name={item.icon} className="size-5" />
                                {railOnly ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
                            </NavLink>
                        </li>
                    ))}
                </ul>
            </nav>

            <div className="hidden border-t border-sidebar-hover p-2 md:block">
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    aria-controls="admin-sidebar"
                    aria-expanded={!collapsed}
                    className={[
                        "flex h-9 w-full items-center gap-3 rounded px-3 text-label-md hover:bg-sidebar-hover hover:text-sidebar-text-active",
                        railOnly ? "justify-center px-0" : "",
                    ].join(" ")}
                >
                    <Icon name="chevron_left" className={`size-5 transition-transform ${collapsed ? "rotate-180" : ""}`} />
                    {railOnly ? <span className="sr-only">Expand sidebar</span> : <span>Collapse</span>}
                </button>
            </div>
        </aside>
    );
}
