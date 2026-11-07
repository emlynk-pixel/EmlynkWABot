import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList, type CandidateSuggestion } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// The candidate search box's live suggestions (components/CandidateSearchBox.tsx) on Candidates and
// Work Allocation. Synthetic data; the backend is a stub recording every request (the server's own
// matching, ranking and scope are in test/candidateNameSearch.test.js).

const SUGGESTIONS: CandidateSuggestion[] = [
    { passportId: "N1100001", name: "NIMAL PERERA SILVA", nic: "199011111111" },
    { passportId: "N1100002", name: "NIMESH FERNANDO", nic: null },
    { passportId: "N1100004", name: "KAMAL NIMALASIRI", nic: null },
];
const LIST: CandidateList = {
    items: [{ passportId: "N1100001", uniqueId: "8101", name: "NIMAL PERERA SILVA", nic: null, jobTypes: [], workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })) }],
    pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    filters: { search: null },
};
function backend(role = "ADMIN") {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        "GET /api/admin/candidates": { status: 200, body: LIST },
        "GET /api/admin/candidate-filter-options": { status: 200, body: { jobTypes: ["Welder"], noPreference: { code: "NO_PREFERENCE", label: "No Preferred Type" } } },
        "GET /api/admin/candidate-suggestions": (url) => ({ status: 200, body: { items: (url.searchParams.get("q") ?? "").length >= 2 ? SUGGESTIONS : [] } }),
        "GET /api/admin/work-allocation/candidates": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 }, filters: { status: "UNALLOCATED", analystId: null, search: null } } },
        "GET /api/admin/work-allocation/analysts": { status: 200, body: { analysts: [], unavailableAnalysts: [], unallocatedCount: 0 } },
    });
}
const suggestionCalls = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.path.startsWith("/api/admin/candidate-suggestions")).map((c) => c.url.searchParams);
const listQueries = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.path.startsWith("/api/admin/candidates?")).map((c) => Object.fromEntries(c.url.searchParams));
const box = () => screen.getByRole("combobox", { name: "Search candidates" });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready(path = "/candidates") {
    const stub = backend();
    renderApp(path);
    await screen.findByRole("link", { name: "NIMAL PERERA SILVA" }, RENDER_STEP);
    return { ...stub, user: userEvent.setup() };
}

describe("Candidate search suggestions", () => {
    test("UI-15 / 28 nothing for one character; while typing, one debounced request for the latest text", async () => {
        const { calls, user } = await ready();
        await user.type(box(), "n");
        await wait(400);
        expect(suggestionCalls(calls)).toHaveLength(0);
        expect(box()).toHaveAttribute("aria-expanded", "false");
        await user.type(box(), "imal");
        await waitFor(() => expect(suggestionCalls(calls)).toHaveLength(1));
        expect(suggestionCalls(calls)[0].get("q")).toBe("nimal");
        await wait(400);
        expect(suggestionCalls(calls)).toHaveLength(1);
    });

    test("UI-24 the dropdown appears with name, passport and NIC", async () => {
        const { user } = await ready();
        await user.type(box(), "nim");
        const options = await screen.findAllByRole("option");
        const lines = options.map((option) => [...option.querySelectorAll("span.block")].map((line) => line.textContent));
        expect(lines).toEqual([["NIMAL PERERA SILVA", "N1100001 · 199011111111"], ["NIMESH FERNANDO", "N1100002"], ["KAMAL NIMALASIRI", "N1100004"]]);
        expect(box()).toHaveAttribute("aria-expanded", "true");
    });

    test("UI-25 / 29 / 30 a click puts the name in the box and searches through the list, keeping the filters, page 1", async () => {
        const { calls, user } = await ready("/candidates?page=3&jobType=Welder&sex=M");
        await user.type(box(), "nim");
        await user.click(await screen.findByRole("option", { name: /NIMESH FERNANDO/ }));
        expect(box()).toHaveValue("NIMESH FERNANDO");
        await waitFor(() => expect(listQueries(calls).at(-1)).toEqual({ page: "1", pageSize: "100", search: "NIMESH FERNANDO", jobType: "Welder", sex: "M" }));
        expect(screen.queryByRole("option")).toBeNull();
    });

    test("UI-26 Arrow keys move the highlight (wrapping) and Enter picks it", async () => {
        const { calls, user } = await ready();
        await user.type(box(), "nim");
        await screen.findAllByRole("option");
        await user.keyboard("{ArrowDown}{ArrowDown}");
        expect(screen.getByRole("option", { name: /NIMESH/ })).toHaveAttribute("aria-selected", "true");
        expect(box().getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /NIMESH/ }).id);
        await user.keyboard("{ArrowUp}{ArrowUp}");
        expect(screen.getByRole("option", { name: /KAMAL/ })).toHaveAttribute("aria-selected", "true");
        await user.keyboard("{Enter}");
        await waitFor(() => expect(listQueries(calls).at(-1)?.search).toBe("KAMAL NIMALASIRI"));
        expect(box()).toHaveValue("KAMAL NIMALASIRI");
    });

    test("UI-27 Escape closes the list and keeps the typed text; Enter without a highlight is a plain search", async () => {
        const { calls, user } = await ready();
        await user.type(box(), "nim");
        await screen.findAllByRole("option");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("option")).toBeNull();
        expect(box()).toHaveAttribute("aria-expanded", "false");
        expect(box()).toHaveValue("nim");
        await user.keyboard("{Enter}");
        await waitFor(() => expect(listQueries(calls).at(-1)?.search).toBe("nim"));
    });

    test("UI-23 Work Allocation asks for suggestions within its view", async () => {
        const stub = backend();
        renderApp("/work-allocation?view=allocated");
        const user = userEvent.setup();
        const input = await screen.findByRole("combobox", { name: "Search candidates" }, RENDER_STEP);
        await user.type(input, "nim");
        await waitFor(() => expect(suggestionCalls(stub.calls).at(-1)?.get("allocation")).toBe("ALLOCATED"));
        await user.click(await screen.findByRole("option", { name: /NIMAL PERERA SILVA/ }));
        await waitFor(() => {
            const last = stub.calls.filter((c) => c.path.startsWith("/api/admin/work-allocation/candidates")).at(-1)!.url.searchParams;
            expect([last.get("status"), last.get("search"), last.get("page")]).toEqual(["ALLOCATED", "NIMAL PERERA SILVA", "1"]);
        });
    });
});
