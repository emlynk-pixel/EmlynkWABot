import { Link } from "react-router";
import type { ClientList, ClientListItem } from "../api/admin";
import { documentTypeLabel, formatNumber } from "./format";
import { StatusBadge, ToneBadge } from "./StatusBadge";

const th = "h-[34px] whitespace-nowrap border-b border-border bg-canvas px-4 text-left text-label-caps uppercase text-ink-subtle";
const td = "h-11 border-b border-canvas-muted px-4 py-2 text-body-sm";

// Clients with their required documents (Clients directory, Missing Documents).
export function ClientTable({ items, caption, showWhatsapp = true }: { items: ClientListItem[]; caption: string; showWhatsapp?: boolean }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0">
                <caption className="sr-only">{caption}</caption>
                <thead>
                    <tr>
                        <th scope="col" className={th}>Client</th>
                        {showWhatsapp && <th scope="col" className={th}>WhatsApp</th>}
                        <th scope="col" className={th}>Status</th>
                        <th scope="col" className={th}>Required documents</th>
                        <th scope="col" className={th}>Missing</th>
                        <th scope="col" className={th}><span className="sr-only">Action</span></th>
                    </tr>
                </thead>
                <tbody>
                    {items.map((item) => (
                        <tr key={item.client.passportId} className="hover:bg-canvas">
                            <td className={td}>
                                <div className="flex flex-col">
                                    <span className="font-medium text-ink">{item.client.name ?? "—"}</span>
                                    <span className="text-label-sm text-ink-subtle">{item.client.passportId} · {item.client.uniqueId}</span>
                                </div>
                            </td>
                            {showWhatsapp && <td className={`${td} whitespace-nowrap text-ink-muted`}>{item.client.whatsappNumber ?? "—"}</td>}
                            <td className={td}>
                                <ToneBadge tone={item.completion === "COMPLETE" ? "verified" : "review"}>{item.completion === "COMPLETE" ? "Complete" : "Incomplete"}</ToneBadge>
                            </td>
                            <td className={td}>
                                <ul className="flex flex-wrap gap-1.5" aria-label={`Required documents of ${item.client.passportId}`}>
                                    {item.requirements.map((r) => (
                                        <li key={r.documentType} className="flex items-center gap-1">
                                            <span className="text-label-sm text-ink-muted">{documentTypeLabel(r.documentType)}</span>
                                            <StatusBadge status={r.status} />
                                        </li>
                                    ))}
                                </ul>
                            </td>
                            <td className={td}>
                                {item.missingDocumentTypes.length
                                    ? <span className="font-medium text-critical">{item.missingDocumentTypes.map(documentTypeLabel).join(", ")}</span>
                                    : <span className="text-ink-subtle">—</span>}
                            </td>
                            <td className={`${td} whitespace-nowrap text-right`}>
                                <Link to={`/clients/${encodeURIComponent(item.client.passportId)}`} className="text-label-md text-primary hover:underline">View client</Link>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// "Page 1 of 3" with Previous / Next (same controls as the other lists).
export function Pager({ pagination, noun, onPage }: { pagination: ClientList["pagination"]; noun: [string, string]; onPage: (page: number) => void }) {
    const button = "h-8 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft hover:bg-canvas disabled:opacity-50";
    return (
        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-body-sm text-ink-muted">
            <p>{formatNumber(pagination.total)} {pagination.total === 1 ? noun[0] : noun[1]}</p>
            <div className="flex items-center gap-2">
                <button type="button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)} className={button}>Previous</button>
                <span aria-current="page">Page {pagination.page} of {pagination.totalPages}</span>
                <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)} className={button}>Next</button>
            </div>
        </nav>
    );
}
