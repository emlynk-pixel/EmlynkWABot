import { Link } from "react-router";
import type { DocumentItem } from "../api/admin";
import { Confidence } from "./Confidence";
import { documentTypeLabel, formatDateTime, shortId } from "./format";
import { StatusBadge } from "./StatusBadge";

// High-density documents table (Stitch "Data Tables"). Columns can be
// dropped where the context already says them (e.g. the client page).
export function DocumentsTable({ documents, showClient = true, caption }: { documents: DocumentItem[]; showClient?: boolean; caption: string }) {
    const th = "sticky top-0 h-[34px] whitespace-nowrap border-b border-border bg-canvas px-4 text-left text-label-caps uppercase text-ink-subtle";
    const td = "h-11 whitespace-nowrap border-b border-canvas-muted px-4 text-body-sm";

    return (
        <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0">
                <caption className="sr-only">{caption}</caption>
                <thead>
                    <tr>
                        <th scope="col" className={th}>Document ID</th>
                        {showClient && <th scope="col" className={th}>Client</th>}
                        <th scope="col" className={th}>Type</th>
                        <th scope="col" className={th}>Status</th>
                        <th scope="col" className={`${th} text-right`}>Confidence</th>
                        <th scope="col" className={th}>Received</th>
                        <th scope="col" className={`${th} text-right`}>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {documents.map((doc) => (
                        <tr key={doc.documentId} className="hover:bg-canvas">
                            <td className={td}>
                                <span className="font-medium text-primary" title={doc.documentId}>{shortId(doc.documentId)}</span>
                            </td>
                            {showClient && (
                                <td className={td}>
                                    {doc.client ? (
                                        <div className="flex flex-col">
                                            <span className="font-medium text-ink">{doc.client.name ?? "—"}</span>
                                            <span className="text-label-sm text-ink-subtle">{doc.client.passportId}</span>
                                        </div>
                                    ) : (
                                        <span className="text-ink-subtle">—</span>
                                    )}
                                </td>
                            )}
                            <td className={td}>{documentTypeLabel(doc.documentType)}</td>
                            <td className={td}><StatusBadge status={doc.verificationStatus} /></td>
                            <td className={`${td} text-right`}><Confidence value={doc.ocrConfidence} /></td>
                            <td className={`${td} text-label-sm text-ink-muted`}>{formatDateTime(doc.receivedDate)}</td>
                            <td className={`${td} text-right`}>
                                {doc.client && showClient ? (
                                    <Link
                                        to={`/clients/${encodeURIComponent(doc.client.passportId)}`}
                                        className="text-label-md text-primary hover:text-primary-hover hover:underline"
                                    >
                                        View client
                                    </Link>
                                ) : (
                                    <span className="text-label-sm text-ink-subtle">{doc.storedFilename}</span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
