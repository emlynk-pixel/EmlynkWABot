import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { CANDIDATE_STAGES, getCandidate, type CandidateDetails, type CandidateStageKey } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import { canReview, useAuth } from "../auth/AuthProvider";
import { CallLogDialog } from "../components/candidate/CallLogDialog";
import { CandidateStepper } from "../components/candidate/CandidateStepper";
import { CandidateDetailsStage, DocumentSubmissionStage, NotesStage } from "../components/candidate/StagePanels";
import { secondaryButton } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { Card, ErrorState, LoadingState } from "../components/States";

const isStage = (value: string | null): value is CandidateStageKey => CANDIDATE_STAGES.includes(value as CandidateStageKey);

// A candidate's deployment process: who they are, the six stages, and the
// selected stage (?stage=…, default the first incomplete one).
export function CandidateDeploymentPage() {
    const { passportId = "" } = useParams();
    const { admin } = useAuth();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const resource = useAdminResource(`candidate:${passportId}`, (token, signal) => getCandidate(token, passportId, signal));
    const [updated, setUpdated] = useState<CandidateDetails | null>(null);
    const [callLogOpen, setCallLogOpen] = useState(false);
    const notice = (location.state as { notice?: string } | null)?.notice;

    // A reload (Sync) replaces any locally updated copy.
    useEffect(() => setUpdated(null), [resource.data]);

    const details = updated ?? resource.data;
    if (!details) {
        return resource.status === "error"
            ? <Card><ErrorState message={resource.error.message} onRetry={resource.reload} /></Card>
            : <Card><LoadingState label="Loading candidate…" /></Card>;
    }

    const requested = searchParams.get("stage");
    const current: CandidateStageKey = isStage(requested) ? requested : (details.stages.find((s) => !s.completed)?.stage ?? CANDIDATE_STAGES[0]);
    const select = (stage: CandidateStageKey) => setSearchParams({ stage }, { replace: true });
    const canEdit = canReview(admin);
    const c = details.candidate;
    const panelProps = { details, canEdit, onChange: setUpdated };

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

            {notice && <p role="alert" className="rounded border border-review-border bg-review-bg px-3 py-2 text-body-sm text-review">{notice}</p>}

            <Card className="px-4 py-5">
                <CandidateStepper stages={details.stages} current={current} onSelect={select} />
            </Card>

            <Card className="p-6">
                {current === "CANDIDATE_DETAILS" && <CandidateDetailsStage key={current} {...panelProps} />}
                {current === "DOCUMENT_SUBMISSION" && <DocumentSubmissionStage key={current} {...panelProps} />}
                {current !== "CANDIDATE_DETAILS" && current !== "DOCUMENT_SUBMISSION" && <NotesStage key={current} stage={current} {...panelProps} />}
            </Card>

            {callLogOpen && <CallLogDialog passportId={c.passportId} canEdit={canEdit} onClose={() => setCallLogOpen(false)} />}
        </section>
    );
}
