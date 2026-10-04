import { useId, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { removeCandidateDocument, uploadCandidateDocument, variantLabel, type CandidateDetails, type CandidateDocument, type CandidateDocumentType } from "../../api/candidates";
import { formatDate } from "../format";
import { Icon } from "../Icon";
import { ActionDialog, DialogError, dangerButton, dangerSolidButton, secondaryButton } from "../Dialog";
import { textAreaControl } from "./CandidateFields";

export const DOCUMENT_ACCEPT = "application/pdf,image/jpeg,image/png";
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm";

function statusLine(document: CandidateDocument | null, description?: string, showVariant = true) {
    if (!document) return [description, "No file uploaded"].filter(Boolean).join(" • ");
    const displayName = document.originalFilename.replace(/^Copy of\s+/i, "");
    return [description, displayName, showVariant ? variantLabel(document.variant) : null, formatDate(document.receivedDate)].filter(Boolean).join(" • ");
}

// One document: its name, what is stored now, Upload / Replace and Remove. A
// file is uploaded as soon as it is chosen. `variant`: this row is one variant
// of a police report or affidavit (each has its own row and its own current
// document). `uploadable={false}`: a stored document that can only be removed
// (a police report with no known variant). Remove deletes the stored document
// and its file, after a confirmation with a reason (kept in the audit log).
// onUploaded gets the candidate after an upload or a removal.
export function DocumentRow({ passportId, documentType, label, removeTitle = label, description, required, document, variant, uploadable = true, accept = DOCUMENT_ACCEPT, readOnly, onUploaded, title }: {
    passportId: string;
    documentType: CandidateDocumentType;
    label: string;
    removeTitle?: string;
    description?: string;
    required?: boolean;
    document: CandidateDocument | null;
    variant?: string;
    uploadable?: boolean;
    accept?: string;
    readOnly?: boolean;
    onUploaded: (details: CandidateDetails) => void;
    title?: string;
}) {
    const { token } = useAuth();
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // An upload or a removal is saved as soon as it finishes (the form's Save
    // changes is for the form's fields): say so, so the admin doesn't look for a save.
    const [done, setDone] = useState<"Saved" | "Removed" | null>(null);
    const [removing, setRemoving] = useState(false);
    const [reason, setReason] = useState("");
    const [removeError, setRemoveError] = useState<string | null>(null);
    const reasonId = useId();

    const closeRemove = () => {
        setRemoving(false);
        setReason("");
        setRemoveError(null);
    };

    const confirmRemove = async (event: FormEvent) => {
        event.preventDefault();
        if (!token || !document || busy) return;
        if (!reason.trim()) {
            setRemoveError("Enter the reason for removing this file.");
            return;
        }
        setBusy(true);
        setRemoveError(null);
        try {
            onUploaded(await removeCandidateDocument(token, passportId, document.documentId, reason.trim()));
            closeRemove();
            setError(null);
            setDone("Removed");
        } catch (caught) {
            setRemoveError(caught instanceof ApiError ? caught.message : "The file could not be removed.");
        } finally {
            setBusy(false);
        }
    };

    const upload = async (file: File | undefined) => {
        if (!file || !token || !uploadable) return;
        setBusy(true);
        setError(null);
        setDone(null);
        try {
            onUploaded(await uploadCandidateDocument(token, passportId, documentType, file, variant));
            setDone("Saved");
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The file could not be uploaded.");
        } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
        }
    };

    return (
        <div className="rounded-lg border border-border px-4 py-3" title={title}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-label-md text-ink">
                        {label}{required && <span className="text-critical"> *</span>}
                        {document?.verificationStatus === "REVIEW_REQUIRED" && <span className="ml-2 text-label-sm text-review">Needs review</span>}
                        {done && <span role="status" className="ml-2 inline-flex items-center gap-1 text-label-sm text-verified"><Icon name="check" className="size-3.5" />{done}</span>}
                    </p>
                    <p className="truncate text-label-sm text-ink-subtle">{statusLine(document, description, !variant)}</p>
                </div>
                <div className="flex items-center gap-2">
                    {uploadable && (
                        <>
                            <input ref={input} type="file" accept={accept} className="hidden" aria-label={`${removeTitle} file`} disabled={readOnly || busy} onChange={(event) => upload(event.target.files?.[0])} />
                            <button type="button" disabled={readOnly || busy} onClick={() => input.current?.click()} className={`${secondaryButton} inline-flex items-center gap-1.5`}>
                                <Icon name="upload" className="size-4" />{busy && !removing ? "Uploading…" : document ? "Replace" : "Upload"}
                            </button>
                        </>
                    )}
                    {document && !readOnly && (
                        <button type="button" disabled={busy} onClick={() => setRemoving(true)} className={`${dangerButton} inline-flex items-center gap-1.5`}>
                            <Icon name="delete" className="size-4" />Remove
                        </button>
                    )}
                </div>
            </div>
            {error && <p role="alert" className="mt-2 text-label-sm text-critical">{error}</p>}
            {removing && document && (
                <ActionDialog title={`Remove ${removeTitle}?`} busy={busy} onClose={closeRemove}>
                    <form onSubmit={confirmRemove}>
                        <p className="text-body-sm text-ink-muted">
                            <span className="font-medium text-ink">{document.originalFilename.replace(/^Copy of\s+/i, "")}</span> will be deleted permanently: the file and its record.
                            The removal and your reason are kept in the audit log.
                        </p>
                        <label htmlFor={reasonId} className="mb-1 mt-4 block text-label-sm text-ink-muted">Reason<span className="text-critical"> *</span></label>
                        <textarea id={reasonId} rows={3} maxLength={500} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} className={textAreaControl} />
                        <DialogError message={removeError} />
                        <div className="mt-4 flex justify-end gap-2">
                            <button type="button" onClick={closeRemove} disabled={busy} className={secondaryButton}>Cancel</button>
                            <button type="submit" disabled={busy} className={dangerSolidButton}>{busy ? "Removing…" : "Remove"}</button>
                        </div>
                    </form>
                </ActionDialog>
            )}
        </div>
    );
}
