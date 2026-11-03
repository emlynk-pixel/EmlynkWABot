import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { DASHBOARD_ROLES, hasRole, type Role } from "../auth/roles";
import { NAV_ITEMS, SETTINGS_TABS } from "../layout/navigation";

// The one breadcrumb of the admin shell: the header (layout/Header.tsx)
// renders it on every page, so it takes no row of the content area; pages
// never render their own. It stays on one line and the last item truncates.
// The trail comes from the URL: Admin > the section (a sidebar entry, or
// Clients, which has no entry) > the page inside it. A details page names
// its record (useBreadcrumbLabel); until it does, the last item says "Details".
// A section the user can't open is named without a link (a Registration Desk
// on a candidate's page has no Candidates list).

export type Crumb = { label: string; to?: string };

type Section = { to: string; label: string; end?: boolean; roles: readonly Role[] };

// Sections that are not sidebar entries but have pages under them.
const EXTRA_SECTIONS: Section[] = [{ to: "/clients", label: "Clients", roles: DASHBOARD_ROLES }];

// Fixed pages inside a section (anything else under a section is a record).
const SUB_PAGES: Record<string, string> = {
    "/candidates/new": "Register Candidate",
    ...Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.to, tab.label])),
};

// A sidebar entry that is itself a fixed page (Add Candidate) stays a page of its section.
const SECTIONS: Section[] = [...NAV_ITEMS.filter((item) => !SUB_PAGES[item.to]), ...EXTRA_SECTIONS].sort((a, b) => b.to.length - a.to.length);

const inSection = (pathname: string, section: { to: string; end?: boolean }) =>
    section.end ? pathname === section.to : pathname === section.to || pathname.startsWith(`${section.to}/`);

// `user`: the signed-in user, whose sections get links (omitted: every section is linked).
export function breadcrumbTrail(pathname: string, recordLabel: string | null, user?: { role: string } | null): Crumb[] {
    const home: Crumb = { label: "Admin", to: "/" };
    const section = SECTIONS.find((item) => inSection(pathname, item));
    if (!section) return [home, { label: "Page not found" }];
    if (pathname === section.to) return [home, { label: section.label }];
    const linked = user === undefined || hasRole(user, section.roles);
    return [home, linked ? { label: section.label, to: section.to } : { label: section.label }, { label: SUB_PAGES[pathname] ?? recordLabel ?? "Details" }];
}

const SetLabelContext = createContext<((label: string | null) => void) | null>(null);
const LabelContext = createContext<string | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
    const [label, setLabel] = useState<string | null>(null);
    return (
        <SetLabelContext.Provider value={setLabel}>
            <LabelContext.Provider value={label}>{children}</LabelContext.Provider>
        </SetLabelContext.Provider>
    );
}

// A details page names its record in the breadcrumb (null while loading).
export function useBreadcrumbLabel(label: string | null | undefined) {
    const setLabel = useContext(SetLabelContext);
    useEffect(() => {
        if (!setLabel) return;
        setLabel(label || null);
        return () => setLabel(null);
    }, [setLabel, label]);
}

export function Breadcrumbs() {
    const { pathname } = useLocation();
    const { user } = useAuth();
    const trail = breadcrumbTrail(pathname, useContext(LabelContext), user);
    return (
        <nav aria-label="Breadcrumb" className="min-w-0" data-testid="breadcrumb">
            <ol className="flex min-w-0 items-center gap-2 overflow-hidden text-body-sm text-ink-subtle">
                {trail.map((crumb, index) => {
                    const last = index === trail.length - 1;
                    return (
                        <li key={`${index}:${crumb.label}`} className={`flex items-center gap-2 ${last ? "min-w-0 flex-1" : "shrink-0"}`}>
                            {index > 0 && <span aria-hidden="true">/</span>}
                            {last || !crumb.to ? (
                                <span className="truncate font-medium text-ink" aria-current={last ? "page" : undefined}>{crumb.label}</span>
                            ) : (
                                <Link to={crumb.to} className="whitespace-nowrap text-primary hover:underline">{crumb.label}</Link>
                            )}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}
