import { useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import {
    createCandidate,
    getCandidate,
    updateCandidate,
    updateCandidateStage,
    uploadCandidateDocument,
    storedDocuments,
    variantLabel,
    type CandidateDetails,
    type CandidateDetailsInput,
    type CandidateDocumentType,
    type FailedUpload,
} from "../api/candidates";
import { canReview, useAuth } from "../auth/AuthProvider";
import { CandidateFields, detailsFrom, emptyDetails, Field, textAreaControl, validateDetails } from "../components/candidate/CandidateFields";
import { DocumentRow, DOCUMENT_ACCEPT, VIDEO_ACCEPT } from "../components/candidate/DocumentRow";
import { DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { documentTypeLabel } from "../components/format";
import { Icon } from "../components/Icon";
import { Card, EmptyState } from "../components/States";

const PASSPORT_PATTERN = /^[A-Z0-9]{6,9}$/;
const normalizePassportId = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();
const isPassportId = (value: string) => PASSPORT_PATTERN.test(value) && /\d/.test(value);

// Documents collected in Document Submission: listed here only when on record.
const OTHER_DOCUMENTS = ["MEDICAL", "POLICE_SLIP", "POLICE_REPORT", "SCAN"] as const;

// The passport ID lookup: not run yet, running, no candidate (new
// registration), an existing candidate (loaded into the form), or failed.
type Lookup =
    | { status: "idle" }
    | { status: "checking"; passportId: string }
    | { status: "new"; passportId: string }
    | { status: "error"; passportId: string; message: string }
    | { status: "found"; details: CandidateDetails };

const notesOf = (details: CandidateDetails) => details.stages.find((s) => s.stage === "CANDIDATE_DETAILS")?.notes ?? "";

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
// The passport ID is looked up first (on leaving the field, and before
// registering): a new one is created in `users` and its files uploaded; an
// existing candidate is loaded into the same form and saved to their record,
// with their stored documents shown (Replace uses the normal versioning).
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
    const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
    // The lookup for the current passport ID, shared by blur and submit so
    // the same ID is fetched once.
    const pending = useRef<{ passportId: string; promise: Promise<CandidateDetails | null> } | null>(null);

    if (!canReview(admin)) {
        return <Card><EmptyState title="Candidate registration needs an admin or analyst account." /></Card>;
    }

    const existing = lookup.status === "found" ? lookup.details : null;

    const load = (found: CandidateDetails) => {
        setLookup({ status: "found", details: found });
        setPassportId(found.candidate.passportId);
        setDetails(detailsFrom(found.candidate));
        setComment(notesOf(found));
        setFiles({ PASSPORT: null, NIC: null, SKILL_VIDEO: null });
        setErrors({});
        setError(null);
    };

    // Looks the passport ID up in `users` (once per ID). Resolves to the
    // existing candidate, or null for a new one or a failed lookup.
    const runLookup = (raw: string): Promise<CandidateDetails | null> => {
        const normalized = normalizePassportId(raw);
        if (!token || !isPassportId(normalized)) return Promise.resolve(null);
        if (pending.current?.passportId === normalized) return pending.current.promise;
        setLookup({ status: "checking", passportId: normalized });
        const entry = { passportId: normalized, promise: Promise.resolve<CandidateDetails | null>(null) };
        entry.promise = getCandidate(token, normalized).then(
            (found) => {
                if (pending.current !== entry) return null;
                load(found);
                return found;
            },
            (caught: unknown) => {
                if (pending.current !== entry) return null;
                if (caught instanceof ApiError && caught.status === 404) {
                    setLookup({ status: "new", passportId: normalized });
                } else {
                    pending.current = null; // not cached: can be tried again
                    setLookup({ status: "error", passportId: normalized, message: "The passport ID could not be checked." });
                }
                return null;
            },
        );
        pending.current = entry;
        return entry.promise;
    };

    const changePassportId = (next: string) => {
        setPassportId(next);
        const normalized = normalizePassportId(next);
        if (pending.current?.passportId !== normalized) pending.current = null;
        if (lookup.status !== "idle" && lookup.status !== "found" && lookup.passportId !== normalized) setLookup({ status: "idle" });
    };

    const startOver = () => {
        pending.current = null;
        setLookup({ status: "idle" });
        setPassportId("");
        setDetails(emptyDetails());
        setComment("");
        setErrors({});
        setError(null);
    };

    const saveExisting = async (current: CandidateDetails) => {
        if (!token) return;
        const found = validateDetails(details);
        setErrors(found);
        if (Object.keys(found).length) return;
        setBusy(true);
        setError(null);
        const candidateId = current.candidate.passportId;
        try {
            // The existing users row; stages keep their completion (only the
            // Candidate Details note changes, and only when it was edited).
            await updateCandidate(token, candidateId, details);
            if (comment.trim() !== notesOf(current).trim()) {
                await updateCandidateStage(token, candidateId, "CANDIDATE_DETAILS", { notes: comment.trim() || null });
            }
            navigate(`/candidates/${encodeURIComponent(candidateId)}?stage=CANDIDATE_DETAILS`);
        } catch (caught) {
            setError({ message: caught instanceof ApiError ? caught.message : "The changes could not be saved." });
            setBusy(false);
        }
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token) return;
        if (existing) return saveExisting(existing);

        // An existing passport ID loads that candidate instead of registering.
        const normalizedId = normalizePassportId(passportId);
        if (isPassportId(normalizedId)) {
            setBusy(true);
            const found = await runLookup(normalizedId);
            setBusy(false);
            if (found) return;
        }

        const found = validateDetails(details);
        if (!isPassportId(normalizedId)) found.passportId = "Enter the passport number (6 to 9 letters and digits).";
        setErrors(found);
        if (Object.keys(found).length) return;

        setBusy(true);
        setError(null);
        let created: string;
        try {
            created = (await createCandidate(token, { ...details, passportId: normalizedId, comment })).passportId;
        } catch (caught) {
            const exists = caught instanceof ApiError && caught.status === 409 && /passport ID/i.test(caught.message);
            setBusy(false);
            // Registered in the meantime: load it instead.
            if (exists) {
                try {
                    const found = await getCandidate(token, normalizedId);
                    pending.current = { passportId: normalizedId, promise: Promise.resolve(found) };
                    load(found);
                    return;
                } catch {
                    // fall through to the message with the link
                }
            }
            setError({ message: caught instanceof ApiError ? caught.message : "The candidate could not be registered.", existingId: exists ? normalizedId : undefined });
            return;
        }

        // The candidate exists now; a failed upload is reported on their page,
        // where it can be uploaded again (the report goes once it is).
        const failedUploads: FailedUpload[] = [];
        for (const documentType of ["PASSPORT", "NIC", "SKILL_VIDEO"] as CandidateDocumentType[]) {
            const file = files[documentType as keyof typeof files];
            if (!file) continue;
            try {
                await uploadCandidateDocument(token, created, documentType, file);
            } catch (caught) {
                failedUploads.push({ documentType, message: caught instanceof ApiError ? caught.message : "upload failed" });
            }
        }
        navigate(`/candidates/${encodeURIComponent(created)}?stage=CANDIDATE_DETAILS`, {
            state: failedUploads.length ? { failedUploads } : undefined,
        });
    };

    const setFile = (type: keyof typeof files) => (file: File | null) => setFiles((previous) => ({ ...previous, [type]: file }));
    const onUploaded = (next: CandidateDetails) => setLookup({ status: "found", details: next });

    const hint = lookup.status === "checking"
        ? <span className="text-ink-subtle">Checking passport ID…</span>
        : lookup.status === "found"
            ? (
                <span className="flex flex-wrap items-center gap-x-2 text-verified">
                    <span className="inline-flex items-center gap-1"><Icon name="check" className="size-3.5" />Existing candidate found — details loaded.</span>
                    <button type="button" onClick={startOver} disabled={busy} className="text-primary hover:underline">Use another passport ID</button>
                </span>
            )
            : lookup.status === "error"
                ? (
                    <span className="flex flex-wrap items-center gap-x-2 text-critical">
                        {lookup.message}
                        <button type="button" onClick={() => void runLookup(passportId)} className="text-primary hover:underline">Try again</button>
                    </span>
                )
                : undefined;

    const others = existing ? OTHER_DOCUMENTS.flatMap((type) => storedDocuments(existing, type).map((document) => {
        const variant = variantLabel(document.variant);
        return `${documentTypeLabel(type)}${variant ? ` (${variant})` : ""}`;
    })) : [];

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
                            passportId={existing
                                ? { value: passportId, hint }
                                : { value: passportId, onChange: changePassportId, onBlur: () => void runLookup(passportId), error: errors.passportId, hint }}
                            whatsappLocked={Boolean(existing?.candidate.whatsappNumber)}
                        />
                    </div>
                    {existing ? (
                        <div className="mt-6 space-y-2">
                            <DocumentRow passportId={existing.candidate.passportId} documentType="PASSPORT" label="Passport" document={existing.documents.PASSPORT} onUploaded={onUploaded} />
                            <DocumentRow passportId={existing.candidate.passportId} documentType="NIC" label="NIC document" document={existing.documents.NIC} onUploaded={onUploaded} />
                            <DocumentRow passportId={existing.candidate.passportId} documentType="SKILL_VIDEO" label="Skill video" document={existing.documents.SKILL_VIDEO} accept={VIDEO_ACCEPT} onUploaded={onUploaded} />
                            {others.length > 0 && <p className="text-label-sm text-ink-subtle">Also on record: {others.join(", ")}</p>}
                        </div>
                    ) : (
                        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                            <FileInput id={`${id}-passport`} label="Passport" accept={DOCUMENT_ACCEPT} file={files.PASSPORT} onChange={setFile("PASSPORT")} disabled={busy} />
                            <FileInput id={`${id}-nic`} label="NIC document" accept={DOCUMENT_ACCEPT} file={files.NIC} onChange={setFile("NIC")} disabled={busy} />
                            <FileInput id={`${id}-video`} label="Skill video" accept={VIDEO_ACCEPT} file={files.SKILL_VIDEO} onChange={setFile("SKILL_VIDEO")} disabled={busy} />
                        </div>
                    )}
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
                        <button type="submit" disabled={busy} className={primaryButton}>
                            {existing ? (busy ? "Saving…" : "Save changes") : busy ? "Registering…" : "Register candidate"}
                        </button>
                    </div>
                </form>
            </Card>
        </section>
    );
}
