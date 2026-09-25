import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ApproveResult, PoliceCountdown, PoliceList, PoliceListItem, ReviewItem } from "../api/admin";
import { CLIENT_DETAILS, CLIENT_REF, OVERVIEW, renderApp, signedInBackend, stubBackend, type FetchRoutes } from "./helpers";

// Synthetic data only.
const countdown = (overrides: Partial<PoliceCountdown> = {}): PoliceCountdown => ({
    status: "PENDING",
    submittedDate: "2026-09-10",
    dueDate: "2026-10-01",
    daysRemaining: 6,
    slip: { documentId: "slip-1", verificationStatus: "VERIFIED", receivedDate: "2026-09-10T03:00:00.000Z" },
    report: null,
    slipAwaitingReview: false,
    ...overrides,
});
const row = (passportId: string, overrides: Partial<PoliceCountdown> = {}): PoliceListItem => ({
    client: { ...CLIENT_REF, passportId, name: `CLIENT ${passportId}` },
    ...countdown(overrides),
});
const ROWS = [
    row("N0000001", { status: "OVERDUE", submittedDate: "2026-09-01", dueDate: "2026-09-22", daysRemaining: -3 }),
    row("N0000002", { status: "DUE_TODAY", submittedDate: "2026-09-04", dueDate: "2026-09-25", daysRemaining: 0 }),
    row("N0000003", { status: "DUE_SOON", daysRemaining: 4, slip: { documentId: "s3", verificationStatus: "REVIEW_REQUIRED", receivedDate: null } }),
    row("N0000007", { status: "DATE_MISSING", submittedDate: null, dueDate: null, daysRemaining: null, slip: null, slipAwaitingReview: true }),
    row("N0000005", { status: "COMPLETED", daysRemaining: null, report: { documentId: "r5", receivedDate: "2026-09-20T00:00:00.000Z" } }),
];
const BY_STATUS = { OVERDUE: 3, DUE_TODAY: 1, DUE_SOON: 2, PENDING: 4, DATE_MISSING: 1, NOT_UPLOADED: 5, COMPLETED: 6 };
const list = (items: PoliceListItem[], { page = 1, total = items.length } = {}): PoliceList => ({
    businessDate: "2026-09-25",
    items,
    pagination: { page, pageSize: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
    summary: { total: 22, byStatus: BY_STATUS },
});
const lastPolice = (calls: { path: string }[]) => new URL([...calls].reverse().find((c) => c.path.startsWith("/api/admin/police"))!.path, "http://x").searchParams;

describe("Police Workflow page", () => {
    test("lists clients with status, dates, days and documents; counts per status", async () => {
        signedInBackend({ "GET /api/admin/police": { status: 200, body: list(ROWS) } });
        renderApp("/police");
        const table = await screen.findByRole("table", { name: "Police workflow" });
        const rows = within(table).getAllByRole("row").slice(1);
        expect(rows).toHaveLength(5);
        expect(rows[0]).toHaveTextContent("CLIENT N0000001");
        expect(rows[0]).toHaveTextContent("Overdue");
        expect(rows[0]).toHaveTextContent("01 Sept 2026");
        expect(rows[0]).toHaveTextContent("22 Sept 2026");
        expect(rows[0]).toHaveTextContent("3 days overdue");
        expect(rows[1]).toHaveTextContent("Due today");
        expect(rows[2]).toHaveTextContent("4 days left");
        expect(rows[2]).toHaveTextContent("Review required");
        expect(rows[3]).toHaveTextContent("Date missing");
        expect(rows[3]).toHaveTextContent("Waiting for review");
        expect(rows[4]).toHaveTextContent("Completed");
        expect(within(rows[4]).getAllByText("Verified")).toHaveLength(2); // slip and final report
        expect(within(rows[0]).getByRole("link", { name: "View client" })).toHaveAttribute("href", "/clients/N0000001");

        expect(screen.getByRole("button", { name: /Overdue\s*3/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Due today\s*1/ })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Not uploaded (5)" })).toBeInTheDocument();
    });

    test("status filter (select or card) is sent to the API and kept in the URL; paging too", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/police": (url) => ({ status: 200, body: list(ROWS, { total: 60, page: Number(url.searchParams.get("page") ?? 1) }) }),
        });
        renderApp("/police");
        await screen.findByText("Page 1 of 3");
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
        expect(lastPolice(calls).get("page")).toBe("2");

        await user.selectOptions(screen.getByLabelText("Status"), "DUE_SOON");
        expect(lastPolice(calls).get("status")).toBe("DUE_SOON");
        expect(lastPolice(calls).get("page")).toBe("1");

        await user.click(screen.getByRole("button", { name: /Overdue/ }));
        expect(lastPolice(calls).get("status")).toBe("OVERDUE");
        expect(screen.getByRole("button", { name: /Overdue/ })).toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByRole("button", { name: /Overdue/ }));
        expect(lastPolice(calls).get("status")).toBeNull();
    });

    test("loading, error with retry, empty filtered view", async () => {
        let mode: "fail" | "empty" = "fail";
        signedInBackend({ "GET /api/admin/police": () => (mode === "fail" ? { status: 500, body: {} } : { status: 200, body: list([]) }) });
        renderApp("/police?status=OVERDUE");
        const alert = await screen.findByRole("alert");
        mode = "empty";
        await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByText('No clients with status "Overdue"')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole("button", { name: "Show all clients" }));
        expect(await screen.findByText("No clients yet")).toBeInTheDocument();
    });

    test("without a session -> login, no API call", async () => {
        const { calls } = stubBackend({});
        renderApp("/police");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(calls.filter((c) => c.path.startsWith("/api/admin"))).toHaveLength(0);
    });
});

describe("Overview police counts", () => {
    test("shows due soon, due today and overdue with links to the filtered list", async () => {
        signedInBackend({ "GET /api/admin/overview": { status: 200, body: OVERVIEW } });
        renderApp("/");
        const counts = await screen.findByRole("list", { name: "Police reports by status" });
        const links = within(counts).getAllByRole("link");
        expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
            ["Overdue3", "/police?status=OVERDUE"],
            ["Due today1", "/police?status=DUE_TODAY"],
            ["Due soon (1–7 days)2", "/police?status=DUE_SOON"],
        ]);
    });
});

describe("Client details police countdown", () => {
    const withCountdown = (c: PoliceCountdown) => ({ ...CLIENT_DETAILS, police: { ...CLIENT_DETAILS.police, countdown: c } });

    test("overdue: submitted date, due date and days overdue", async () => {
        signedInBackend({ "GET /api/admin/clients/N1234567": { status: 200, body: withCountdown(countdown({ status: "OVERDUE", submittedDate: "2026-09-01", dueDate: "2026-09-22", daysRemaining: -3 })) } });
        renderApp("/clients/N1234567");
        const panel = await screen.findByRole("group", { name: "Police report follow-up" });
        expect(panel).toHaveTextContent("Overdue");
        expect(panel).toHaveTextContent("01 Sept 2026");
        expect(panel).toHaveTextContent("22 Sept 2026");
        expect(panel).toHaveTextContent("3 days overdue");
        expect(screen.getByRole("link", { name: "Open Police Workflow" })).toHaveAttribute("href", "/police");
    });

    test("slip waiting for review -> date missing, with an explanation", async () => {
        signedInBackend({ "GET /api/admin/clients/N1234567": { status: 200, body: withCountdown(countdown({ status: "DATE_MISSING", submittedDate: null, dueDate: null, daysRemaining: null, slip: null, slipAwaitingReview: true })) } });
        renderApp("/clients/N1234567");
        const panel = await screen.findByRole("group", { name: "Police report follow-up" });
        expect(panel).toHaveTextContent("Date missing");
        expect(panel).toHaveTextContent("A police slip is waiting for review.");
    });

    test("no slip -> not uploaded", async () => {
        signedInBackend({ "GET /api/admin/clients/N1234567": { status: 200, body: withCountdown(countdown({ status: "NOT_UPLOADED", submittedDate: null, dueDate: null, daysRemaining: null, slip: null })) } });
        renderApp("/clients/N1234567");
        expect(await screen.findByRole("group", { name: "Police report follow-up" })).toHaveTextContent("No police slip has been received");
    });
});

describe("approving a police slip", () => {
    const TEMP_ID = "11111111-1111-4111-8111-111111111111";
    const DOC_ID = "33333333-3333-4333-8333-333333333333";
    const slipItem = (overrides: Partial<ReviewItem["document"]> = {}, kind: "PENDING" | "DOCUMENT" = "PENDING"): ReviewItem => ({
        reviewId: kind === "PENDING" ? `pending-${TEMP_ID}` : `document-${DOC_ID}`,
        kind,
        reviewReason: "POLICE_DATE_UNRESOLVED",
        reviewCategory: "QUALITY",
        document: { documentId: kind === "PENDING" ? null : DOC_ID, temporaryId: TEMP_ID, documentType: "POLICE_SLIP", processingStatus: "MANUAL_REVIEW", verificationStatus: kind === "PENDING" ? null : "REVIEW_REQUIRED", receivedDate: "2026-09-24T01:00:00.000Z", confidence: 80, policeSubmittedDate: null, ...overrides },
        client: CLIENT_REF,
        submission: { whatsappNumber: "94770000000", receivedDate: "2026-09-24T01:00:00.000Z" },
        processing: null,
        file: { name: "slip.pdf", mimeType: "application/pdf", size: null, location: kind === "PENDING" ? "PENDING" : "CLIENT", previewUrl: null },
        auditLog: [],
        actions: { approve: { available: true, code: null, message: null, needsPoliceDate: !overrides.policeSubmittedDate }, keepPending: { available: true, code: null, message: null } },
    });
    const approved = (date: string): ApproveResult => ({
        action: "APPROVE",
        reviewId: `pending-${TEMP_ID}`,
        document: { documentId: DOC_ID, storedFilename: "police_slip.pdf", verificationStatus: "VERIFIED", location: "CLIENT", policeSubmittedDate: date },
        pendingCopyRemoved: true,
        audit: { auditId: "a1", action: "APPROVE", adminId: "admin-1", adminName: "Test Admin", reason: null, previousStatus: "MANUAL_REVIEW", newStatus: "VERIFIED", policeSubmittedDate: date, documentType: null, createdDate: "2026-09-25T05:00:00.000Z" },
    });
    beforeEach(() => {
        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    });

    async function open(item: ReviewItem, routes: FetchRoutes = {}) {
        const backend = signedInBackend({ [`GET /api/admin/review/${item.reviewId}`]: { status: 200, body: item }, ...routes });
        renderApp(`/review/${item.reviewId}`);
        const user = userEvent.setup();
        await user.click(within(await screen.findByRole("group", { name: "Review actions" })).getByRole("button", { name: "Approve" }));
        return { ...backend, user, dialog: screen.getByRole("dialog", { name: "Approve this document?" }) };
    }

    test("the date is required when OCR could not read it; entered date is sent and shown", async () => {
        const { calls, user, dialog } = await open(slipItem(), { [`POST /api/admin/review/pending-${TEMP_ID}/approve`]: { status: 200, body: approved("2026-09-10") } });
        const input = within(dialog).getByLabelText(/Submitted date on the police slip/);
        expect(input).toBeRequired();
        expect(input).toHaveAttribute("type", "date");
        expect(input).toHaveAttribute("min", "2000-01-01");
        expect(input.getAttribute("max")).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        await user.click(within(dialog).getByRole("button", { name: "Approve" }));
        expect(within(dialog).getByText("Enter the submitted date shown on the police slip.")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

        fireEvent.change(input, { target: { value: "2026-09-10" } });
        await user.click(within(dialog).getByRole("button", { name: "Approve" }));
        expect(await screen.findByRole("status")).toHaveTextContent("The 21-day follow-up runs from 10 Sept 2026.");
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ policeSubmittedDate: "2026-09-10" }]);
        expect(within(screen.getByRole("list", { name: "Review history" })).getByText("Police slip submitted date: 10 Sept 2026")).toBeInTheDocument();
    });

    test("a date read by OCR is shown for confirmation, without an input; nothing extra is sent", async () => {
        const item = slipItem({ policeSubmittedDate: "2026-09-05" }, "DOCUMENT");
        const { calls, user, dialog } = await open(item, { [`POST /api/admin/review/document-${DOC_ID}/approve`]: { status: 200, body: approved("2026-09-05") } });
        expect(dialog).toHaveTextContent("Submitted date read from the slip: 05 Sept 2026");
        expect(within(dialog).queryByLabelText(/Submitted date on the police slip/)).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Approve" }));
        await screen.findByRole("status");
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{}]);
    });

    test("a server refusal about the date is shown", async () => {
        const { user, dialog } = await open(slipItem(), {
            [`POST /api/admin/review/pending-${TEMP_ID}/approve`]: { status: 400, body: { message: "Invalid request body", errors: [{ field: "policeSubmittedDate", message: "must be between 2000-01-01 and today" }] } },
        });
        fireEvent.change(within(dialog).getByLabelText(/Submitted date on the police slip/), { target: { value: "2026-09-10" } });
        await user.click(within(dialog).getByRole("button", { name: "Approve" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("Invalid request body");
    });

    test("other document types have no date field", async () => {
        const passport = { ...slipItem(), document: { ...slipItem().document, documentType: "PASSPORT" } };
        const { dialog } = await open(passport);
        expect(within(dialog).queryByLabelText(/Submitted date/)).not.toBeInTheDocument();
    });
});
