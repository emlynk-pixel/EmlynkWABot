import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
    approveReviewItem,
    getReviewFile,
    getReviewItem,
    keepReviewItemPending,
    type ApproveResult,
    type AuditEntry,
    type ProcessingSummary,
    type ReviewItem,
} from "../api/admin";
import { ApiError } from "../api/client";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { Confidence } from "../components/Confidence";
import { documentTypeLabel, formatDateTime, formatFileSize, humanize, shortId } from "../components/format";
import { Icon } from "../components/Icon";
import { AUDIT_ACTIONS, IDENTITY_NOTES, REVIEW_REASONS, reviewReasonLabel, reviewReasonTone } from "../components/reviewLabels";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { StatusBadge, ToneBadge } from "../components/StatusBadge";

// The file is fetched through the backend with the admin's token and shown
// from a local blob: URL (released when the page closes).
function FilePreview({ file }: { file: ReviewItem["file"] }) {
    const { token, signOut } = useAuth();
    const [state, setState] = useState<{ status: "loading" | "ready" | "error"; url?: string; message?: string }>({ status: "loading" });

    useEffect(() => {
        if (!token || !file.previewUrl) return;
        const controller = new AbortController();
        let objectUrl: string | undefined;
        setState({ status: "loading" });
        getReviewFile(token, file.previewUrl, controller.signal)
            .then((blob) => {
                objectUrl = URL.createObjectURL(blob);
                setState({ status: "ready", url: objectUrl });
            })
            .catch((error: unknown) => {
                if ((error as Error)?.name === "AbortError") return;
                if (error instanceof ApiError && error.status === 401) return signOut();
                setState({ status: "error", message: error instanceof ApiError ? error.message : "The file could not be loaded." });
            });
        return () => {
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [token, file.previewUrl, signOut]);

    if (!file.previewUrl) return <EmptyState title="No preview available" description="This file type cannot be previewed." />;
    if (state.status === "loading") return <LoadingState label="Loading file…" />;
    if (state.status === "error") return <ErrorState message={state.message ?? "The file could not be loaded."} />;

    return file.mimeType === "application/pdf" ? (
        <div className="flex h-full flex-col">
            <iframe title={`Preview of ${file.name}`} src={state.url} className="h-[70vh] w-full rounded border border-border bg-canvas" />
            <a href={state.url} target="_blank" rel="noopener noreferrer" className="mt-2 self-end text-label-md text-primary hover:underline">Open PDF in a new tab</a>
        </div>
    ) : (
        <img src={state.url} alt={`Preview of ${file.name}`} className="mx-auto max-h-[70vh] w-auto rounded border border-border bg-canvas object-contain" />
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4 py-1.5">
            <dt className="text-label-caps uppercase text-ink-subtle">{label}</dt>
            <dd className="text-right text-body-sm text-ink">{children ?? "—"}</dd>
        </div>
    );
}

const list = (values: string[] | undefined) => (values && values.length ? values.map(humanize).join(", ") : "—");

function ProcessingDetails({ processing }: { processing: ProcessingSummary | null }) {
    if (!processing) {
        return <p className="text-body-sm text-ink-muted">Processing details were not recorded for this item (it was processed before review data was saved).</p>;
    }
    const { confidence, passport, policeDate, passportAcceptance, storage, reconciliation } = processing;
    return (
        <dl className="divide-y divide-border">
            <Row label="Stage">{processing.stage ? humanize(processing.stage) : null}</Row>
            {processing.error && <Row label="Error"><span className="text-critical">{processing.error}</span></Row>}
            <Row label="Extraction method">{processing.extractionMethod ? humanize(processing.extractionMethod) : null}</Row>
            <Row label="Classification source">{processing.typeSource ? humanize(processing.typeSource) : null}</Row>
            {processing.ocrThresholding && <Row label="OCR thresholding">{[processing.ocrThresholding].flat().join(", ")}</Row>}
            {processing.ocrUpscaled !== undefined && processing.ocrUpscaled !== null && <Row label="OCR upscaling">{processing.ocrUpscaled ? "2× read used" : "No"}</Row>}
            {confidence && (
                <>
                    <Row label="Confidence band"><StatusBadge status={confidence.band} /></Row>
                    {confidence.measuredBand && confidence.measuredBand !== confidence.band && <Row label="Measured band">{humanize(confidence.measuredBand)}</Row>}
                    <Row label="Extraction / classification">{`${confidence.extraction}% / ${confidence.classification}%`}</Row>
                    <Row label="Flags">{list(confidence.flags)}</Row>
                </>
            )}
            {passport && (
                <>
                    <Row label="Passport fields">{humanize(passport.status)}</Row>
                    <Row label="Missing fields">{list(passport.missingFields)}</Row>
                    <Row label="MRZ lines found">{String(passport.mrzLinesFound)}</Row>
                    <Row label="Passport ID band">{passport.passportIdBand ? humanize(passport.passportIdBand) : null}</Row>
                </>
            )}
            {passportAcceptance && <Row label="Low-quality passport rule">{passportAcceptance.accepted ? "Accepted" : `Not accepted: ${list(passportAcceptance.failedConditions)}`}</Row>}
            {policeDate && <Row label="Police slip date">{`${humanize(policeDate.status)}${policeDate.kind ? ` (${humanize(policeDate.kind)})` : ""}`}</Row>}
            {reconciliation && (
                <>
                    <Row label="Matches client record">{list(reconciliation.matched)}</Row>
                    <Row label="Differs from record">{list(reconciliation.conflicts)}</Row>
                </>
            )}
            {storage && <Row label="Checksum / placement">{`${storage.checksum ? humanize(storage.checksum) : "—"} / ${humanize(storage.placement)}`}</Row>}
        </dl>
    );
}

const MAX_REASON_LENGTH = 500;

// Review history (append-only on the server), newest first.
function AuditLog({ entries }: { entries: AuditEntry[] }) {
    if (!entries.length) {
        return <EmptyState title="No review actions yet" description="Approve and Keep Pending decisions are recorded here." />;
    }
    return (
        <ol aria-label="Review history" className="mt-2 divide-y divide-border">
            {entries.map((entry) => {
                const action = AUDIT_ACTIONS[entry.action] ?? { label: humanize(entry.action), tone: "pending" as const };
                return (
                    <li key={entry.auditId} className="space-y-1 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <ToneBadge tone={action.tone}>{action.label}</ToneBadge>
                            <time dateTime={entry.createdDate} className="text-label-sm text-ink-muted">{formatDateTime(entry.createdDate)}</time>
                        </div>
                        <p className="text-body-sm text-ink">{entry.adminName ?? "Unknown admin"}</p>
                        <p className="text-body-sm text-ink-soft">{entry.reason ?? <span className="text-ink-subtle">No reason given</span>}</p>
                    </li>
                );
            })}
        </ol>
    );
}

// A small modal in the page's card style. Escape or Cancel closes it,
// except while the request is running.
function ActionDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
    const titleId = useId();
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !busy) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-surface">
                <h2 id={titleId} className="text-headline-sm text-ink">{title}</h2>
                <div className="mt-3">{children}</div>
            </div>
        </div>
    );
}

const buttonBase = "h-9 rounded px-4 text-label-md disabled:cursor-not-allowed disabled:opacity-60";
const primaryButton = `${buttonBase} bg-primary text-white hover:opacity-90`;
const secondaryButton = `${buttonBase} border border-border-strong bg-surface text-ink-soft hover:border-border-focus hover:bg-canvas`;

function DialogError({ message }: { message: string | null }) {
    return message ? <p role="alert" className="mt-3 rounded border border-critical-border bg-critical-bg px-3 py-2 text-body-sm text-critical">{message}</p> : null;
}

type Notice = { tone: "success" | "info"; text: string };

function ReviewContent({ item, onChanged }: { item: ReviewItem; onChanged: () => void }) {
    const { token, signOut } = useAuth();
    const reason = item.reviewReason ? REVIEW_REASONS[item.reviewReason] : undefined;
    const identity = item.processing?.identity;
    const idLabel = shortId((item.document.documentId ?? item.document.temporaryId ?? item.reviewId.replace(/^(pending|document)-/, "")));

    const [dialog, setDialog] = useState<"approve" | "keep" | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [approved, setApproved] = useState<ApproveResult | null>(null);
    const [keepReason, setKeepReason] = useState("");
    const [reasonError, setReasonError] = useState<string | null>(null);

    const approveBlocked = item.actions?.approve.available === false ? item.actions.approve.message : null;
    const auditLog = approved ? [approved.audit, ...item.auditLog] : item.auditLog;
    const verificationStatus = approved ? approved.document.verificationStatus : item.document.verificationStatus;

    const open = (which: "approve" | "keep") => {
        setError(null);
        setReasonError(null);
        setNotice(null);
        if (which === "keep") setKeepReason("");
        setDialog(which);
    };
    const close = () => {
        if (!busy) setDialog(null);
    };

    // The server's message is shown as it is (e.g. a 409 conflict); nothing
    // on the page changes, the item stays pending.
    const fail = (caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) return signOut();
        setError(caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");
    };

    const confirmApprove = async () => {
        if (!token || busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await approveReviewItem(token, item.reviewId);
            setApproved(result);
            setDialog(null);
            setNotice({
                tone: "success",
                text: result.document.storedFilename
                    ? `Approved. The document was stored in the client folder as ${result.document.storedFilename} and marked as verified.`
                    : "Approved. The document is marked as verified.",
            });
        } catch (caught) {
            fail(caught);
        } finally {
            setBusy(false);
        }
    };

    const confirmKeep = async (event: FormEvent) => {
        event.preventDefault();
        if (!token || busy) return;
        const trimmed = keepReason.trim();
        if (!trimmed) {
            setReasonError("Enter a reason.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await keepReviewItemPending(token, item.reviewId, trimmed);
            setDialog(null);
            setNotice({ tone: "info", text: "Kept pending. The item stays in the Review Queue." });
            onChanged();
        } catch (caught) {
            fail(caught);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-label-md">
                <Link to="/review" className="inline-flex items-center gap-1 text-primary hover:underline">
                    <Icon name="chevron_left" className="size-4" />Review Queue
                </Link>
                <span aria-hidden="true" className="text-ink-subtle">/</span>
                <h1 id="page-title" className="font-semibold text-ink">{idLabel}</h1>
                <span className="text-label-sm text-ink-muted">{item.kind === "PENDING" ? "Waiting file" : "Stored document"}</span>
            </div>

            {notice && (
                <div role="status" className={`rounded-lg border px-3 py-2 text-body-sm ${notice.tone === "success" ? "border-verified-border bg-verified-bg text-verified" : "border-review-border bg-review-bg text-ink"}`}>
                    {notice.text}
                </div>
            )}

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
                <Card className="p-4 xl:col-span-7">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-label-md text-ink">{item.file.name}</p>
                        <span className="text-label-sm text-ink-muted">
                            {approved || item.file.location === "CLIENT" ? "Client folder" : "Pending storage"}
                            {item.file.size !== null ? ` · ${formatFileSize(item.file.size)}` : ""}
                        </span>
                    </div>
                    <FilePreview file={item.file} />
                </Card>

                <div className="space-y-4 xl:col-span-5">
                    <div role="note" className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${reviewReasonTone(item.reviewReason) === "critical" ? "border-critical-border bg-critical-bg" : "border-review-border bg-review-bg"}`}>
                        <Icon name="error" className={`mt-0.5 size-5 ${reviewReasonTone(item.reviewReason) === "critical" ? "text-critical" : "text-review"}`} />
                        <div>
                            <p className="text-label-md text-ink">{reviewReasonLabel(item.reviewReason)}</p>
                            <p className="text-body-sm text-ink-muted">{reason?.description ?? "The review reason was not recorded for this item."}</p>
                        </div>
                    </div>

                    <Card className="p-4">
                        <SectionHeading title="Document information" />
                        <dl className="mt-2 divide-y divide-border">
                            <Row label="Document type">{documentTypeLabel(item.document.documentType)}</Row>
                            <Row label="Client">
                                {item.client ? (
                                    <Link to={`/clients/${encodeURIComponent(item.client.passportId)}`} className="text-primary hover:underline">
                                        {item.client.name ?? item.client.passportId} ({item.client.passportId})
                                    </Link>
                                ) : "Not identified"}
                            </Row>
                            <Row label="Sender (WhatsApp)">{item.submission?.whatsappNumber}</Row>
                            <Row label="Received">{formatDateTime(item.document.receivedDate)}</Row>
                            <Row label="Processing status"><StatusBadge status={item.document.processingStatus} /></Row>
                            {verificationStatus && <Row label="Verification status"><StatusBadge status={verificationStatus} /></Row>}
                            <Row label="Confidence"><Confidence value={item.document.confidence} /></Row>
                            <Row label="Review reason"><ToneBadge tone={reviewReasonTone(item.reviewReason)}>{reviewReasonLabel(item.reviewReason)}</ToneBadge></Row>
                        </dl>
                    </Card>

                    <Card className="p-4">
                        <SectionHeading title="Identity" />
                        {identity ? (
                            <dl className="mt-2 divide-y divide-border">
                                <Row label="Identity status">{humanize(identity.status)}</Row>
                                <Row label="Provisional">{identity.provisional ? "Yes" : "No"}</Row>
                                <Row label="Notes">{identity.notes.length ? identity.notes.map((note) => IDENTITY_NOTES[note] ?? humanize(note)).join("; ") : "—"}</Row>
                            </dl>
                        ) : <p className="mt-2 text-body-sm text-ink-muted">No identity check was recorded.</p>}
                    </Card>

                    <Card className="p-4">
                        <SectionHeading title="Processing details" />
                        <div className="mt-2"><ProcessingDetails processing={item.processing} /></div>
                    </Card>

                    <Card className="p-4">
                        <SectionHeading title="Audit log" />
                        <AuditLog entries={auditLog} />
                    </Card>

                    <Card className="space-y-2 p-4">
                        {approved ? (
                            <p className="text-body-sm text-ink-muted">
                                This item is no longer in the Review Queue.{" "}
                                <Link to="/review" className="text-primary hover:underline">Back to Review Queue</Link>
                            </p>
                        ) : (
                            <>
                                <div className="flex flex-wrap gap-2" role="group" aria-label="Review actions">
                                    <button type="button" className={primaryButton} disabled={busy || Boolean(approveBlocked)} onClick={() => open("approve")}>
                                        Approve
                                    </button>
                                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => open("keep")}>
                                        Keep Pending
                                    </button>
                                </div>
                                {approveBlocked && <p className="text-label-sm text-ink-muted">Approve is not available: {approveBlocked}</p>}
                            </>
                        )}
                    </Card>
                </div>
            </div>

            {dialog === "approve" && (
                <ActionDialog title="Approve this document?" busy={busy} onClose={close}>
                    <p className="text-body-sm text-ink-soft">
                        {item.kind === "PENDING"
                            ? "This will move the document to permanent client storage and mark it as verified."
                            : "The document is already in the client folder. It will be marked as verified."}
                    </p>
                    <DialogError message={error} />
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" className={secondaryButton} disabled={busy} onClick={close} autoFocus>Cancel</button>
                        <button type="button" className={primaryButton} disabled={busy} onClick={confirmApprove}>{busy ? "Approving…" : "Approve"}</button>
                    </div>
                </ActionDialog>
            )}

            {dialog === "keep" && (
                <ActionDialog title="Keep this document pending?" busy={busy} onClose={close}>
                    <form onSubmit={confirmKeep} noValidate>
                        <p className="text-body-sm text-ink-soft">It stays in pending storage and in the Review Queue. Your reason is recorded in the audit log.</p>
                        <label htmlFor="keep-reason" className="mt-3 block text-label-md text-ink">
                            Reason <span aria-hidden="true" className="text-critical">*</span>
                        </label>
                        <textarea
                            id="keep-reason"
                            required
                            aria-invalid={reasonError ? "true" : undefined}
                            aria-describedby={reasonError ? "keep-reason-error" : undefined}
                            maxLength={MAX_REASON_LENGTH}
                            rows={3}
                            value={keepReason}
                            disabled={busy}
                            onChange={(event) => {
                                setKeepReason(event.target.value);
                                setReasonError(null);
                            }}
                            className="mt-1 w-full rounded border border-border-strong bg-surface px-3 py-2 text-body-sm text-ink focus:border-border-focus focus:outline-none"
                            autoFocus
                        />
                        {reasonError && <p id="keep-reason-error" className="mt-1 text-label-sm text-critical">{reasonError}</p>}
                        <DialogError message={error} />
                        <div className="mt-4 flex justify-end gap-2">
                            <button type="button" className={secondaryButton} disabled={busy} onClick={close}>Cancel</button>
                            <button type="submit" className={primaryButton} disabled={busy}>{busy ? "Saving…" : "Keep Pending"}</button>
                        </div>
                    </form>
                </ActionDialog>
            )}
        </div>
    );
}

export function ReviewDetailPage() {
    const { id = "" } = useParams();
    const item = useAdminResource(`review/${id}`, (token, signal) => getReviewItem(token, id, signal));
    // While reloading after an action the item on screen stays visible
    // (only when it is still the item in the URL).
    const current = item.status !== "error" && item.data?.reviewId === id ? item.data : null;

    return (
        <section aria-labelledby="page-title">
            {current ? (
                <ReviewContent item={current} onChanged={item.reload} />
            ) : (
                item.status === "loading" && <Card><LoadingState label="Loading review item…" /></Card>
            )}
            {item.status === "error" && (item.error.status === 404 || item.error.status === 400 ? (
                <Card>
                    <h1 id="page-title" className="sr-only">Review item not found</h1>
                    <EmptyState
                        title="Review item not found"
                        description="It may have been resolved, or the link is wrong."
                        action={<Link to="/review" className="text-label-md text-primary hover:underline">Back to Review Queue</Link>}
                    />
                </Card>
            ) : (
                <Card><ErrorState message={item.error.message} onRetry={item.reload} /></Card>
            ))}
        </section>
    );
}
