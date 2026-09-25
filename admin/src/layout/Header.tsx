import { useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { useSync } from "../sync/SyncProvider";
import { useTheme } from "../theme/theme";
import { NAV_ITEMS } from "./navigation";

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function currentSectionLabel(pathname: string): string {
    const match = [...NAV_ITEMS]
        .sort((a, b) => b.to.length - a.to.length)
        .find((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)));
    return match?.label ?? "Admin";
}

// Top utility bar (Stitch: fixed 56px): breadcrumb, Sync (reload the data
// on screen), light/dark mode, the signed-in admin and Sign out.
export function Header({ onOpenMenu, menuOpen }: { onOpenMenu: () => void; menuOpen: boolean }) {
    const { admin, signOut } = useAuth();
    const { pathname } = useLocation();
    const { syncing, result, sync } = useSync();
    const { theme, toggle } = useTheme();
    const control = "flex h-8 items-center gap-2 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft shadow-surface hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60";

    return (
        <header className="sticky top-0 z-40 flex h-header shrink-0 items-center gap-3 border-b border-border bg-surface px-4 md:px-6">
            <button
                type="button"
                onClick={onOpenMenu}
                aria-controls="admin-sidebar"
                aria-expanded={menuOpen}
                className="-ml-1 flex size-9 items-center justify-center rounded text-ink-muted hover:bg-canvas-muted hover:text-ink md:hidden"
            >
                <Icon name="menu" className="size-5" />
                <span className="sr-only">Open navigation</span>
            </button>

            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
                <ol className="flex items-center gap-2 text-body-sm text-ink-subtle">
                    <li className="hidden sm:block">Admin</li>
                    <li aria-hidden="true" className="hidden sm:block">/</li>
                    <li className="truncate font-medium text-ink" aria-current="page">
                        {currentSectionLabel(pathname)}
                    </li>
                </ol>
            </nav>

            <div className="flex items-center gap-2">
                <span aria-live="polite" data-testid="sync-status" className="hidden text-label-sm lg:block">
                    {syncing ? (
                        <span className="text-ink-muted">Syncing…</span>
                    ) : result?.status === "success" ? (
                        <span className="text-ink-muted">Synced {timeFormat.format(result.at)}</span>
                    ) : result?.status === "error" ? (
                        <span className="text-critical">Sync failed — some data could not be loaded</span>
                    ) : null}
                </span>
                <button type="button" onClick={sync} disabled={syncing} aria-busy={syncing} className={control} title="Reload the data on this page from the server">
                    <Icon name={syncing ? "progress_activity" : "sync"} className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                    <span className="sr-only sm:not-sr-only">{syncing ? "Syncing…" : "Sync"}</span>
                </button>
                <button
                    type="button"
                    onClick={toggle}
                    aria-pressed={theme === "dark"}
                    className={`${control} px-2`}
                    title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                >
                    <Icon name={theme === "dark" ? "light_mode" : "dark_mode"} className="size-4" />
                    <span className="sr-only">Dark mode</span>
                </button>
            </div>

            {admin && (
                <div className="flex items-center gap-3">
                    <div className="hidden text-right sm:block">
                        <p className="text-label-md text-ink" data-testid="admin-name">{admin.name}</p>
                        <p className="text-label-sm text-ink-subtle">{admin.role}</p>
                    </div>
                    <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-label-md text-primary" aria-hidden="true">
                        {admin.name.trim().charAt(0).toUpperCase() || "A"}
                    </span>
                    <button
                        type="button"
                        onClick={signOut}
                        className="flex h-8 items-center gap-2 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft shadow-surface hover:border-border-focus hover:bg-canvas"
                    >
                        <Icon name="logout" className="size-4" />
                        <span className="sr-only sm:not-sr-only">Sign out</span>
                    </button>
                </div>
            )}
        </header>
    );
}
