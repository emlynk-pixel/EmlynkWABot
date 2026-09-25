import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { getReviewFile, getReviewItem, type ProcessingSummary, type ReviewItem } from "../api/admin";
import { ApiError } from "../api/client";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { Confidence } from "../components/Confidence";
import { documentTypeLabel, formatDateTime, formatFileSize, humanize, shortId } from "../components/format";
import { Icon } from "../components/Icon";
import { IDENTITY_NOTES, REVIEW_REASONS, reviewReasonLabel, reviewReasonTone } from "../components/reviewLabels";
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

const ACTIONS = ["Approve / Verify", "Reject", "Keep pending"] as const;

function ReviewContent({ item }: { item: ReviewItem }) {
    const reason = item.reviewReason ? REVIEW_REASONS[item.reviewReason] : undefined;
    const identity = item.processing?.identity;
    const idLabel = shortId((item.document.documentId ?? item.document.temporaryId ?? item.reviewId.replace(/^(pending|document)-/, "")));

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

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
                <Card className="p-4 xl:col-span-7">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-label-md text-ink">{item.file.name}</p>
                        <span className="text-label-sm text-ink-muted">
                            {item.file.location === "PENDING" ? "Pending storage" : "Client folder"}
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
                            {item.document.verificationStatus && <Row label="Verification status"><StatusBadge status={item.document.verificationStatus} /></Row>}
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
                        <p className="mt-2 text-body-sm text-ink-muted">Review decisions are not recorded yet. The audit log arrives with review actions.</p>
                    </Card>

                    <Card className="space-y-2 p-4">
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Review actions">
                            {ACTIONS.map((action) => (
                                <button
                                    key={action}
                                    type="button"
                                    disabled
                                    aria-disabled="true"
                                    title="Review actions are not available yet"
                                    className={`h-9 cursor-not-allowed rounded px-4 text-label-md opacity-60 ${action === "Approve / Verify" ? "bg-primary text-white" : action === "Reject" ? "bg-critical text-white" : "border border-border-strong bg-surface text-ink-soft"}`}
                                >
                                    {action}
                                </button>
                            ))}
                        </div>
                        <p className="text-label-sm text-ink-subtle">Review actions are read-only in this version and will be enabled in a later update.</p>
                    </Card>
                </div>
            </div>
        </div>
    );
}

export function ReviewDetailPage() {
    const { id = "" } = useParams();
    const item = useAdminResource(`review/${id}`, (token, signal) => getReviewItem(token, id, signal));

    return (
        <section aria-labelledby="page-title">
            {item.status === "loading" && <Card><LoadingState label="Loading review item…" /></Card>}
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
            {item.status === "success" && <ReviewContent item={item.data} />}
        </section>
    );
}
