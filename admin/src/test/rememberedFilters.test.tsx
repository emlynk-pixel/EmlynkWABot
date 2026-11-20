import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList, type CandidateListItem } from "../api/candidates";
import { validFilters, type CandidateFilterOptions } from "../api/candidateFilters";
import type { AllocationCandidateList } from "../api/workAllocation";
import { ADMIN, fakeAuth, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// Each list page's filters are remembered per user and per page in localStorage
// (hooks/useRememberedSearchParams.ts): coming back to the page's bare URL shows them again,
// clearing them is remembered too, and a saved value that is malformed, invalid or refused by the
// server never breaks the page. Synthetic data; the backend is a stub that records every request.

const OPTIONS: CandidateFilterOptions = {
    jobTypes: ["Welder"],
    noPreference: { code: "NO_PREFERENCE", label: "No Preferred Type" },
    officers: [{ id: "u-ann", name: "Ann Analyst", active: true }],
};
const item = (n: number): CandidateListItem => ({
    passportId: `N${String(n).padStart(7, "0")}`, uniqueId: String(n).padStart(4, "0"), name: `CANDIDATE ${n}`, nic: null, jobTypes: ["Welder"],
    workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })),
});
const candidates = (): CandidateList => ({
    items: [item(1), item(2)],
    pagination: { page: 1, pageSize: 100, total: 2, totalItems: 2, totalPages: 1 },
    filters: { search: null },
});
const allocation = (): AllocationCandidateList => ({
    items: [],
    pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 },
    filters: { status: "UNALLOCATED", analystId: null, search: null },
});

function backend({ refuse }: { refuse?: (url: URL) => boolean } = {}) {
    return signedInBackend({
        "GET /api/admin/candidates": (url) => (refuse?.(url) ? { status: 400, body: { message: "Invalid filters" } } : { status: 200, body: candidates() }),
        "GET /api/admin/candidate-filter-options": { status: 200, body: OPTIONS },
        "GET /api/admin/work-allocation/candidates": { status: 200, body: allocation() },
        "GET /api/admin/work-allocation/analysts": { status: 200, body: { analysts: [], unavailableAnalysts: [], unallocatedCount: 0 } },
    });
}
type Calls = { path: string; url: URL }[];
const queries = (calls: Calls, path: string) => calls.filter((c) => c.url.pathname === path).map((c) => c.url.searchParams);
const lastCandidates = (calls: Calls) => queries(calls, "/api/admin/candidates").at(-1)!;
const lastAllocation = (calls: Calls) => queries(calls, "/api/admin/work-allocation/candidates").at(-1)!;
const key = (userId: string, page: string) => `emlynk.admin.filters.${userId}.${page}`;
const saved = (userId: string, page: string) => {
    const raw = window.localStorage.getItem(key(userId, page));
    return raw === null ? null : JSON.parse(raw);
};
const nav = () => within(screen.getByRole("navigation", { name: "Main navigation" }));
const candidatesShown = () => screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP);

describe("Remembered filters", () => {
    test("filters and search are restored after leaving the page and coming back by the sidebar (never the page number)", async () => {
        const { calls } = backend();
        renderApp("/candidates?search=kamal&workflowStatus=REGISTERED&page=2");
        await candidatesShown();
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toEqual({ search: "kamal", workflowStatus: "REGISTERED" }));

        const user = userEvent.setup();
        await user.click(nav().getByRole("link", { name: "Overview" }));
        await screen.findByRole("heading", { name: "Overview", level: 1 }, RENDER_STEP);
        await user.click(nav().getByRole("link", { name: "Candidates" }));
        await candidatesShown();
        await waitFor(() => expect(lastCandidates(calls).get("workflowStatus")).toBe("REGISTERED"));
        expect(lastCandidates(calls).get("search")).toBe("kamal");
        expect(lastCandidates(calls).get("page")).toBe("1");
        expect(screen.getByLabelText("Search candidates")).toHaveValue("kamal");
        expect(screen.getByRole("group", { name: "Active filters" })).toBeInTheDocument();
    });

    test("a reload of the bare URL restores them; a URL that has its own filters is not overridden", async () => {
        window.localStorage.setItem(key(ADMIN.userId, "candidates"), JSON.stringify({ sex: "F" }));
        const { calls } = backend();
        const first = renderApp("/candidates");
        await candidatesShown();
        await waitFor(() => expect(lastCandidates(calls).get("sex")).toBe("F"));
        first.unmount();

        renderApp("/candidates?workflowStatus=REGISTERED");
        await candidatesShown();
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toEqual({ workflowStatus: "REGISTERED" }));
        expect(lastCandidates(calls).get("sex")).toBeNull();
        expect(lastCandidates(calls).get("workflowStatus")).toBe("REGISTERED");
    });

    test("per user: another user's saved filters are never read or overwritten", async () => {
        window.localStorage.setItem(key("user-2", "candidates"), JSON.stringify({ workflowStatus: "DEPARTED" }));
        const { calls } = backend();
        renderApp("/candidates");
        await candidatesShown();
        // admin-1 has nothing saved: the unfiltered list, and user-2's entry is untouched.
        expect(lastCandidates(calls).get("workflowStatus")).toBeNull();
        expect(saved("user-2", "candidates")).toEqual({ workflowStatus: "DEPARTED" });
        expect(saved(ADMIN.userId, "candidates")).toBeNull();
    });

    test("per user: the signed-in user's own entry is the one restored", async () => {
        window.localStorage.setItem(key("user-2", "candidates"), JSON.stringify({ workflowStatus: "DEPARTED" }));
        window.localStorage.setItem(key(ADMIN.userId, "candidates"), JSON.stringify({ workflowStatus: "CANCELLED" }));
        const { calls } = backend();
        renderApp("/candidates");
        await candidatesShown();
        await waitFor(() => expect(lastCandidates(calls).get("workflowStatus")).toBe("CANCELLED"));
        expect(saved("user-2", "candidates")).toEqual({ workflowStatus: "DEPARTED" });
    });

    test("per page: Candidates and Work Allocation keep separate entries", async () => {
        const { calls } = backend();
        const first = renderApp("/candidates?workflowStatus=REGISTERED");
        await candidatesShown();
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toEqual({ workflowStatus: "REGISTERED" }));
        first.unmount();

        const second = renderApp("/work-allocation");
        await screen.findByRole("heading", { name: "Work Allocation", level: 1 }, RENDER_STEP);
        await waitFor(() => expect(queries(calls, "/api/admin/work-allocation/candidates").length).toBeGreaterThan(0));
        expect(lastAllocation(calls).get("workflowStatus")).toBeNull();
        expect(saved(ADMIN.userId, "work-allocation")).toBeNull();
        second.unmount();

        // Work Allocation's own (legacy parameter names, and the view) come back on its bare URL.
        window.localStorage.setItem(key(ADMIN.userId, "work-allocation"), JSON.stringify({ view: "allocated", analyst: "u-ann", wstatus: "TEST_PASSED" }));
        renderApp("/work-allocation");
        await waitFor(() => expect(lastAllocation(calls).get("status")).toBe("ALLOCATED"), RENDER_STEP);
        expect(lastAllocation(calls).get("analystId")).toBe("u-ann");
        expect(lastAllocation(calls).get("workflowStatus")).toBe("TEST_PASSED");
        expect(saved(ADMIN.userId, "candidates")).toEqual({ workflowStatus: "REGISTERED" });
    });

    test("Clear all filters removes the saved entry, and they stay cleared on the next visit", async () => {
        window.localStorage.setItem(key(ADMIN.userId, "candidates"), JSON.stringify({ workflowStatus: "REGISTERED" }));
        const { calls } = backend();
        const first = renderApp("/candidates");
        await candidatesShown();
        await waitFor(() => expect(lastCandidates(calls).get("workflowStatus")).toBe("REGISTERED"));

        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Clear all filters" }, RENDER_STEP));
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toBeNull());
        expect(lastCandidates(calls).get("workflowStatus")).toBeNull();
        first.unmount();

        const before = queries(calls, "/api/admin/candidates").length;
        renderApp("/candidates");
        await candidatesShown();
        await waitFor(() => expect(queries(calls, "/api/admin/candidates").length).toBeGreaterThan(before));
        expect(lastCandidates(calls).get("workflowStatus")).toBeNull();
        expect(saved(ADMIN.userId, "candidates")).toBeNull();
    });

    test("malformed JSON in storage is ignored: the page loads unfiltered", async () => {
        window.localStorage.setItem(key(ADMIN.userId, "candidates"), "{not json");
        window.localStorage.setItem(key(ADMIN.userId, "work-allocation"), JSON.stringify(["view", "allocated"]));
        const { calls } = backend();
        const first = renderApp("/candidates");
        await candidatesShown();
        expect(screen.queryByRole("alert")).toBeNull();
        expect([...lastCandidates(calls).keys()].sort()).toEqual(["page", "pageSize"]);
        first.unmount();

        renderApp("/work-allocation");
        await screen.findByRole("heading", { name: "Work Allocation", level: 1 }, RENDER_STEP);
        await waitFor(() => expect(queries(calls, "/api/admin/work-allocation/candidates").length).toBeGreaterThan(0));
        expect(lastAllocation(calls).get("status")).toBe("UNALLOCATED");
    });

    test("invalid saved values (old choices, wrong types, bad dates, unknown keys) are dropped before the request", async () => {
        window.localStorage.setItem(key(ADMIN.userId, "candidates"), JSON.stringify({
            workflowStatus: "NO_SUCH_STATUS,REGISTERED", stage: 5, sex: "FEMALE", registeredFrom: "2026-13-40",
            surname: "PERERA", surnameMatch: "regex", allocation: "SOMETIMES", unknownKey: "x", page: "9",
        }));
        const { calls } = backend();
        renderApp("/candidates");
        await candidatesShown();
        await waitFor(() => expect(lastCandidates(calls).get("workflowStatus")).toBe("REGISTERED"));
        const query = lastCandidates(calls);
        expect(query.get("surname")).toBe("PERERA");
        for (const dropped of ["surnameMatch", "stage", "sex", "registeredFrom", "allocation", "unknownKey"]) expect(query.get(dropped)).toBeNull();
        expect(query.get("page")).toBe("1");
        // What is saved again is the cleaned value.
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toEqual({ surname: "PERERA", workflowStatus: "REGISTERED" }));
    });

    test("a restored filter the server refuses (400) is forgotten and the page loads unfiltered, without the error", async () => {
        window.localStorage.setItem(key(ADMIN.userId, "candidates"), JSON.stringify({ analystId: "u-gone" }));
        const { calls } = backend({ refuse: (url) => url.searchParams.has("analystId") });
        renderApp("/candidates");
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toBeNull(), RENDER_STEP);
        await candidatesShown();
        expect(lastCandidates(calls).get("analystId")).toBeNull();
        expect(screen.queryByText("Invalid filters")).toBeNull();
    });

    test("a 400 for filters the user typed in the URL is still shown (nothing restored)", async () => {
        backend({ refuse: (url) => url.searchParams.has("analystId") });
        renderApp("/candidates?analystId=u-gone");
        expect(await screen.findByText("Invalid filters", {}, RENDER_STEP)).toBeInTheDocument();
    });

    test("signing out forgets the user's saved filters on every page (another user's are kept)", async () => {
        window.localStorage.setItem(key(ADMIN.userId, "work-allocation"), JSON.stringify({ view: "ALLOCATED" }));
        window.localStorage.setItem(key("user-2", "candidates"), JSON.stringify({ sex: "M" }));
        backend();
        renderApp("/candidates?sex=F");
        await candidatesShown();
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toEqual({ sex: "F" }));

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /^Account:/ }));
        await user.click(screen.getByRole("button", { name: "Sign out" }));
        await screen.findByRole("heading", { name: "Sign in to EMOPS" }, RENDER_STEP);
        expect(saved(ADMIN.userId, "candidates")).toBeNull();
        expect(saved(ADMIN.userId, "work-allocation")).toBeNull();
        expect(saved("user-2", "candidates")).toEqual({ sex: "M" });
    });

    test("a session ended elsewhere (another tab's sign-out, expiry) forgets them too", async () => {
        backend();
        renderApp("/candidates?sex=F");
        await candidatesShown();
        await waitFor(() => expect(saved(ADMIN.userId, "candidates")).toEqual({ sex: "F" }));
        fakeAuth.expireSession();
        await screen.findByRole("heading", { name: "Sign in to EMOPS" }, RENDER_STEP);
        expect(saved(ADMIN.userId, "candidates")).toBeNull();
    });
});

describe("validFilters", () => {
    test("keeps valid values and drops the invalid ones (list items one by one)", () => {
        expect(validFilters({
            workflowStatus: "REGISTERED,BOGUS", stage: "COMPLETE", sex: "M,MALE", allocation: "ALLOCATED",
            nationality: "  Sri Lankan ", nationalityMatch: "equals", name: "kamal", nameMatch: "equals",
            testFrom: "2026-02-30", registeredFrom: "2026-10-01", registeredTo: "2026-10-31",
            analystId: "bad id!", clientId: "11111111-1111-4111-8111-111111111111", agentId: "not-a-uuid", jobType: 7,
        })).toEqual({
            workflowStatus: "REGISTERED", stage: "COMPLETE", sex: "M", allocation: "ALLOCATED",
            nationality: "Sri Lankan", nationalityMatch: "equals", name: "kamal",
            registeredFrom: "2026-10-01", registeredTo: "2026-10-31", clientId: "11111111-1111-4111-8111-111111111111",
        });
    });

    test("a date range ending before it starts is dropped whole; empty input gives nothing", () => {
        expect(validFilters({ testFrom: "2026-10-31", testTo: "2026-10-01" })).toEqual({});
        expect(validFilters({})).toEqual({});
    });
});
