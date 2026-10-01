import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import {
    AFFIDAVIT_VARIANTS,
    POLICE_REPORT_VARIANTS,
    STAGE_LABELS,
    updateCandidate,
    updateCandidateStage,
    type CandidateDetails,
    type CandidateDetailsInput,
    type CandidateStageKey,
} from "../../api/candidates";
import { documentTypeLabel } from "../format";
import { Icon } from "../Icon";
import { DialogError, primaryButton, secondaryButton } from "../Dialog";
import { CandidateFields, detailsFrom, textAreaControl, validateDetails } from "./CandidateFields";
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

// "Completed" checkbox, error, and Cancel / Save changes.
function PanelFooter({ completedLabel, completed, onCompleted, completedDisabled, canEdit, busy, dirty, error, onCancel }: {
    completedLabel: string;
    completed: boolean;
    onCompleted: (value: boolean) => void;
    completedDisabled?: boolean;
    canEdit: boolean;
    busy: boolean;
    dirty: boolean;
    error: string | null;
    onCancel: () => void;
}) {
    const id = useId();
    return (
        <div className="mt-6 border-t border-border pt-4">
            <label htmlFor={id} className="inline-flex items-center gap-2 text-body-sm text-ink">
                <input id={id} type="checkbox" checked={completed} disabled={!canEdit || busy || completedDisabled} onChange={(event) => onCompleted(event.target.checked)} className="size-4 accent-primary" />
                {completedLabel}
            </label>
            <DialogError message={error} />
            {canEdit && (
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={onCancel} disabled={busy || !dirty} className={secondaryButton}>Cancel</button>
                    <button type="submit" disabled={busy || !dirty} className={primaryButton}>{busy ? "Saving…" : "Save changes"}</button>
                </div>
            )}
        </div>
    );
}

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "The changes could not be saved.");

// Stages without their own data yet (Test details, IVS interview, Visa
// approval, Finalizing the job): notes and completion.
export function NotesStage({ details, canEdit, onChange, stage }: PanelProps & { stage: CandidateStageKey }) {
    const { token } = useAuth();
    const saved = stageOf(details, stage);
    const [notes, setNotes] = useState(saved.notes ?? "");
    const [completed, setCompleted] = useState(saved.completed);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const notesId = useId();
    const dirty = notes !== (saved.notes ?? "") || completed !== saved.completed;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        setBusy(true);
        setError(null);
        try {
            const next = await updateCandidateStage(token, details.candidate.passportId, stage, { notes: notes.trim() || null, completed });
            const after = stageOf(next, stage);
            setNotes(after.notes ?? "");
            setCompleted(after.completed);
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
            <div className="mt-4">
                <label htmlFor={notesId} className="mb-1 block text-label-sm text-ink-muted">Notes</label>
                <textarea id={notesId} rows={5} maxLength={2000} value={notes} disabled={!canEdit || busy} onChange={(event) => setNotes(event.target.value)} className={textAreaControl} />
            </div>
            <PanelFooter
                completedLabel="Stage completed"
                completed={completed}
                onCompleted={setCompleted}
                canEdit={canEdit}
                busy={busy}
                dirty={dirty}
                error={error}
                onCancel={() => { setNotes(saved.notes ?? ""); setCompleted(saved.completed); setError(null); }}
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
    const [completed, setCompleted] = useState(saved.completed);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const commentId = useId();
    const passportId = details.candidate.passportId;
    const dirty = !sameDetails(form, detailsFrom(details.candidate)) || comment !== (saved.notes ?? "") || completed !== saved.completed;

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
            if (comment !== (saved.notes ?? "") || completed !== saved.completed) {
                next = await updateCandidateStage(token, passportId, "CANDIDATE_DETAILS", { notes: comment.trim() || null, completed });
                onChange(next);
            }
            setForm(detailsFrom(next.candidate));
            setComment(stageOf(next, "CANDIDATE_DETAILS").notes ?? "");
            setCompleted(stageOf(next, "CANDIDATE_DETAILS").completed);
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
                completedLabel="Stage completed"
                completed={completed}
                onCompleted={setCompleted}
                canEdit={canEdit}
                busy={busy}
                dirty={dirty}
                error={error}
                onCancel={() => { setForm(detailsFrom(details.candidate)); setComment(saved.notes ?? ""); setCompleted(saved.completed); setFieldErrors({}); setError(null); }}
            />
        </form>
    );
}

// Stage 3: medical, police report, agreement and affidavit, the five-document
// check, and the PDF export.
export function DocumentSubmissionStage({ details, canEdit, onChange }: PanelProps) {
    const { token } = useAuth();
    const saved = stageOf(details, "DOCUMENT_SUBMISSION");
    const [completed, setCompleted] = useState(saved.completed);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const passportId = details.candidate.passportId;
    const allIncluded = details.requiredDocuments.every((r) => r.included);
    const total = details.requiredDocuments.length;

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        setBusy(true);
        setError(null);
        try {
            const next = await updateCandidateStage(token, passportId, "DOCUMENT_SUBMISSION", { completed });
            setCompleted(stageOf(next, "DOCUMENT_SUBMISSION").completed);
            onChange(next);
        } catch (caught) {
            setError(message(caught));
        } finally {
            setBusy(false);
        }
    };
    const exportPdf = () => {
        if (!exportDocumentSubmissionPdf(details)) setError("The browser blocked the export window. Allow pop-ups for this site and try again.");
    };

    return (
        <form onSubmit={submit}>
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
            <div className="mt-4 space-y-2">
                <DocumentRow passportId={passportId} documentType="MEDICAL" label="Medical" required document={details.documents.MEDICAL} readOnly={!canEdit} onUploaded={onChange} />
                <DocumentRow passportId={passportId} documentType="POLICE_REPORT" label="Police report" required document={details.documents.POLICE_REPORT} variants={POLICE_REPORT_VARIANTS} readOnly={!canEdit} onUploaded={onChange} />
                <DocumentRow passportId={passportId} documentType="AGREEMENT" label="Scan - Agreement" required description="Agreement document" document={details.documents.AGREEMENT} readOnly={!canEdit} onUploaded={onChange} />
                <DocumentRow passportId={passportId} documentType="AFFIDAVIT" label="Scan - Affidavit" required document={details.documents.AFFIDAVIT} variants={AFFIDAVIT_VARIANTS} readOnly={!canEdit} onUploaded={onChange} />
            </div>
            <PanelFooter
                completedLabel={`All ${total} required documents are included`}
                completed={completed}
                onCompleted={setCompleted}
                completedDisabled={!allIncluded && !completed}
                canEdit={canEdit}
                busy={busy}
                dirty={completed !== saved.completed}
                error={error}
                onCancel={() => { setCompleted(saved.completed); setError(null); }}
            />
        </form>
    );
}
