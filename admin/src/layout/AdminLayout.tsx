import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

const COLLAPSED_KEY = "emlynk.admin.sidebarCollapsed";

// A per-browser convenience only; the app works the same without it.
function readCollapsed(): boolean {
    try {
        return window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
        return false;
    }
}

function writeCollapsed(value: boolean): void {
    try {
        window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
    } catch {
        // not remembered
    }
}

// Shared shell for every signed-in page: sidebar, header, content canvas.
export function AdminLayout() {
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const [mobileOpen, setMobileOpen] = useState(false);
    const { pathname } = useLocation();

    // Close the mobile drawer after navigating.
    useEffect(() => setMobileOpen(false), [pathname]);

    const toggleCollapsed = () => {
        setCollapsed((value) => {
            writeCollapsed(!value);
            return !value;
        });
    };

    return (
        <div className="min-h-full">
            <Sidebar
                collapsed={collapsed}
                mobileOpen={mobileOpen}
                onToggleCollapsed={toggleCollapsed}
                onNavigate={() => setMobileOpen(false)}
            />
            {mobileOpen && (
                <div
                    className="fixed inset-0 z-40 bg-ink/60 md:hidden"
                    aria-hidden="true"
                    onClick={() => setMobileOpen(false)}
                />
            )}

            <div className={`flex min-h-full flex-col transition-[padding] duration-200 ${collapsed ? "md:pl-sidebar-rail" : "md:pl-sidebar"}`}>
                <Header onOpenMenu={() => setMobileOpen(true)} menuOpen={mobileOpen} />
                <main className="mx-auto w-full max-w-content flex-1 p-4 md:p-6">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
