import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AllocationAnalysts, AllocationCandidate, AllocationCandidateList } from "../api/workAllocation";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

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
        "POST /api/admin/work-allocation/auto-allocate": {
            status: 200,
            body: {
                selectedCount: 3,
                eligibleCount: 3,
                allocatedCount: 2,
                analystCount: 2,
                equalAllocationCount: 1,
                remainderCount: 1,
                conflictsCount: 0,
                skippedCount: 0,
                unallocatedCandidateIds: ["P0000001"],
                skippedCandidateIds: [],
                byAnalyst: [
                    { analystId: "u-ann", name: "Ann Analyst", count: 1 },
                    { analystId: "u-ben", name: "Ben Analyst", count: 1 },
                ],
            },
        },
        ...extra,
    });
}

const table = () => screen.findByRole("table", { name: "Candidates to allocate" }, RENDER_STEP);
const posts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST");

describe("Work Allocation: Automatic Equal Candidate Distribution (ALLOC-EQUAL-018 - 020)", () => {
    test("ALLOC-EQUAL-018: UI displays correct selected / per-analyst / remainder calculation and confirmation dialog", async () => {
        backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();

        const allocateBtn = () => screen.getByRole("button", { name: "Allocate" });
        // Initially no candidate and no analyst selected => Allocate button is disabled
        expect(allocateBtn()).toBeDisabled();

        // Select all 3 candidates on this page
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        expect(allocateBtn()).toBeDisabled(); // Still disabled because 0 analysts selected

        // Select 2 analysts
        await user.click(screen.getByRole("checkbox", { name: "Select Ann Analyst" }));
        await user.click(screen.getByRole("checkbox", { name: "Select Ben Analyst" }));

        // Now Allocate button must be enabled
        expect(allocateBtn()).toBeEnabled();

        // Verify small allocation summary in the sidebar card
        expect(screen.getByText("Selected candidates:").nextElementSibling).toHaveTextContent("3");
        expect(screen.getByText("Selected analysts:").nextElementSibling).toHaveTextContent("2");
        expect(screen.getByText("Each analyst will receive:").nextElementSibling).toHaveTextContent("1");
        expect(screen.getByText("Remaining unallocated:").nextElementSibling).toHaveTextContent("1");

        // Click "Allocate" to open the confirmation dialog
        await user.click(allocateBtn());

        // Verify confirmation dialog is visible with title "Confirm Allocation"
        expect(await screen.findByRole("dialog", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Confirm Allocation" })).toBeInTheDocument();

        // Verify confirmation text matches expected calculated values:
        // "2 candidates will be allocated equally across 2 analysts."
        // "1 candidate will be assigned to each analyst."
        // "1 selected candidate will remain unallocated."
        expect(screen.getByText(/2 candidates will be allocated equally across 2 analysts\./)).toBeInTheDocument();
        expect(screen.getByText(/1 candidate will be assigned to each analyst\./)).toBeInTheDocument();
        expect(screen.getByText(/1 selected candidate will remain unallocated\./)).toBeInTheDocument();
    });

    test("ALLOC-EQUAL-019: After allocation, relevant UI refreshes without full-page reload", async () => {
        const { calls } = backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();

        // Select all candidates and all analysts
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        await user.click(screen.getByRole("button", { name: "Select all" })); // selects all analysts

        const listCallsBefore = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/candidates")).length;
        const analystCallsBefore = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/analysts")).length;

        // Click Allocate to open dialog
        await user.click(screen.getByRole("button", { name: "Allocate" }));

        // Confirm allocation in dialog
        const dialog = within(screen.getByRole("dialog"));
        await user.click(dialog.getByRole("button", { name: "Allocate" }));

        // Verify success result notice
        expect(await screen.findByText(/2 candidates allocated successfully\. 2 analysts received 1 candidates each\. 1 candidate remains unallocated\./, {}, RENDER_STEP)).toBeInTheDocument();

        // Verify request payload was sent to /work-allocation/auto-allocate with candidateIds and analystIds
        const autoPosts = posts(calls).filter((c) => c.path === "/api/admin/work-allocation/auto-allocate");
        expect(autoPosts).toHaveLength(1);
        expect(autoPosts[0].body).toEqual({
            candidateIds: ["P0000003", "P0000002", "P0000001"],
            analystIds: ["u-ann", "u-ben"],
        });

        // Verify candidates and analysts data reloaded in place without reloading entire application
        const listCallsAfter = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/candidates")).length;
        const analystCallsAfter = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/analysts")).length;
        expect(listCallsAfter).toBeGreaterThan(listCallsBefore);
        expect(analystCallsAfter).toBeGreaterThan(analystCallsBefore);

        // Verify selection was cleared
        expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
    });

    test("ALLOC-EQUAL-020: Existing search/filter/pagination behavior still works", async () => {
        backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();

        // Search for a candidate
        const searchInput = screen.getByPlaceholderText(/Name, passport ID/);
        await user.type(searchInput, "P0000002");
        await user.click(screen.getByRole("button", { name: "Search" }));

        // Switch view to Allocated
        await user.click(screen.getByRole("button", { name: "Allocated" }));
        expect(screen.getByRole("button", { name: "Allocated" })).toHaveAttribute("aria-pressed", "true");

        // Switch back to Unallocated
        await user.click(screen.getByRole("button", { name: /Unallocated/ }));
        expect(screen.getByRole("button", { name: /Unallocated/ })).toHaveAttribute("aria-pressed", "true");
    });
});
