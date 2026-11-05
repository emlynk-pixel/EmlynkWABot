import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AllocationAnalysts, AllocationCandidate, AllocationCandidateList, AllocationStatus } from "../api/workAllocation";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// The Work Allocation table's columns (Allocated and Unallocated). Status is the candidate's workflow
// status (Registered, Job Assigned, Stopped with Test…), not the allocation state the tab already says;
// there is no Current stage or Contact column and no "0/8" progress; Unallocated rows have no Analyst.
// Synthetic data; the backend is a stub.

const ANN = { analystId: "u-ann", name: "Ann Analyst", active: true };
const candidate = (n: number, analyst: AllocationCandidate["analyst"] = null): AllocationCandidate => ({
    passportId: `P000000${n}`,
    uniqueId: `000${n}`,
    name: `CANDIDATE ${n}`,
    nic: null,
    jobTypes: ["Driver"],
    whatsappNumber: `9477000000${n}`,
    contactNumber: `071000000${n}`,
    registeredDate: "2026-10-01T05:00:00.000Z",
    stagesCompleted: 0,
    stagesTotal: 8,
    currentStage: "TEST_DETAILS",
    workflowStatus: { code: "STOPPED_WITH_TEST", label: "Stopped with Test" },
    analyst,
    assignedDate: analyst ? "2026-10-02T05:00:00.000Z" : null,
});
const list = (items: AllocationCandidate[], status: AllocationStatus, page = 1, totalPages = 1): AllocationCandidateList => ({
    items,
    pagination: { page, pageSize: 100, total: totalPages * 100, totalPages },
    filters: { status, analystId: null, search: null },
});
const ANALYSTS: AllocationAnalysts = { analysts: [{ analystId: "u-ann", name: "Ann Analyst", assignedCount: 2 }], unavailableAnalysts: [], unallocatedCount: 2 };

function backend() {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "OWNER" } } },
        "GET /api/admin/work-allocation/candidates": (url) => {
            const page = Number(url.searchParams.get("page") ?? "1");
            return {
                status: 200,
                body: url.searchParams.get("status") === "ALLOCATED"
                    ? list([candidate(5, ANN), candidate(4, { ...ANN, analystId: "u-old", name: "Old Analyst", active: false })], "ALLOCATED", page, 2)
                    : list([candidate(2 + (page - 1) * 10), candidate(1 + (page - 1) * 10)], "UNALLOCATED", page, 2),
            };
        },
        "GET /api/admin/work-allocation/analysts": { status: 200, body: ANALYSTS },
        "GET /api/admin/candidate-filter-options": { status: 200, body: { jobTypes: ["Driver"], noPreference: { code: "NO_PREFERENCE", label: "No Preferred Type" }, officers: [ANN] } },
        "POST /api/admin/work-allocation/assign": { status: 200, body: { assigned: 1, reassigned: 0, unchanged: 0, byAnalyst: [{ analystId: "u-ann", name: "Ann Analyst", count: 1 }] } },
    });
}
const table = () => screen.findByRole("table", { name: "Candidates to allocate" }, RENDER_STEP);
const headers = (t: HTMLElement) => within(t).getAllByRole("columnheader").map((h) => h.textContent);
const listQueries = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.path.startsWith("/api/admin/work-allocation/candidates")).map((c) => c.url.searchParams);

describe("Work Allocation table columns", () => {
    test("1-2 / 6 Allocated: no Contact or Current stage; the Analyst column stays, with the inactive mark", async () => {
        backend();
        renderApp("/work-allocation?view=allocated");
        const t = await table();
        await within(t).findByText("CANDIDATE 5");
        expect(headers(t)).toEqual(["", "Passport number", "Candidate", "Registered", "Status", "Analyst"]);
        for (const row of within(t).getAllByRole("row").slice(1)) expect(within(row).getAllByRole("cell")).toHaveLength(6);
        expect(within(within(t).getByText("CANDIDATE 5").closest("tr")!).getByText("Ann Analyst")).toBeInTheDocument();
        expect(within(within(t).getByText("CANDIDATE 4").closest("tr")!).getByText("(inactive)")).toBeInTheDocument();
        expect(within(t).queryByText("Allocated")).toBeNull();
        expect(within(t).queryByText("Test details")).toBeNull();
        expect(within(t).queryByText(/0710000005|94770000005/)).toBeNull();
    });

    test("3-5 Unallocated: no Contact, Current stage or Analyst column (no empty Analyst cells)", async () => {
        backend();
        renderApp("/work-allocation");
        const t = await table();
        await within(t).findByText("CANDIDATE 1");
        expect(headers(t)).toEqual(["", "Passport number", "Candidate", "Registered", "Status"]);
        for (const row of within(t).getAllByRole("row").slice(1)) expect(within(row).getAllByRole("cell")).toHaveLength(5);
        expect(within(t).queryByText("Unallocated")).toBeNull();
        expect(within(t).queryByText("—")).toBeNull();
        expect(within(t).queryByText(/0710000001|^WA /)).toBeNull();
    });

    test("7-8 the Status cell is the workflow status badge; no stage name and no 0/8 progress", async () => {
        backend();
        renderApp("/work-allocation");
        const t = await table();
        const row = within(within(t).getByText("CANDIDATE 1").closest("tr")!);
        expect(row.getAllByRole("cell")[4].textContent).toBe("Stopped with Test");
        expect(within(t).queryByText(/\d+\/\d+/)).toBeNull();
        expect(within(t).queryByText("Test details")).toBeNull();
    });

    test("9 selecting a row and assigning still sends the allocation", async () => {
        const { calls } = backend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        await user.type(screen.getByLabelText("Candidates for Ann Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Assign 1 candidates" }));
        await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/api/admin/work-allocation/assign")).toHaveLength(1));
        expect(calls.find((c) => c.method === "POST")!.body).toEqual({ candidateIds: ["P0000001"], allocations: [{ analystId: "u-ann", count: 1 }], reassign: false });
    });

    test("10 paging keeps the view and the columns", async () => {
        const { calls } = backend();
        renderApp("/work-allocation?view=allocated");
        await table();
        await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => expect(listQueries(calls).at(-1)?.get("page")).toBe("2"));
        expect(listQueries(calls).at(-1)?.get("status")).toBe("ALLOCATED");
        expect(headers(await table())).toEqual(["", "Passport number", "Candidate", "Registered", "Status", "Analyst"]);
    });

    test("11 the Status and Current stage filters (Filters) still reach the server (from the URL)", async () => {
        const { calls } = backend();
        renderApp("/work-allocation?wstatus=STOPPED_WITH_TEST&stage=TEST_DETAILS");
        await table();
        const query = listQueries(calls).at(-1)!;
        expect([query.get("status"), query.get("workflowStatus"), query.get("stage")]).toEqual(["UNALLOCATED", "STOPPED_WITH_TEST", "TEST_DETAILS"]);
        expect(screen.getByRole("group", { name: "Active filters" })).toBeInTheDocument();
    });
});
