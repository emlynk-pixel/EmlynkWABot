// Audit log export files (POST /api/admin/audit-logs/export): the entries, as
// the Audit Logs page shows them (auditLogService.js toItem, sensitive keys
// already stripped), written straight to the response as they are read.
//
//   - xlsx: ExcelJS's streaming WorkbookWriter, one committed row at a time.
//   - pdf:  PDFKit, a landscape A4 table; each page is flushed when the next
//           one starts (no buffered pages).
//
// Both libraries are loaded on first use only, so the API starts without them.
// Every text cell of the workbook passes spreadsheetSafe (no formula
// injection).

import { once } from "node:events";

import { BUSINESS_TIME_ZONE } from "../utils/businessDay.js";

export const AUDIT_EXPORT_CONTENT_TYPES = Object.freeze({
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
});

// A spreadsheet opening (or a later CSV re-save) must never treat a stored
// value as a formula: text starting with = + - @ (or a tab / carriage return,
// which some spreadsheets skip before reading one) gets a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;
export const spreadsheetSafe = (value) => (typeof value === "string" && FORMULA_START.test(value) ? `'${value}` : value);

// Excel's limit for one cell is 32,767 characters.
const MAX_XLSX_CELL = 32_000;
const MAX_PDF_CELL = 600;
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

const humanize = (value) => {
    if (value === null || value === undefined || value === "") return "";
    const text = String(value).toLowerCase().replace(/_/g, " ");
    return text.charAt(0).toUpperCase() + text.slice(1);
};

const valueText = (value) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
};

const DATE_TIME = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
// "YYYY-MM-DD HH:mm:ss" in Sri Lanka time, like the page's dates.
export function formatExportDateTime(date) {
    const parts = Object.fromEntries(DATE_TIME.formatToParts(new Date(date)).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// One entry as the export's columns (plain strings). Changed fields are
// listed one per line as "field: value" in Previous value / New value.
export function exportRowOf(item) {
    let previousValue;
    let newValue;
    if (item.changes && item.changes.length) {
        previousValue = item.changes.map(({ field, from }) => `${field}: ${valueText(from) || "-"}`).join("\n");
        newValue = item.changes.map(({ field, to }) => `${field}: ${valueText(to) || "-"}`).join("\n");
    } else {
        previousValue = valueText(item.previousValue);
        const details = item.details ? Object.entries(item.details).map(([key, value]) => `${key}: ${valueText(value)}`) : [];
        newValue = [valueText(item.newValue), ...details].filter(Boolean).join("\n");
    }
    return {
        dateTime: formatExportDateTime(item.createdDate),
        action: humanize(item.action),
        subject: item.stage ? humanize(item.stage) : humanize(item.documentType),
        user: item.actor?.name ?? "Unknown user",
        role: humanize(item.actor?.role),
        passportId: item.candidate?.passportId ?? "",
        uniqueId: item.candidate?.uniqueId ?? "",
        candidateName: item.candidate?.name ?? "",
        category: humanize(item.category),
        previousValue,
        newValue,
        previousStatus: humanize(item.previousStatus),
        newStatus: humanize(item.newStatus),
        policeSubmittedDate: item.policeSubmittedDate ?? "",
        reason: item.reason ?? "",
    };
}

export const EXPORT_COLUMNS = Object.freeze([
    { key: "dateTime", header: "Date / time (Sri Lanka)", width: 20 },
    { key: "action", header: "Action", width: 26 },
    { key: "subject", header: "Stage / document type", width: 20 },
    { key: "user", header: "Performed by", width: 22 },
    { key: "role", header: "Role", width: 16 },
    { key: "passportId", header: "Passport number", width: 16 },
    { key: "uniqueId", header: "Unique ID", width: 14 },
    { key: "candidateName", header: "Candidate", width: 24 },
    { key: "category", header: "Category", width: 12 },
    { key: "previousValue", header: "Previous value", width: 36, wrap: true },
    { key: "newValue", header: "New value", width: 36, wrap: true },
    { key: "previousStatus", header: "Previous status", width: 16 },
    { key: "newStatus", header: "New status", width: 16 },
    { key: "policeSubmittedDate", header: "Police slip date", width: 14 },
    { key: "reason", header: "Reason / notes", width: 36, wrap: true },
]);

// Resolves once the response can take more (or is gone).
async function drained(out) {
    if (!out.writableNeedDrain || out.destroyed) return;
    await Promise.race([once(out, "drain"), once(out, "close")]);
}

const gone = (out) => out.destroyed || out.writableEnded;

async function writeXlsx(ExcelJS, { items, out, generatedAt }) {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
    workbook.creator = "Emlynk";
    workbook.created = generatedAt;
    const sheet = workbook.addWorksheet("Audit log", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = EXPORT_COLUMNS.map(({ key, header, width, wrap }) => ({
        key, header, width, style: { alignment: { vertical: "top", wrapText: Boolean(wrap) } },
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();
    let written = 0;
    for await (const item of items) {
        if (gone(out)) break;
        const row = exportRowOf(item);
        sheet.addRow(Object.fromEntries(EXPORT_COLUMNS.map(({ key }) => [key, spreadsheetSafe(truncate(row[key], MAX_XLSX_CELL))]))).commit();
        written += 1;
        if (written % 200 === 0) await drained(out);
    }
    sheet.commit();
    await workbook.commit();
}

// PDFKit's built-in fonts cover Latin-1 (WinAnsi) only: anything else is
// shown as "?" rather than as broken glyphs.
const pdfText = (text) => truncate(String(text ?? ""), MAX_PDF_CELL).replace(/[^\t\n\r\x20-\x7E\xA0-\xFF]/g, "?");

// The PDF's columns: the page's columns, a few combined to fit a page width.
const PDF_COLUMNS = Object.freeze([
    { header: "Date / time", width: 62, text: (r) => r.dateTime },
    { header: "Action", width: 92, text: (r) => [r.action, r.subject].filter(Boolean).join("\n") },
    { header: "Performed by", width: 86, text: (r) => [r.user, r.role].filter(Boolean).join("\n") },
    { header: "Candidate", width: 100, text: (r) => [r.candidateName, [r.passportId, r.uniqueId].filter(Boolean).join(" / ")].filter(Boolean).join("\n") },
    { header: "Category", width: 52, text: (r) => r.category },
    { header: "Previous value", width: 120, text: (r) => r.previousValue },
    { header: "New value", width: 120, text: (r) => r.newValue },
    { header: "Status / reason", width: 150, text: (r) => [
        r.previousStatus || r.newStatus ? `${r.previousStatus} -> ${r.newStatus}` : "",
        r.policeSubmittedDate ? `Slip date ${r.policeSubmittedDate}` : "",
        r.reason,
    ].filter(Boolean).join("\n") },
]);

async function writePdf(PDFDocument, { items, out, total, generatedAt }) {
    const margin = 30;
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin, bufferPages: false, info: { Title: "Audit log export", Creator: "Emlynk" } });
    doc.pipe(out);
    const finished = once(out, "finish").catch(() => {});
    const padding = 3;
    const fontSize = 7;
    const bottom = doc.page.height - margin;
    let page = 1;

    const header = () => {
        doc.font("Helvetica-Bold").fontSize(11).fillColor("black")
            .text("Audit log export", margin, margin, { lineBreak: false });
        doc.font("Helvetica").fontSize(8)
            .text(`Generated ${formatExportDateTime(generatedAt)} (Sri Lanka) - ${total} record${total === 1 ? "" : "s"} - page ${page}`, margin, margin + 14, { lineBreak: false });
        let x = margin;
        const y = margin + 30;
        doc.font("Helvetica-Bold").fontSize(fontSize);
        for (const column of PDF_COLUMNS) {
            doc.text(column.header, x + padding, y + padding, { width: column.width - padding * 2, lineBreak: false });
            x += column.width;
        }
        doc.moveTo(margin, y + 14).lineTo(x, y + 14).lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(fontSize);
        return y + 16;
    };

    let y = header();
    let written = 0;
    for await (const item of items) {
        if (gone(out)) break;
        const row = exportRowOf(item);
        const cells = PDF_COLUMNS.map((column) => pdfText(column.text(row)));
        const height = Math.max(...cells.map((text, i) => doc.heightOfString(text || " ", { width: PDF_COLUMNS[i].width - padding * 2 }))) + padding * 2;
        if (y + height > bottom) {
            doc.addPage();
            page += 1;
            y = header();
        }
        let x = margin;
        cells.forEach((text, i) => {
            doc.text(text, x + padding, y + padding, { width: PDF_COLUMNS[i].width - padding * 2 });
            x += PDF_COLUMNS[i].width;
        });
        y += height;
        doc.moveTo(margin, y).lineTo(x, y).lineWidth(0.25).strokeColor("#cccccc").stroke().strokeColor("black");
        written += 1;
        if (written % 200 === 0) await drained(out);
    }
    doc.end();
    await finished;
}

const WRITERS = {
    xlsx: { load: () => import("exceljs"), write: writeXlsx },
    pdf: { load: () => import("pdfkit"), write: writePdf },
};

// The writer of this format, its library loaded: (options) => Promise, writing
// the file to options.out (the response). Loaded before the response starts,
// so a missing library is a plain error response, never a broken file.
// options: { items (async iterable of toItem entries), out, total (shown on
// the PDF), generatedAt }.
export async function loadAuditLogExportWriter(format) {
    const writer = WRITERS[format];
    if (!writer) throw new RangeError("Unknown export format");
    const { default: library } = await writer.load();
    return ({ items, out, total, generatedAt = new Date() }) => writer.write(library, { items, out, total, generatedAt });
}
