import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import {
    AFFIDAVIT_VARIANTS,
    POLICE_REPORT_VARIANTS,
    STAGE_LABELS,
    TEST_RESULT_OPTIONS,
    updateCandidate,
    updateCandidateStage,
    type CandidateDetails,
    type CandidateDetailsInput,
    type CandidateStageKey,
    type StageState,
    type TestResult,
    type VariantDocumentType,
} from "../../api/candidates";
import { documentTypeLabel } from "../format";
import { Icon } from "../Icon";
import { DialogError, primaryButton, secondaryButton } from "../Dialog";
import { CandidateFields, detailsFrom, Field, fieldControl, textAreaControl, validateDetails } from "./CandidateFields";
import { DocumentRow, VIDEO_ACCEPT } from "./DocumentRow";
import { exportDocumentSubmissionPdf } from "./exportPdf";

type PanelProps = { details: CandidateDetails; canEdit: boolean; onChange: (details: CandidateDetails) => void };

const stageOf = (details: CandidateDetails, stage: CandidateStageKey) => details.stages.find((s) => s.stage === stage)!;

function PanelHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 className="text-headline-sm text-ink">{title}</h2>
                {description && <p className="mt-1 text-body-sm text-ink-muted">{description}</p>}
            </div>
            {action}
        </div>
    );
}

// Completion (a checkbox, or the automatic status), error, and Cancel / Save changes.
function PanelFooter({ status, canEdit, busy, dirty, error, onCancel }: {
    status: ReactNode;
    canEdit: boolean;
    busy: boolean;
    dirty: boolean;
    error: string | null;
    onCancel?: () => void;
}) {
    return (
        <div className="mt-6 border-t border-border pt-4">
            {status}
            <DialogError message={error} />
            {canEdit && onCancel && (
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={onCancel} disabled={busy || !dirty} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy || !dirty} className={primaryButton}>{busy ? "Saving…" : "Save changes"}</button>
                </div>
            )}
        </div>
    );
}

function CompletedCheckbox({ completed, onChange, disabled }: { completed: boolean; onChange: (value: boolean) => void; disabled: boolean }) {
    const id = useId();
    return (
        <label htmlFor={id} className="inline-flex items-center gap-2 text-body-sm text-ink">
            <input id={id} type="checkbox" checked={completed} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-primary" />
            Stage completed
        </label>
    );
}

// Stages completed by their data: done, or what is still missing.
function AutomaticStatus({ stage, completedLabel = "Stage completed" }: { stage: StageState; completedLabel?: string }) {
    return stage.completed ? (
        <p className="inline-flex items-center gap-1.5 text-body-sm text-verified"><Icon name="check" className="size-4" />{completedLabel}</p>
    ) : (
        <p className="text-body-sm text-ink-muted">Missing: {stage.missing.join(", ")}</p>
    );
}

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "The changes could not be saved.");

// The stages completed by an admin (Test details, IVS interview, Visa
// approval, Finalizing the job): notes and completion. Test details also
// records the job ID (entered by the admin), the test's result and the date
// it was sat; the client name shown with them comes from the candidate's record.
export function NotesStage({ details, canEdit, onChange, stage }: PanelProps & { stage: CandidateStageKey }) {
    const { token } = useAuth();
    const saved = stageOf(details, stage);
    const isTest = stage === "TEST_DETAILS";
    const [notes, setNotes] = useState(saved.notes ?? "");
    const [completed, setCompleted] = useState(saved.completed);
    const [jobId, setJobId] = useState(saved.jobId ?? "");
    const [testResult, setTestResult] = useState<TestResult | "">(saved.testResult ?? "");
    const [testDate, setTestDate] = useState(saved.testDate ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const notesId = useId();
    const testId = useId();
    const dirty = notes !== (saved.notes ?? "") || completed !== saved.completed
        || (isTest && (jobId !== (saved.jobId ?? "") || testResult !== (saved.testResult ?? "") || testDate !== (saved.testDate ?? "")));

    const showSaved = (state: StageState) => {
        setNotes(state.notes ?? "");
        setCompleted(state.completed);
        setJobId(state.jobId ?? "");
        setTestResult(state.testResult ?? "");
        setTestDate(state.testDate ?? "");
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        setBusy(true);
        setError(null);
        try {
            const next = await updateCandidateStage(token, details.candidate.passportId, stage, {
                notes: notes.trim() || null,
                completed,
                ...(isTest ? { jobId: jobId.trim() || null, testResult: testResult || null, testDate: testDate || null } : {}),
            });
            showSaved(stageOf(next, stage));
            onChange(next);
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit}>
            <PanelHeading title={STAGE_LABELS[stage]} />
            {isTest && (
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Client name" htmlFor={`${testId}-client`}>
                        <input id={`${testId}-client`} value={details.candidate.name ?? ""} readOnly className={`${fieldControl} bg-canvas text-ink-muted`} />
                    </Field>
                    <Field label="Job ID" htmlFor={`${testId}-job`}>
                        <input id={`${testId}-job`} value={jobId} maxLength={50} disabled={!canEdit || busy} onChange={(event) => setJobId(event.target.value)} className={fieldControl} />
                    </Field>
                    <Field label="Test result" htmlFor={`${testId}-result`}>
                        <select
                            id={`${testId}-result`}
                            value={testResult}
                            disabled={!canEdit || busy}
                            onChange={(event) => setTestResult(TEST_RESULT_OPTIONS.find((o) => o.value === event.target.value)?.value ?? "")}
                            className={fieldControl}
                        >
                            <option value="">Select result…</option>
                            {TEST_RESULT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                    </Field>
                    <Field label="Test date" htmlFor={`${testId}-date`}>
                        <input id={`${testId}-date`} type="date" value={testDate} disabled={!canEdit || busy} onChange={(event) => setTestDate(event.target.value)} className={fieldControl} />
                    </Field>
                </div>
            )}
            <div className="mt-4">
                <label htmlFor={notesId} className="mb-1 block text-label-sm text-ink-muted">Notes</label>
                <textarea id={notesId} rows={5} maxLength={2000} value={notes} disabled={!canEdit || busy} onChange={(event) => setNotes(event.target.value)} className={textAreaControl} />
            </div>
            <PanelFooter
                status={<CompletedCheckbox completed={completed} onChange={setCompleted} disabled={!canEdit || busy} />}
                canEdit={canEdit}
                busy={busy}
                dirty={dirty}
                error={error}
                onCancel={() => { showSaved(saved); setError(null); }}
            />
        </form>
    );
}

const sameDetails = (a: CandidateDetailsInput, b: CandidateDetailsInput) => JSON.stringify(a) === JSON.stringify(b);

// Stage 2: the candidate's details, passport / NIC / skill video, and the
// comment for admins and analysts.
export function CandidateDetailsStage({ details, canEdit, onChange }: PanelProps) {
    const { token } = useAuth();
    const saved = stageOf(details, "CANDIDATE_DETAILS");
    const [form, setForm] = useState<CandidateDetailsInput>(() => detailsFrom(details.candidate));
    const [comment, setComment] = useState(saved.notes ?? "");
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const commentId = useId();
    const passportId = details.candidate.passportId;
    const dirty = !sameDetails(form, detailsFrom(details.candidate)) || comment !== (saved.notes ?? "");

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        const errors = validateDetails(form);
        setFieldErrors(errors);
        if (Object.keys(errors).length) return;
        setBusy(true);
        setError(null);
        try {
            let next = details;
            if (!sameDetails(form, detailsFrom(details.candidate))) {
                next = await updateCandidate(token, passportId, form);
                onChange(next);
            }
            if (comment !== (saved.notes ?? "")) {
                next = await updateCandidateStage(token, passportId, "CANDIDATE_DETAILS", { notes: comment.trim() || null });
                onChange(next);
            }
            setForm(detailsFrom(next.candidate));
            setComment(stageOf(next, "CANDIDATE_DETAILS").notes ?? "");
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit}>
            <PanelHeading title="Candidate details" />
            <div className="mt-4">
                <CandidateFields value={form} onChange={setForm} errors={fieldErrors} disabled={!canEdit || busy} passportId={{ value: passportId }} whatsappLocked={Boolean(details.candidate.whatsappNumber)} />
            </div>
            <div className="mt-6 space-y-2">
                <DocumentRow passportId={passportId} documentType="PASSPORT" label="Passport" required document={details.documents.PASSPORT} readOnly={!canEdit} onUploaded={onChange} />
                <DocumentRow passportId={passportId} documentType="NIC" label="NIC document" document={details.documents.NIC} readOnly={!canEdit} onUploaded={onChange} />
                <DocumentRow passportId={passportId} documentType="SKILL_VIDEO" label="Skill video" document={details.documents.SKILL_VIDEO} accept={VIDEO_ACCEPT} readOnly={!canEdit} onUploaded={onChange} />
            </div>
            <div className="mt-6">
                <label htmlFor={commentId} className="mb-1 block text-label-sm text-ink-muted">Comment</label>
                <textarea id={commentId} rows={3} maxLength={2000} value={comment} disabled={!canEdit || busy} onChange={(event) => setComment(event.target.value)} placeholder="Internal note for admins and analysts" className={textAreaControl} />
            </div>
            <PanelFooter
                status={<AutomaticStatus stage={saved} />}
                canEdit={canEdit}
                busy={busy}
                dirty={dirty}
                error={error}
                onCancel={() => { setForm(detailsFrom(details.candidate)); setComment(saved.notes ?? ""); setFieldErrors({}); setError(null); }}
            />
        </form>
    );
}

// A police report or an affidavit: one row per variant, each with its own
// file, so any or all of them can be on record (one is required). A stored
// one with no known variant (e.g. received on WhatsApp) is listed too; it can
// be removed, and a typed one uploaded beside it.
function VariantDocumentGroup({ passportId, documentType, label, variants, details, readOnly, onUploaded, required = false, requiredVariants = [] }: {
    passportId: string;
    documentType: VariantDocumentType;
    label: string;
    variants: readonly { value: string; label: string }[];
    details: CandidateDetails;
    readOnly: boolean;
    onUploaded: (details: CandidateDetails) => void;
    required?: boolean;
    requiredVariants?: readonly string[];
}) {
    const stored = details.variantDocuments[documentType];
    return (
        <section aria-label={label} className="space-y-2">
            <p className="text-label-md text-ink">{label}{required && <span className="text-critical"> *</span>}</p>
            <div className="space-y-2 border-l-2 border-border pl-3">
                {variants.map((option) => (
                    <DocumentRow
                        key={option.value}
                        passportId={passportId}
                        documentType={documentType}
                        label={option.label}
                        removeTitle={`${label} (${option.label})`}
                        variant={option.value}
                        document={stored.byVariant[option.value] ?? null}
                        readOnly={readOnly}
                        onUploaded={onUploaded}
                        required={requiredVariants?.includes(option.value)}
                    />
                ))}
                {stored.untyped && (
                    <DocumentRow
                        passportId={passportId}
                        documentType={documentType}
                        label="Type not set"
                        removeTitle={`${label} (type not set)`}
                        document={stored.untyped}
                        uploadable={false}
                        readOnly={readOnly}
                        onUploaded={onUploaded}
                    />
                )}
            </div>
        </section>
    );
}

// Stage 3: medical, police report, agreement and affidavit, the five-document
// check, and the PDF export.
// Each upload saves on its own, and the stage completes once all required
// documents are in, so there is nothing else to save here.
export function DocumentSubmissionStage({ details, canEdit, onChange }: PanelProps) {
    const saved = stageOf(details, "DOCUMENT_SUBMISSION");
    const [error, setError] = useState<string | null>(null);
    const passportId = details.candidate.passportId;
    const total = details.requiredDocuments.length;

    const exportPdf = () => {
        setError(exportDocumentSubmissionPdf(details) ? null : "The browser blocked the export window. Allow pop-ups for this site and try again.");
    };

    return (
        <div>
            <PanelHeading
                title="Document submission"
                description="Accepted formats: PDF, JPG, PNG."
                action={(
                    <button type="button" onClick={exportPdf} className={`${secondaryButton} inline-flex items-center gap-1.5`}>
                        <Icon name="picture_as_pdf" className="size-4" />Export PDF
                    </button>
                )}
            />
            <ul className="mt-4 flex flex-wrap items-center gap-2 border-b border-border pb-4" aria-label="Required documents">
                <li className="text-label-caps uppercase text-ink-subtle">Required checklist:</li>
                {details.requiredDocuments.map((r) => (
                    <li key={r.documentType} className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-label-sm ${r.included ? "border-verified-border bg-verified-bg text-verified" : "border-border text-ink-muted"}`}>
                        {r.included && <Icon name="check" className="size-3.5" />}
                        {documentTypeLabel(r.documentType)}
                        <span className="sr-only">{r.included ? "included" : "missing"}</span>
                    </li>
                ))}
            </ul>
            <div className="mt-4 space-y-3">
                <DocumentRow passportId={passportId} documentType="MEDICAL" label="Medical" required document={details.documents.MEDICAL} readOnly={!canEdit} onUploaded={onChange} />
                <VariantDocumentGroup passportId={passportId} documentType="POLICE_REPORT" label="Police report" variants={POLICE_REPORT_VARIANTS} details={details} readOnly={!canEdit} onUploaded={onChange} required={true} requiredVariants={["SL_VERIFIED", "ROMANIA"]} />
                <DocumentRow passportId={passportId} documentType="AGREEMENT" label="Scan - Agreement" required description="Agreement document" document={details.documents.AGREEMENT} readOnly={!canEdit} onUploaded={onChange} />
                <VariantDocumentGroup passportId={passportId} documentType="AFFIDAVIT" label="Scan - Affidavit" variants={AFFIDAVIT_VARIANTS} details={details} readOnly={!canEdit} onUploaded={onChange} required={false} />
            </div>
            <PanelFooter
                status={<AutomaticStatus stage={saved} completedLabel={`All ${total} required documents are included`} />}
                canEdit={canEdit}
                busy={false}
                dirty={false}
                error={error}
            />
        </div>
    );
}
