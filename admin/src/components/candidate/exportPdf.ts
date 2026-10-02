import { storedDocuments, variantLabel, type CandidateDetails } from "../../api/candidates";
import { documentTypeLabel, formatDate, formatDateTime } from "../format";

const escape = (value: string | null | undefined) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// The Document Submission summary as a printable page. It opens the browser's
// print dialog, where "Save as PDF" produces the PDF (no PDF library needed).
// Returns false when the browser blocked the new window.
export function exportDocumentSubmissionPdf(details: CandidateDetails): boolean {
    const c = details.candidate;
    // One row per stored document (a police report or an affidavit can have
    // several, one per variant); one "Missing" row for a type with none.
    const rows = details.requiredDocuments.map(({ documentType, included }) => {
        const documents = storedDocuments(details, documentType);
        if (!documents.length) {
            return `<tr><td>${escape(documentTypeLabel(documentType))}</td><td>${included ? "Included" : "Missing"}</td><td>—</td><td>—</td><td>—</td></tr>`;
        }
        return documents.map((document) => `<tr>
            <td>${escape(documentTypeLabel(documentType))}</td>
            <td>Included</td>
            <td>${escape(document.originalFilename)}</td>
            <td>${escape(variantLabel(document.variant) ?? "—")}</td>
            <td>${escape(formatDate(document.receivedDate))}</td>
        </tr>`).join("");
    }).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Document submission – ${escape(c.name ?? c.passportId)}</title>
<style>
  body { font: 13px/1.5 system-ui, sans-serif; color: #0f172a; margin: 32px; }
  h1 { font-size: 18px; margin: 0 0 4px; } p.sub { color: #475569; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; width: 28%; }
  thead th { width: auto; }
  footer { color: #64748b; font-size: 11px; }
</style></head><body>
<h1>Document submission</h1>
<p class="sub">${escape(c.name ?? "")}</p>
<table>
  <tr><th>Passport ID</th><td>${escape(c.passportId)}</td></tr>
  <tr><th>NIC</th><td>${escape(c.nic ?? "—")}</td></tr>
  <tr><th>Date of birth</th><td>${escape(c.dateOfBirth ?? "—")}</td></tr>
  <tr><th>Address</th><td>${escape(c.address ?? "—")}</td></tr>
  <tr><th>Job type</th><td>${escape(c.jobTypes.join(", ") || "—")}</td></tr>
</table>
<table>
  <thead><tr><th>Document</th><th>Status</th><th>File</th><th>Type</th><th>Received</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<footer>Exported ${escape(formatDateTime(new Date().toISOString()))}</footer>
</body></html>`;

    const printWindow = window.open("", "_blank", "width=900,height=700");
    if (!printWindow) return false;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    return true;
}
