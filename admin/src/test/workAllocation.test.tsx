import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList } from "../api/candidates";
import type { AllocationAnalysts, AllocationCandidate, AllocationCandidateList, AllocationStatus } from "../api/workAllocation";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes, expectRedirectedHome } from "./helpers";

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
const page = (items: AllocationCandidate[], status: AllocationStatus = "UNALLOCATED"): AllocationCandidateList => ({
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

function backend(role = "OWNER", extra: FetchRoutes = {}) {
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
    for (const role of ["ADMIN", "OWNER", "TEAM_LEAD"]) {
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
            await expectRedirectedHome(role);
            expect(screen.queryByRole("link", { name: "Work Allocation" })).toBeNull();
            expect(calls.some((c) => c.path.startsWith("/api/admin/work-allocation"))).toBe(false);
        });
    }
});

describe("Work Allocation: Team Leads as allocation targets (an ADMIN's list)", () => {
    const WITH_TEAM_LEAD: AllocationAnalysts = {
        ...ANALYSTS,
        // The server's name order; the page shows the Analysts first, then the Team Leads.
        analysts: [{ analystId: "u-tia", name: "Aaron Lead", role: "TEAM_LEAD", assignedCount: 1 }, ...ANALYSTS.analysts.map((a) => ({ ...a, role: "ANALYST" }))],
    };
    const TIA = { analystId: "u-tia", name: "Aaron Lead", active: true, role: "TEAM_LEAD" };

    test("Team Leads are listed after the Analysts, marked Team Lead, and can be given candidates", async () => {
        const { calls } = backend("ADMIN", { "GET /api/admin/work-allocation/analysts": { status: 200, body: WITH_TEAM_LEAD } });
        renderApp("/work-allocation");
        await table();
        const list = within(await screen.findByRole("list", { name: "Analysts" }, RENDER_STEP));
        const names = list.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
        expect(names).toEqual(["Ann Analyst", "Ben Analyst", "Aaron LeadTeam Lead"]);
        expect(screen.getByText(/Assign candidates to Analysts or Team Leads/)).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        await user.type(screen.getByLabelText("Candidates for Aaron Lead"), "3");
        await user.click(screen.getByRole("button", { name: "Assign 3 candidates" }));
        await waitFor(() => expect(posts(calls)).toHaveLength(1));
        expect(posts(calls)[0]).toMatchObject({ path: "/api/admin/work-allocation/assign", body: { allocations: [{ analystId: "u-tia", count: 3 }] } });
    });

    test("an allocated Team Lead is shown with the Team Lead mark, not as inactive", async () => {
        backend("ADMIN", {
            "GET /api/admin/work-allocation/analysts": { status: 200, body: WITH_TEAM_LEAD },
            "GET /api/admin/work-allocation/candidates": { status: 200, body: page([candidate(6, TIA)], "ALLOCATED") },
        });
        renderApp("/work-allocation?view=allocated");
        const rows = within(await table());
        const row = rows.getByText("CANDIDATE 6").closest("tr")!;
        expect(row).toHaveTextContent("Aaron LeadTeam Lead");
        expect(row).not.toHaveTextContent("(inactive)");
    });

    test("without Team Leads the page reads as before", async () => {
        backend();
        renderApp("/work-allocation");
        await table();
        expect(screen.getByText("Assign candidates to Analysts. An Analyst only sees and works on the candidates allocated to them.")).toBeInTheDocument();
    });
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
        backend("OWNER", { "POST /api/admin/work-allocation/assign": { status: 409, body: { message: "Ann Analyst is not an active user. Nothing was changed.", code: "ANALYST_INACTIVE" } } });
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        await user.type(screen.getByLabelText("Candidates for Ann Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Assign 1 candidates" }));
        expect(await screen.findByText("Ann Analyst is not an active user. Nothing was changed.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByText(/^Allocated \d/)).toBeNull();
    });

    test("a 409 conflict keeps its message, refreshes the list and Analysts, and the stale row leaves the Unallocated list", async () => {
        // Another manager allocated CANDIDATE 1 while this page was open.
        let allocatedElsewhere = false;
        const { calls } = backend("OWNER", {
            "GET /api/admin/work-allocation/candidates": () => ({ status: 200, body: page(allocatedElsewhere ? [candidate(2)] : [candidate(2), candidate(1)]) }),
            "POST /api/admin/work-allocation/assign": () => {
                allocatedElsewhere = true;
                return { status: 409, body: { message: "1 selected candidate is already allocated. Nothing was changed; confirm a reassignment to move them.", code: "ALREADY_ALLOCATED" } };
            },
        });
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        expect(screen.getByText("CANDIDATE 1")).toBeInTheDocument();
        const listCalls = () => calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/candidates")).length;
        const analystCalls = () => calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/analysts")).length;
        const [listBefore, analystsBefore] = [listCalls(), analystCalls()];

        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Assign 1 candidates" }));

        // The message stays, the data is fetched again, and the row is current.
        expect(await screen.findByText(/already allocated\. Nothing was changed/, {}, RENDER_STEP)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByText("CANDIDATE 1")).toBeNull(), RENDER_STEP);
        expect(screen.getByText("CANDIDATE 2")).toBeInTheDocument();
        expect(listCalls()).toBeGreaterThan(listBefore);
        expect(analystCalls()).toBeGreaterThan(analystsBefore);
        // The selection made from the old state is dropped; the message is still there.
        expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
        expect(screen.getByRole("alert")).toHaveTextContent("already allocated");
    });

    test("a 409 from the reassign dialog closes it, keeps the message on the page and refreshes", async () => {
        const { calls } = backend("OWNER", {
            "POST /api/admin/work-allocation/assign": { status: 409, body: { message: "Ben Analyst is not an active user. Nothing was changed.", code: "ANALYST_INACTIVE" } },
        });
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        const before = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/candidates")).length;
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Reassign 1 candidates" }));
        await user.click(within(screen.getByRole("dialog", { name: "Reassign candidates?" })).getByRole("button", { name: "Reassign" }));
        expect(await screen.findByRole("alert", {}, RENDER_STEP)).toHaveTextContent("Ben Analyst is not an active user.");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/admin/work-allocation/candidates")).length).toBeGreaterThan(before);
    });
});

describe("Work Allocation: pages and empty messages", () => {
    const paged = (items: AllocationCandidate[], pageNumber: number, totalPages: number, total: number): AllocationCandidateList => ({
        items,
        pagination: { page: pageNumber, pageSize: 100, total, totalItems: total, totalPages, hasNextPage: pageNumber < totalPages, hasPreviousPage: pageNumber > 1 },
        filters: { status: "ALLOCATED", analystId: null, search: null },
    });

    test("a page past the last one moves to the last page, without claiming nothing is allocated", async () => {
        const { calls } = backend("OWNER", {
            "GET /api/admin/work-allocation/candidates": (url) => {
                const requested = Number(url.searchParams.get("page"));
                return { status: 200, body: requested === 2 ? paged([candidate(5, ANN)], 2, 2, 101) : paged([], requested, 2, 101) };
            },
        });
        renderApp("/work-allocation?view=allocated&page=3");
        await table();
        expect(screen.getByText("CANDIDATE 5")).toBeInTheDocument();
        expect(calls.some((c) => c.path === "/api/admin/work-allocation/candidates?status=ALLOCATED&page=2")).toBe(true);
        expect(screen.queryByText("No candidates are allocated yet.")).toBeNull();
        expect(screen.queryByText("There are no candidates on this page.")).toBeNull();
    });

    test("when every allocation was removed, a page past the end falls back to page 1 and shows the real empty state", async () => {
        const { calls } = backend("OWNER", {
            "GET /api/admin/work-allocation/candidates": (url) => ({ status: 200, body: paged([], Number(url.searchParams.get("page")), 1, 0) }),
        });
        renderApp("/work-allocation?view=allocated&page=4");
        expect(await screen.findByText("No candidates are allocated yet.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(calls.some((c) => c.path === "/api/admin/work-allocation/candidates?status=ALLOCATED&page=1")).toBe(true);
    });

    test("an empty page inside the range says so, and offers the first page", async () => {
        backend("OWNER", {
            "GET /api/admin/work-allocation/candidates": (url) => {
                const requested = Number(url.searchParams.get("page"));
                return { status: 200, body: requested === 1 ? paged([candidate(5, ANN)], 1, 3, 250) : paged([], requested, 3, 250) };
            },
        });
        renderApp("/work-allocation?view=allocated&page=2");
        expect(await screen.findByText("There are no candidates on this page.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByText("No candidates are allocated yet.")).toBeNull();
        await userEvent.setup().click(screen.getByRole("button", { name: "Go to the first page" }));
        expect(await screen.findByText("CANDIDATE 5", {}, RENDER_STEP)).toBeInTheDocument();
    });

    test("the empty message follows the view, the Analyst filter and the search", async () => {
        backend("OWNER", { "GET /api/admin/work-allocation/candidates": (url) => ({ status: 200, body: paged([], Number(url.searchParams.get("page")), 1, 0) }) });
        const first = renderApp("/work-allocation?view=allocated&analyst=u-ann");
        expect(await screen.findByText("No candidates are allocated to this Analyst.", {}, RENDER_STEP)).toBeInTheDocument();
        first.unmount();
        const second = renderApp("/work-allocation?view=allocated&search=nobody");
        expect(await screen.findByText("No candidates match this search.", {}, RENDER_STEP)).toBeInTheDocument();
        second.unmount();
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
        expect(dialog.getByText(/1 of the 1 selected candidates are already allocated/)).toBeInTheDocument();
        expect(dialog.getByText("Ben Analyst")).toBeInTheDocument(); // the new assignee
        expect(dialog.getByText(/→ Ben Analyst/)).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
        await user.click(dialog.getByRole("button", { name: "Reassign" }));
        await screen.findByRole("status", {}, RENDER_STEP);
        expect(posts(calls)[0].body).toMatchObject({ candidateIds: ["P0000005"], reassign: true });
    });

    test("REALLOC-UI: cancelling the reassignment confirmation sends nothing and keeps the selection", async () => {
        const { calls } = backend();
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Reassign 1 candidates" }));
        await user.click(within(screen.getByRole("dialog", { name: "Reassign candidates?" })).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "Reassign candidates?" })).not.toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
        expect(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" })).toBeChecked();
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
        expect(await screen.findByText("2 candidates are unallocated again. Their previous assignees are no longer assigned to them; an Analyst loses access to the candidate immediately.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(posts(calls)[0]).toMatchObject({ path: "/api/admin/work-allocation/unassign", body: { candidateIds: ["P0000005", "P0000004"], confirm: true } });
    });
});

describe("Work Allocation: the Completed view (Cancelled, Rejected, Departed)", () => {
    const WITH_COMPLETED: AllocationAnalysts = { ...ANALYSTS, completedCount: 1234 };
    const DEPARTED = { ...candidate(8, ANN), workflowStatus: { code: "DEPARTED", label: "Departed" } } as AllocationCandidate;
    const CANCELLED = { ...candidate(9), workflowStatus: { code: "CANCELLED", label: "Cancelled" } } as AllocationCandidate;
    const completedBackend = (extra: FetchRoutes = {}) => backend("OWNER", {
        "GET /api/admin/work-allocation/analysts": { status: 200, body: WITH_COMPLETED },
        "GET /api/admin/work-allocation/candidates": (url) => ({
            status: 200,
            body: url.searchParams.get("status") === "COMPLETED"
                ? page(url.searchParams.get("analystId") === "u-ann" ? [DEPARTED] : [DEPARTED, CANCELLED], "COMPLETED")
                : url.searchParams.get("status") === "ALLOCATED" ? page([candidate(5, ANN)], "ALLOCATED") : page(UNALLOCATED),
        }),
        ...extra,
    });
    const listCalls = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.path.startsWith("/api/admin/work-allocation/candidates")).map((c) => c.url.searchParams);
    const viewButtons = () => within(screen.getByRole("group", { name: "View" })).getAllByRole("button");

    test("Completed is right of Allocated, with its count styled like Unallocated's; Allocated still has none", async () => {
        completedBackend();
        renderApp("/work-allocation");
        await table();
        await waitFor(() => expect(viewButtons().map((b) => b.textContent)).toEqual(["Unallocated3", "Allocated", "Completed1,234"]));
        const [unallocated, , completed] = viewButtons();
        expect(completed.querySelector("span")!.className).toBe(unallocated.querySelector("span")!.className);
    });

    test("an older server without completedCount: the Completed tab shows no count", async () => {
        backend();
        renderApp("/work-allocation");
        await table();
        await screen.findByRole("list", { name: "Analysts" }, RENDER_STEP);
        expect(viewButtons().map((b) => b.textContent)).toEqual(["Unallocated3", "Allocated", "Completed"]);
    });

    test("clicking Completed loads the COMPLETED list with the same columns, and offers the Analyst filter", async () => {
        const { calls } = completedBackend();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /^Completed/ }));
        expect(screen.getByRole("button", { name: /^Completed/ })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Allocated" })).toHaveAttribute("aria-pressed", "false");
        const t = within(await screen.findByRole("table", { name: "Candidates to allocate" }, RENDER_STEP));
        expect(await t.findByText("CANDIDATE 9", {}, RENDER_STEP)).toBeInTheDocument();
        expect(t.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "Passport number", "Candidate", "Registered", "Status", "Assigned to"]);
        expect(within(t.getByText("CANDIDATE 8").closest("tr")!).getByText("Ann Analyst")).toBeInTheDocument();
        expect(within(t.getByText("CANDIDATE 9").closest("tr")!).getByText("Unallocated")).toBeInTheDocument();
        expect(listCalls(calls).at(-1)!.get("status")).toBe("COMPLETED");

        await user.selectOptions(screen.getByRole("combobox", { name: "Analyst" }), "u-ann");
        await waitFor(() => expect(listCalls(calls).at(-1)!.get("analystId")).toBe("u-ann"));
        expect(listCalls(calls).at(-1)!.get("status")).toBe("COMPLETED");
        await waitFor(() => expect(screen.queryByText("CANDIDATE 9")).toBeNull());
    });

    test("the URL ?view=completed opens it, with its analyst and search sent", async () => {
        const { calls } = completedBackend();
        renderApp("/work-allocation?view=completed&analyst=u-ann&search=synth");
        await table();
        expect(calls.some((c) => c.path === "/api/admin/work-allocation/candidates?status=COMPLETED&page=1&analystId=u-ann&search=synth")).toBe(true);
        expect(screen.getByRole("combobox", { name: "Analyst" })).toHaveValue("u-ann");
    });

    test("leaving Completed clears the Analyst; Unallocated has no Analyst filter, Allocated keeps it", async () => {
        const { calls } = completedBackend();
        renderApp("/work-allocation?view=completed&analyst=u-ann");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /^Unallocated/ }));
        await waitFor(() => expect(listCalls(calls).at(-1)!.get("status")).toBe("UNALLOCATED"));
        expect(listCalls(calls).at(-1)!.has("analystId")).toBe(false);
        expect(screen.queryByRole("combobox", { name: "Analyst" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Allocated" }));
        await waitFor(() => expect(listCalls(calls).at(-1)!.get("status")).toBe("ALLOCATED"));
        expect(screen.getByRole("combobox", { name: "Analyst" })).toBeInTheDocument();
    });

    test("selected completed candidates keep the side-panel actions (Unassign for the allocated one)", async () => {
        completedBackend();
        renderApp("/work-allocation?view=completed");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
        expect(screen.getByRole("button", { name: "Unassign 1" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reassign 2 candidates" })).toBeInTheDocument();
    });

    test("empty Completed list: its own message, and one for an Analyst with none", async () => {
        backend("OWNER", { "GET /api/admin/work-allocation/candidates": { status: 200, body: page([], "COMPLETED") } });
        const first = renderApp("/work-allocation?view=completed");
        expect(await screen.findByText("No candidates are cancelled, rejected or departed yet.", {}, RENDER_STEP)).toBeInTheDocument();
        first.unmount();
        renderApp("/work-allocation?view=completed&analyst=u-ann");
        expect(await screen.findByText("No completed candidates are allocated to this Analyst.", {}, RENDER_STEP)).toBeInTheDocument();
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

describe("Work Allocation: Team Lead and Admin reassignment, Assign to me, removal", () => {
    const TL_ME = { analystId: "admin-1", name: "Test Admin", role: "TEAM_LEAD", assignedCount: 3 };
    const TL_TIA = { analystId: "u-tia", name: "Aaron Lead", role: "TEAM_LEAD", assignedCount: 1 };
    const withTeamLeads = (): AllocationAnalysts => ({
        ...ANALYSTS,
        analysts: [TL_ME, TL_TIA, ...ANALYSTS.analysts.map((a) => ({ ...a, role: "ANALYST" }))],
    });
    const TIA = { analystId: "u-tia", name: "Aaron Lead", active: true, role: "TEAM_LEAD" };
    const ME = { analystId: "admin-1", name: "Test Admin", active: true, role: "TEAM_LEAD" };
    const lead = (extra: FetchRoutes = {}) => backend("TEAM_LEAD", { "GET /api/admin/work-allocation/analysts": { status: 200, body: withTeamLeads() }, ...extra });
    const allocatedRoutes = (...items: AllocationCandidate[]): FetchRoutes => ({ "GET /api/admin/work-allocation/candidates": { status: 200, body: page(items, "ALLOCATED") } });

    for (const role of ["TEAM_LEAD", "ADMIN"]) {
        test(`${role}: sees the page, Team Leads are targets and an allocated candidate shows its assignee; reassign asks first and sends reassign: true`, async () => {
            const { calls } = backend(role, { "GET /api/admin/work-allocation/analysts": { status: 200, body: withTeamLeads() } });
            renderApp("/work-allocation?view=allocated");
            const t = within(await table());
            expect(t.getByRole("columnheader", { name: "Assigned to" })).toBeInTheDocument();
            expect(within(t.getByText("CANDIDATE 5").closest("tr")!).getByText("Ann Analyst")).toBeInTheDocument();
            const user = userEvent.setup();
            await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
            await user.type(await screen.findByLabelText("Candidates for Aaron Lead", {}, RENDER_STEP), "1");
            await user.click(screen.getByRole("button", { name: "Reassign 1 candidates" }));
            expect(posts(calls)).toHaveLength(0);
            await user.click(within(screen.getByRole("dialog", { name: "Reassign candidates?" })).getByRole("button", { name: "Reassign" }));
            expect(await screen.findByText(/^Allocated \d+ candidates/,{}, RENDER_STEP)).toBeInTheDocument();
            expect(posts(calls)[0]).toMatchObject({ path: "/api/admin/work-allocation/assign", body: { candidateIds: ["P0000005"], allocations: [{ analystId: "u-tia", count: 1 }], reassign: true } });
        });
    }

    test("a Team Lead assigns an unallocated candidate to themselves with Assign to me (no confirmation, reassign: false)", async () => {
        const { calls } = lead();
        renderApp("/work-allocation");
        await table();
        const user = userEvent.setup();
        const button = await screen.findByRole("button", { name: "Assign to me" }, RENDER_STEP);
        expect(button).toBeDisabled();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 1" }));
        await user.click(button);
        await waitFor(() => expect(posts(calls)).toHaveLength(1));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(posts(calls)[0]).toMatchObject({ path: "/api/admin/work-allocation/assign", body: { candidateIds: ["P0000001"], allocations: [{ analystId: "admin-1", count: 1 }], reassign: false } });
        expect(await screen.findByRole("status", {}, RENDER_STEP)).toHaveTextContent(/^Allocated \d+ candidates/);
    });

    test("Assign to me on an allocated candidate asks for reassignment first, then sends reassign: true to the user's own id", async () => {
        const { calls } = lead(allocatedRoutes(candidate(5, ANN)));
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.click(await screen.findByRole("button", { name: "Assign to me" }, RENDER_STEP));
        const dialog = within(screen.getByRole("dialog", { name: "Reassign candidates?" }));
        expect(dialog.getByText(/CANDIDATE 5 · now Ann Analyst/)).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
        await user.click(dialog.getByRole("button", { name: "Reassign" }));
        await screen.findByRole("status", {}, RENDER_STEP);
        expect(posts(calls)[0].body).toMatchObject({ candidateIds: ["P0000005"], allocations: [{ analystId: "admin-1", count: 1 }], reassign: true });
    });

    test("Assign to me is not offered to an Admin who is not an assignable Team Lead", async () => {
        backend("ADMIN");
        renderApp("/work-allocation");
        await table();
        await screen.findByRole("list", { name: "Analysts" }, RENDER_STEP);
        expect(screen.queryByRole("button", { name: "Assign to me" })).toBeNull();
    });

    test("Team Lead to Team Lead: a candidate held by another Team Lead moves to this one", async () => {
        const { calls } = lead(allocatedRoutes(candidate(6, TIA)));
        renderApp("/work-allocation?view=allocated");
        const t = within(await table());
        expect(t.getByText("Aaron Lead")).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 6" }));
        await user.click(await screen.findByRole("button", { name: "Assign to me" }, RENDER_STEP));
        await user.click(within(screen.getByRole("dialog", { name: "Reassign candidates?" })).getByRole("button", { name: "Reassign" }));
        await screen.findByRole("status", {}, RENDER_STEP);
        expect(posts(calls)[0].body).toMatchObject({ allocations: [{ analystId: "admin-1", count: 1 }], reassign: true });
    });

    test("Analyst to Team Lead and Team Lead to Analyst, both through the reassign confirmation", async () => {
        const { calls } = lead(allocatedRoutes(candidate(5, ANN), candidate(6, ME)));
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.type(await screen.findByLabelText("Candidates for Aaron Lead", {}, RENDER_STEP), "1");
        await user.click(screen.getByRole("button", { name: "Reassign 1 candidates" }));
        await user.click(within(screen.getByRole("dialog", { name: "Reassign candidates?" })).getByRole("button", { name: "Reassign" }));
        await screen.findByRole("status", {}, RENDER_STEP);
        expect(posts(calls)[0].body).toMatchObject({ candidateIds: ["P0000005"], allocations: [{ analystId: "u-tia", count: 1 }], reassign: true });

        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 6" }));
        await user.type(screen.getByLabelText("Candidates for Ben Analyst"), "1");
        await user.click(screen.getByRole("button", { name: "Reassign 1 candidates" }));
        await user.click(within(screen.getByRole("dialog", { name: "Reassign candidates?" })).getByRole("button", { name: "Reassign" }));
        await waitFor(() => expect(posts(calls)).toHaveLength(2));
        expect(posts(calls)[1].body).toMatchObject({ candidateIds: ["P0000006"], allocations: [{ analystId: "u-ben", count: 1 }], reassign: true });
    });

    test("removal: the confirmation names the candidates, Cancel sends nothing, then success feedback", async () => {
        const { calls } = lead(allocatedRoutes(candidate(5, ANN)));
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.click(screen.getByRole("button", { name: "Unassign 1" }));
        const dialog = within(screen.getByRole("dialog", { name: "Unassign candidates?" }));
        expect(dialog.getByText(/CANDIDATE 5 · now Ann Analyst/)).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Cancel" }));
        expect(posts(calls)).toHaveLength(0);
        await user.click(screen.getByRole("button", { name: "Unassign 1" }));
        await user.click(within(screen.getByRole("dialog", { name: "Unassign candidates?" })).getByRole("button", { name: "Unassign" }));
        expect(await screen.findByRole("status", {}, RENDER_STEP)).toHaveTextContent("unallocated again");
        expect(posts(calls)[0]).toMatchObject({ path: "/api/admin/work-allocation/unassign", body: { candidateIds: ["P0000005"], confirm: true } });
    });

    test("removal failure shows the error on the page and no success message", async () => {
        lead({ ...allocatedRoutes(candidate(5, ANN)), "POST /api/admin/work-allocation/unassign": { status: 403, body: { message: "You may not remove this allocation." } } });
        renderApp("/work-allocation?view=allocated");
        await table();
        const user = userEvent.setup();
        await user.click(screen.getByRole("checkbox", { name: "Select CANDIDATE 5" }));
        await user.click(screen.getByRole("button", { name: "Unassign 1" }));
        await user.click(within(screen.getByRole("dialog", { name: "Unassign candidates?" })).getByRole("button", { name: "Unassign" }));
        expect(await within(screen.getByRole("dialog")).findByText("You may not remove this allocation.", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByText(/unallocated again/)).toBeNull();
    });

    test("unallocated rows are marked, and the page explains that Allocate skips allocated candidates and Reassign moves them", async () => {
        lead();
        renderApp("/work-allocation");
        const t = within(await table());
        expect(t.getAllByText("Unallocated")).toHaveLength(3);
        expect(await screen.findByText(/skips candidates that are already allocated\. To move those, use Reassign/, {}, RENDER_STEP)).toBeInTheDocument();
    });

    for (const role of ["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"]) {
        test(`${role}: no allocation controls and no allocation request`, async () => {
            const { calls } = backend(role);
            renderApp("/work-allocation");
            await expectRedirectedHome(role);
            expect(screen.queryByRole("button", { name: /Assign to me|Allocate|Reassign|Unassign/ })).toBeNull();
            expect(calls.some((c) => c.path.startsWith("/api/admin/work-allocation"))).toBe(false);
        });
    }

});

describe("Candidates for an ANALYST", () => {
    test("the list is exactly what the server returns (scoped there); no Add candidate", async () => {
        const list: CandidateList = {
            items: [1, 2].map((n) => ({ passportId: `P000000${n}`, uniqueId: `000${n}`, name: `MINE ${n}`, nic: null, jobTypes: [], workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })) })),
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
