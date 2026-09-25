import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ReviewItem, ReviewQueue, ReviewQueueItem } from "../api/admin";
import { CLIENT_REF, TOKEN_KEY, renderApp, signedInBackend, stubBackend } from "./helpers";

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
    document: { documentId: null, temporaryId: TEMP_ID, documentType: "PASSPORT", processingStatus: "MANUAL_REVIEW", verificationStatus: null, receivedDate: "2026-09-24T01:00:00.000Z", confidence: 71 },
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

    test("review action buttons are shown but disabled and never call the API", async () => {
        const { calls } = signedInBackend({
            [`GET /api/admin/review/pending-${TEMP_ID}`]: { status: 200, body: ITEM },
            [`GET /api/admin/review/pending-${TEMP_ID}/file`]: fileResponse,
        });
        renderApp(`/review/pending-${TEMP_ID}`);
        const group = await screen.findByRole("group", { name: "Review actions" });
        const buttons = within(group).getAllByRole("button");
        expect(buttons.map((b) => b.textContent)).toEqual(["Approve / Verify", "Reject", "Keep pending"]);
        for (const button of buttons) {
            expect(button).toBeDisabled();
            await userEvent.setup().click(button).catch(() => {});
        }
        expect(calls.every((c) => c.method === "GET")).toBe(true);
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
