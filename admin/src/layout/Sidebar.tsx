import { NavLink } from "react-router";
import logo from "../assets/emops-on-dark.svg";
import emMark from "../assets/em-mark-on-dark.svg";
import { useAuth } from "../auth/AuthProvider";
import { hasRole } from "../auth/roles";
import { Icon } from "../components/Icon";
import { AccountMenu } from "./AccountMenu";
import { NAV_ITEMS, type NavItem } from "./navigation";

type SidebarProps = {
    collapsed: boolean;
    mobileOpen: boolean;
    onNavigate: () => void;
};

function NavGroup({ label, items, railOnly, onNavigate }: { label: string; items: NavItem[]; railOnly: boolean; onNavigate: () => void }) {
    if (items.length === 0) return null;
    return (
        <div className="p-2">
            {!railOnly && <p className="flex h-8 items-center px-2 text-label-sm text-sidebar-text-muted">{label}</p>}
            <ul>
                {items.map((item) => (
                    <li key={item.to}>
                        <NavLink
                            to={item.to}
                            end={item.end}
                            onClick={onNavigate}
                            title={railOnly ? item.label : undefined}
                            className={({ isActive }) =>
                                [
                                    "flex h-8 items-center gap-2 rounded-md px-2 text-body-sm transition-colors",
                                    isActive
                                        ? "bg-sidebar-hover font-medium text-sidebar-text-active"
                                        : "hover:bg-sidebar-hover hover:text-sidebar-text-active",
                                    railOnly ? "justify-center px-0" : "",
                                ].join(" ")
                            }
                        >
                            <Icon name={item.icon} />
                            {railOnly ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
                        </NavLink>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// The slate sidebar: 256px, collapsible to a 48px icon rail with the EM mark.
// The panel icon in the header collapses it (Header.tsx); below md it becomes an
// off-canvas drawer opened from the same icon.
export function Sidebar({ collapsed, mobileOpen, onNavigate }: SidebarProps) {
    const railOnly = collapsed && !mobileOpen;
    const { user } = useAuth();
    // Only the entries this role can use; the backend remains the authoritative gate.
    const visibleItems = NAV_ITEMS.filter((item) => hasRole(user, item.roles));

    return (
        <aside
            id="admin-sidebar"
            className={[
                "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-text transition-[width,transform] duration-200 ease-linear",
                mobileOpen ? "w-sidebar translate-x-0" : "-translate-x-full md:translate-x-0",
                railOnly ? "md:w-sidebar-rail" : "md:w-sidebar",
            ].join(" ")}
        >
            <div className="flex h-[4.5rem] shrink-0 items-center justify-center">
                {railOnly
                    ? <img src={emMark} alt="EM" width={28} height={16} className="h-auto w-7" />
                    : <img src={logo} alt="EMOPS by EMLYNK" width={136} height={53} className="h-auto w-[136px]" />}
            </div>

            <nav aria-label="Main navigation" className="flex-1 overflow-y-auto">
                <NavGroup label="Workspace" items={visibleItems.filter((item) => !item.group)} railOnly={railOnly} onNavigate={onNavigate} />
                <NavGroup label="Configuration" items={visibleItems.filter((item) => item.group === "Configuration")} railOnly={railOnly} onNavigate={onNavigate} />
            </nav>

            <div className="border-t border-sidebar-border p-2">
                <AccountMenu railOnly={railOnly} />
            </div>
        </aside>
    );
}
