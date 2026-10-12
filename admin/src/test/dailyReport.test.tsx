import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DailyRoleSummary, DailySummary } from "../api/admin";
import { todayInSriLanka } from "../components/format";
import { ADMIN, RENDER_STEP, renderApp, renderAppSignedIn, signedInBackend } from "./helpers";

// Daily Report page: Summary and Summary by Roles. Synthetic data; the
// backend is a stub (the figures themselves are tested in
// test/dailyReportSummary.test.js). jspdf is replaced by a recorder.

// ---------------------------------------------------------------- jspdf recorder

const pdf = vi.hoisted(() => ({ texts: [] as string[], saved: [] as string[] }));
vi.mock("jspdf", () => {
    function MockJsPDF() {
        let pages = 1;
        return {
            internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
            setFontSize() {}, setFont() {}, setTextColor() {}, setDrawColor() {}, setFillColor() {}, line() {}, rect() {},
            splitTextToSize: (value: string) => [value],
            text: (value: string) => { pdf.texts.push(value); },
            addPage: () => { pages += 1; },
            getNumberOfPages: () => pages,
            setPage() {},
            save: (name: string) => { pdf.saved.push(name); },
        };
    }
    return { jsPDF: MockJsPDF };
});
beforeEach(() => {
    pdf.texts.length = 0;
    pdf.saved.length = 0;
});

// ---------------------------------------------------------------- fixtures

const STAGES = ["TEST_DETAILS", "CANDIDATE_DETAILS", "DOCUMENT_SUBMISSION", "IVS_INTERVIEW", "VISA_SUBMISSION", "VISA_APPROVAL", "FINALIZING_JOB"];
const DATE = "2026-10-10";

const summary = (date = DATE, overrides: Partial<DailySummary> = {}): DailySummary => ({
    businessDate: date, today: todayInSriLanka(), isToday: date === todayInSriLanka(), timeZone: "Asia/Colombo",
    range: { start: "2026-10-09T18:30:00.000Z", end: "2026-10-10T18:30:00.000Z" },
    summary: { candidatesCompleted: 1, visaCompleted: 2, callsTaken: 4, documentsSubmitted: 6 },
    documents: {
        total: 6, whatsapp: 3, manual: 3,
        byType: [
            { type: "PASSPORT", total: 2, whatsapp: 1, manual: 1 },
            { type: "NIC", total: 0, whatsapp: 0, manual: 0 },
            { type: "SKILL_VIDEO", total: 0, whatsapp: 0, manual: 0 },
            { type: "MEDICAL", total: 1, whatsapp: 1, manual: 0 },
            { type: "POLICE_SLIP", total: 0, whatsapp: 0, manual: 0 },
            { type: "POLICE_REPORT", total: 1, whatsapp: 0, manual: 1 },
            { type: "SCAN", total: 1, whatsapp: 0, manual: 1 },
            { type: "VISA_SUBMISSION", total: 0, whatsapp: 0, manual: 0 },
            { type: "UNKNOWN", total: 1, whatsapp: 1, manual: 0 },
        ],
    },
    whatsappProcessing: { received: 3, successfullyProcessed: 1, storedInCandidateFolder: 1, heldForReview: 0, duplicates: 0, failed: 1, stillProcessing: 0, unclear: 0, temporary: 1 },
    adminActions: { APPROVE: 2 },
    calls: {
        total: 2, truncated: false,
        items: [
            { callLogId: "c2", calledAt: "2026-10-10T08:00:00.000Z", passportId: "N1000002", candidateName: "Bimal Silva", handledBy: "Dee Desk", role: "REGISTRATION_DESK" },
            { callLogId: "c1", calledAt: "2026-10-10T05:00:00.000Z", passportId: "N1000001", candidateName: "Anil Silva", handledBy: "Ann Analyst", role: "ANALYST" },
        ],
    },
    completedCandidates: { total: 1, truncated: false, items: [{ passportId: "N1000001", name: "Anil Silva", completedAt: "2026-10-10T10:00:00.000Z", allStagesComplete: false }] },
    current: {
        asOf: "2026-10-11T06:00:00.000Z",
        incomplete: {
            asOf: "2026-10-11T06:00:00.000Z", totalCandidates: 3, incompleteCandidates: 3, completeCandidates: 0,
            byStage: STAGES.map((stage) => ({
                stage,
                count: stage === "DOCUMENT_SUBMISSION" ? 3 : stage === "VISA_APPROVAL" ? 0 : 1,
                reasons: stage === "DOCUMENT_SUBMISSION"
                    ? [{ reason: "Romania police report missing", count: 3 }, { reason: "Scan missing", count: 2 }]
                    : stage === "VISA_APPROVAL" ? [] : [{ reason: "Not marked complete", count: 1 }],
            })),
        },
        police: { dueSoon: 2, dueToday: 1, overdue: 3, missingSlipDate: 0, notUploaded: 4 },
    },
    ...overrides,
});

const empty = (date = DATE): DailySummary => ({
    ...summary(date),
    summary: { candidatesCompleted: 0, visaCompleted: 0, callsTaken: 0, documentsSubmitted: 0 },
    documents: { total: 0, whatsapp: 0, manual: 0, byType: summary(date).documents.byType.filter((r) => r.type !== "UNKNOWN").map((r) => ({ ...r, total: 0, whatsapp: 0, manual: 0 })) },
    whatsappProcessing: { ...summary(date).whatsappProcessing, received: 0 },
    adminActions: {},
    calls: { total: 0, items: [], truncated: false },
    completedCandidates: { total: 0, items: [], truncated: false },
});

const roleSummary = (role = "ANALYST"): DailyRoleSummary => ({
    businessDate: DATE, timeZone: "Asia/Colombo", range: { start: "2026-10-09T18:30:00.000Z", end: "2026-10-10T18:30:00.000Z" },
    role, staffCount: 2, callsTaken: 2, documentsUploaded: 2,
    documentsByType: ["PASSPORT", "NIC", "SKILL_VIDEO", "MEDICAL", "POLICE_SLIP", "POLICE_REPORT", "SCAN", "VISA_SUBMISSION"].map((type) => ({ type, count: type === "PASSPORT" || type === "POLICE_REPORT" ? 1 : 0 })),
    staff: [{ adminId: "a1", name: "Ann Analyst", status: "ACTIVE", calls: 1, documents: 1 }, { adminId: "a2", name: "Bob Analyst", status: "INACTIVE", calls: 1, documents: 1 }],
    activity: [
        { kind: "DOCUMENT_UPLOAD", at: "2026-10-10T04:00:00.000Z", staff: "Bob Analyst", passportId: "N1000001", candidateName: "Anil Silva", documentType: "POLICE_REPORT", variant: "SL_VERIFIED" },
        { kind: "CALL", at: "2026-10-10T03:30:00.000Z", staff: "Ann Analyst", passportId: "N1000001", candidateName: "Anil Silva", documentType: null, variant: null },
    ],
    activityTotal: 2, truncated: false,
});

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });
const summaryRoute = (body: (date: string) => DailySummary = summary) => ({
    "GET /api/admin/reports/daily/summary": (url: URL) => ({ status: 200, body: body(url.searchParams.get("date") ?? todayInSriLanka()) }),
});
const requests = (calls: { path: string }[], prefix: string) => calls.filter((c) => c.path.startsWith(prefix)).map((c) => c.path);
const kpi = (label: string) => screen.getByText(label, { selector: "p" }).parentElement!;
const main = () => screen.getByRole("region", { name: "Daily Report" }) ?? document.body;

// ---------------------------------------------------------------- Summary

describe("Daily Report: Summary", () => {
    test("1-2, 8-12. today by default: four KPIs, Candidates (never Clients) wording", async () => {
        const { calls } = signedInBackend({ ...summaryRoute() });
        renderApp("/reports/daily");
        expect(await screen.findByText("Candidates completed", {}, RENDER_STEP)).toBeInTheDocument();
        expect(requests(calls, "/api/admin/reports/daily/summary")).toEqual([`/api/admin/reports/daily/summary?date=${todayInSriLanka()}`]);
        expect(kpi("Candidates completed")).toHaveTextContent("1");
        expect(kpi("Visa completed")).toHaveTextContent("2");
        expect(kpi("Calls taken")).toHaveTextContent("4");
        expect(kpi("Documents submitted")).toHaveTextContent("6");
        expect(kpi("Documents submitted")).toHaveTextContent("3 WhatsApp · 3 manual");
        expect(main()).not.toHaveTextContent(/client/i);
        expect(screen.getByText("Completed candidates")).toBeInTheDocument();
        expect(screen.getByText("Incomplete candidates")).toBeInTheDocument();
    });

    test("13-15. documents by type: real types with WhatsApp / manual, unclassified named plainly, one Scan, no removed types", async () => {
        signedInBackend({ ...summaryRoute() });
        renderApp(`/reports/daily?date=${DATE}`);
        const table = await screen.findByRole("table", { name: "Documents submitted by type" }, RENDER_STEP);
        const rows = within(table).getAllByRole("row").slice(1).map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
        expect(rows).toContainEqual(["Passport", "2", "1", "1"]);
        expect(rows).toContainEqual(["Police report", "1", "0", "1"]);
        expect(rows).toContainEqual(["Unclassified", "1", "1", "0"]);
        expect(rows.filter((r) => r[0] === "Scan")).toHaveLength(1);
        for (const removed of ["Agreement", "Affidavit", "Contract"]) expect(within(table).queryByText(removed)).toBeNull();
        expect(screen.getByText(/WhatsApp processing: 1 processed/)).toBeInTheDocument();
    });

    test("19. completed candidates show passport number, name, time and the current stage state; calls show handler and role", async () => {
        signedInBackend({ ...summaryRoute() });
        renderApp(`/reports/daily?date=${DATE}`);
        const completed = await screen.findByRole("table", { name: "Completed candidates" }, RENDER_STEP);
        expect(within(completed).getByRole("link", { name: "N1000001" })).toHaveAttribute("href", "/candidates/N1000001");
        expect(within(completed).getByText("Anil Silva")).toBeInTheDocument();
        expect(within(completed).getByText("15:30")).toBeInTheDocument();
        expect(within(completed).getByText("Some stages open")).toBeInTheDocument();
        const calls = screen.getByRole("table", { name: "Calls taken" });
        expect(within(calls).getByText("Dee Desk")).toBeInTheDocument();
        expect(within(calls).getByText("Registration Desk")).toBeInTheDocument();
        expect(within(calls).getByText("N1000002")).toBeInTheDocument();
    });

    test("16-17. incomplete candidates (current state): count and reasons per process; View loads that process's candidates", async () => {
        const { calls } = signedInBackend({
            ...summaryRoute(),
            "GET /api/admin/reports/daily/incomplete": {
                status: 200,
                body: { stage: "DOCUMENT_SUBMISSION", asOf: "2026-10-11T06:00:00.000Z", items: [{ passportId: "N1000003", name: "Chamari Silva", reasons: ["Medical missing", "Scan missing"] }], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 } },
            },
        });
        renderApp(`/reports/daily?date=${DATE}`);
        const current = (await screen.findByRole("heading", { name: "Current state" }, RENDER_STEP)).closest("section")!;
        expect(current).toHaveTextContent("not on");
        const table = within(current).getByRole("table", { name: "Incomplete candidates by process" });
        const row = within(table).getByText("Document submission").closest("tr")!;
        expect(row).toHaveTextContent("3");
        expect(row).toHaveTextContent("Romania police report missing (3) · Scan missing (2)");
        expect(within(within(table).getByText("Visa approval").closest("tr")!).queryByRole("button")).toBeNull();
        await userEvent.setup().click(within(row).getByRole("button", { name: /View/ }));
        const detail = await screen.findByRole("table", { name: "Candidates with Document submission incomplete" });
        expect(within(detail).getByText("Medical missing · Scan missing")).toBeInTheDocument();
        expect(requests(calls, "/api/admin/reports/daily/incomplete")).toEqual(["/api/admin/reports/daily/incomplete?stage=DOCUMENT_SUBMISSION&page=1"]);
    });

    test("34. police report status is shown (current state) with a link to the Police Workflow", async () => {
        signedInBackend({ ...summaryRoute() });
        renderApp(`/reports/daily?date=${DATE}`);
        const police = await screen.findByLabelText("Police report status", {}, RENDER_STEP);
        expect(within(police).getByText("Overdue").nextSibling).toHaveTextContent("3");
        expect(within(police).getByText("Slip not uploaded").nextSibling).toHaveTextContent("4");
        expect(within(police.closest("section") ?? police.parentElement!.parentElement!).getByRole("link", { name: "Police Workflow" })).toHaveAttribute("href", "/police");
    });

    test("an empty day shows zeros and plain empty messages", async () => {
        signedInBackend({ ...summaryRoute(empty) });
        renderApp(`/reports/daily?date=${DATE}`);
        expect(await screen.findByText("No candidate completed on this day.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByText("No calls were logged on this day.")).toBeInTheDocument();
        expect(kpi("Documents submitted")).toHaveTextContent("0");
    });
});

// ---------------------------------------------------------------- Date

describe("Daily Report: date", () => {
    test("3-6. previous day, the date picker and Today request that day; Next day is disabled on today", async () => {
        const { calls } = signedInBackend({ ...summaryRoute() });
        renderApp("/reports/daily");
        const user = userEvent.setup();
        await screen.findByText("Candidates completed", {}, RENDER_STEP);
        expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
        expect(screen.getByLabelText("Business date")).toHaveAttribute("max", todayInSriLanka());
        await user.click(screen.getByRole("button", { name: "Previous day" }));
        const yesterday = new Date(Date.parse(`${todayInSriLanka()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        expect(requests(calls, "/api/admin/reports/daily/summary").at(-1)).toBe(`/api/admin/reports/daily/summary?date=${yesterday}`);
        expect(screen.getByRole("button", { name: "Next day" })).toBeEnabled();

        fireEvent.change(screen.getByLabelText("Business date"), { target: { value: "2026-09-01" } });
        expect(requests(calls, "/api/admin/reports/daily/summary").at(-1)).toBe("/api/admin/reports/daily/summary?date=2026-09-01");

        await user.click(screen.getByRole("button", { name: "Today" }));
        expect(requests(calls, "/api/admin/reports/daily/summary").at(-1)).toBe(`/api/admin/reports/daily/summary?date=${todayInSriLanka()}`);
        expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    });

    test("loading, then error with retry", async () => {
        let fail = true;
        signedInBackend({ "GET /api/admin/reports/daily/summary": () => (fail ? { status: 500, body: {} } : { status: 200, body: summary() }) });
        await renderAppSignedIn("/reports/daily");
        const alert = await screen.findByRole("alert", {}, RENDER_STEP);
        fail = false;
        await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Candidates completed", {}, RENDER_STEP)).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------- Summary by Roles

describe("Daily Report: Summary by Roles", () => {
    test("25. ANALYST sees the Summary only (no role view)", async () => {
        const { calls } = signedInBackend({ ...asRole("ANALYST"), ...summaryRoute() });
        renderApp("/reports/daily?view=roles");
        expect(await screen.findByText("Candidates completed", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("tab", { name: "Summary by Roles" })).toBeNull();
        expect(requests(calls, "/api/admin/reports/daily/roles")).toEqual([]);
    });

    for (const role of ["ADMIN", "MANAGER"]) {
        test(`21-23, 26-27. ${role}: the role view, role selector in order, figures for the chosen role`, async () => {
            const { calls } = signedInBackend({
                ...asRole(role), ...summaryRoute(),
                "GET /api/admin/reports/daily/roles": (url: URL) => ({ status: 200, body: roleSummary(url.searchParams.get("role") ?? "ANALYST") }),
            });
            renderApp(`/reports/daily?date=${DATE}`);
            const user = userEvent.setup();
            await user.click(await screen.findByRole("tab", { name: "Summary by Roles" }, RENDER_STEP));
            const select = await screen.findByRole("combobox", { name: "Role" });
            expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Analyst", "Manager", "Admin", "Registration Desk"]);
            expect(requests(calls, "/api/admin/reports/daily/roles").at(-1)).toBe(`/api/admin/reports/daily/roles?date=${DATE}&role=ANALYST`);
            expect(await screen.findByText("Documents uploaded", { selector: "p" })).toBeInTheDocument();
            expect(kpi("Calls taken")).toHaveTextContent("2");
            expect(within(screen.getByRole("table", { name: "Staff activity" })).getByText("(inactive)")).toBeInTheDocument();
            expect(within(screen.getByRole("table", { name: "Activity details" })).getByText("Uploaded Police report (SL Verified)")).toBeInTheDocument();
            expect(screen.getByText(/WhatsApp files are not attributed to staff/)).toBeInTheDocument();

            await user.selectOptions(select, "REGISTRATION_DESK");
            expect(requests(calls, "/api/admin/reports/daily/roles").at(-1)).toBe(`/api/admin/reports/daily/roles?date=${DATE}&role=REGISTRATION_DESK`);
        });
    }
});

// ---------------------------------------------------------------- PDF

describe("Daily Report: PDF", () => {
    test("28-30. the Summary PDF has the date, the main metrics, the document breakdown and the completed candidates", async () => {
        signedInBackend({ ...summaryRoute() });
        renderApp(`/reports/daily?date=${DATE}`);
        await screen.findByText("Candidates completed", {}, RENDER_STEP);
        await userEvent.setup().click(screen.getByRole("button", { name: "Export PDF" }));
        await vi.waitFor(() => expect(pdf.saved).toEqual([`daily-report-${DATE}.pdf`]));
        const text = pdf.texts.join("\n");
        expect(text).toContain("Daily Report — Summary");
        expect(text).toContain("10 Oct 2026");
        expect(text).toContain("Asia/Colombo");
        for (const label of ["Candidates completed (final stage completed)", "Visa completed (visa approval completed)", "Calls taken", "Documents submitted", "Passport", "Unclassified", "N1000001", "Anil Silva", "Incomplete candidates (current state)", "Police reports (current state)"]) {
            expect(text).toContain(label);
        }
        expect(text).not.toMatch(/client/i);
    });

    test("31-32. the role PDF uses the selected role and leaves out the Summary sections", async () => {
        signedInBackend({
            ...summaryRoute(),
            "GET /api/admin/reports/daily/roles": (url: URL) => ({ status: 200, body: roleSummary(url.searchParams.get("role") ?? "ANALYST") }),
        });
        renderApp(`/reports/daily?date=${DATE}&view=roles&role=REGISTRATION_DESK`);
        await screen.findByText("Documents uploaded", { selector: "p" }, RENDER_STEP);
        await userEvent.setup().click(screen.getByRole("button", { name: "Export PDF" }));
        await vi.waitFor(() => expect(pdf.saved).toEqual([`daily-report-${DATE}-registration_desk.pdf`]));
        const text = pdf.texts.join("\n");
        expect(text).toContain("Daily Report — Registration Desk");
        expect(text).toContain("Staff");
        expect(text).toContain("Ann Analyst");
        expect(text).not.toContain("Completed candidates");
        expect(text).not.toContain("Police reports");
    });

    test("33. exporting a day with no records works", async () => {
        signedInBackend({ ...summaryRoute(empty) });
        renderApp(`/reports/daily?date=${DATE}`);
        await screen.findByText("No candidate completed on this day.", {}, RENDER_STEP);
        await userEvent.setup().click(screen.getByRole("button", { name: "Export PDF" }));
        await vi.waitFor(() => expect(pdf.saved).toEqual([`daily-report-${DATE}.pdf`]));
        expect(pdf.texts.join("\n")).toContain("No candidate completed on this day.");
    });

    test("Export PDF is disabled until the report has loaded", async () => {
        signedInBackend({ "GET /api/admin/reports/daily/summary": () => new Promise(() => {}) });
        await renderAppSignedIn("/reports/daily");
        expect(await screen.findByRole("button", { name: "Export PDF" }, RENDER_STEP)).toBeDisabled();
    });
});
