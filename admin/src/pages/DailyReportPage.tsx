import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { getDailyReport, type DailyReport } from "../api/admin";
import { useAdminResource } from "../api/useAdminResource";
import { documentTypeLabel, formatDateTime, formatDay, formatNumber, todayInSriLanka } from "../components/format";
import { AUDIT_ACTIONS } from "../components/reviewLabels";
import { Card, ErrorState, LoadingState, SectionHeading } from "../components/States";
import { Icon } from "../components/Icon";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// PDF export (jspdf, client-side only)
// ---------------------------------------------------------------------------

async function exportPdf(report: DailyReport) {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    const ensureSpace = (needed: number) => {
        if (y + needed > pageHeight - margin) {
            doc.addPage();
            y = margin;
        }
    };

    // ---- Header
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text("EmlynkWABot — Daily Report", margin, y);
    y += 8;

    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(`Report date: ${formatDay(report.businessDate)}`, margin, y);
    y += 5;
    doc.text(`Generated: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Colombo", dateStyle: "long", timeStyle: "short" })} (Sri Lanka time)`, margin, y);
    y += 3;
    doc.setDrawColor(200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;
    doc.setTextColor(0);

    // ---- Section 1: Daily Received Documents
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(`Received on ${formatDay(report.businessDate)}`, margin, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(`WhatsApp submissions received between 00:00 and 24:00 Sri Lanka time${report.isToday ? " (today, so far)" : ""}.`, margin, y);
    y += 7;
    doc.setTextColor(0);

    const { daily } = report;

    if (daily.totalReceived === 0) {
        ensureSpace(12);
        doc.setFontSize(11);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(120);
        doc.text("No documents were received on this day.", margin, y);
        y += 10;
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0);
    } else {
        // Key metrics table
        const dailyRows: [string, string][] = [
            ["Documents received", formatNumber(daily.totalReceived)],
            ["Successfully processed", formatNumber(daily.successfullyProcessed)],
            ["  Stored in client folder", formatNumber(daily.storedInClientFolder)],
            ["  Held for review", formatNumber(daily.heldForReview)],
            ["  Duplicates", formatNumber(daily.duplicates)],
            ["Failed processing", formatNumber(daily.failed)],
            ["Unclear documents", formatNumber(daily.unclear)],
            ["Temporary documents", formatNumber(daily.temporary)],
        ];
        if (daily.stillProcessing) {
            dailyRows.push(["Still processing", formatNumber(daily.stillProcessing)]);
        }

        drawTable(doc, margin, y, contentWidth, dailyRows);
        y += dailyRows.length * 7 + 4;

        // By document type
        const typeEntries = Object.entries(daily.byType);
        if (typeEntries.length > 0) {
            ensureSpace(typeEntries.length * 7 + 14);
            doc.setFontSize(11);
            doc.setFont("helvetica", "bold");
            doc.text("By document type", margin, y);
            y += 6;
            const typeRows: [string, string][] = typeEntries.map(([type, count]) => [documentTypeLabel(type), formatNumber(count)]);
            drawTable(doc, margin, y, contentWidth, typeRows);
            y += typeRows.length * 7 + 4;
        }

        // Admin actions
        const actionEntries = Object.entries(daily.adminActions);
        if (actionEntries.length > 0) {
            ensureSpace(actionEntries.length * 7 + 14);
            doc.setFontSize(11);
            doc.setFont("helvetica", "bold");
            doc.text("Admin actions this day", margin, y);
            y += 6;
            const actionRows: [string, string][] = actionEntries.map(([action, count]) => [AUDIT_ACTIONS[action]?.label ?? action, formatNumber(count)]);
            drawTable(doc, margin, y, contentWidth, actionRows);
            y += actionRows.length * 7 + 4;
        }
    }

    // ---- Divider
    ensureSpace(20);
    y += 2;
    doc.setDrawColor(200);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;

    // ---- Section 2: Current Status (snapshot)
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Current Status (snapshot)", margin, y);
    y += 5;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(`As of ${formatDateTime(report.current.asOf)}. These figures are the state now, not on ${formatDay(report.businessDate)}.`, margin, y);
    y += 7;
    doc.setTextColor(0);

    const { clients, police } = report.current;

    // Clients
    ensureSpace(30);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Clients", margin, y);
    y += 6;
    const clientRows: [string, string][] = [
        ["Completed clients", `${formatNumber(clients.complete)} of ${formatNumber(clients.total)}`],
        ["Incomplete clients", formatNumber(clients.incomplete)],
        ["Missing documents", `${formatNumber(clients.missingDocuments)} (${formatNumber(clients.withMissing)} clients)`],
    ];
    drawTable(doc, margin, y, contentWidth, clientRows);
    y += clientRows.length * 7 + 6;

    // Police
    ensureSpace(40);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Police Reports", margin, y);
    y += 6;
    const policeRows: [string, string][] = [
        ["Due soon (1–7 days)", formatNumber(police.dueSoon)],
        ["Due today", formatNumber(police.dueToday)],
        ["Overdue", formatNumber(police.overdue)],
        ["Missing slip date", formatNumber(police.missingSlipDate)],
        ["Police slip not uploaded", formatNumber(police.notUploaded)],
    ];
    drawTable(doc, margin, y, contentWidth, policeRows);
    y += policeRows.length * 7 + 4;

    // ---- Footer on every page
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(160);
        doc.text(`EmlynkWABot Admin · Page ${i} of ${totalPages}`, margin, pageHeight - 10);
        doc.text(`Confidential`, pageWidth - margin, pageHeight - 10, { align: "right" });
    }

    doc.save(`daily-report-${report.businessDate}.pdf`);
}

function drawTable(doc: InstanceType<typeof import("jspdf").jsPDF>, x: number, y: number, width: number, rows: [string, string][]) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    for (let i = 0; i < rows.length; i++) {
        const rowY = y + i * 7;
        // Alternate row background
        if (i % 2 === 0) {
            doc.setFillColor(245, 247, 250);
            doc.rect(x, rowY - 4, width, 7, "F");
        }
        doc.setTextColor(30);
        doc.text(rows[i][0], x + 2, rowY);
        doc.setTextColor(0);
        doc.setFont("helvetica", "bold");
        doc.text(rows[i][1], x + width - 2, rowY, { align: "right" });
        doc.setFont("helvetica", "normal");
    }
}

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

function Figure({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "critical" }) {
    return (
        <div className="rounded-md border border-border/60 bg-surface/80 px-3 py-3">
            <p className="text-label-caps uppercase text-ink-subtle">{label}</p>
            <p className={`mt-0.5 text-headline-xl tabular-nums ${tone === "critical" && value > 0 ? "text-critical" : "text-ink"}`}>{formatNumber(value)}</p>
            {hint && <p className="mt-0.5 text-label-sm text-ink-muted">{hint}</p>}
        </div>
    );
}

function Counts({ label, entries }: { label: string; entries: [string, ReactNode, number][] }) {
    return (
        <ul aria-label={label} className="divide-y divide-border">
            {entries.map(([key, name, count]) => (
                <li key={key} className="flex items-center justify-between py-2 text-body-sm">
                    <span className="text-ink">{name}</span>
                    <span className="font-semibold tabular-nums text-ink">{formatNumber(count)}</span>
                </li>
            ))}
        </ul>
    );
}

function DailySection({ report }: { report: DailyReport }) {
    const { daily } = report;
    const actions = Object.entries(daily.adminActions);
    return (
        <section aria-labelledby="daily-heading" className="space-y-3">
            <SectionHeading
                title={`Received on ${formatDay(report.businessDate)}`}
                description={`Daily figures: WhatsApp submissions received between 00:00 and 24:00 Sri Lanka time${report.isToday ? " (today, so far)" : ""}.`}
            />
            <h2 id="daily-heading" className="sr-only">Daily figures</h2>
            {daily.totalReceived === 0 ? (
                <div className="rounded-md border border-border/60 bg-surface/50 px-4 py-6 text-center">
                    <p className="text-headline-sm text-ink">No documents were received on this day</p>
                    <p className="mt-1 text-body-sm text-ink-muted">Choose another date, or check back later today.</p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
                        <Figure label="Documents received" value={daily.totalReceived} />
                        <Figure label="Successfully processed" value={daily.successfullyProcessed} hint={`${formatNumber(daily.storedInClientFolder)} stored · ${formatNumber(daily.heldForReview)} held for review · ${formatNumber(daily.duplicates)} duplicates`} />
                        <Figure label="Failed processing" value={daily.failed} tone="critical" hint={daily.stillProcessing ? `${formatNumber(daily.stillProcessing)} still processing` : undefined} />
                        <Figure label="Unclear documents" value={daily.unclear} hint="Low confidence or unreliable read" />
                        <Figure label="Temporary documents" value={daily.temporary} hint="Received this day, still waiting in pending storage" />
                    </div>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <Card className="p-4">
                            <SectionHeading title="By document type" />
                            <Counts label="Documents by type" entries={Object.entries(daily.byType).map(([type, count]) => [type, documentTypeLabel(type), count])} />
                        </Card>
                        <Card className="p-4">
                            <SectionHeading title="Admin actions this day" description="From the audit log" />
                            {actions.length
                                ? <Counts label="Admin actions" entries={actions.map(([action, count]) => [action, AUDIT_ACTIONS[action]?.label ?? action, count])} />
                                : <p className="mt-2 text-body-sm text-ink-muted">No review actions or corrections this day.</p>}
                        </Card>
                    </div>
                </>
            )}
        </section>
    );
}

function CurrentSection({ report }: { report: DailyReport }) {
    const { clients, police } = report.current;
    return (
        <section aria-labelledby="current-heading" className="space-y-3">
            <div className="border-t border-border pt-4">
                <h2 id="current-heading" className="text-headline-md text-ink">Current status</h2>
                <p className="mt-0.5 text-body-sm text-ink-muted">
                    As of {formatDateTime(report.current.asOf)}. These figures are the state now, not on {formatDay(report.businessDate)}: no history of them is kept.
                </p>
            </div>
            {/* Clients group */}
            <div className="space-y-1">
                <p className="text-label-caps uppercase text-ink-subtle">Clients</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Figure label="Completed clients" value={clients.complete} hint={`of ${formatNumber(clients.total)} clients`} />
                    <Figure label="Incomplete clients" value={clients.incomplete} />
                    <Figure label="Missing documents" value={clients.missingDocuments} tone="critical" hint={`${formatNumber(clients.withMissing)} clients`} />
                </div>
            </div>
            {/* Police group */}
            <div className="space-y-1">
                <p className="text-label-caps uppercase text-ink-subtle">Police reports</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    <Figure label="Police reports due soon" value={police.dueSoon} hint="1–7 days left" />
                    <Figure label="Police reports due today" value={police.dueToday} tone="critical" />
                    <Figure label="Overdue police reports" value={police.overdue} tone="critical" />
                    <Figure label="Missing slip date" value={police.missingSlipDate} tone="critical" />
                    <Figure label="Police slip not uploaded" value={police.notUploaded} tone="critical" />
                </div>
            </div>
            <p className="text-body-sm">
                <Link to="/missing-documents" className="text-primary hover:underline">Missing Documents</Link>
                <span aria-hidden="true" className="px-2 text-ink-subtle">·</span>
                <Link to="/police" className="text-primary hover:underline">Police Workflow</Link>
            </p>
        </section>
    );
}

// Daily report (proposal §22 Daily Summary, §35) for a chosen business day.
export function DailyReportPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [exporting, setExporting] = useState(false);
    const today = todayInSriLanka();
    const requested = searchParams.get("date");
    const date = requested && DATE_PATTERN.test(requested) ? requested : today;
    const report = useAdminResource(`report?${date}`, (token, signal) => getDailyReport(token, date, signal));
    const setDate = (value: string) => {
        const next = new URLSearchParams(searchParams);
        if (value && value !== today) next.set("date", value);
        else next.delete("date");
        setSearchParams(next);
    };
    const button = "h-9 rounded border border-border-strong bg-surface px-3 text-label-md text-ink-soft hover:border-border-focus hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";

    const handleExport = async () => {
        if (!report.data) return;
        setExporting(true);
        try {
            await exportPdf(report.data);
        } finally {
            setExporting(false);
        }
    };

    return (
        <section aria-labelledby="page-title" className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 id="page-title" className="text-headline-lg text-ink">Daily Report</h1>
                    <p className="mt-1 text-body-sm text-ink-muted">Figures for one business day in Sri Lanka, and the current status.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Report date">
                    <button type="button" className={button} onClick={() => setDate(shiftDay(date, -1))}>Previous day</button>
                    <label htmlFor="report-date" className="sr-only">Business date</label>
                    <input
                        id="report-date"
                        type="date"
                        min="2000-01-01"
                        max={today}
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                        className="h-9 rounded border border-border-strong bg-surface px-2 text-body-sm text-ink focus:border-primary focus:shadow-focus focus:outline-none"
                    />
                    <button type="button" className={button} disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}>Next day</button>
                    <button type="button" className={button} disabled={date === today} onClick={() => setDate(today)}>Today</button>
                    {report.status === "success" && (
                        <button
                            type="button"
                            className={`${button} inline-flex items-center gap-1.5`}
                            onClick={handleExport}
                            disabled={exporting}
                            aria-label="Export PDF"
                        >
                            <Icon name="picture_as_pdf" className="size-4" />
                            {exporting ? "Exporting…" : "Export PDF"}
                        </button>
                    )}
                </div>
            </div>

            {report.status === "error" && (
                <Card>
                    <ErrorState message={report.error.status === 400 ? "Choose a date between 1 January 2000 and today." : report.error.message} onRetry={report.error.status === 400 ? () => setDate(today) : report.reload} />
                </Card>
            )}
            {report.status === "loading" && <Card><LoadingState label="Loading daily report…" /></Card>}
            {report.status === "success" && (
                <>
                    <DailySection report={report.data} />
                    <CurrentSection report={report.data} />
                </>
            )}
        </section>
    );
}
