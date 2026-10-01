import { useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ApiError } from "../../api/client";
import { uploadCandidateDocument, variantLabel, type CandidateDetails, type CandidateDocument, type CandidateDocumentType } from "../../api/candidates";
import { formatDate } from "../format";
import { Icon } from "../Icon";
import { secondaryButton } from "../Dialog";

export const DOCUMENT_ACCEPT = "application/pdf,image/jpeg,image/png";
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm";

function statusLine(document: CandidateDocument | null, description?: string) {
    if (!document) return [description, "No file uploaded"].filter(Boolean).join(" • ");
    return [description, document.originalFilename, variantLabel(document.variant), formatDate(document.receivedDate)].filter(Boolean).join(" • ");
}

// One document: its name, what is stored now, an optional type selector and
// Upload. A file is uploaded as soon as it is chosen. A document with
// variants (police report, affidavit) needs its type chosen first: nothing is
// preselected unless the stored document already has one.
export function DocumentRow({ passportId, documentType, label, description, required, document, variants, accept = DOCUMENT_ACCEPT, readOnly, onUploaded }: {
    passportId: string;
    documentType: CandidateDocumentType;
    label: string;
    description?: string;
    required?: boolean;
    document: CandidateDocument | null;
    variants?: readonly { value: string; label: string }[];
    accept?: string;
    readOnly?: boolean;
    onUploaded: (details: CandidateDetails) => void;
}) {
    const { token } = useAuth();
    const input = useRef<HTMLInputElement>(null);
    const [variant, setVariant] = useState(() => (variants?.some((v) => v.value === document?.variant) ? document?.variant ?? "" : ""));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // An upload is saved as soon as it finishes (the form's Save changes is
    // for the form's fields): say so, so the admin doesn't look for a save.
    const [saved, setSaved] = useState(false);
    const needsVariant = Boolean(variants) && !variant;

    const upload = async (file: File | undefined) => {
        if (!file || !token || needsVariant) return;
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            onUploaded(await uploadCandidateDocument(token, passportId, documentType, file, variants ? variant : undefined));
            setSaved(true);
        } catch (caught) {
            setError(caught instanceof ApiError ? caught.message : "The file could not be uploaded.");
        } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
        }
    };

    return (
        <div className="rounded-lg border border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-label-md text-ink">
                        {label}{required && <span className="text-critical"> *</span>}
                        {document?.verificationStatus === "REVIEW_REQUIRED" && <span className="ml-2 text-label-sm text-review">Needs review</span>}
                        {saved && <span role="status" className="ml-2 inline-flex items-center gap-1 text-label-sm text-verified"><Icon name="check" className="size-3.5" />Saved</span>}
                    </p>
                    <p className="truncate text-label-sm text-ink-subtle">{statusLine(document, description)}</p>
                </div>
                <div className="flex items-center gap-2">
                    {variants && (
                        <select
                            aria-label={`${label} type`}
                            value={variant}
                            disabled={readOnly || busy}
                            onChange={(event) => setVariant(event.target.value)}
                            className="h-9 rounded border border-border-strong bg-surface px-2 text-label-sm text-ink focus:border-primary focus:outline-none"
                        >
                            <option value="" disabled>Select type…</option>
                            {variants.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                    )}
                    <input ref={input} type="file" accept={accept} className="hidden" aria-label={`${label} file`} disabled={readOnly || busy || needsVariant} onChange={(event) => upload(event.target.files?.[0])} />
                    <button type="button" disabled={readOnly || busy || needsVariant} onClick={() => input.current?.click()} className={`${secondaryButton} inline-flex items-center gap-1.5`}>
                        <Icon name="upload" className="size-4" />{busy ? "Uploading…" : document ? "Replace" : "Upload"}
                    </button>
                </div>
            </div>
            {error && <p role="alert" className="mt-2 text-label-sm text-critical">{error}</p>}
        </div>
    );
}
