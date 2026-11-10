import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { canRegisterCandidates, notificationSource } from "../auth/roles";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Icon } from "../components/Icon";
import { useSync } from "../sync/SyncProvider";
import { useTheme } from "../theme/theme";
import { NotificationBell } from "../components/NotificationBell";

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

// Top utility bar (fixed 56px): the page's breadcrumb (the product name is
// the sidebar's logo), Sync (reload the data on screen) and light/dark mode.
// The account card is at the foot of the sidebar. Candidate
// registration starts from the Candidates page ("Add candidate"), or from
// the Register Candidate quick access shown here on every page.
export function Header({ onOpenMenu, menuOpen, collapsed, onToggleCollapsed }: { onOpenMenu: () => void; menuOpen: boolean; collapsed: boolean; onToggleCollapsed: () => void }) {
    const { user } = useAuth();
    const { syncing, result, sync } = useSync();
    const { theme, toggle } = useTheme();
    // Quick access to the registration form (the existing /candidates/new
    // route) on every page, for the roles that can register candidates.
    const showRegister = canRegisterCandidates(user);
    // The bell's source for this role (roles.ts): the review queue, Need Attention, or none (an empty bell).
    const bellSource = notificationSource(user);
    const trigger = "-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-canvas-muted hover:text-ink";
    const control = "flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2.5 text-label-md text-ink-soft transition-colors hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";

    return (
        <header className="sticky top-0 z-40 flex h-header shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-4 backdrop-blur">
            {/* The same panel icon as EMLYNK Talent: below md it opens the drawer,
                from md up it collapses the sidebar to the icon rail. */}
            <button
                type="button"
                onClick={onOpenMenu}
                aria-controls="admin-sidebar"
                aria-expanded={menuOpen}
                className={`${trigger} md:hidden`}
            >
                <Icon name="panel_left" />
                <span className="sr-only">Open navigation</span>
            </button>
            <button
                type="button"
                onClick={onToggleCollapsed}
                aria-controls="admin-sidebar"
                aria-expanded={!collapsed}
                className={`${trigger} hidden md:flex`}
            >
                <Icon name="panel_left" />
                <span className="sr-only">Toggle sidebar</span>
            </button>
            <span aria-hidden="true" className="mr-1 hidden h-4 w-px bg-border sm:block" />

            <div className="min-w-0 flex-1">
                <Breadcrumbs />
            </div>

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
                {showRegister && (
                    <Link to="/candidates/new" className={control} title="Open the candidate registration form">
                        <Icon name="person_add" className="size-4" />
                        <span className="sr-only sm:not-sr-only">Register Candidate</span>
                    </Link>
                )}
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
                {/* Every role has the bell; it reads only data the role may already open (never the Review Queue for a role without it). */}
                {user && <NotificationBell source={bellSource} />}
            </div>
        </header>
    );
}
