import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CLIENT_DETAILS, OVERVIEW, documentList, makeDocument, renderApp, signedInBackend, stubBackend, SESSION_TOKEN, fakeAuth, renderAppSignedIn, RENDER_STEP, userWithRole, type FetchRoutes } from "./helpers";

const lastRequest = (calls: { path: string }[], prefix: string) => [...calls].reverse().find((c) => c.path.startsWith(prefix));

// The role-scoped Overview tab (GET /api/admin/overview). Synthetic figures only.
const ZERO_OVERVIEW = {
    ...OVERVIEW,
    overview: {
        activeAllocated: 0, jobAllocated: 0, policeReportsYetToReceive: { total: 0, byVariant: { ROMANIA: 0, SL_VERIFIED: 0 } },
        agreementsYetToReceive: 0, detailsNotCompleted: 0, newlyAllocated: 0, visaSubmissionCompleted: 0,
    },
    daily: { formSubmissions: 0, newlyAllocated: 0, callsTaken: 0 },
};
const OVERVIEW_LABELS = ["Active Allocated Candidates", "Job Allocated Candidates", "Police reports", "Agreements", "Candidate details", "Newly allocated", "Visa submission completed"];
const DAILY_LABELS = ["Form submissions", "New allocated candidates", "Calls taken"];
// A card's big number: the paragraph right after the card's label.
const cardValue = (label: string) => screen.getByText(label, { selector: "p" }).nextElementSibling?.textContent;
const overviewCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/admin/overview"));
const viewParam = (path: string) => new URL(path, "http://x").searchParams.get("view");
const asRole = (role: string, body: unknown, routes: FetchRoutes = {}) =>
    signedInBackend({ "GET /auth/me": { status: 200, body: { user: userWithRole(role) } }, "GET /api/admin/overview": { status: 200, body }, ...routes });

describe("Overview", () => {
    test("renders the 7 Overview cards and the 3 Daily cards from the API", async () => {
        const { calls } = signedInBackend();
        renderApp("/");

        expect(await screen.findByText("1,428")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Overview", level: 2 })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Daily Overview", level: 2 })).toBeInTheDocument();
        expect(screen.getByText("Today's updates · 25 Sept 2026")).toBeInTheDocument();
        expect(screen.getByText("Welcome, Test Admin. Current figures; Sri Lanka time.")).toBeInTheDocument();

        expect(OVERVIEW_LABELS.map(cardValue)).toEqual(["1,428", "312", "57", "44", "91", "13", "208"]);
        expect(DAILY_LABELS.map(cardValue)).toEqual(["27", "9", "64"]);
        expect(screen.getByText("Yet to receive · Romania 21 · SL 36")).toBeInTheDocument();
        expect(screen.getByText("Yet to receive (job allocated only)")).toBeInTheDocument();
        expect(screen.getByText("Visa Submission stage completed")).toBeInTheDocument();

        const request = overviewCalls(calls).at(-1)!;
        expect((request as unknown as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
        expect(viewParam(request.path)).toBeNull(); // an Admin sends no view
    });

    test("zeros are shown as 0 on every card", async () => {
        signedInBackend({ "GET /api/admin/overview": { status: 200, body: ZERO_OVERVIEW } });
        renderApp("/");
        await screen.findByText("Active Allocated Candidates");
        expect([...OVERVIEW_LABELS, ...DAILY_LABELS].map(cardValue)).toEqual(Array(10).fill("0"));
        expect(screen.getByText("Yet to receive · Romania 0 · SL 0")).toBeInTheDocument();
    });

    test("only the new cards: no client text, no Monthly overview, no old dashboard cards or links", async () => {
        signedInBackend();
        renderApp("/");
        await screen.findByText("1,428");
        const page = screen.getByRole("heading", { name: "Overview", level: 1 }).closest("section")!;
        expect(page.textContent).not.toMatch(/client/i);
        for (const el of page.querySelectorAll("[aria-label]")) expect(el.getAttribute("aria-label")).not.toMatch(/client/i);
        for (const gone of ["Monthly overview", "Client documents", "Total clients", "Total documents", "Pending review", "Received today", "Recent documents", "Document processing statuses", "Review queue", "Police due", "Daily Report"]) {
            expect(within(page).queryByText(gone, { exact: false }), gone).toBeNull();
        }
        expect(within(page).queryByRole("button", { name: "Monthly overview" })).toBeNull();
        expect(within(page).queryAllByRole("link")).toHaveLength(0);
        expect(within(page).queryAllByRole("table")).toHaveLength(0);
        expect(within(page).queryByRole("group", { name: "Overview view" })).toBeNull(); // Admin: no choice
    });

    test("Team Lead: My Overview by default; Full Overview requests view=full", async () => {
        const mine = { ...OVERVIEW, view: "mine", canChooseView: true };
        const full = { ...OVERVIEW, view: "full", canChooseView: true, overview: { ...OVERVIEW.overview, activeAllocated: 5000 } };
        const { calls } = asRole("TEAM_LEAD", mine, {
            "GET /api/admin/overview": (url: URL) => ({ status: 200, body: url.searchParams.get("view") === "full" ? full : mine }),
        });
        renderApp("/");
        expect(await screen.findByText("1,428")).toBeInTheDocument();
        const chooser = screen.getByRole("group", { name: "Overview view" });
        expect(within(chooser).getByRole("button", { name: "My Overview" })).toHaveAttribute("aria-pressed", "true");
        expect(within(chooser).getByRole("button", { name: "Full Overview" })).toHaveAttribute("aria-pressed", "false");
        expect(overviewCalls(calls).map((c) => viewParam(c.path))).toEqual(["mine"]);

        await userEvent.setup().click(within(chooser).getByRole("button", { name: "Full Overview" }));
        expect(await screen.findByText("5,000")).toBeInTheDocument();
        expect(viewParam(overviewCalls(calls).at(-1)!.path)).toBe("full");
        expect(within(screen.getByRole("group", { name: "Overview view" })).getByRole("button", { name: "Full Overview" })).toHaveAttribute("aria-pressed", "true");
    });

    test("Team Lead: while Full Overview loads, My Overview's figures are not shown under it", async () => {
        const mine = { ...OVERVIEW, view: "mine", canChooseView: true };
        const full = { ...OVERVIEW, view: "full", canChooseView: true, overview: { ...OVERVIEW.overview, activeAllocated: 5000 } };
        let release: (value: { status: number; body: unknown }) => void = () => {};
        asRole("TEAM_LEAD", mine, {
            "GET /api/admin/overview": (url: URL) =>
                url.searchParams.get("view") === "full" ? new Promise((resolve) => { release = resolve; }) : { status: 200, body: mine },
        });
        renderApp("/");
        expect(await screen.findByText("1,428")).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole("button", { name: "Full Overview" }));
        expect(await screen.findByText("Loading overview…")).toBeInTheDocument();
        expect(screen.queryByText("1,428")).toBeNull();
        expect(screen.queryByText("Active Allocated Candidates")).toBeNull();
        release({ status: 200, body: full });
        expect(await screen.findByText("5,000")).toBeInTheDocument();
        expect(screen.queryByText("Loading overview…")).toBeNull();
    });

    test("Team Lead: a failed Full Overview shows the error with a retry, not My Overview's figures", async () => {
        const mine = { ...OVERVIEW, view: "mine", canChooseView: true };
        const full = { ...OVERVIEW, view: "full", canChooseView: true, overview: { ...OVERVIEW.overview, activeAllocated: 5000 } };
        let fail = true;
        const { calls } = asRole("TEAM_LEAD", mine, {
            "GET /api/admin/overview": (url: URL) =>
                url.searchParams.get("view") === "full" ? (fail ? { status: 500, body: { message: "boom" } } : { status: 200, body: full }) : { status: 200, body: mine },
        });
        renderApp("/");
        expect(await screen.findByText("1,428")).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Full Overview" }));
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Something went wrong. Please try again.");
        expect(screen.queryByText("1,428")).toBeNull();
        expect(screen.queryByText("Active Allocated Candidates")).toBeNull();
        // The choice stays visible and on Full Overview, so the Team Lead can retry or switch back.
        expect(screen.getByRole("button", { name: "Full Overview" })).toHaveAttribute("aria-pressed", "true");
        fail = false;
        await user.click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("5,000")).toBeInTheDocument();
        expect(viewParam(overviewCalls(calls).at(-1)!.path)).toBe("full");
    });

    test("Analyst: no view choice and never sends a view", async () => {
        const { calls } = asRole("ANALYST", { ...OVERVIEW, view: "mine", canChooseView: false });
        renderApp("/");
        expect(await screen.findByText("1,428")).toBeInTheDocument();
        expect(screen.queryByRole("group", { name: "Overview view" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Full Overview" })).toBeNull();
        expect(overviewCalls(calls).map((c) => viewParam(c.path))).toEqual([null]);
    });

    test("Refresh reloads the figures", async () => {
        const { calls } = signedInBackend();
        renderApp("/");
        await screen.findByText("1,428");
        const before = overviewCalls(calls).length;
        await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect(overviewCalls(calls).length).toBe(before + 1));
    });

    test("shows a loading state first", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        signedInBackend({ "GET /api/admin/overview": () => new Promise((resolve) => { release = resolve; }) });
        await renderAppSignedIn("/");
        expect(await screen.findByText("Loading overview…", {}, RENDER_STEP)).toBeInTheDocument();
        release({ status: 200, body: OVERVIEW });
        expect(await screen.findByText("1,428", {}, RENDER_STEP)).toBeInTheDocument();
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

    test("a 401 from the API (session ended) signs the admin out", async () => {
        signedInBackend({ "GET /api/admin/overview": { status: 401, body: { message: "Invalid or Expired Token" } } });
        renderApp("/");
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
        expect(fakeAuth.currentSession).toBeNull();
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
        // Checkpoint 5: the 21-day follow-up (a verified police report completes it).
        const followUp = screen.getByRole("group", { name: "Police report follow-up" });
        expect(followUp).toHaveTextContent("Completed");
        expect(followUp).toHaveTextContent("A verified police report is on file.");
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
            expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
            expect(calls.filter((c) => c.path.startsWith("/api/admin"))).toHaveLength(0);
        });
    }

    test("a stored session the backend no longer accepts never reaches the admin API", async () => {
        fakeAuth.setSession(SESSION_TOKEN);
        const { calls } = stubBackend({ "GET /auth/me": { status: 401, body: { message: "Invalid or Expired Token" } } });
        renderApp("/clients/N1234567");
        expect(await screen.findByRole("heading", { name: "Sign in to EMOPS" })).toBeInTheDocument();
        expect(calls.map((c) => c.path)).toEqual(["/auth/me"]);
        expect(fakeAuth.currentSession).toBeNull();
    });
});
