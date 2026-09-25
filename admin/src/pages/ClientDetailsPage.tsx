import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { getClientDetails, type ClientDetails } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { DocumentsTable } from "../components/DocumentsTable";
import { documentTypeLabel, formatDate, formatDateTime, formatDay } from "../components/format";
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

function ClientContent({ data }: { data: ClientDetails }) {
    const { client } = data;
    const missing = data.missingDocumentTypes;

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
                </div>
            </div>

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
        </div>
    );
}

export function ClientDetailsPage() {
    const { passportId = "" } = useParams();
    const details = useAdminResource(`client/${passportId}`, (token, signal) => getClientDetails(token, passportId, signal));

    return (
        <section aria-labelledby="page-title">
            {details.status === "loading" && <Card><LoadingState label="Loading client…" /></Card>}
            {details.status === "error" && (
                details.error.status === 404 || details.error.status === 400 ? (
                    <Card>
                        <h1 id="page-title" className="sr-only">Client not found</h1>
                        <EmptyState
                            title="Client not found"
                            description={`No client has the passport ID ${passportId}.`}
                            action={<Link to="/documents" className="text-label-md text-primary hover:underline">Back to Documents</Link>}
                        />
                    </Card>
                ) : (
                    <Card><ErrorState message={details.error.message} onRetry={details.reload} /></Card>
                )
            )}
            {details.status === "success" && <ClientContent data={details.data} />}
        </section>
    );
}
