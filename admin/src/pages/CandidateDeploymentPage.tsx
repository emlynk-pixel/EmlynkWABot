import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { CANDIDATE_STAGES, getCandidate, type CandidateDetails, type CandidateStageKey, type FailedUpload } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import { canManageCandidates, useAuth } from "../auth/AuthProvider";
import { AdditionalDetailsPanel } from "../components/candidate/AdditionalDetailsPanel";
import { CallLogDialog } from "../components/candidate/CallLogDialog";
import { CandidateStepper } from "../components/candidate/CandidateStepper";
import { CandidateDetailsStage, DocumentSubmissionStage, NotesStage } from "../components/candidate/StagePanels";
import { secondaryButton } from "../components/Dialog";
import { documentTypeLabel } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, ErrorState, LoadingState } from "../components/States";

const isStage = (value: string | null): value is CandidateStageKey => CANDIDATE_STAGES.includes(value as CandidateStageKey);

type TabKey = "deployment" | "additional";
const TABS: { key: TabKey; label: string }[] = [
    { key: "deployment", label: "Deployment" },
    { key: "additional", label: "Additional Details" },
];

// A candidate's page: who they are, then two tabs. Deployment: the six
// stages and the selected stage (?stage=…, default the first incomplete
// one). Additional Details (?tab=additional): the extra details form.
export function CandidateDeploymentPage() {
    const { passportId = "" } = useParams();
    const { user } = useAuth();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const resource = useAdminResource(`candidate:${passportId}`, (token, signal) => getCandidate(token, passportId, signal));
    const [updated, setUpdated] = useState<CandidateDetails | null>(null);
    const [callLogOpen, setCallLogOpen] = useState(false);
    const failedUploads = (location.state as { failedUploads?: FailedUpload[] } | null)?.failedUploads ?? [];

    // A reload (Sync) replaces any locally updated copy.
    useEffect(() => setUpdated(null), [resource.data]);

    // Reset local state when the route parameter changes.
    useEffect(() => {
        setUpdated(null);
        setCallLogOpen(false);
    }, [passportId]);

    const details = updated ?? resource.data;
    if (!details || details.candidate.passportId.toUpperCase() !== passportId.toUpperCase()) {
        return resource.status === "error"
            ? <Card><ErrorState message={resource.error.message} onRetry={resource.reload} /></Card>
            : <Card><LoadingState label="Loading candidate…" /></Card>;
    }

    const requested = searchParams.get("stage");
    const current: CandidateStageKey = isStage(requested) ? requested : (details.stages.find((s) => !s.completed)?.stage ?? CANDIDATE_STAGES[0]);
    const select = (stage: CandidateStageKey) => setSearchParams({ stage }, { replace: true });
    const tab: TabKey = searchParams.get("tab") === "additional" ? "additional" : "deployment";
    const selectTab = (next: TabKey) => setSearchParams(next === "additional" ? { tab: next } : {}, { replace: true });
    const canEdit = canManageCandidates(user);
    const c = details.candidate;
    const panelProps = { details, canEdit, onChange: setUpdated };
    // Files registration couldn't upload, as long as they're still missing:
    // the message goes once each one has been uploaded here.
    const stillMissing = failedUploads.filter((failed) => !details.documents[failed.documentType]);

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-5xl space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                    <Link to="/candidates" className="text-label-md text-primary hover:underline">Candidates</Link>
                    <h1 id="page-title" className="mt-1 truncate text-headline-lg text-ink">{c.name ?? c.passportId}</h1>
                    <p className="text-body-sm text-ink-muted">{[c.passportId, c.nic].filter(Boolean).join(" • ")}</p>
                </div>
                <button type="button" onClick={() => setCallLogOpen(true)} className={`${secondaryButton} inline-flex items-center gap-1.5`}>
                    <Icon name="call" className="size-4" />Call log
                </button>
            </div>

            {stillMissing.length > 0 && (
                <p role="alert" className="rounded border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">
                    The candidate was registered, but these files were not uploaded — {stillMissing.map((failed) => `${documentTypeLabel(failed.documentType)}: ${failed.message}`).join("; ")}
                </p>
            )}

            <div role="tablist" aria-label="Candidate sections" className="flex gap-1 border-b border-border">
                {TABS.map(({ key, label }) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        id={`candidate-tab-${key}`}
                        aria-selected={tab === key}
                        aria-controls={`candidate-panel-${key}`}
                        onClick={() => selectTab(key)}
                        className={`-mb-px border-b-2 px-4 py-2 text-label-md ${tab === key ? "border-primary font-semibold text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === "deployment" ? (
                <div role="tabpanel" id="candidate-panel-deployment" aria-labelledby="candidate-tab-deployment" className="space-y-4">
                    <Card className="px-4 py-5">
                        <CandidateStepper stages={details.stages} current={current} onSelect={select} />
                    </Card>

                    <Card className="p-6">
                        {current === "CANDIDATE_DETAILS" && <CandidateDetailsStage key={current} {...panelProps} />}
                        {current === "DOCUMENT_SUBMISSION" && <DocumentSubmissionStage key={current} {...panelProps} />}
                        {current !== "CANDIDATE_DETAILS" && current !== "DOCUMENT_SUBMISSION" && <NotesStage key={current} stage={current} {...panelProps} />}
                    </Card>
                </div>
            ) : (
                <div role="tabpanel" id="candidate-panel-additional" aria-labelledby="candidate-tab-additional">
                    <Card className="p-6">
                        <AdditionalDetailsPanel passportId={c.passportId} canEdit={canEdit} />
                    </Card>
                </div>
            )}

            {callLogOpen && <CallLogDialog passportId={c.passportId} candidate={c} canEdit={canEdit} onClose={() => setCallLogOpen(false)} />}
        </section>
    );
}
