import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import {
    CLIENT_DETAILS,
    OVERVIEW,
    TOKEN_KEY,
    documentList,
    fakeJwt,
    makeDocument,
    renderApp,
    signedInBackend,
    stubBackend,
} from "./helpers";

const lastRequest = (calls: { path: string }[], prefix: string) => [...calls].reverse().find((c) => c.path.startsWith(prefix));

describe("Overview", () => {
    test("renders KPIs, summaries, recent documents and the review queue from the API", async () => {
        const { calls } = signedInBackend();
        renderApp("/");

        expect(await screen.findByText("1,428")).toBeInTheDocument();
        expect(screen.getByText("8,942")).toBeInTheDocument();
        expect(screen.getByText("42")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Review queue — 17 items" })).toBeInTheDocument();
        expect(screen.getByText("Document processing statuses")).toBeInTheDocument();
        expect(screen.getByText("(75.0%)")).toBeInTheDocument(); // 30 of 40 verified

        const recent = screen.getByRole("table", { name: "Recent documents" });
        expect(within(recent).getAllByRole("row")).toHaveLength(3);
        expect(within(recent).getByText("3F2B8C1E")).toBeInTheDocument();
        expect(within(recent).getByText("52.3%")).toBeInTheDocument();
        expect(within(recent).getAllByText("KAMAL NIMAL PERERA")).toHaveLength(2);

        const queue = screen.getByRole("table", { name: "Latest files waiting for review" });
        expect(within(queue).getByText("Police slip")).toBeInTheDocument();
        expect(within(queue).getByText("Manual review")).toBeInTheDocument();

        const request = lastRequest(calls, "/api/admin/overview")!;
        expect((request as unknown as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${window.sessionStorage.getItem(TOKEN_KEY)}`);
    });

    test("shows a loading state first", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        signedInBackend({ "GET /api/admin/overview": () => new Promise((resolve) => { release = resolve; }) });
        renderApp("/");
        expect(await screen.findByText("Loading overview…")).toBeInTheDocument();
        release({ status: 200, body: OVERVIEW });
        expect(await screen.findByText("1,428")).toBeInTheDocument();
    });

    test("server error -> error state with a retry that reloads", async () => {
        let fail = true;
        signedInBackend({ "GET /api/admin/overview": () => (fail ? { status: 500, body: { message: "boom" } } : { status: 200, body: OVERVIEW }) });
        renderApp("/");

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Something went wrong. Please try again.");
        fail = false;
        await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("1,428")).toBeInTheDocument();
    });

    test("empty data -> empty states instead of blank tables", async () => {
        signedInBackend({
            "GET /api/admin/overview": {
                status: 200,
                body: { ...OVERVIEW, submissionsByStatus: {}, submissionsByType: {}, recentDocuments: [], reviewQueue: { total: 0, pendingFiles: 0, reviewRequiredDocuments: 0, pendingByStatus: {}, items: [] } },
            },
        });
        renderApp("/");
        expect(await screen.findByText("No documents stored yet")).toBeInTheDocument();
        expect(screen.getByText("Nothing waiting for review")).toBeInTheDocument();
        expect(screen.getAllByText("No submissions yet")).toHaveLength(2);
    });

    test("a 401 from the API (session ended) signs the admin out", async () => {
        signedInBackend({ "GET /api/admin/overview": { status: 401, body: { message: "Invalid or Expired Token" } } });
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });
});

describe("Documents", () => {
    const TWO_DOCS = [makeDocument(), makeDocument({ documentId: "9a1d0000-0000-4000-8000-000000000002", documentType: "MEDICAL", verificationStatus: "REVIEW_REQUIRED", ocrConfidence: null })];

    test("renders the returned documents with badges, confidence and chip counts", async () => {
        signedInBackend({ "GET /api/admin/documents": { status: 200, body: documentList(TWO_DOCS, { total: 2 }) } });
        renderApp("/documents");

        const table = await screen.findByRole("table", { name: "Documents" });
        expect(within(table).getAllByRole("row")).toHaveLength(3);
        expect(within(table).getByText("Review required")).toBeInTheDocument();
        expect(within(table).getByText("97.5%")).toBeInTheDocument();
        expect(within(table).getByText("—", { selector: "span" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Verified (1)" })).toBeInTheDocument();
        expect(screen.getByText("Showing 1–2 of 2")).toBeInTheDocument();
    });

    test("filters and sorting are sent to the API and reset the page", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/documents": { status: 200, body: documentList(TWO_DOCS, { total: 60, page: 2 }) } });
        renderApp("/documents?page=2");
        await screen.findByRole("table", { name: "Documents" });
        expect(lastRequest(calls, "/api/admin/documents")!.path).toContain("page=2");

        const user = userEvent.setup();
        await user.selectOptions(screen.getByLabelText("Document type"), "MEDICAL");
        let query = new URL(lastRequest(calls, "/api/admin/documents")!.path, "http://x").searchParams;
        expect(query.get("documentType")).toBe("MEDICAL");
        expect(query.get("page")).toBe("1");

        await user.click(screen.getByRole("button", { name: /^Review required/ }));
        query = new URL(lastRequest(calls, "/api/admin/documents")!.path, "http://x").searchParams;
        expect(query.get("verificationStatus")).toBe("REVIEW_REQUIRED");

        await user.selectOptions(screen.getByLabelText("Sort"), "ocrConfidence:asc");
        query = new URL(lastRequest(calls, "/api/admin/documents")!.path, "http://x").searchParams;
        expect([query.get("sort"), query.get("order")]).toEqual(["ocrConfidence", "asc"]);

        await user.type(screen.getByLabelText("Search documents"), "perera");
        await user.click(screen.getByRole("button", { name: "Search" }));
        query = new URL(lastRequest(calls, "/api/admin/documents")!.path, "http://x").searchParams;
        expect(query.get("search")).toBe("perera");
        expect(query.get("documentType")).toBe("MEDICAL");
    });

    test("pagination: Next and Previous request the neighbouring pages", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/documents": (url) => {
                const page = Number(url.searchParams.get("page") ?? 1);
                return { status: 200, body: documentList(TWO_DOCS, { total: 60, page }) };
            },
        });
        renderApp("/documents");
        await screen.findByText("Page 1 of 3");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
        expect(lastRequest(calls, "/api/admin/documents")!.path).toContain("page=2");

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    });

    test("no results -> empty state with a reset", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/documents": { status: 200, body: documentList([], { total: 0 }) } });
        renderApp("/documents?documentType=MEDICAL");
        expect(await screen.findByText("No documents match the selected criteria")).toBeInTheDocument();
        await userEvent.setup().click(screen.getAllByRole("button", { name: "Reset all filters" })[0]);
        expect(lastRequest(calls, "/api/admin/documents")!.path).not.toContain("documentType");
    });

    test("error -> error state", async () => {
        signedInBackend({ "GET /api/admin/documents": { status: 400, body: { message: "Invalid query parameters" } } });
        renderApp("/documents");
        expect(await screen.findByRole("alert")).toHaveTextContent("Invalid query parameters");
    });

    test("'View client' opens the client's details page", async () => {
        signedInBackend({
            "GET /api/admin/documents": { status: 200, body: documentList([makeDocument()]) },
            "GET /api/admin/clients/N1234567": { status: 200, body: CLIENT_DETAILS },
        });
        renderApp("/documents");
        await userEvent.setup().click(await screen.findByRole("link", { name: "View client" }));
        expect(await screen.findByRole("heading", { name: "KAMAL NIMAL PERERA" })).toBeInTheDocument();
    });
});

describe("Client details", () => {
    test("loads the client from the URL and shows profile, requirements, police and documents", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/clients/N1234567": { status: 200, body: CLIENT_DETAILS } });
        renderApp("/clients/N1234567");

        expect(await screen.findByRole("heading", { name: "KAMAL NIMAL PERERA" })).toBeInTheDocument();
        expect(lastRequest(calls, "/api/admin/clients/")!.path).toBe("/api/admin/clients/N1234567");
        expect(screen.getByText("Missing: Medical")).toBeInTheDocument();
        expect(screen.getByText("Missing")).toBeInTheDocument();
        expect(screen.getByText("12 Mar 1990")).toBeInTheDocument();
        expect(screen.getByText("Not received")).toBeInTheDocument(); // police slip
        expect(screen.getByText("The 21-day follow-up for police reports is added in Phase 9.")).toBeInTheDocument();
        expect(within(screen.getByRole("table", { name: "Submitted documents" })).getAllByRole("row")).toHaveLength(3);
        expect(screen.getByRole("heading", { name: "Waiting for review" })).toBeInTheDocument();
    });

    test("unknown client -> not-found state", async () => {
        signedInBackend({ "GET /api/admin/clients/X9999999": { status: 404, body: { message: "Client not found" } } });
        renderApp("/clients/X9999999");
        expect(await screen.findByRole("heading", { name: "Client not found" })).toBeInTheDocument();
        expect(screen.getByText("No client has the passport ID X9999999.")).toBeInTheDocument();
    });

    test("server error -> error state with retry", async () => {
        signedInBackend({ "GET /api/admin/clients/N1234567": { status: 503, body: {} } });
        renderApp("/clients/N1234567");
        expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    });
});

describe("protected routes stay protected", () => {
    for (const path of ["/", "/documents", "/documents?page=2", "/clients/N1234567"]) {
        test(`${path} without a session -> login, no admin API call`, async () => {
            const { calls } = stubBackend({});
            renderApp(path);
            expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
            expect(calls.filter((c) => c.path.startsWith("/api/admin"))).toHaveLength(0);
        });
    }

    test("an expired stored token never reaches the admin API", async () => {
        window.sessionStorage.setItem(TOKEN_KEY, fakeJwt(-5));
        const { calls } = stubBackend({});
        renderApp("/clients/N1234567");
        expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(calls).toHaveLength(0);
    });
});
