import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ApproveResult, AuditEntry, ReviewItem, ReviewQueue, ReviewQueueItem } from "../api/admin";
import { CLIENT_REF, TOKEN_KEY, renderApp, signedInBackend, stubBackend, type FetchRoutes } from "./helpers";

// Synthetic review data only.
const TEMP_ID = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "33333333-3333-4333-8333-333333333333";

const queueItem = (overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem => ({
    reviewId: `pending-${TEMP_ID}`,
    kind: "PENDING",
    documentType: "PASSPORT",
    processingStatus: "MANUAL_REVIEW",
    verificationStatus: null,
    reviewReason: "IDENTITY_NOT_CONFIRMED",
    reviewCategory: "IDENTITY",
    confidence: 71,
    receivedDate: "2026-09-24T01:00:00.000Z",
    client: CLIENT_REF,
    ...overrides,
});

function queue(items: ReviewQueueItem[], { page = 1, total = items.length } = {}): ReviewQueue {
    return {
        items,
        pagination: { page, pageSize: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
        summary: { total, pending: total - 1, documents: 1, byReason: { IDENTITY_NOT_CONFIRMED: 1 }, byCategory: { IDENTITY: 4, QUALITY: 7, CONFLICT: 2, OTHER: 1 } },
    };
}

const TWO_ITEMS = [
    queueItem(),
    queueItem({ reviewId: `document-${DOC_ID}`, kind: "DOCUMENT", documentType: "MEDICAL", processingStatus: "STORED", verificationStatus: "REVIEW_REQUIRED", reviewReason: "LOW_CONFIDENCE", reviewCategory: "QUALITY", confidence: 50 }),
];

const ITEM: ReviewItem = {
    reviewId: `pending-${TEMP_ID}`,
    kind: "PENDING",
    reviewReason: "IDENTITY_NOT_CONFIRMED",
    reviewCategory: "IDENTITY",
    document: { documentId: null, temporaryId: TEMP_ID, documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW", verificationStatus: null, receivedDate: "2026-09-24T01:00:00.000Z", confidence: 71, policeSubmittedDate: null },
    client: CLIENT_REF,
    submission: { whatsappNumber: "94770000000", receivedDate: "2026-09-24T01:00:00.000Z" },
    processing: {
        stage: "COMPLETED", error: null, extractionMethod: "OCR", typeSource: "CONTENT", ocrUpscaled: true,
        confidence: { extraction: 71, classification: 100, document: 71, band: "SLIGHTLY_UNCLEAR", measuredBand: "SLIGHTLY_UNCLEAR", flags: [] },
        passport: { status: "COMPLETE", missingFields: [], mrzLinesFound: 2, passportIdBand: "VERIFIED" },
        identity: { status: "PASSPORT_MATCH_ONLY", reviewRequired: true, provisional: false, notes: ["WHATSAPP_NOT_ON_RECORD"] },
        storage: { checksum: "NEW", placement: "PENDING", verificationStatus: null, documentStored: false, pendingCopy: true },
    },
    file: { name: "document_20260924_063000.png", mimeType: "image/png", size: null, location: "PENDING", previewUrl: `/api/admin/review/pending-${TEMP_ID}/file` },
    auditLog: [],
    actions: { approve: { available: true, code: null, message: null }, keepPending: { available: true, code: null, message: null } },
};

const auditEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    auditId: "a0000000-0000-4000-8000-000000000001",
    action: "KEEP_PENDING",
    adminId: "admin-1",
    adminName: "Test Admin",
    reason: "Waiting for a clearer photo",
    previousStatus: "MANUAL_REVIEW",
    newStatus: "MANUAL_REVIEW",
    policeSubmittedDate: null,
    documentType: null,
    previousValue: null,
    newValue: null,
    createdDate: "2026-09-25T04:30:00.000Z",
    ...overrides,
});

const APPROVE_RESULT: ApproveResult = {
    action: "APPROVE",
    reviewId: `pending-${TEMP_ID}`,
    document: { documentId: DOC_ID, storedFilename: "passport.pdf", verificationStatus: "VERIFIED", location: "CLIENT", policeSubmittedDate: null },
    pendingCopyRemoved: true,
    audit: auditEntry({ auditId: "a0000000-0000-4000-8000-000000000002", action: "APPROVE", reason: null, newStatus: "VERIFIED" }),
};

// jsdom has no object URLs; the preview only needs them to exist.
beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview-1"), revokeObjectURL: vi.fn() }));
});

const lastRequest = (calls: { path: string }[], prefix: string) => [...calls].reverse().find((c) => c.path.startsWith(prefix));
const fileResponse = { status: 200, body: "PNGDATA" };

describe("Review Queue", () => {
    test("renders items with reason, confidence, status and the category cards", async () => {
        signedInBackend({ "GET /api/admin/review": { status: 200, body: queue(TWO_ITEMS, { total: 14 }) } });
        renderApp("/review");

        const table = await screen.findByRole("table", { name: "Review queue" });
        expect(within(table).getAllByRole("row")).toHaveLength(3);
        expect(within(table).getByText("Identity not confirmed")).toBeInTheDocument();
        expect(within(table).getByText("Low confidence")).toBeInTheDocument();
        expect(within(table).getByText("71.0%")).toBeInTheDocument();
        expect(within(table).getByText("Waiting file")).toBeInTheDocument();
        expect(within(table).getByText("Stored")).toBeInTheDocument();
        expect(within(table).getByText("Review required")).toBeInTheDocument();
        expect(screen.getByText("14")).toBeInTheDocument(); // pending reviews card
        expect(screen.getByText("7")).toBeInTheDocument();  // quality card
    });

    test("loading, then data", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        signedInBackend({ "GET /api/admin/review": () => new Promise((resolve) => { release = resolve; }) });
        renderApp("/review");
        expect(await screen.findByText("Loading review queue…")).toBeInTheDocument();
        release({ status: 200, body: queue(TWO_ITEMS) });
        expect(await screen.findByRole("table", { name: "Review queue" })).toBeInTheDocument();
    });

    test("error -> retry reloads", async () => {
        let fail = true;
        signedInBackend({ "GET /api/admin/review": () => (fail ? { status: 500, body: {} } : { status: 200, body: queue(TWO_ITEMS) }) });
        renderApp("/review");
        const alert = await screen.findByRole("alert");
        fail = false;
        await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("table", { name: "Review queue" })).toBeInTheDocument();
    });

    test("empty queue -> empty state", async () => {
        signedInBackend({ "GET /api/admin/review": { status: 200, body: queue([], { total: 0 }) } });
        renderApp("/review");
        expect(await screen.findByText("Nothing waiting for review")).toBeInTheDocument();
    });

    test("filters and pagination are sent to the API", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/review": (url) => ({ status: 200, body: queue(TWO_ITEMS, { total: 60, page: Number(url.searchParams.get("page") ?? 1) }) }),
        });
        renderApp("/review");
        await screen.findByText("Page 1 of 3");
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
        expect(lastRequest(calls, "/api/admin/review")!.path).toContain("page=2");

        await user.selectOptions(screen.getByLabelText("Review reason"), "LOW_CONFIDENCE");
        let query = new URL(lastRequest(calls, "/api/admin/review")!.path, "http://x").searchParams;
        expect(query.get("reviewReason")).toBe("LOW_CONFIDENCE");
        expect(query.get("page")).toBe("1");

        await user.selectOptions(screen.getByLabelText("Source"), "DOCUMENT");
        await user.selectOptions(screen.getByLabelText("Sort"), "desc");
        query = new URL(lastRequest(calls, "/api/admin/review")!.path, "http://x").searchParams;
        expect([query.get("kind"), query.get("order"), query.get("reviewReason")]).toEqual(["DOCUMENT", "desc", "LOW_CONFIDENCE"]);
    });

    test("'Review' opens the detail page", async () => {
        signedInBackend({
            "GET /api/admin/review": { status: 200, body: queue(TWO_ITEMS) },
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: ITEM },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse,
        });
        renderApp("/review");
        await userEvent.setup().click((await screen.findAllByRole("link", { name: "Review" }))[0]);
        expect(await screen.findByText("Document information")).toBeInTheDocument();
    });
});

describe("Review Detail", () => {
    test("shows reason, identity, sender, processing details and the file preview", async () => {
        const { calls } = signedInBackend({
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: ITEM },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse,
        });
        renderApp(`/review/pending-${TEMP_ID}`);

        expect(await screen.findByRole("heading", { name: "11111111" })).toBeInTheDocument();
        expect(screen.getByRole("note")).toHaveTextContent("Identity not confirmed");
        expect(screen.getByText("94770000000")).toBeInTheDocument();
        expect(screen.getByText("The client has no WhatsApp number on record")).toBeInTheDocument();
        expect(screen.getByText("2× read used")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /KAMAL NIMAL PERERA/ })).toHaveAttribute("href", "/clients/N1234567");

        const preview = await screen.findByRole("img", { name: "Preview of document_20260924_063000.png" });
        expect(preview).toHaveAttribute("src", "blob:preview-1");
        const fileRequest = lastRequest(calls, `/api/admin/review/pending-${TEMP_ID}/file`) as unknown as { headers: Record<string, string> };
        expect(fileRequest.headers.Authorization).toBe(`Bearer ${window.sessionStorage.getItem(TOKEN_KEY)}`);
    });

    test("offers exactly Approve and Keep Pending; there is no Reject", async () => {
        signedInBackend({
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: ITEM },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse,
        });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        const buttons = within(group).getAllByRole("button");
        expect(buttons.map((b) => b.textContent)).toEqual(["Approve", "Keep Pending"]);
        buttons.forEach((button) => expect(button).toBeEnabled());
        expect(screen.queryByRole("button", { name: /reject/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/reject/i)).not.toBeInTheDocument();
    });

    test("an item without saved processing data says so", async () => {
        signedInBackend({
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: { ...ITEM, reviewReason: null, reviewCategory: null, processing: null } },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse,
        });
        renderApp(`/review/pending-${TEMP_ID}`);
        expect(await screen.findByText(/were not recorded for this item/)).toBeInTheDocument();
        expect(screen.getByRole("note")).toHaveTextContent("Not recorded");
    });

    test("preview error is shown inside the page, details still visible", async () => {
        signedInBackend({
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: ITEM },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: { status: 502, body: { message: "The file could not be loaded from storage" } },
        });
        renderApp(`/review/pending-${TEMP_ID}`);
        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
        expect(screen.getByText("Document information")).toBeInTheDocument();
    });

    test("unknown item -> not-found state", async () => {
        signedInBackend({ "GET /api/admin/review/pending-99999999-9999-4999-8999-999999999999": { status: 404, body: { message: "Review item not found" } } });
        renderApp("/review/pending-99999999-9999-4999-8999-999999999999");
        expect(await screen.findByRole("heading", { name: "Review item not found" })).toBeInTheDocument();
    });
});

describe("Review actions", () => {
    const DETAIL = `GET /api/admin/review/pending-${TEMP_ID}`;
    const APPROVE = `POST /api/admin/review/pending-${TEMP_ID}/approve`;
    const KEEP = `POST /api/admin/review/pending-${TEMP_ID}/keep-pending`;
    const posts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "POST");

    async function openDetail(routes: FetchRoutes = {}) {
        const backend = signedInBackend({ [DETAIL]: { status: 200, body: ITEM }, [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse, ...routes });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        return { ...backend, group, user: userEvent.setup() };
    }

    test("Approve asks for confirmation; Cancel sends nothing", async () => {
        const { calls, group, user } = await openDetail();
        await user.click(within(group).getByRole("button", { name: "Approve" }));
        const dialog = screen.getByRole("dialog", { name: "Approve this document?" });
        expect(dialog).toHaveTextContent("This will move the document to permanent client storage and mark it as verified.");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
    });

    test("successful approval: success message, verified status, audit entry, item leaves the queue", async () => {
        let approved = false;
        const { calls, group, user } = await openDetail({
            [APPROVE]: () => { approved = true; return { status: 200, body: APPROVE_RESULT }; },
            "GET /api/admin/review": () => ({ status: 200, body: queue(approved ? [] : [queueItem()]) }),
        });
        await user.click(within(group).getByRole("button", { name: "Approve" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));

        expect(await screen.findByRole("status")).toHaveTextContent("stored in the client folder as passport.pdf and marked as verified");
        expect(posts(calls).map((c) => c.path)).toEqual([`/api/admin/review/pending-${TEMP_ID}/approve`]);
        expect(screen.queryByRole("group", { name: "Review actions" })).not.toBeInTheDocument();
        expect(screen.getByText("This item is no longer in the Review Queue.", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("Verification status").nextElementSibling).toHaveTextContent("Verified");
        const history = screen.getByRole("list", { name: "Review history" });
        expect(within(history).getByText("Approved")).toBeInTheDocument();

        // Back in the queue, the list is fetched again and the item is gone.
        await user.click(screen.getByRole("link", { name: "Back to Review Queue" }));
        expect(await screen.findByText("Nothing waiting for review")).toBeInTheDocument();
        expect(calls.filter((c) => c.path.startsWith("/api/admin/review?") || c.path === "/api/admin/review").length).toBeGreaterThan(0);
    });

    test("while approving, both the confirm button and the page actions are disabled: one request only", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        const { calls, group, user } = await openDetail({ [APPROVE]: () => new Promise((resolve) => { release = resolve; }) });
        await user.click(within(group).getByRole("button", { name: "Approve" }));
        const dialog = screen.getByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Approve" }));

        const busy = within(dialog).getByRole("button", { name: "Approving…" });
        expect(busy).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
        within(group).getAllByRole("button").forEach((button) => expect(button).toBeDisabled());
        await user.click(busy).catch(() => {});
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(1);

        release({ status: 200, body: APPROVE_RESULT });
        expect(await screen.findByRole("status")).toHaveTextContent("Approved.");
    });

    test("a conflict is shown as the server's message and nothing is marked approved", async () => {
        const message = "This client already has a verified passport. It was not changed, and this item stays pending.";
        const { group, user } = await openDetail({ [APPROVE]: { status: 409, body: { message, code: "VERIFIED_DOCUMENT_EXISTS" } } });
        await user.click(within(group).getByRole("button", { name: "Approve" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));

        expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(message);
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(within(screen.getByRole("group", { name: "Review actions" })).getByRole("button", { name: "Approve" })).toBeEnabled();
        expect(screen.getByText("Pending storage")).toBeInTheDocument();
    });

    test("a storage failure (502) shows the server's message; other server errors a generic one", async () => {
        const { group, user } = await openDetail({ [APPROVE]: { status: 502, body: { message: "The file could not be stored in the client folder. Nothing was changed; the item stays pending." } } });
        await user.click(within(group).getByRole("button", { name: "Approve" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("could not be stored in the client folder");
    });

    test("Keep Pending requires a reason before anything is sent", async () => {
        const { calls, group, user } = await openDetail({ [KEEP]: { status: 200, body: { action: "KEEP_PENDING", reviewId: `pending-${TEMP_ID}`, audit: auditEntry() } } });
        await user.click(within(group).getByRole("button", { name: "Keep Pending" }));
        const dialog = screen.getByRole("dialog", { name: "Keep this document pending?" });
        const reason = within(dialog).getByLabelText(/Reason/);
        expect(reason).toBeRequired();

        await user.click(within(dialog).getByRole("button", { name: "Keep Pending" }));
        expect(within(dialog).getByText("Enter a reason.")).toBeInTheDocument();
        await user.type(reason, "   ");
        await user.click(within(dialog).getByRole("button", { name: "Keep Pending" }));
        expect(within(dialog).getByText("Enter a reason.")).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
    });

    test("successful Keep Pending: reason sent, item reloaded with the new audit entry, still reviewable", async () => {
        let kept = false;
        const { calls, group, user } = await openDetail({
            [DETAIL]: () => ({ status: 200, body: kept ? { ...ITEM, auditLog: [auditEntry()] } : ITEM }),
            [KEEP]: () => { kept = true; return { status: 200, body: { action: "KEEP_PENDING", reviewId: `pending-${TEMP_ID}`, audit: auditEntry() } }; },
        });
        expect(screen.getByText("No review actions yet")).toBeInTheDocument();
        await user.click(within(group).getByRole("button", { name: "Keep Pending" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText(/Reason/), "  Waiting for a clearer photo ");
        await user.click(within(dialog).getByRole("button", { name: "Keep Pending" }));

        expect(await screen.findByRole("status")).toHaveTextContent("Kept pending. The item stays in the Review Queue.");
        expect(posts(calls)[0].body).toEqual({ reason: "Waiting for a clearer photo" });
        const history = await screen.findByRole("list", { name: "Review history" });
        expect(within(history).getByText("Kept pending")).toBeInTheDocument();
        expect(within(history).getByText("Waiting for a clearer photo")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "GET" && c.path === `/api/admin/review/pending-${TEMP_ID}`)).toHaveLength(2);
        within(screen.getByRole("group", { name: "Review actions" })).getAllByRole("button").forEach((button) => expect(button).toBeEnabled());
    });

    test("Keep Pending errors are shown in the dialog", async () => {
        const { group, user } = await openDetail({ [KEEP]: { status: 409, body: { message: "You already kept this item pending with the same reason a moment ago.", code: "DUPLICATE_ACTION" } } });
        await user.click(within(group).getByRole("button", { name: "Keep Pending" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText(/Reason/), "same reason");
        await user.click(within(dialog).getByRole("button", { name: "Keep Pending" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("already kept this item pending");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    test("audit entries render action, admin, reason and time; no Reject action is ever shown", async () => {
        const entries = [
            auditEntry({ auditId: "a2", action: "APPROVE", adminName: "Second Admin", reason: null, createdDate: "2026-09-25T06:00:00.000Z" }),
            auditEntry({ auditId: "a1", adminName: "First Admin", reason: "Asked the client for a new scan", createdDate: "2026-09-25T05:00:00.000Z" }),
        ];
        signedInBackend({ [DETAIL]: { status: 200, body: { ...ITEM, auditLog: entries } }, [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse });
        renderApp(`/review/pending-${TEMP_ID}`);
        const history = await screen.findByRole("list", { name: "Review history" });
        const items = within(history).getAllByRole("listitem");
        expect(items).toHaveLength(2);
        expect(items[0]).toHaveTextContent("Approved");
        expect(items[0]).toHaveTextContent("Second Admin");
        expect(items[0]).toHaveTextContent("No reason given");
        expect(items[1]).toHaveTextContent("Kept pending");
        expect(items[1]).toHaveTextContent("First Admin");
        expect(items[1]).toHaveTextContent("Asked the client for a new scan");
        expect(within(items[1]).getByText(/2026/).tagName).toBe("TIME");
        expect(within(history).queryByText(/reject/i)).not.toBeInTheDocument();
    });

    test("when Approve isn't possible the button is disabled with the reason", async () => {
        const blocked = { ...ITEM, actions: { ...ITEM.actions!, approve: { available: false, code: "CLIENT_NOT_IDENTIFIED", message: "This file is not linked to a client, so it can't be stored in a client folder. It stays pending." } } };
        signedInBackend({ [DETAIL]: { status: 200, body: blocked }, [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        expect(within(group).getByRole("button", { name: "Approve" })).toBeDisabled();
        expect(within(group).getByRole("button", { name: "Keep Pending" })).toBeEnabled();
        expect(screen.getByText(/Approve is not available: This file is not linked to a client/)).toBeInTheDocument();
    });
});

describe("Remove from Review", () => {
    const DETAIL = `GET /api/admin/review/pending-${TEMP_ID}`;
    const REMOVE = `POST /api/admin/review/pending-${TEMP_ID}/remove`;
    const REMOVABLE: ReviewItem = { ...ITEM, actions: { ...ITEM.actions!, remove: { available: true, code: null, message: null } } };
    const removedResult = { action: "REMOVE_FROM_REVIEW", reviewId: `pending-${TEMP_ID}`, filesDeleted: true, audit: auditEntry({ auditId: "a-rm", action: "REMOVE_FROM_REVIEW", reason: "Blank page sent by mistake", newStatus: "REMOVED", documentType: "PASSPORT" }) };

    async function openRemovable(routes: FetchRoutes = {}) {
        const backend = signedInBackend({ [DETAIL]: { status: 200, body: REMOVABLE }, [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse, ...routes });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        return { ...backend, group, user: userEvent.setup() };
    }

    test("offered for a waiting file; not for items the server marks as not removable; never called Reject", async () => {
        const { group } = await openRemovable();
        expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve", "Keep Pending", "Remove from Review"]);
        expect(screen.queryByText(/reject/i)).not.toBeInTheDocument();
    });

    test("needs a reason and an explicit confirmation before anything is sent", async () => {
        const { calls, group, user } = await openRemovable({ [REMOVE]: { status: 200, body: removedResult } });
        await user.click(within(group).getByRole("button", { name: "Remove from Review" }));
        const dialog = screen.getByRole("dialog", { name: "Remove this file from review?" });
        expect(dialog).toHaveTextContent("permanently deleted");
        expect(dialog).toHaveTextContent("can't be undone");

        await user.click(within(dialog).getByRole("button", { name: "Remove permanently" }));
        expect(within(dialog).getByText("Enter the reason for removing this file.")).toBeInTheDocument();
        await user.type(within(dialog).getByLabelText(/Reason/), "Blank page sent by mistake");
        await user.click(within(dialog).getByRole("button", { name: "Remove permanently" }));
        expect(within(dialog).getByText(/Confirm that you inspected the file/)).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

        await user.click(within(dialog).getByRole("checkbox", { name: /I have inspected this file/ }));
        await user.click(within(dialog).getByRole("button", { name: "Remove permanently" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Removed from review. The file and its record were permanently deleted; the audit log entry is kept.");
        expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([[`/api/admin/review/pending-${TEMP_ID}/remove`, { reason: "Blank page sent by mistake" }]]);
        expect(screen.queryByRole("group", { name: "Review actions" })).not.toBeInTheDocument();
        expect(screen.queryByRole("img", { name: /Preview of/ })).not.toBeInTheDocument();
        expect(within(screen.getByRole("list", { name: "Review history" })).getByText("Removed from review")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Back to Review Queue" })).toHaveAttribute("href", "/review");
    });

    test("while removing, the dialog is locked and only one request is sent; errors are shown", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        const { calls, group, user } = await openRemovable({ [REMOVE]: () => new Promise((resolve) => { release = resolve; }) });
        await user.click(within(group).getByRole("button", { name: "Remove from Review" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText(/Reason/), "Duplicate");
        await user.click(within(dialog).getByRole("checkbox"));
        await user.click(within(dialog).getByRole("button", { name: "Remove permanently" }));
        const busyButton = within(dialog).getByRole("button", { name: "Removing…" });
        expect(busyButton).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
        await user.click(busyButton).catch(() => {});
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
        release({ status: 409, body: { message: "This item is no longer waiting for review. Reload the page to see its current state.", code: "ALREADY_RESOLVED" } });
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("no longer waiting for review");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
});

describe("review routes stay protected", () => {
    for (const path of ["/review", `/review/pending-${TEMP_ID}`]) {
        test(`${path} without a session -> login, no admin API call`, async () => {
            const { calls } = stubBackend({});
            renderApp(path);
            expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
            expect(calls.filter((c) => c.path.startsWith("/api/admin"))).toHaveLength(0);
        });
    }
});

describe("Corrections: set document type and assign client", () => {
    const DETAIL = `GET /api/admin/review/pending-${TEMP_ID}`;
    const CORRECTABLE: ReviewItem = {
        ...ITEM,
        client: null,
        document: { ...ITEM.document, documentType: "UNKNOWN" },
        actions: {
            ...ITEM.actions!,
            approve: { available: false, code: "CLIENT_NOT_IDENTIFIED", message: "This file is not linked to a client, so it can't be stored in a client folder. It stays pending." },
            remove: { available: true, code: null, message: null },
            setDocumentType: { available: true, code: null, message: null },
            assignClient: { available: true, code: null, message: null },
        },
    };
    const CLIENTS = {
        items: [
            { client: { passportId: "N7654321", uniqueId: "0002", name: "SAMAN SILVA", whatsappNumber: null }, completion: "INCOMPLETE", requirements: [], missingDocumentTypes: [] },
        ],
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
        summary: { total: 1, complete: 0, incomplete: 1, withMissing: 0, missingDocuments: 0, missingByType: {} },
        requiredDocumentTypes: ["PASSPORT", "POLICE_REPORT", "MEDICAL"],
    };

    async function open(item: ReviewItem, routes: FetchRoutes = {}) {
        const backend = signedInBackend({ [DETAIL]: { status: 200, body: item }, [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse, "GET /api/admin/clients": { status: 200, body: CLIENTS }, ...routes });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        return { ...backend, group, user: userEvent.setup() };
    }

    test("offered for a waiting file only; never a Reject", async () => {
        const { group } = await open(CORRECTABLE);
        expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve", "Keep Pending", "Set Document Type", "Assign Client", "Remove from Review"]);
        expect(screen.queryByText(/reject/i)).not.toBeInTheDocument();
    });

    test("not offered when the server says the item can't be corrected (stored document)", async () => {
        const stored = { ...CORRECTABLE, actions: { ...CORRECTABLE.actions!, setDocumentType: { available: false, code: "NOT_CORRECTABLE", message: "x" }, assignClient: { available: false, code: "NOT_CORRECTABLE", message: "x" }, remove: { available: false, code: "NOT_REMOVABLE", message: "x" } } };
        const { group } = await open(stored);
        expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve", "Keep Pending"]);
    });

    test("Set Document Type: type and reason required; sent; item reloaded, still pending", async () => {
        let type = "UNKNOWN";
        const { calls, group, user } = await open(CORRECTABLE, {
            [DETAIL]: () => ({ status: 200, body: { ...CORRECTABLE, document: { ...CORRECTABLE.document, documentType: type } } }),
            [`POST /api/admin/review/pending-${TEMP_ID}/document-type`]: () => {
                type = "MEDICAL";
                return { status: 200, body: { action: "SET_DOCUMENT_TYPE", reviewId: `pending-${TEMP_ID}`, documentType: "MEDICAL", audit: auditEntry({ action: "SET_DOCUMENT_TYPE", previousValue: "UNKNOWN", newValue: "MEDICAL" }) } };
            },
        });
        await user.click(within(group).getByRole("button", { name: "Set Document Type" }));
        const dialog = screen.getByRole("dialog", { name: "Set the document type" });
        expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose…", "Passport", "Police slip", "Police report", "Medical"]);
        await user.click(within(dialog).getByRole("button", { name: "Set type" }));
        expect(within(dialog).getByText("Choose the document type.")).toBeInTheDocument();
        await user.selectOptions(within(dialog).getByLabelText(/Document type/), "MEDICAL");
        await user.click(within(dialog).getByRole("button", { name: "Set type" }));
        expect(within(dialog).getByText("Enter a reason.")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

        await user.type(within(dialog).getByLabelText(/Reason/), "Content is a medical report");
        await user.click(within(dialog).getByRole("button", { name: "Set type" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Document type set to Medical. The file stays pending");
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ documentType: "MEDICAL", reason: "Content is a medical report" }]);
        await screen.findByText("Medical", { selector: "dd" });
        expect(calls.filter((c) => c.path === `/api/admin/review/pending-${TEMP_ID}`).length).toBe(2); // reloaded
        expect(screen.getByRole("group", { name: "Review actions" })).toBeInTheDocument();
    });

    test("Assign Client: only an existing client from the search, reason and confirmation required", async () => {
        const { calls, group, user } = await open(CORRECTABLE, {
            [`POST /api/admin/review/pending-${TEMP_ID}/assign-client`]: { status: 200, body: { action: "ASSIGN_CLIENT", reviewId: `pending-${TEMP_ID}`, client: { passportId: "N7654321", uniqueId: "0002" }, audit: auditEntry({ action: "ASSIGN_CLIENT", newValue: "N7654321" }) } },
        });
        await user.click(within(group).getByRole("button", { name: "Assign Client" }));
        const dialog = screen.getByRole("dialog", { name: "Assign this file to a client" });
        expect(dialog).toHaveTextContent("no client is created");
        await user.click(within(dialog).getByRole("button", { name: "Assign client" }));
        expect(within(dialog).getByText("Choose an existing client.")).toBeInTheDocument();

        await user.type(within(dialog).getByLabelText("Find the client"), "silva");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        const option = await within(dialog).findByRole("radio", { name: /SAMAN SILVA/ });
        expect(calls.find((c) => c.path.startsWith("/api/admin/clients"))?.path).toBe("/api/admin/clients?search=silva&pageSize=10");
        await user.click(option);
        await user.type(within(dialog).getByLabelText(/Reason/), "Client confirmed by phone");
        await user.click(within(dialog).getByRole("button", { name: "Assign client" }));
        expect(within(dialog).getByText(/Confirm that this file belongs/)).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

        await user.click(within(dialog).getByRole("checkbox", { name: /belongs to SAMAN SILVA \(N7654321\)/ }));
        await user.click(within(dialog).getByRole("button", { name: "Assign client" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Assigned to SAMAN SILVA (N7654321)");
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ passportId: "N7654321", reason: "Client confirmed by phone" }]);
    });

    test("Assign Client: no match says only existing clients can be assigned", async () => {
        const { group, user } = await open(CORRECTABLE, { "GET /api/admin/clients": { status: 200, body: { ...CLIENTS, items: [] } } });
        await user.click(within(group).getByRole("button", { name: "Assign Client" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText("Find the client"), "nobody{Enter}");
        expect(await within(dialog).findByText(/Only existing clients can be assigned/)).toBeInTheDocument();
    });

    test("audit entries show the corrected values", async () => {
        const item = { ...CORRECTABLE, auditLog: [
            auditEntry({ auditId: "a-2", action: "ASSIGN_CLIENT", previousValue: null, newValue: "N7654321" }),
            auditEntry({ auditId: "a-1", action: "SET_DOCUMENT_TYPE", previousValue: "UNKNOWN", newValue: "MEDICAL" }),
        ] };
        await open(item);
        const history = screen.getByRole("list", { name: "Review history" });
        expect(within(history).getByText("Client assigned")).toBeInTheDocument();
        expect(within(history).getByText("Client: not identified → N7654321")).toBeInTheDocument();
        expect(within(history).getByText("Type: Unknown → Medical")).toBeInTheDocument();
    });
});

describe("Remove from Review for a stored REVIEW_REQUIRED document (H4)", () => {
    const DETAIL = `GET /api/admin/review/document-${DOC_ID}`;
    const STUCK: ReviewItem = {
        ...ITEM,
        reviewId: `document-${DOC_ID}`,
        kind: "DOCUMENT",
        reviewReason: "LOW_CONFIDENCE",
        document: { ...ITEM.document, documentId: DOC_ID, verificationStatus: "REVIEW_REQUIRED", processingStatus: "STORED" },
        file: { ...ITEM.file, location: "CLIENT", previewUrl: `/api/admin/review/document-${DOC_ID}/file` },
        actions: {
            approve: { available: false, code: "VERIFIED_DOCUMENT_EXISTS", message: "This client already has a verified passport. It was not changed, and this item stays pending." },
            keepPending: { available: true, code: null, message: null },
            remove: { available: true, code: null, message: null },
            setDocumentType: { available: false, code: "NOT_CORRECTABLE", message: "x" },
            assignClient: { available: false, code: "NOT_CORRECTABLE", message: "x" },
        },
    };

    test("the stuck item offers Remove from Review; the dialog says only this document is deleted; the request goes to the document", async () => {
        const removed = { action: "REMOVE_FROM_REVIEW", reviewId: `document-${DOC_ID}`, filesDeleted: true, audit: auditEntry({ auditId: "a-rm-doc", action: "REMOVE_FROM_REVIEW", reason: "Blurry duplicate", newStatus: "REMOVED", documentType: "PASSPORT" }) };
        const { calls } = signedInBackend({
            [DETAIL]: { status: 200, body: STUCK },
            [`GET /api/admin/review/document-${DOC_ID}/file`]: fileResponse,
            [`POST /api/admin/review/document-${DOC_ID}/remove`]: { status: 200, body: removed },
        });
        renderApp(`/review/document-${DOC_ID}`);
        const user = userEvent.setup();
        const group = await screen.findByRole("group", { name: "Review actions" });
        expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Approve", "Keep Pending", "Remove from Review"]);
        expect(within(group).getByRole("button", { name: "Approve" })).toBeDisabled();

        await user.click(within(group).getByRole("button", { name: "Remove from Review" }));
        const dialog = screen.getByRole("dialog", { name: "Remove this file from review?" });
        expect(dialog).toHaveTextContent("This stored document and its file in the client folder are permanently deleted");
        expect(dialog).toHaveTextContent("including any verified one, are not changed");
        await user.type(within(dialog).getByLabelText(/Reason/), "Blurry duplicate");
        await user.click(within(dialog).getByRole("checkbox", { name: /I have inspected this file/ }));
        await user.click(within(dialog).getByRole("button", { name: "Remove permanently" }));

        expect(await screen.findByRole("status")).toHaveTextContent("Removed from review.");
        expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([[`/api/admin/review/document-${DOC_ID}/remove`, { reason: "Blurry duplicate" }]]);
        expect(screen.queryByRole("group", { name: "Review actions" })).not.toBeInTheDocument();
    });

    test("a waiting file keeps its own wording", async () => {
        signedInBackend({
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: { ...ITEM, actions: { ...ITEM.actions!, remove: { available: true, code: null, message: null } } } },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse,
        });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        await userEvent.setup().click(within(group).getByRole("button", { name: "Remove from Review" }));
        expect(screen.getByRole("dialog")).toHaveTextContent("The file, its original copy and its submission record are permanently deleted");
    });
});
