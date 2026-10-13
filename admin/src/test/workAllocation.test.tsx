import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList } from "../api/candidates";
import type { AllocationAnalysts, AllocationCandidate, AllocationCandidateList } from "../api/workAllocation";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Work Allocation page and the Analyst's candidate list. Synthetic candidates
// only; the backend is a stub (the API's own rules, and the Analyst scoping,
// are in test/workAllocation.test.js).

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });

const candidate = (n: number, analyst: AllocationCandidate["analyst"] = null): AllocationCandidate => ({
    passportId: `P000000${n}`,
    uniqueId: `000${n}`,
    name: `CANDIDATE ${n}`,
    nic: null,
    jobTypes: ["Driver"],
    whatsappNumber: `9477000000${n}`,
    contactNumber: `071000000${n}`,
    registeredDate: "2026-10-01T05:00:00.000Z",
    stagesCompleted: 1,
    stagesTotal: 7,
    currentStage: "CANDIDATE_DETAILS",
    analyst,
    assignedDate: analyst ? "2026-10-02T05:00:00.000Z" : null,
});
const ANN = { analystId: "u-ann", name: "Ann Analyst", active: true };
const page = (items: AllocationCandidate[], status: "UNALLOCATED" | "ALLOCATED" = "UNALLOCATED"): AllocationCandidateList => ({
    items,
    pagination: { page: 1, pageSize: 100, total: items.length, totalItems: items.length, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
    filters: { status, analystId: null, search: null },
});
const ANALYSTS: AllocationAnalysts = {
    analysts: [
        { analystId: "u-ann", name: "Ann Analyst", assignedCount: 42 },
        { analystId: "u-ben", name: "Ben Analyst", assignedCount: 7 },
    ],
    unavailableAnalysts: [],
    unallocatedCount: 3,
};
const UNALLOCATED = [candidate(3), candidate(2), candidate(1)];

function backend(role = "MANAGER", extra: FetchRoutes = {}) {
    return signedInBackend({
        ...asRole(role),
        "GET /api/admin/work-allocation/candidates": (url) => ({
            status: 200,
            body: url.searchParams.get("status") === "ALLOCATED" ? page([candidate(5, ANN), candidate(4, ANN)], "ALLOCATED") : page(UNALLOCATED),
        }),
        "GET /api/admin/work-allocation/analysts": { status: 200, body: ANALYSTS },
        "POST /api/admin/work-allocation/assign": { status: 200, body: { assigned: 3, reassigned: 0, unchanged: 0, byAnalyst: [{ analystId: "u-ann", name: "Ann Analyst", count: 2 }, { analystId: "u-ben", name: "Ben Analyst", count: 1 }] } },
        "POST /api/admin/work-allocation/unassign": { status: 200, body: { unassigned: 2, alreadyUnallocated: 0 } },
        ...extra,
    });
}
const table = () => screen.findByRole("table", { name: "Candidates to allocate" }, RENDER_STEP);
const posts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST");
const assignButton = () => screen.getByRole("button", { name: /^(Assign|Reassign) \d+ candidates$/ });

describe("Work Allocation: who sees it", () => {
    for (const role of ["ADMIN", "MANAGER"]) {
        test(`${role}: in the sidebar, and the page loads`, async () => {
            backend(role);
            renderApp("/work-allocation");
            await table();
            expect(screen.getByRole("link", { name: "Work Allocation" })).toBeInTheDocument();
        });
    }
    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`${role}: not in the sidebar; the URL shows Access Restricted and requests nothing`, async () => {
            const { calls } = backend(role);
            renderApp("/work-allocation");
            expect(await screen.findByText("Access Restricted", {}, RENDER_STEP)).toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Work Allocation" })).toBeNull();
            expect(calls.some((c) => c.path.startsWith("/api/admin/work-allocation"))).toBe(false);
        });
    }
});

describe("Work Allocation: selecting and assigning", () => {
    test("checkboxes, Select all (this page only) and Clear selection", async () => {
        backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 2" }));
        expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0);
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        expect(screen.getAllByText("3 selected").length).toBeGreaterThan(0);
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        await user.click(screen.getByRole("button", { name: "Clear selection" }));
        expect(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" })).not.toBeChecked();
    });

    test("Analysts with their current counts; totals must match before Assign is enabled; one request with the distribution", async () => {
        const { calls } = backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        const analysts = within(await screen.findByRole("list", { name: "Analysts" }, RENDER_STEP));
        expect(analysts.getByText("Ann Analyst")).toBeInTheDocument();
        expect(analysts.getByText("42 candidates")).toBeInTheDocument();
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        expect(assignButton()).toBeDisabled();

        await user.type(screen.getByLabelText("Candidates for Ann Analyst"), "2");
        expect(screen.getByText("The counts add up to 2; they must add up to the 3 selected.")).toBeInTheDocument();
        expect(assignButton()).toBeDisabled();
        expect(analysts.getByText("→ 44")).toBeInTheDocument();
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1.5");
        expect(screen.getByText("Counts must be whole numbers, 0 or more.")).toBeInTheDocument();
        await user.clear(screen.getByLabelText("Candidates for Ben Analyst"));
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1");
        expect(screen.getByText("3 / 3")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Assign 3 candidates" }));
        expect(await screen.findByText("Allocated 3 candidates: Ann Analyst 2, Ben Analyst 1.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(1);
        expect(posts(calls)[0]).toMatchObject({
            path: "/api/admin/work-allocation/assign",
            body: { candidateIds: ["P0000003", "P0000002", "P0000001"], allocations: [{ analystId: "u-ann", count: 2 }, { analystId: "u-ben", count: 1 }], reassign: false },
        });
        // Reloaded after the change, and the selection is cleared.
        expect(calls.filter((c) => c.path.startsWith("/api/admin/work-allocation/analysts")).length).toBeGreaterThan(1);
        expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
    });

    test("All gives the whole selection to one Analyst", async () => {
        const { calls } = backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        const ben = within(screen.getByText("Ben Analyst").closest("li")!);
        await user.click(ben.getByRole("button", { name: "All" }));
        await user.click(screen.getByRole("button", { name: "Assign 1 candidates" }));
        await screen.findByRole("status", {}, RENDER_STEP);
        expect(posts(calls)[0].body).toMatchObject({ candidateIds: ["P0000001"], allocations: [{ analystId: "u-ben", count: 1 }] });
    });

    test("a server error is shown and nothing is reported as done", async () => {
        backend("MANAGER", { "POST /api/admin/work-allocation/assign": { status: 409, body: { message: "Ann Analyst is not an active user. Nothing was changed.", code: "ANALYST_INACTIVE" } } });
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        await user.type(screen.getByLabelText("Candidates for Ann Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Assign 1 candidates" }));
        expect(await screen.findByText("Ann Analyst is not an active user. Nothing was changed.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("Work Allocation: allocated candidates", () => {
    test("reassignment is confirmed first and sent with reassign: true", async () => {
        const { calls } = backend();
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        expect(screen.getAllByText("Ann Analyst").length).toBeGreaterThan(1);
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Reassign 1 candidates" }));
        const dialog = within(screen.getByRole("dialog", { name: "Reassign candidates?" }));
        expect(dialog.getByText(/CANDIDATE 5 · now Ann Analyst/)).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
        await user.click(dialog.getByRole("button", { name: "Reassign" }));
        await screen.findByRole("status", {}, RENDER_STEP);
        expect(posts(calls)[0].body).toMatchObject({ candidateIds: ["P0000005"], reassign: true });
    });

    test("unassigning asks for confirmation, then sends confirm: true", async () => {
        const { calls } = backend();
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        await user.click(screen.getByRole("button", { name: "Unassign 2" }));
        const dialog = within(screen.getByRole("dialog", { name: "Unassign candidates?" }));
        await user.click(dialog.getByRole("button", { name: "Cancel" }));
        expect(posts(calls)).toHaveLength(0);
        await user.click(screen.getByRole("button", { name: "Unassign 2" }));
        await user.click(within(screen.getByRole("dialog", { name: "Unassign candidates?" })).getByRole("button", { name: "Unassign" }));
        expect(await screen.findByText("2 candidates are unallocated again.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(posts(calls)[0]).toMatchObject({ path: "/api/admin/work-allocation/unassign", body: { candidateIds: ["P0000005", "P0000004"], confirm: true } });
    });
});

describe("Work Allocation: empty states", () => {
    test("no unallocated candidates, no active Analysts", async () => {
        backend("ADMIN", {
            "GET /api/admin/work-allocation/candidates": { status: 200, body: page([]) },
            "GET /api/admin/work-allocation/analysts": { status: 200, body: { analysts: [], unavailableAnalysts: [], unallocatedCount: 0 } },
        });
        renderApp("/work-allocation");
        expect(await screen.findByText("All candidates are currently allocated.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(await screen.findByText("No active Analysts are available for allocation.", {}, RENDER_STEP)).toBeInTheDocument();
    });

    test("a search with no match", async () => {
        const { calls } = backend("ADMIN", { "GET /api/admin/work-allocation/candidates": { status: 200, body: page([]) } });
        renderApp("/work-allocation?search=nobody");
        expect(await screen.findByText("No candidates match this search.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(calls.some((c) => c.path === "/api/admin/work-allocation/candidates?status=UNALLOCATED&page=1&search=nobody")).toBe(true);
    });
});

describe("Candidates for an ANALYST", () => {
    test("the list is exactly what the server returns (scoped there); no Add candidate", async () => {
        const list: CandidateList = {
            items: [1, 2].map((n) => ({ passportId: `P000000${n}`, uniqueId: `000${n}`, name: `MINE ${n}`, nic: null, jobTypes: [], stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })) })),
            pagination: { page: 1, pageSize: 100, total: 2, totalItems: 2, totalPages: 1 },
            filters: { search: null },
        };
        const { calls } = signedInBackend({ ...asRole("ANALYST"), "GET /api/admin/candidates": { status: 200, body: list } });
        renderApp("/candidates");
        const table = await screen.findByRole("table", { name: "Candidates" }, RENDER_STEP);
        expect(within(table).getAllByRole("row").slice(1)).toHaveLength(2);
        expect(calls.filter((c) => c.path.startsWith("/api/admin/candidates")).map((c) => c.path)).toEqual(["/api/admin/candidates?page=1&pageSize=100"]);
        expect(screen.queryByRole("link", { name: /Add candidate/ })).toBeNull();
    });
});
