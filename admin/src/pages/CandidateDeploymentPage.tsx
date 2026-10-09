import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { CANDIDATE_STAGES, STAGE_LABELS, getAdditionalDetails, getCandidate, type CandidateDetails, type CandidateStageKey, type FailedUpload } from "../api/candidates";
import { useAdminResource } from "../api/useAdminResource";
import { canManageCandidates, useAuth } from "../auth/AuthProvider";
import { AdditionalDetailsPanel } from "../components/candidate/AdditionalDetailsPanel";
import { CallLogDialog } from "../components/candidate/CallLogDialog";
import { CandidateStepper, type StepperStep } from "../components/candidate/CandidateStepper";
import { CandidateDetailsStage, DocumentSubmissionStage, NotesStage } from "../components/candidate/StagePanels";
import { secondaryButton } from "../components/Dialog";
import { documentTypeLabel } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, ErrorState, LoadingState } from "../components/States";

const isStage = (value: string | null): value is CandidateStageKey => CANDIDATE_STAGES.includes(value as CandidateStageKey);

// Which content shows under the stepper: a deployment stage, or the
// Additional details form (?tab=additional, opened from its step).
type TabKey = "deployment" | "additional";

// The progress stepper shows these stages, with Additional details right
// after Candidate details. IVS interview and Finalizing the job have no
// circle; their data and panels (?stage=…) are unchanged.
const STEPPER_HIDDEN_STAGES: CandidateStageKey[] = ["IVS_INTERVIEW", "FINALIZING_JOB"];
const ADDITIONAL_STEP = "ADDITIONAL_DETAILS";

// A candidate's page: who they are, the progress stepper, then the selected
// step's content: a stage (?stage=…, default the first incomplete one in
// the stepper) or the Additional details form (?tab=additional).
export function CandidateDeploymentPage() {
    const { passportId = "" } = useParams();
    const { user } = useAuth();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const resource = useAdminResource(`candidate:${passportId}`, (token, signal) => getCandidate(token, passportId, signal));
    // Whether additional details are saved: the Additional details step's circle.
    const additional = useAdminResource(`candidate-additional-step:${passportId}`, (token, signal) => getAdditionalDetails(token, passportId, signal));
    const [additionalSaved, setAdditionalSaved] = useState<boolean | null>(null);
    const [updated, setUpdated] = useState<CandidateDetails | null>(null);
    const [callLogOpen, setCallLogOpen] = useState(false);
    const failedUploads = (location.state as { failedUploads?: FailedUpload[] } | null)?.failedUploads ?? [];

    // A reload (Sync) replaces any locally updated copy.
    useEffect(() => setUpdated(null), [resource.data]);
    useEffect(() => setAdditionalSaved(null), [additional.data]);

    // Reset local state when the route parameter changes.
    useEffect(() => {
        setUpdated(null);
        setAdditionalSaved(null);
        setCallLogOpen(false);
    }, [passportId]);

    const details = updated ?? resource.data;
    if (!details || details.candidate.passportId.toUpperCase() !== passportId.toUpperCase()) {
        return resource.status === "error"
            ? <Card><ErrorState message={resource.error.message} onRetry={resource.reload} /></Card>
            : <Card><LoadingState label="Loading candidate…" /></Card>;
    }

    const stepperStages = details.stages.filter((s) => !STEPPER_HIDDEN_STAGES.includes(s.stage));
    const requested = searchParams.get("stage");
    const current: CandidateStageKey = isStage(requested) ? requested : (stepperStages.find((s) => !s.completed)?.stage ?? stepperStages[0]?.stage ?? CANDIDATE_STAGES[0]);
    const tab: TabKey = searchParams.get("tab") === "additional" ? "additional" : "deployment";
    const selectTab = (next: TabKey) => setSearchParams(next === "additional" ? { tab: next } : {}, { replace: true });
    const select = (key: string) => (key === ADDITIONAL_STEP ? selectTab("additional") : setSearchParams({ stage: key }, { replace: true }));
    const steps: StepperStep[] = stepperStages.flatMap((s) => {
        const step = { key: s.stage, label: STAGE_LABELS[s.stage], completed: s.completed };
        return s.stage === "CANDIDATE_DETAILS"
            ? [step, { key: ADDITIONAL_STEP, label: "Additional details", completed: additionalSaved ?? Boolean(additional.data?.details) }]
            : [step];
    });
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

            <Card className="px-4 py-5">
                <CandidateStepper steps={steps} current={tab === "additional" ? ADDITIONAL_STEP : current} onSelect={select} />
            </Card>

            {tab === "deployment" ? (
                <Card className="p-6">
                    {current === "CANDIDATE_DETAILS" && <CandidateDetailsStage key={current} {...panelProps} />}
                    {current === "DOCUMENT_SUBMISSION" && <DocumentSubmissionStage key={current} {...panelProps} />}
                    {current !== "CANDIDATE_DETAILS" && current !== "DOCUMENT_SUBMISSION" && <NotesStage key={current} stage={current} {...panelProps} />}
                </Card>
            ) : (
                <Card className="p-6">
                    <AdditionalDetailsPanel passportId={c.passportId} canEdit={canEdit} onSaved={(view) => setAdditionalSaved(Boolean(view.details))} />
                </Card>
            )}

            {callLogOpen && <CallLogDialog passportId={c.passportId} candidate={c} canEdit={canEdit} onClose={() => setCallLogOpen(false)} />}
        </section>
    );
}
