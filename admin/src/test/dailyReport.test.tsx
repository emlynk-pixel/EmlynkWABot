import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { DailyReport } from "../api/admin";
import { todayInSriLanka } from "../components/format";
import { renderApp, signedInBackend } from "./helpers";

// ---------------------------------------------------------------------------
// Mock jspdf at module level (vitest hoists vi.mock)
// ---------------------------------------------------------------------------

const saveMock = vi.fn();

function createMockDoc() {
    const pages = [1];
    return {
        internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
        setFontSize: vi.fn(), setFont: vi.fn(), setTextColor: vi.fn(),
        setDrawColor: vi.fn(), setFillColor: vi.fn(),
        text: vi.fn(), line: vi.fn(), rect: vi.fn(),
        addPage: vi.fn(() => pages.push(pages.length + 1)),
        getNumberOfPages: vi.fn(() => pages.length),
        setPage: vi.fn(),
        save: saveMock,
    };
}

vi.mock("jspdf", () => {
    // jsPDF is used with `new jsPDF(...)`, so we need a class-like constructor.
    function MockJsPDF() {
        return createMockDoc();
    }
    return { jsPDF: MockJsPDF };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const report = (overrides: Partial<DailyReport["daily"]> = {}, date = "2026-09-24"): DailyReport => ({
    businessDate: date, today: todayInSriLanka(), isToday: date === todayInSriLanka(), timeZone: "Asia/Colombo",
    range: { start: "2026-09-23T18:30:00.000Z", end: "2026-09-24T18:30:00.000Z" },
    daily: {
        totalReceived: 9, successfullyProcessed: 7, failed: 1, stillProcessing: 1, storedInClientFolder: 3, heldForReview: 3, duplicates: 1,
        unclear: 2, temporary: 3, byType: { PASSPORT: 3, POLICE_SLIP: 1, POLICE_REPORT: 1, MEDICAL: 1, UNKNOWN: 3 }, byStatus: {}, adminActions: { APPROVE: 4, REMOVE_FROM_REVIEW: 1 },
        ...overrides,
    },
    current: { asOf: "2026-09-25T06:00:00.000Z", clients: { total: 10, complete: 6, incomplete: 4, withMissing: 3, missingDocuments: 5, missingByType: {} }, police: { dueSoon: 2, dueToday: 1, overdue: 0, missingSlipDate: 0, notUploaded: 0 } },
});

// ---------------------------------------------------------------------------
// PDF Export Tests
// ---------------------------------------------------------------------------

describe("Daily Report — PDF Export", () => {
    test("Export PDF button is visible when report data is loaded", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report() } });
        renderApp("/reports/daily");
        expect(await screen.findByRole("button", { name: "Export PDF" })).toBeInTheDocument();
    });

    test("Export PDF button is NOT visible while loading", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        signedInBackend({ "GET /api/admin/reports/daily": () => new Promise((resolve) => { release = resolve; }) });
        renderApp("/reports/daily");
        expect(await screen.findByText("Loading daily report…")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Export PDF" })).not.toBeInTheDocument();
        release({ status: 200, body: report() });
        expect(await screen.findByRole("button", { name: "Export PDF" })).toBeInTheDocument();
    });

    test("Export PDF button is NOT visible on error", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 500, body: {} } });
        renderApp("/reports/daily");
        await screen.findByRole("alert");
        expect(screen.queryByRole("button", { name: "Export PDF" })).not.toBeInTheDocument();
    });

    test("clicking Export PDF triggers jspdf save with correct filename", async () => {
        saveMock.mockClear();
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report({}, "2026-09-24") } });
        renderApp("/reports/daily?date=2026-09-24");
        const user = userEvent.setup();
        const button = await screen.findByRole("button", { name: "Export PDF" });
        await user.click(button);
        expect(saveMock).toHaveBeenCalledWith("daily-report-2026-09-24.pdf");
    });

    test("Export PDF works with no received documents", async () => {
        saveMock.mockClear();
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report({ totalReceived: 0, successfullyProcessed: 0, failed: 0 }, "2026-09-01") } });
        renderApp("/reports/daily?date=2026-09-01");
        const user = userEvent.setup();
        const button = await screen.findByRole("button", { name: "Export PDF" });
        await user.click(button);
        expect(saveMock).toHaveBeenCalledWith("daily-report-2026-09-01.pdf");
    });
});

// ---------------------------------------------------------------------------
// UI Structure Tests
// ---------------------------------------------------------------------------

describe("Daily Report — UI structure", () => {
    test("daily section and current status section are present and distinct", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report() } });
        renderApp("/reports/daily");
        await screen.findByRole("heading", { name: /^Received on/ });
        const currentSection = screen.getByRole("heading", { name: "Current status" }).closest("section")!;
        expect(currentSection).toBeInTheDocument();
        // The current section has a top border (via border-t class on its inner div)
        expect(currentSection.querySelector(".border-t")).toBeInTheDocument();
    });

    test("current status groups clients and police under sub-headings", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report() } });
        renderApp("/reports/daily");
        await screen.findByRole("heading", { name: /^Received on/ });
        const currentSection = screen.getByRole("heading", { name: "Current status" }).closest("section")!;
        expect(within(currentSection).getByText("Clients")).toBeInTheDocument();
        expect(within(currentSection).getByText("Police reports")).toBeInTheDocument();
    });

    test("all existing metrics are still present with data", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report() } });
        renderApp("/reports/daily");
        await screen.findByRole("heading", { name: /^Received on/ });

        // Daily metrics
        expect(screen.getByText("Documents received")).toBeInTheDocument();
        expect(screen.getByText("Successfully processed")).toBeInTheDocument();
        expect(screen.getByText("Failed processing")).toBeInTheDocument();
        expect(screen.getByText("Unclear documents")).toBeInTheDocument();
        expect(screen.getByText("Temporary documents")).toBeInTheDocument();

        // Current status
        expect(screen.getByText("Completed clients")).toBeInTheDocument();
        expect(screen.getByText("Incomplete clients")).toBeInTheDocument();
        expect(screen.getByText("Missing documents")).toBeInTheDocument();
        expect(screen.getByText("Police reports due soon")).toBeInTheDocument();
        expect(screen.getByText("Police reports due today")).toBeInTheDocument();
        expect(screen.getByText("Overdue police reports")).toBeInTheDocument();
        expect(screen.getByText("Missing slip date")).toBeInTheDocument();
        expect(screen.getByText("Police slip not uploaded")).toBeInTheDocument();
    });

    test("empty daily state is compact and clear", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report({ totalReceived: 0, successfullyProcessed: 0, failed: 0 }) } });
        renderApp("/reports/daily?date=2026-09-01");
        expect(await screen.findByText("No documents were received on this day")).toBeInTheDocument();
        expect(screen.getByText("Choose another date, or check back later today.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Current status" })).toBeInTheDocument();
    });

    test("Missing Documents and Police Workflow links are present in the report", async () => {
        signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report() } });
        renderApp("/reports/daily");
        const reportSection = (await screen.findByRole("heading", { name: "Current status" })).closest("section")!;
        expect(within(reportSection).getByRole("link", { name: "Missing Documents" })).toHaveAttribute("href", "/missing-documents");
        expect(within(reportSection).getByRole("link", { name: "Police Workflow" })).toHaveAttribute("href", "/police");
    });

    test("selected date is sent correctly to the API", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/reports/daily": { status: 200, body: report({}, "2026-08-15") } });
        renderApp("/reports/daily?date=2026-08-15");
        await screen.findByRole("heading", { name: /^Received on/ });
        const lastReport = [...calls].reverse().find((c) => c.path.startsWith("/api/admin/reports/daily"));
        expect(lastReport?.path).toBe("/api/admin/reports/daily?date=2026-08-15");
    });
});
