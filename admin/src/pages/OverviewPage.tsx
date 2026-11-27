import { useState } from "react";
import { getOverview, type Overview } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { ROLES, hasRole } from "../auth/roles";
import { useSync } from "../sync/SyncProvider";
import { formatDate, formatNumber } from "../components/format";
import { Icon, type IconName } from "../components/Icon";
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/States";

// The Overview tab (GET /api/admin/overview). The same cards for every role; the server scopes the
// figures to the signed-in user: ADMIN the whole system, ANALYST their allocated candidates, TEAM_LEAD
// their own ("My Overview") or everyone's ("Full Overview").

type ChosenView = "mine" | "full";

function KpiCard({ label, value, hint, icon }: { label: string; value: number; hint?: string; icon?: IconName }) {
    return (
        <Card className="flex flex-col justify-between p-5">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <p className="text-label-sm text-ink-muted">{label}</p>
                    <p className="mt-1 text-headline-xl tabular-nums text-ink">{formatNumber(value ?? 0)}</p>
                </div>
                {icon && (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                        <Icon name={icon} className="size-5" />
                    </span>
                )}
            </div>
            {hint && <p className="mt-4 border-t border-border pt-1 text-body-sm text-ink-muted">{hint}</p>}
        </Card>
    );
}

// Team Lead only: whose candidates the figures cover.
function ViewChooser({ view, onChange }: { view: ChosenView; onChange: (view: ChosenView) => void }) {
    const options: { value: ChosenView; label: string }[] = [
        { value: "mine", label: "My Overview" },
        { value: "full", label: "Full Overview" },
    ];
    return (
        <div role="group" aria-label="Overview view" className="inline-flex rounded-lg border border-border-strong bg-surface p-0.5 shadow-surface">
            {options.map((option) => {
                const selected = option.value === view;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onChange(option.value)}
                        className={`h-7 rounded-md px-3 text-label-md ${selected ? "bg-primary-soft text-primary" : "text-ink-soft hover:bg-canvas"}`}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

function OverviewContent({ data }: { data: Overview }) {
    const o = data.overview;
    const police = o.policeReportsYetToReceive;
    const d = data.daily;
    return (
        <div className="space-y-6">
            <section aria-labelledby="overview-current" className="space-y-3">
                <div id="overview-current">
                    <SectionHeading title="Overview" />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <KpiCard label="Active Allocated Candidates" value={o.activeAllocated} hint="Allocated and still in progress" icon="assignment_ind" />
                    <KpiCard label="Job Allocated Candidates" value={o.jobAllocated} hint="Currently assigned to a job" icon="work" />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    <KpiCard
                        label="Police reports"
                        value={police?.total ?? 0}
                        hint={`Yet to receive · Romania ${formatNumber(police?.byVariant?.ROMANIA ?? 0)} · SL ${formatNumber(police?.byVariant?.SL_VERIFIED ?? 0)}`}
                    />
                    <KpiCard label="Agreements" value={o.agreementsYetToReceive} hint="Yet to receive (job allocated only)" />
                    <KpiCard label="Candidate details" value={o.detailsNotCompleted} hint="Candidate / additional details not completed" />
                    <KpiCard label="Newly allocated" value={o.newlyAllocated} hint="No action taken yet" />
                    <KpiCard label="Visa submission completed" value={o.visaSubmissionCompleted} hint="Visa Submission stage completed" />
                </div>
            </section>

            <section aria-labelledby="overview-daily" className="space-y-3">
                <div id="overview-daily">
                    <SectionHeading title="Daily Overview" description={`Today's updates · ${formatDate(data.businessDate)}`} />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <KpiCard label="Form submissions" value={d.formSubmissions} icon="edit_note" />
                    <KpiCard label="New allocated candidates" value={d.newlyAllocated} icon="person_add" />
                    <KpiCard label="Calls taken" value={d.callsTaken} icon="call" />
                </div>
            </section>
        </div>
    );
}

export function OverviewPage() {
    const { user } = useAuth();
    // Only a Team Lead may choose (default "My Overview"); every other role sends no view (an Analyst
    // asking for "full" gets 403). The server decides the served view and says whether to show the choice.
    const [chosen, setChosen] = useState<ChosenView>("mine");
    const requested = hasRole(user, [ROLES.TEAM_LEAD]) ? chosen : undefined;
    const overview = useAdminResource(`overview:${requested ?? ""}`, (token, signal) => getOverview(token, requested, signal));
    const { syncing } = useSync();
    const showChooser = Boolean(overview.data?.canChooseView);
    // useAdminResource keeps the previous data while a new key loads and after it fails. A Team Lead's
    // figures are shown only when they are the selected view's, so switching My <-> Full never shows
    // the other view's figures under the new label (loading or error instead).
    // (A successful response is always the current request's, whatever view the server served.)
    const data = overview.status === "success" || (overview.data && (requested === undefined || overview.data.view === requested)) ? overview.data : null;

    return (
        <section aria-labelledby="page-title" className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Overview</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Welcome{user ? `, ${user.name}` : ""}. Current figures; Sri Lanka time.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {showChooser && <ViewChooser view={chosen} onChange={setChosen} />}
                    <button
                        type="button"
                        onClick={overview.reload}
                        disabled={overview.status === "loading" || syncing}
                        className="h-8 rounded-lg border border-border-strong bg-surface px-3 text-label-md text-ink-soft shadow-surface hover:border-border-focus hover:bg-canvas disabled:opacity-60"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {overview.status === "error" && !data && <Card><ErrorState message={overview.error.message} onRetry={overview.reload} /></Card>}
            {overview.status === "loading" && !data && <Card><LoadingState label="Loading overview…" /></Card>}
            {data && <OverviewContent data={data} />}
        </section>
    );
}
