import type { DailyRoleSummary, DailySummary } from "../api/admin";
import { STAGE_LABELS, variantLabel, type CandidateStageKey } from "../api/candidates";
import { ROLE_LABELS, type Role } from "../auth/roles";
import { documentTypeLabel, formatDateTime, formatDay, formatNumber, formatTime } from "./format";

// Daily Report PDF (jspdf, in the browser): a structured report, not a
// screenshot. The selected date and mode (Summary, or Summary by Roles with
// its role) decide the content. Tables repeat their header row on every page
// and long cells wrap, so nothing is cut off.

type Doc = InstanceType<typeof import("jspdf").jsPDF>;
type Column = { title: string; width: number; align?: "left" | "right" };

const MARGIN = 16;
const LINE = 4.6;
// WhatsApp files the classifier could not type are "Unclassified" here.
export const reportTypeLabel = (type: string) => (type === "UNKNOWN" ? "Unclassified" : documentTypeLabel(type));
const roleLabel = (role: string) => ROLE_LABELS[role as Role] ?? role;
const stageLabel = (stage: string) => STAGE_LABELS[stage as CandidateStageKey] ?? stage;
const generatedAt = () => new Date().toLocaleString("en-GB", { timeZone: "Asia/Colombo", dateStyle: "long", timeStyle: "short" });

function createWriter(doc: Doc) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const contentWidth = pageWidth - MARGIN * 2;
    let y = MARGIN;

    const ensure = (needed: number) => {
        if (y + needed > pageHeight - MARGIN - 6) {
            doc.addPage();
            y = MARGIN;
            return true;
        }
        return false;
    };

    const text = (value: string, { size = 10, bold = false, color = 30, gap = LINE } = {}) => {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.setFontSize(size);
        doc.setTextColor(color);
        const lines = doc.splitTextToSize(value, contentWidth) as string[];
        ensure(lines.length * gap);
        for (const line of lines) {
            doc.text(line, MARGIN, y);
            y += gap;
        }
    };

    const heading = (value: string, note?: string) => {
        ensure(16);
        y += 3;
        text(value, { size: 12, bold: true, color: 20, gap: 5.5 });
        if (note) text(note, { size: 8.5, color: 110, gap: 4 });
        y += 1;
    };

    // A table: header row (repeated after a page break), wrapped cells.
    const table = (columns: Column[], rows: string[][], empty = "None.") => {
        const scale = contentWidth / columns.reduce((sum, c) => sum + c.width, 0);
        const widths = columns.map((c) => c.width * scale);
        const drawHeader = () => {
            doc.setFillColor(238, 241, 245);
            doc.rect(MARGIN, y - 3.8, contentWidth, 6, "F");
            doc.setFont("helvetica", "bold");
            doc.setFontSize(8.5);
            doc.setTextColor(60);
            let x = MARGIN;
            columns.forEach((c, i) => {
                const at = c.align === "right" ? x + widths[i] - 2 : x + 2;
                doc.text(c.title, at, y, c.align === "right" ? { align: "right" } : undefined);
                x += widths[i];
            });
            y += 5;
        };
        ensure(14);
        drawHeader();
        if (rows.length === 0) {
            text(empty, { size: 9, color: 120 });
            y += 1;
            return;
        }
        doc.setFontSize(9);
        rows.forEach((row) => {
            const cells = row.map((cell, i) => doc.splitTextToSize(cell, widths[i] - 4) as string[]);
            const height = Math.max(...cells.map((c) => c.length)) * 4.2 + 1.4;
            if (ensure(height)) drawHeader();
            doc.setFont("helvetica", "normal");
            doc.setFontSize(9);
            doc.setTextColor(30);
            let x = MARGIN;
            cells.forEach((lines, i) => {
                const right = columns[i].align === "right";
                lines.forEach((line, n) => doc.text(line, right ? x + widths[i] - 2 : x + 2, y + n * 4.2, right ? { align: "right" } : undefined));
                x += widths[i];
            });
            doc.setDrawColor(228);
            doc.line(MARGIN, y + height - 3.4, MARGIN + contentWidth, y + height - 3.4);
            y += height;
        });
        y += 2;
    };

    const header = (title: string, date: string, subtitle: string) => {
        text(title, { size: 17, bold: true, color: 15, gap: 7 });
        text(`${formatDay(date)} · ${subtitle}`, { size: 10, color: 70, gap: 5 });
        text(`Business day 00:00–24:00 Sri Lanka time (Asia/Colombo). Generated ${generatedAt()} (Sri Lanka time).`, { size: 8.5, color: 110, gap: 4 });
        doc.setDrawColor(210);
        doc.line(MARGIN, y, MARGIN + contentWidth, y);
        y += 4;
    };

    const footer = (label: string) => {
        const total = doc.getNumberOfPages();
        for (let page = 1; page <= total; page++) {
            doc.setPage(page);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(150);
            doc.text(`${label} · Page ${page} of ${total}`, MARGIN, pageHeight - 8);
            doc.text("Confidential", pageWidth - MARGIN, pageHeight - 8, { align: "right" });
        }
    };

    return { text, heading, table, header, footer };
}

async function newDoc(): Promise<Doc> {
    const { jsPDF } = await import("jspdf");
    return new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
}

export async function exportSummaryPdf(report: DailySummary) {
    const doc = await newDoc();
    const w = createWriter(doc);
    const { summary, documents, registeredCandidates, completedCandidates, current } = report;

    w.header("Daily Report — Summary", report.businessDate, report.isToday ? "today, so far" : "full day");

    w.heading("Key metrics");
    w.table([{ title: "Metric", width: 3 }, { title: "Count", width: 1, align: "right" }], [
        ["Candidates registered", formatNumber(summary.candidatesRegistered)],
        ["Candidates completed (final stage completed)", formatNumber(summary.candidatesCompleted)],
        ["Visa completed (visa approval completed)", formatNumber(summary.visaCompleted)],
        ["Calls taken", formatNumber(summary.callsTaken)],
        ["Documents submitted", formatNumber(summary.documentsSubmitted)],
    ]);

    w.heading("Documents submitted", `${formatNumber(documents.total)} in total: ${formatNumber(documents.whatsapp)} received on WhatsApp, ${formatNumber(documents.manual)} uploaded by staff.`);
    w.table(
        [{ title: "Document type", width: 3 }, { title: "Total", width: 1, align: "right" }, { title: "WhatsApp", width: 1, align: "right" }, { title: "Manual", width: 1, align: "right" }],
        documents.byType.map((r) => [reportTypeLabel(r.type), formatNumber(r.total), formatNumber(r.whatsapp), formatNumber(r.manual)]),
    );

    w.heading("Registered candidates", `${formatNumber(registeredCandidates.total)} candidate(s) registered on this day, with or without documents. Documents and progress are as they are now.`);
    w.table(
        [{ title: "Passport number", width: 1.3 }, { title: "Name", width: 2 }, { title: "Registered", width: 0.9 }, { title: "Registered by", width: 1.5 }, { title: "Documents", width: 1 }, { title: "Progress", width: 1 }],
        registeredCandidates.items.map((c) => [c.passportId, c.name ?? "—", formatTime(c.registeredAt), c.registeredBy ?? "—", c.documents ? formatNumber(c.documents) : "No documents", `${c.stagesComplete} of ${c.stagesTotal} stages`]),
        "No candidate was registered on this day.",
    );
    if (registeredCandidates.truncated) w.text(`Showing the first ${formatNumber(registeredCandidates.items.length)} of ${formatNumber(registeredCandidates.total)}.`, { size: 8.5, color: 110 });

    w.heading("Completed candidates", `${formatNumber(completedCandidates.total)} candidate(s) had their final stage (Finalizing the job) completed on this day.`);
    w.table(
        [{ title: "Passport number", width: 1.4 }, { title: "Name", width: 2.4 }, { title: "Completed", width: 1.4 }, { title: "All stages now", width: 1.2 }],
        completedCandidates.items.map((c) => [c.passportId, c.name ?? "—", formatDateTime(c.completedAt), c.allStagesComplete ? "Complete" : "Some open"]),
        "No candidate completed on this day.",
    );
    if (completedCandidates.truncated) w.text(`Showing the first ${formatNumber(completedCandidates.items.length)} of ${formatNumber(completedCandidates.total)}.`, { size: 8.5, color: 110 });

    w.heading("Incomplete candidates (current state)", `As of ${formatDateTime(current.asOf)}: ${formatNumber(current.incomplete.incompleteCandidates)} of ${formatNumber(current.incomplete.totalCandidates)} candidates have at least one stage open. This is the state now, not on ${formatDay(report.businessDate)}.`);
    w.table(
        [{ title: "Process", width: 1.6 }, { title: "Candidates", width: 0.9, align: "right" }, { title: "Main reasons", width: 3.5 }],
        current.incomplete.byStage.map((s) => [stageLabel(s.stage), formatNumber(s.count), s.reasons.slice(0, 3).map((r) => `${r.reason} (${formatNumber(r.count)})`).join("; ") || "—"]),
    );

    w.heading("Police reports (current state)", `As of ${formatDateTime(current.asOf)}.`);
    w.table([{ title: "Status", width: 3 }, { title: "Count", width: 1, align: "right" }], [
        ["Due soon (1–7 days)", formatNumber(current.police.dueSoon)],
        ["Due today", formatNumber(current.police.dueToday)],
        ["Overdue", formatNumber(current.police.overdue)],
        ["Missing slip date", formatNumber(current.police.missingSlipDate)],
        ["Police slip not uploaded", formatNumber(current.police.notUploaded)],
    ]);

    w.footer(`Daily Report · ${report.businessDate}`);
    doc.save(`daily-report-${report.businessDate}.pdf`);
}

export async function exportRolePdf(report: DailyRoleSummary) {
    const doc = await newDoc();
    const w = createWriter(doc);
    const role = roleLabel(report.role);

    w.header(`Daily Report — ${role}`, report.businessDate, `Summary by role: ${role} (${formatNumber(report.staffCount)} staff member(s))`);

    w.heading("Activity", "Calls and document uploads by staff members whose current role is this role. Documents received on WhatsApp are not attributed to staff.");
    w.table([{ title: "Metric", width: 3 }, { title: "Count", width: 1, align: "right" }], [
        ["Calls taken", formatNumber(report.callsTaken)],
        ["Documents uploaded", formatNumber(report.documentsUploaded)],
    ]);

    w.heading("Documents uploaded by type");
    w.table([{ title: "Document type", width: 3 }, { title: "Uploaded", width: 1, align: "right" }], report.documentsByType.map((t) => [reportTypeLabel(t.type), formatNumber(t.count)]));

    w.heading("Staff");
    w.table(
        [{ title: "Staff member", width: 3 }, { title: "Calls", width: 1, align: "right" }, { title: "Documents", width: 1, align: "right" }],
        report.staff.map((s) => [s.status === "ACTIVE" ? s.name : `${s.name} (${s.status.toLowerCase()})`, formatNumber(s.calls), formatNumber(s.documents)]),
        "No staff member has this role.",
    );

    w.heading("Activity details");
    w.table(
        [{ title: "Time", width: 0.8 }, { title: "Staff member", width: 1.6 }, { title: "Action", width: 1.8 }, { title: "Candidate", width: 1.8 }, { title: "Passport number", width: 1.3 }],
        report.activity.map((a) => [formatTime(a.at), a.staff ?? "—", activityLabel(a), a.candidateName ?? "—", a.passportId ?? "—"]),
        "No calls or uploads on this day.",
    );
    if (report.truncated) w.text(`Showing the latest ${formatNumber(report.activity.length)} of ${formatNumber(report.activityTotal)}.`, { size: 8.5, color: 110 });

    w.footer(`Daily Report · ${role} · ${report.businessDate}`);
    doc.save(`daily-report-${report.businessDate}-${report.role.toLowerCase()}.pdf`);
}

export function activityLabel(a: { kind: string; documentType: string | null; variant: string | null }): string {
    if (a.kind === "CALL") return "Call";
    const type = a.documentType ? documentTypeLabel(a.documentType) : "Document";
    const variant = variantLabel(a.variant);
    return `Uploaded ${type}${variant ? ` (${variant})` : ""}`;
}
