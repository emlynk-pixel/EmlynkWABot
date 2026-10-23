import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { NAV_ITEMS, SETTINGS_TABS } from "../layout/navigation";

// The one breadcrumb of the admin shell: AdminLayout renders it above every
// page (so above any page's horizontal tabs); pages never render their own.
// The trail comes from the URL: Admin > the section (a sidebar entry, or
// Clients, which has no entry) > the page inside it. A details page names
// its record (useBreadcrumbLabel); until it does, the last item says "Details".

export type Crumb = { label: string; to?: string };

// Sections that are not sidebar entries but have pages under them.
const EXTRA_SECTIONS: { to: string; label: string; end?: boolean }[] = [{ to: "/clients", label: "Clients" }];

// Fixed pages inside a section (anything else under a section is a record).
const SUB_PAGES: Record<string, string> = {
    "/candidates/new": "Register Candidate",
    ...Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.to, tab.label])),
};

const inSection = (pathname: string, section: { to: string; end?: boolean }) =>
    section.end ? pathname === section.to : pathname === section.to || pathname.startsWith(`${section.to}/`);

export function breadcrumbTrail(pathname: string, recordLabel: string | null): Crumb[] {
    const home: Crumb = { label: "Admin", to: "/" };
    const section = [...NAV_ITEMS, ...EXTRA_SECTIONS]
        .sort((a, b) => b.to.length - a.to.length)
        .find((item) => inSection(pathname, item));
    if (!section) return [home, { label: "Page not found" }];
    if (pathname === section.to) return [home, { label: section.label }];
    return [home, { label: section.label, to: section.to }, { label: SUB_PAGES[pathname] ?? recordLabel ?? "Details" }];
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
    const trail = breadcrumbTrail(pathname, useContext(LabelContext));
    return (
        <nav aria-label="Breadcrumb" className="mb-4 min-w-0" data-testid="breadcrumb">
            <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-subtle">
                {trail.map((crumb, index) => {
                    const last = index === trail.length - 1;
                    return (
                        <li key={`${index}:${crumb.label}`} className={`flex min-w-0 items-center gap-2 ${last ? "flex-1" : ""}`}>
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
