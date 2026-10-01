import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { createCandidate, uploadCandidateDocument, type CandidateDetailsInput, type CandidateDocumentType } from "../api/candidates";
import { canReview, useAuth } from "../auth/AuthProvider";
import { CandidateFields, emptyDetails, Field, textAreaControl, validateDetails } from "../components/candidate/CandidateFields";
import { DOCUMENT_ACCEPT, VIDEO_ACCEPT } from "../components/candidate/DocumentRow";
import { DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { documentTypeLabel } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, EmptyState } from "../components/States";

const PASSPORT_PATTERN = /^[A-Z0-9]{6,9}$/;

function FileInput({ id, label, required, accept, file, onChange, disabled, error }: { id: string; label: string; required?: boolean; accept: string; file: File | null; onChange: (file: File | null) => void; disabled?: boolean; error?: string }) {
    return (
        <Field label={label} required={required} htmlFor={id} error={error}>
            <div className="flex items-center gap-2">
                <label htmlFor={id} className={`${secondaryButton} inline-flex cursor-pointer items-center gap-1.5 ${disabled ? "pointer-events-none opacity-60" : ""}`}>
                    <Icon name="upload" className="size-4" />Choose file
                </label>
                <input id={id} type="file" accept={accept} disabled={disabled} className="sr-only" onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
                <span className="truncate text-label-sm text-ink-subtle">{file ? file.name : "No file selected"}</span>
            </div>
        </Field>
    );
}

// Registration, the first step: the candidate's details (as in the passport),
// job types and experience, and the passport (required), NIC and skill video.
// The candidate is created in `users`; then the files are uploaded.
export function CandidateRegistrationPage() {
    const { admin, token } = useAuth();
    const navigate = useNavigate();
    const id = useId();
    const [passportId, setPassportId] = useState("");
    const [details, setDetails] = useState<CandidateDetailsInput>(emptyDetails);
    const [comment, setComment] = useState("");
    const [files, setFiles] = useState<Record<"PASSPORT" | "NIC" | "SKILL_VIDEO", File | null>>({ PASSPORT: null, NIC: null, SKILL_VIDEO: null });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ message: string; existingId?: string } | null>(null);

    if (!canReview(admin)) {
        return <Card><EmptyState title="Candidate registration needs an admin or reviewer account." /></Card>;
    }

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        const found = validateDetails(details);
        const normalizedId = passportId.replace(/[\s-]/g, "").toUpperCase();
        if (!PASSPORT_PATTERN.test(normalizedId) || !/\d/.test(normalizedId)) found.passportId = "Enter the passport number (6 to 9 letters and digits).";
        if (!files.PASSPORT) found.passportFile = "Choose the passport file.";
        setErrors(found);
        if (Object.keys(found).length) return;

        setBusy(true);
        setError(null);
        let created: string;
        try {
            created = (await createCandidate(token, { ...details, passportId: normalizedId, comment })).passportId;
        } catch (caught) {
            const existing = caught instanceof ApiError && caught.status === 409 && /passport ID/i.test(caught.message);
            setError({ message: caught instanceof ApiError ? caught.message : "The candidate could not be registered.", existingId: existing ? normalizedId : undefined });
            setBusy(false);
            return;
        }

        // The candidate exists now; a failed upload is reported on their page,
        // where it can be uploaded again.
        const failed: string[] = [];
        for (const documentType of ["PASSPORT", "NIC", "SKILL_VIDEO"] as CandidateDocumentType[]) {
            const file = files[documentType as keyof typeof files];
            if (!file) continue;
            try {
                await uploadCandidateDocument(token, created, documentType, file);
            } catch (caught) {
                failed.push(`${documentTypeLabel(documentType)}: ${caught instanceof ApiError ? caught.message : "upload failed"}`);
            }
        }
        navigate(`/candidates/${encodeURIComponent(created)}?stage=CANDIDATE_DETAILS`, {
            state: failed.length ? { notice: `The candidate was registered, but these files were not uploaded — ${failed.join("; ")}` } : undefined,
        });
    };

    const setFile = (type: keyof typeof files) => (file: File | null) => setFiles((previous) => ({ ...previous, [type]: file }));

    return (
        <section aria-labelledby="page-title" className="mx-auto max-w-4xl space-y-4">
            <div>
                <Link to="/candidates" className="text-label-md text-primary hover:underline">Candidates</Link>
                <h1 id="page-title" className="mt-1 text-headline-lg text-ink">Add candidate</h1>
            </div>
            <Card className="p-6">
                <form onSubmit={submit} noValidate>
                    <h2 className="text-headline-sm text-ink">Candidate details</h2>
                    <div className="mt-4">
                        <CandidateFields
                            value={details}
                            onChange={setDetails}
                            errors={errors}
                            disabled={busy}
                            passportId={{ value: passportId, onChange: setPassportId, error: errors.passportId }}
                        />
                    </div>
                    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                        <FileInput id={`${id}-passport`} label="Passport" required accept={DOCUMENT_ACCEPT} file={files.PASSPORT} onChange={setFile("PASSPORT")} disabled={busy} error={errors.passportFile} />
                        <FileInput id={`${id}-nic`} label="NIC document" accept={DOCUMENT_ACCEPT} file={files.NIC} onChange={setFile("NIC")} disabled={busy} />
                        <FileInput id={`${id}-video`} label="Skill video" accept={VIDEO_ACCEPT} file={files.SKILL_VIDEO} onChange={setFile("SKILL_VIDEO")} disabled={busy} />
                    </div>
                    <div className="mt-6">
                        <Field label="Comment" htmlFor={`${id}-comment`}>
                            <textarea id={`${id}-comment`} rows={3} maxLength={2000} value={comment} disabled={busy} onChange={(event) => setComment(event.target.value)} placeholder="Internal note for admins and analysts" className={textAreaControl} />
                        </Field>
                    </div>
                    {error && (
                        <div>
                            <DialogError message={error.message} />
                            {error.existingId && (
                                <Link to={`/candidates/${encodeURIComponent(error.existingId)}`} className="mt-2 inline-block text-label-md text-primary hover:underline">Open the registered candidate</Link>
                            )}
                        </div>
                    )}
                    <div className="mt-6 flex justify-end gap-2">
                        <button type="button" onClick={() => navigate("/candidates")} disabled={busy} className={secondaryButton}>Cancel</button>
                        <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Registering…" : "Register candidate"}</button>
                    </div>
                </form>
            </Card>
        </section>
    );
}
