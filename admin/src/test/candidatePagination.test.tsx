import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList, type CandidateListItem } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, renderAppSignedIn, signedInBackend } from "./helpers";

// Candidates page: server-side paging, 100 a page. Synthetic candidates only;
// the backend is a stub that pages like the real one (the API's own rules
// are in test/candidateListPagination.test.js).

const PAGE_SIZE = 100;
const candidate = (n: number): CandidateListItem => ({
    passportId: `P${String(n).padStart(7, "0")}`,
    uniqueId: String(n).padStart(4, "0"),
    name: `CANDIDATE ${n}`,
    nic: null,
    jobTypes: ["Driver"],
    stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })),
});

// Like the server: newest (highest number) first, one page at a time.
function pageOf(total: number, page: number): CandidateList {
    const all = Array.from({ length: total }, (_, i) => candidate(total - i));
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return {
        items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        pagination: { page, pageSize: PAGE_SIZE, total, totalItems: total, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
        filters: { search: null },
    };
}
const pagedBackend = (total: number, extra = {}) => signedInBackend({
    "GET /api/admin/candidates": (url) => ({ status: 200, body: pageOf(total, Number(url.searchParams.get("page") ?? "1")) }),
    ...extra,
});
const rows = () => within(screen.getByRole("table", { name: "Candidates" })).getAllByRole("row").slice(1);
const pager = () => within(screen.getByRole("navigation", { name: "Pagination" }));
const listRequests = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/admin/candidates?")).map((c) => c.path);

describe("Candidates page: server-side paging", () => {
    test("1-2, 5-6. loads page 1 only: the first 100 candidates; Page 1 of 3; Previous disabled", async () => {
        const { calls } = pagedBackend(247);
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        expect(listRequests(calls)).toEqual(["/api/admin/candidates?page=1&pageSize=100"]);
        expect(rows()).toHaveLength(100);
        expect(screen.getByRole("link", { name: "CANDIDATE 247" })).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "CANDIDATE 147" })).toBeNull();
        expect(pager().getByText("Page 1 of 3")).toBeInTheDocument();
        expect(pager().getByText("247 candidates")).toBeInTheDocument();
        expect(pager().getByRole("button", { name: "Previous" })).toBeDisabled();
        expect(pager().getByRole("button", { name: "Next" })).toBeEnabled();
    });

    test("3-4, 7, 14. Next loads page 2 (and puts it in the URL); the last page disables Next; Previous goes back", async () => {
        const { calls } = pagedBackend(247);
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        const user = userEvent.setup();

        await user.click(pager().getByRole("button", { name: "Next" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 147" })).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "CANDIDATE 247" })).toBeNull();
        expect(rows()).toHaveLength(100);
        expect(pager().getByText("Page 2 of 3")).toBeInTheDocument();
        expect(listRequests(calls).at(-1)).toBe("/api/admin/candidates?page=2&pageSize=100");

        await user.click(pager().getByRole("button", { name: "Next" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 47" })).toBeInTheDocument();
        expect(rows()).toHaveLength(47);
        expect(pager().getByText("Page 3 of 3")).toBeInTheDocument();
        expect(pager().getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(pager().getByRole("button", { name: "Previous" }));
        await user.click(await screen.findByRole("button", { name: "Previous" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 247" })).toBeInTheDocument();
        expect(pager().getByText("Page 1 of 3")).toBeInTheDocument();
        expect(listRequests(calls)).toEqual([1, 2, 3, 2, 1].map((p) => `/api/admin/candidates?page=${p}&pageSize=100`));
    });

    test("14. ?page=2 in the URL opens page 2 directly (a reload keeps the page)", async () => {
        const { calls } = pagedBackend(247);
        renderApp("/candidates?page=2");
        expect(await screen.findByRole("link", { name: "CANDIDATE 147" })).toBeInTheDocument();
        expect(listRequests(calls)).toEqual(["/api/admin/candidates?page=2&pageSize=100"]);
        expect(pager().getByText("Page 2 of 3")).toBeInTheDocument();
    });

    test("8. while the next page loads, the current rows stay dimmed with a loading note", async () => {
        let release: (() => void) | null = null;
        signedInBackend({
            "GET /api/admin/candidates": (url) => {
                const page = Number(url.searchParams.get("page"));
                return page === 2
                    ? new Promise((resolve) => { release = () => resolve({ status: 200, body: pageOf(247, 2) }); })
                    : { status: 200, body: pageOf(247, page) };
            },
        });
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        await userEvent.setup().click(pager().getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Loading page…", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("table", { name: "Candidates" }).closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
        release!();
        expect(await screen.findByRole("link", { name: "CANDIDATE 147" })).toBeInTheDocument();
        expect(screen.queryByText("Loading page…")).toBeNull();
    });

    test("8. the first load shows the loading state", async () => {
        signedInBackend({ "GET /api/admin/candidates": () => new Promise(() => {}) });
        await renderAppSignedIn("/candidates");
        expect(await screen.findByText("Loading candidates…", {}, RENDER_STEP)).toBeInTheDocument();
    });

    test("9. an API error shows the error state, not stale rows; Try again loads the page", async () => {
        let failing = true;
        signedInBackend({ "GET /api/admin/candidates": (url) => (failing ? { status: 503, body: {} } : { status: 200, body: pageOf(247, Number(url.searchParams.get("page"))) }) });
        renderApp("/candidates?page=2");
        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Candidates" })).toBeNull();
        failing = false;
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 147" })).toBeInTheDocument();
    });

    test("10. no candidates: the empty state, no table", async () => {
        pagedBackend(0);
        renderApp("/candidates");
        expect(await screen.findByText("No candidates yet")).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Candidates" })).toBeNull();
    });

    test("exactly 100 candidates: one page, Next disabled; 101: two pages", async () => {
        pagedBackend(100);
        const { unmount } = renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        expect(rows()).toHaveLength(100);
        expect(pager().getByText("Page 1 of 1")).toBeInTheDocument();
        expect(pager().getByRole("button", { name: "Next" })).toBeDisabled();
        unmount();

        pagedBackend(101);
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        expect(pager().getByText("Page 1 of 2")).toBeInTheDocument();
        await userEvent.setup().click(pager().getByRole("button", { name: "Next" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 1" })).toBeInTheDocument();
        expect(rows()).toHaveLength(1);
    });

    test("a page past the last one (stale link, or the last page emptied) goes to the last page", async () => {
        const { calls } = pagedBackend(150);
        renderApp("/candidates?page=5");
        expect(await screen.findByRole("link", { name: "CANDIDATE 50" })).toBeInTheDocument();
        expect(pager().getByText("Page 2 of 2")).toBeInTheDocument();
        expect(screen.queryByText("No candidates yet")).toBeNull();
        expect(listRequests(calls)).toEqual(["/api/admin/candidates?page=5&pageSize=100", "/api/admin/candidates?page=2&pageSize=100"]);
    });

    test("search keeps paging on the server and starts again at page 1", async () => {
        const { calls } = pagedBackend(247);
        renderApp("/candidates?page=2");
        await screen.findByRole("link", { name: "CANDIDATE 147" });
        await userEvent.setup().type(screen.getByLabelText("Search candidates"), "Kamal{Enter}");
        await screen.findByRole("table", { name: "Candidates" });
        expect(listRequests(calls).at(-1)).toBe("/api/admin/candidates?page=1&pageSize=100&search=Kamal");
    });

    test("contact number search: the placeholder names it; the term goes to the server (page 1), is kept while paging, and no row is filtered in the browser", async () => {
        const { calls } = pagedBackend(247);
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        const box = screen.getByLabelText("Search candidates");
        expect(box).toHaveAttribute("placeholder", "Search by name, passport ID, NIC, contact or WhatsApp number…");
        const user = userEvent.setup();
        await user.type(box, "0771234567{Enter}");
        await screen.findByRole("table", { name: "Candidates" });
        expect(listRequests(calls).at(-1)).toBe("/api/admin/candidates?page=1&pageSize=100&search=0771234567");
        // The stub ignores the term, like the real server would return its matches: whatever it
        // returns is shown as is (100 rows), not filtered again by the page.
        expect(rows()).toHaveLength(100);
        await user.click(pager().getByRole("button", { name: "Next" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 147" })).toBeInTheDocument();
        expect(listRequests(calls).at(-1)).toBe("/api/admin/candidates?page=2&pageSize=100&search=0771234567");
    });

    test("11-12. on page 2 a row still opens the candidate (link and row click)", async () => {
        pagedBackend(247, {
            "GET /api/admin/candidates/P0000147": { status: 404, body: { message: "Candidate not found" } },
            "GET /api/admin/candidates/P0000146": { status: 404, body: { message: "Candidate not found" } },
        });
        const first = renderApp("/candidates?page=2");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("link", { name: "CANDIDATE 147" }));
        expect(await screen.findByText(/Candidate not found|No candidate/i)).toBeInTheDocument();
        first.unmount();

        renderApp("/candidates?page=2");
        // A click anywhere on the row (here its passport ID) opens the candidate too.
        await user.click(await screen.findByText("P0000146"));
        expect(await screen.findByText(/Candidate not found|No candidate/i)).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Candidates" })).toBeNull();
    });

    test("13. roles unchanged: Add candidate for a candidate role, not for the retired VIEWER; paging works for both", async () => {
        pagedBackend(247);
        const { unmount } = renderApp("/candidates?page=2");
        await screen.findByRole("link", { name: "CANDIDATE 147" });
        expect(screen.getByRole("link", { name: "Add candidate" })).toHaveAttribute("href", "/candidates/new");
        unmount();

        pagedBackend(247, { "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "VIEWER" } } } });
        renderApp("/candidates?page=2");
        await screen.findByRole("link", { name: "CANDIDATE 147" });
        expect(screen.queryByRole("link", { name: "Add candidate" })).toBeNull();
    });
});
