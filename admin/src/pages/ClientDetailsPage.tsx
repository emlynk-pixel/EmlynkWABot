import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { getClientDetails, setPoliceDate, type ClientDetails } from "../api/admin";
import { ApiError } from "../api/client";
import { useAdminResource } from "../api/useAdminResource";
import { useAuth } from "../auth/AuthProvider";
import { ActionDialog, DialogError, primaryButton, secondaryButton } from "../components/Dialog";
import { DocumentsTable } from "../components/DocumentsTable";
import { documentTypeLabel, formatDate, formatDateTime, formatDay, todayInSriLanka } from "../components/format";
import { Icon } from "../components/Icon";
import { daysLeftLabel, policeStatusLabel } from "../components/policeLabels";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { StatusBadge, ToneBadge, statusTone } from "../components/StatusBadge";

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <dt className="text-label-caps uppercase text-ink-subtle">{label}</dt>
            <dd className="mt-0.5 text-body-md text-ink">{children ?? "—"}</dd>
        </div>
    );
}

function PoliceDocument({ label, doc }: { label: string; doc: ClientDetails["police"]["latestSlip"] }) {
    return (
        <div className="rounded-lg bg-canvas p-3">
            <p className="text-label-caps uppercase text-ink-subtle">{label}</p>
            {doc ? (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-body-sm text-ink">Received {formatDateTime(doc.receivedDate)}</span>
                    <StatusBadge status={doc.verificationStatus} />
                </div>
            ) : (
                <p className="mt-1 text-body-sm text-ink-muted">Not received</p>
            )}
        </div>
    );
}

// The 21-day follow-up for the final police report (calculated by the backend).
function PoliceCountdownPanel({ countdown }: { countdown: ClientDetails["police"]["countdown"] }) {
    const note: Record<string, string> = {
        COMPLETED: "A verified police report is on file. The follow-up is complete.",
        DATE_MISSING: countdown.slipAwaitingReview
            ? "A police slip is waiting for review. The countdown starts once its submitted date is known."
            : "The police slip's submitted date is not known yet, so no countdown is running.",
        NOT_UPLOADED: "No police slip has been received, so no countdown is running.",
    };
    return (
        <div className="rounded-lg border border-border p-3" aria-label="Police report follow-up" role="group">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-label-caps uppercase text-ink-subtle">21-day follow-up</p>
                <ToneBadge tone={statusTone(countdown.status)}>{policeStatusLabel(countdown.status)}</ToneBadge>
            </div>
            {countdown.submittedDate && (
                <dl className="mt-2 grid grid-cols-3 gap-2 text-body-sm">
                    <div><dt className="text-label-sm text-ink-subtle">Slip submitted</dt><dd className="text-ink">{formatDay(countdown.submittedDate)}</dd></div>
                    <div><dt className="text-label-sm text-ink-subtle">Report due</dt><dd className="text-ink">{formatDay(countdown.dueDate)}</dd></div>
                    <div><dt className="text-label-sm text-ink-subtle">Days</dt><dd className={countdown.daysRemaining !== null && countdown.daysRemaining <= 0 ? "font-medium text-critical" : "text-ink"}>{daysLeftLabel(countdown)}</dd></div>
                </dl>
            )}
            {note[countdown.status] && <p className="mt-2 text-body-sm text-ink-muted">{note[countdown.status]}</p>}
        </div>
    );
}

// Set or correct the submitted date of the client's latest stored police
// slip (e.g. an older verified slip stored without one). Audited; the
// 21-day countdown is recalculated from the new date.
function PoliceDateDialog({ slip, onClose, onSaved }: { slip: NonNullable<ClientDetails["police"]["latestSlip"]>; onClose: () => void; onSaved: (date: string) => void }) {
    const { token, signOut } = useAuth();
    const [date, setDate] = useState(slip.policeSubmittedDate ?? "");
    const [reason, setReason] = useState("");
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const today = todayInSriLanka();

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!token || busy) return;
        if (!date) return setFieldError("Enter the submitted date shown on the police slip.");
        if (date > today) return setFieldError("The date can't be in the future.");
        if (date < "2000-01-01") return setFieldError("The date must be on or after 1 January 2000.");
        if (!reason.trim()) return setFieldError("Enter a reason.");
        setBusy(true);
        setError(null);
        try {
            await setPoliceDate(token, slip.documentId, date, reason.trim());
            onSaved(date);
        } catch (caught) {
            if (caught instanceof ApiError && caught.status === 401) return signOut();
            setError(caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <ActionDialog title={slip.policeSubmittedDate ? "Correct the police slip date" : "Set the police slip date"} busy={busy} onClose={onClose}>
            <form onSubmit={submit} noValidate>
                <p className="text-body-sm text-ink-soft">
                    {slip.policeSubmittedDate
                        ? `The slip's submitted date is ${formatDay(slip.policeSubmittedDate)}. `
                        : "This slip has no submitted date, so no countdown is running. "}
                    The final police report is due 21 days after this date (Sri Lanka calendar). The change is recorded in the audit log.
                </p>
                <label htmlFor="slip-date" className="mt-3 block text-label-md text-ink">
                    Submitted date on the police slip <span aria-hidden="true" className="text-critical">*</span>
                </label>
                <input
                    id="slip-date"
                    type="date"
                    min="2000-01-01"
                    max={today}
                    value={date}
                    disabled={busy}
                    onChange={(event) => {
                        setDate(event.target.value);
                        setFieldError(null);
                    }}
                    className="mt-1 h-9 w-full rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-border-focus focus:outline-none"
                />
                <label htmlFor="slip-date-reason" className="mt-3 block text-label-md text-ink">
                    Reason <span aria-hidden="true" className="text-critical">*</span>
                </label>
                <textarea
                    id="slip-date-reason"
                    maxLength={500}
                    rows={2}
                    value={reason}
                    disabled={busy}
                    onChange={(event) => {
                        setReason(event.target.value);
                        setFieldError(null);
                    }}
                    className="mt-1 w-full rounded border border-border-strong bg-surface px-3 py-2 text-body-sm text-ink focus:border-border-focus focus:outline-none"
                />
                {fieldError && <p className="mt-2 text-label-sm text-critical">{fieldError}</p>}
                <DialogError message={error} />
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>Cancel</button>
                    <button type="submit" className={primaryButton} disabled={busy}>{busy ? "Saving…" : "Save date"}</button>
                </div>
            </form>
        </ActionDialog>
    );
}

function ClientContent({ data, onChanged }: { data: ClientDetails; onChanged: () => void }) {
    const { client } = data;
    const missing = data.missingDocumentTypes;
    const [dateDialog, setDateDialog] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const slip = data.police.latestSlip;

    return (
        <div className="space-y-6">
            <div className="space-y-1">
                <nav aria-label="Breadcrumb" className="text-label-sm text-ink-muted">
                    <Link to="/clients" className="hover:text-primary">Clients</Link>
                    <span aria-hidden="true" className="px-1.5">/</span>
                    <span className="text-ink">{client.name ?? client.passportId} ({client.passportId})</span>
                </nav>
                <div className="flex flex-wrap items-center gap-3">
                    <h1 id="page-title" className="text-headline-xl text-ink">{client.name ?? client.passportId}</h1>
                    <span className="rounded bg-canvas-muted px-2 py-0.5 text-label-caps uppercase text-ink-muted">Unique ID {client.uniqueId}</span>
                    <ToneBadge tone={data.complete ? "verified" : "review"}>{data.complete ? "Complete" : "Incomplete"}</ToneBadge>
                </div>
            </div>

            {notice && <div role="status" className="rounded-lg border border-verified-border bg-verified-bg px-3 py-2 text-body-sm text-verified">{notice}</div>}

            <Card className="p-4">
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Passport ID">{client.passportId}</Field>
                    <Field label="WhatsApp">{client.whatsappNumber}</Field>
                    <Field label="Contact number">{client.contactNumber}</Field>
                    <Field label="Documents">{data.documents.length}</Field>
                    <Field label="Date of birth">{formatDate(client.dateOfBirth)}</Field>
                    <Field label="Place of birth">{client.placeOfBirth}</Field>
                    <Field label="Passport expiry">{formatDate(client.passportExpiryDate)}</Field>
                    <Field label="Client since">{formatDate(client.createdDate)}</Field>
                    <Field label="Job">{client.job}</Field>
                    <div className="sm:col-span-2 lg:col-span-3"><Field label="Address">{client.address}</Field></div>
                </dl>
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="space-y-3 p-4">
                    <SectionHeading
                        title="Required documents"
                        description={missing.length ? `Missing: ${missing.map(documentTypeLabel).join(", ")}` : "Every required document has been received."}
                    />
                    <ul className="divide-y divide-border">
                        {data.requiredDocuments.map((requirement) => (
                            <li key={requirement.documentType} className="flex items-center justify-between py-2">
                                <span className="text-body-md text-ink">{documentTypeLabel(requirement.documentType)}</span>
                                <StatusBadge status={requirement.status} />
                            </li>
                        ))}
                    </ul>
                </Card>

                <Card className="space-y-3 p-4">
                    <div className="flex items-center gap-2">
                        <span className="flex size-8 items-center justify-center rounded bg-primary-soft text-primary"><Icon name="local_police" className="size-5" /></span>
                        <SectionHeading title="Police documents" description="Latest stored slip and final report" />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <PoliceDocument label="Police slip" doc={data.police.latestSlip} />
                        <PoliceDocument label="Police report" doc={data.police.latestReport} />
                    </div>
                    <PoliceCountdownPanel countdown={data.police.countdown} />
                    {slip && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas p-3">
                            <span className="text-body-sm text-ink">
                                Latest slip submitted date: <span className="font-medium">{slip.policeSubmittedDate ? formatDay(slip.policeSubmittedDate) : "not set"}</span>
                            </span>
                            <button type="button" className={secondaryButton} onClick={() => { setNotice(null); setDateDialog(true); }}>
                                {slip.policeSubmittedDate ? "Correct date" : "Set date"}
                            </button>
                        </div>
                    )}
                    {data.police.dateChanges.length > 0 && (
                        <div>
                            <p className="text-label-caps uppercase text-ink-subtle">Date changes</p>
                            <ol aria-label="Police slip date changes" className="mt-1 divide-y divide-border">
                                {data.police.dateChanges.map((change) => (
                                    <li key={change.auditId} className="py-1.5 text-body-sm">
                                        <span className="text-ink">{change.previousDate ? formatDay(change.previousDate) : "No date"} → {formatDay(change.newDate)}</span>
                                        <span className="block text-label-sm text-ink-muted">{change.adminName ?? "Unknown admin"} · {formatDateTime(change.createdDate)}{change.reason ? ` · ${change.reason}` : ""}</span>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}
                    <Link to="/police" className="inline-block text-label-md text-primary hover:underline">Open Police Workflow</Link>
                </Card>
            </div>

            <Card>
                <div className="p-4">
                    <SectionHeading title="Submitted documents" description="Files stored in this client's folders" />
                </div>
                {data.documents.length ? (
                    <DocumentsTable documents={data.documents} showClient={false} caption="Submitted documents" />
                ) : (
                    <EmptyState title="No documents stored yet" />
                )}
            </Card>

            {data.pendingItems.length > 0 && (
                <Card>
                    <div className="p-4">
                        <SectionHeading title="Waiting for review" description="Files from this client held in pending storage" />
                    </div>
                    <ul className="divide-y divide-border border-t border-border">
                        {data.pendingItems.map((item) => (
                            <li key={item.temporaryId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                                <span className="text-body-sm text-ink">{documentTypeLabel(item.documentType)}</span>
                                <span className="flex items-center gap-3">
                                    <StatusBadge status={item.processingStatus} />
                                    <span className="text-label-sm text-ink-muted">{formatDateTime(item.receivedDate)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}

            {dateDialog && slip && (
                <PoliceDateDialog
                    slip={slip}
                    onClose={() => setDateDialog(false)}
                    onSaved={(date) => {
                        setDateDialog(false);
                        setNotice(`Police slip submitted date set to ${formatDay(date)}. The 21-day follow-up has been recalculated.`);
                        onChanged();
                    }}
                />
            )}
        </div>
    );
}

export function ClientDetailsPage() {
    const { passportId = "" } = useParams();
    const details = useAdminResource(`client/${passportId}`, (token, signal) => getClientDetails(token, passportId, signal));

    return (
        <section aria-labelledby="page-title">
            {details.status === "loading" && !details.data && <Card><LoadingState label="Loading client…" /></Card>}
            {details.status === "error" && (
                details.error.status === 404 || details.error.status === 400 ? (
                    <Card>
                        <h1 id="page-title" className="sr-only">Client not found</h1>
                        <EmptyState
                            title="Client not found"
                            description={`No client has the passport ID ${passportId}.`}
                            action={<Link to="/clients" className="text-label-md text-primary hover:underline">Back to Clients</Link>}
                        />
                    </Card>
                ) : (
                    <Card><ErrorState message={details.error.message} onRetry={details.reload} /></Card>
                )
            )}
            {details.status !== "error" && details.data?.client.passportId.toUpperCase() === passportId.toUpperCase() && <ClientContent data={details.data} onChanged={details.reload} />}
        </section>
    );
}
