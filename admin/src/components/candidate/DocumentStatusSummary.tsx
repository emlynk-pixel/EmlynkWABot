import { variantLabel, type DocumentStatusEntry } from "../../api/candidates";
import { documentTypeLabel } from "../format";
import { Icon } from "../Icon";

// The candidate's documents NOW (Call Logs, Priority Follow-Ups), as small
// chips: a green check for a document on record, a quiet outline for one
// that isn't. The server decides what is current (the candidate page's
// rule); this only shows it. Read-only.

export function documentStatusLabel(entry: Pick<DocumentStatusEntry, "documentType" | "variant">): string {
    const type = documentTypeLabel(entry.documentType);
    if (entry.variant) return `${type} · ${variantLabel(entry.variant)}`;
    // A police report with no recorded variant (received on WhatsApp).
    return entry.documentType === "POLICE_REPORT" ? `${type} · variant not set` : type;
}

const stateText = (entry: DocumentStatusEntry) =>
    !entry.uploaded ? "not uploaded" : entry.verificationStatus === "VERIFIED" ? "uploaded" : "uploaded, waiting for review";

export function DocumentStatusSummary({ documents, className = "" }: { documents: DocumentStatusEntry[]; className?: string }) {
    if (documents.length === 0) return null;
    const uploaded = documents.filter((d) => d.uploaded).length;
    return (
        <div className={className}>
            <p className="flex items-baseline justify-between gap-3">
                <span className="text-label-caps uppercase text-ink-subtle">Current documents</span>
                <span className="text-label-sm text-ink-muted tabular-nums">{uploaded} of {documents.length} uploaded</span>
            </p>
            <ul aria-label="Current documents" className="mt-1.5 flex flex-wrap gap-1.5">
                {documents.map((entry) => {
                    const label = documentStatusLabel(entry);
                    const state = stateText(entry);
                    return (
                        <li
                            key={`${entry.documentType}:${entry.variant ?? ""}`}
                            aria-label={`${label}: ${state}`}
                            title={`${label}: ${state}`}
                            data-uploaded={entry.uploaded ? "true" : "false"}
                            className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-label-sm ${entry.uploaded
                                ? "border-verified-border bg-verified-bg text-verified"
                                : "border-border bg-surface text-ink-subtle"}`}
                        >
                            {entry.uploaded
                                ? <Icon name="check_circle" className="size-3.5 shrink-0" />
                                : <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border border-current opacity-60" />}
                            {label}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
