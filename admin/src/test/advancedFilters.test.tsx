import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList, type CandidateListItem } from "../api/candidates";
import type { CandidateFilterOptions } from "../api/candidateFilters";
import type { AllocationCandidateList } from "../api/workAllocation";
import { ADMIN, RENDER_STEP, expectRedirectedHome, renderApp, signedInBackend } from "./helpers";

// Filters on Admin > Candidates and Work Allocation: the Filters box (which filters to use), each
// chosen filter's dropdown under the search bar, and exactly what is sent to the server (which applies
// every filter before paging; test/advancedCandidateFilters.test.js).
// Synthetic data; the backend is a stub that records every request.

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });
const OPTIONS: CandidateFilterOptions = {
    jobTypes: ["Formwork Carpenter", "Steel Fixer", "Welder"],
    noPreference: { code: "NO_PREFERENCE", label: "No Preferred Type" },
    officers: [{ id: "u-anjana", name: "Anjana", active: true }, { id: "u-old", name: "Former", active: false }],
    clients: [{ id: "11111111-1111-4111-8111-111111111111", name: "ACME" }],
    agents: [{ id: "22222222-2222-4222-8222-222222222222", name: "Bucharest Agent" }],
};
const ANALYST_OPTIONS: CandidateFilterOptions = { jobTypes: OPTIONS.jobTypes, noPreference: OPTIONS.noPreference };
const HANDLER_OPTIONS: CandidateFilterOptions = { ...ANALYST_OPTIONS, clients: OPTIONS.clients, agents: OPTIONS.agents };

const item = (n: number): CandidateListItem => ({
    passportId: `N${String(n).padStart(7, "0")}`, uniqueId: String(n).padStart(4, "0"), name: `CANDIDATE ${n}`, nic: null, jobTypes: ["Welder"],
    workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })),
});
const page = (total: number, current: number, count = Math.min(total, 100)): CandidateList => ({
    items: Array.from({ length: count }, (_, i) => item(i + 1 + (current - 1) * 100)),
    pagination: { page: current, pageSize: 100, total, totalItems: total, totalPages: Math.max(1, Math.ceil(total / 100)) },
    filters: { search: null },
});

function candidatesBackend({ role = "ADMIN", options = OPTIONS, respond }: { role?: string; options?: CandidateFilterOptions; respond?: (url: URL) => CandidateList | Promise<CandidateList> } = {}) {
    return signedInBackend({
        ...asRole(role),
        "GET /api/admin/candidates": async (url) => ({ status: 200, body: respond ? await respond(url) : page(3, Number(url.searchParams.get("page") ?? "1"), 3) }),
        "GET /api/admin/candidate-filter-options": { status: 200, body: options },
    });
}
const listQueries = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.path.startsWith("/api/admin/candidates?")).map((c) => c.url.searchParams);
const lastQuery = (calls: { path: string; url: URL }[]) => listQueries(calls).at(-1)!;

type User = ReturnType<typeof userEvent.setup>;
// Typed text applies after a short pause (no Apply button).
const TEXT_APPLIED = { timeout: 3000 };
const filtersButton = () => screen.findByRole("button", { name: /^Filters/ }, RENDER_STEP);
// The Filters box: tick (or untick) the filters to use. It stays open for several.
const openBox = async (user: User) => {
    await user.click(await filtersButton());
    return within(screen.getByRole("group", { name: "Add filters" }));
};
const addFilter = async (user: User, ...labels: string[]) => {
    const box = await openBox(user);
    for (const label of labels) await user.click(box.getByRole("checkbox", { name: label }));
    await user.keyboard("{Escape}");
};
const bar = () => within(screen.getByRole("group", { name: "Active filters" }));
// A filter's dropdown (its button under the search bar), opened.
const openFilter = async (user: User, label: string) => {
    await user.click(bar().getByRole("button", { name: new RegExp(`^${label}`) }));
    return within(screen.getByRole("group", { name: label }));
};

describe("Candidates: Filters", () => {
    test("UI-1..3 the Filters box lists the filters to add, closes with Escape (focus back on the button), and sends nothing", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates");
        await screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP);
        const user = userEvent.setup();
        const before = listQueries(calls).length;
        const box = await openBox(user);
        expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute("aria-expanded", "true");
        for (const name of ["Job type", "Status", "Current stage", "Sex", "Nationality", "Registered date", "Test date", "Allocation", "Officer", "Current job code", "Client", "Agent"]) {
            expect(box.getByRole("checkbox", { name })).not.toBeChecked();
        }
        // The identity lookups are the search box's job: not offered here.
        for (const name of ["Full name", "Surname", "Other names", "Passport number", "NIC", "WhatsApp number"]) expect(box.queryByRole("checkbox", { name })).toBeNull();
        expect(box.queryByText("Identity")).toBeNull();
        expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("group", { name: "Add filters" })).toBeNull();
        expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus();
        expect(listQueries(calls).length).toBe(before);
    });

    test("UI-4 a chosen filter appears under the search bar as a button; its dropdown applies each pick at once, on page 1", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2");
        await screen.findAllByRole("link", { name: /^CANDIDATE/ }, RENDER_STEP);
        const user = userEvent.setup();
        const before = listQueries(calls).length;
        await addFilter(user, "Job type");
        expect(bar().getByRole("button", { name: "Job type" })).toBeInTheDocument();
        expect(listQueries(calls).length).toBe(before);
        const dropdown = await openFilter(user, "Job type");
        expect(dropdown.getByRole("checkbox", { name: "Steel Fixer" })).toBeInTheDocument();
        await user.click(dropdown.getByRole("checkbox", { name: "Steel Fixer" }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", jobType: "Steel Fixer" }));
        await user.click(dropdown.getByRole("checkbox", { name: "Welder" }));
        await waitFor(() => expect(lastQuery(calls).get("jobType")).toBe("Steel Fixer,Welder"));
        expect(bar().getByRole("button", { name: "Job type: Steel Fixer, Welder" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Filters (1 active)" })).toBeInTheDocument();
        // Escape closes the dropdown, focus back on its button.
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("group", { name: "Job type" })).toBeNull();
        expect(bar().getByRole("button", { name: "Job type: Steel Fixer, Welder" })).toHaveFocus();
    });

    test("UI-5..7 filters stack: text (after a pause, or Enter), match type, status, officer and a date range all reach the server together", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates");
        await screen.findAllByRole("link", { name: /^CANDIDATE/ }, RENDER_STEP);
        const user = userEvent.setup();
        await addFilter(user, "Nationality", "Current job code", "Status", "Officer", "Registered date");
        // Text: applied after the pause in typing.
        let dropdown = await openFilter(user, "Nationality");
        await user.type(dropdown.getByLabelText("Nationality"), "Sri Lankan");
        await waitFor(() => expect(lastQuery(calls).get("nationality")).toBe("Sri Lankan"), TEXT_APPLIED);
        // The match type is remembered before there is text, and applies with it; Enter applies at once.
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Current job code");
        await user.selectOptions(dropdown.getByRole("combobox", { name: "Current job code match" }), "equals");
        expect(lastQuery(calls).has("jobCode")).toBe(false);
        expect(dropdown.getByRole("combobox", { name: "Current job code match" })).toHaveValue("equals");
        await user.type(dropdown.getByLabelText("Current job code"), "J-001{Enter}");
        await waitFor(() => expect([lastQuery(calls).get("jobCode"), lastQuery(calls).get("jobCodeMatch")]).toEqual(["J-001", "equals"]));
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Status");
        await user.click(dropdown.getByRole("checkbox", { name: "Visa Submitted" }));
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Officer");
        await user.click(dropdown.getByRole("checkbox", { name: "Anjana" }));
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Registered date");
        await user.type(dropdown.getByLabelText("From"), "2026-11-01");
        await user.type(dropdown.getByLabelText("To"), "2026-11-30");
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({
            page: "1", pageSize: "100", nationality: "Sri Lankan", jobCode: "J-001", jobCodeMatch: "equals",
            workflowStatus: "VISA_SUBMITTED", analystId: "u-anjana", registeredFrom: "2026-11-01", registeredTo: "2026-11-30",
        }));
        await user.keyboard("{Escape}");
        for (const label of ['Nationality contains "Sri Lankan"', 'Current job code is exactly "J-001"', "Status: Visa Submitted", "Officer: Anjana", "Registered: 1 Nov 2026 – 30 Nov 2026"]) {
            expect(bar().getByRole("button", { name: label })).toBeInTheDocument();
        }
        expect(screen.getByRole("button", { name: "Filters (5 active)" })).toBeInTheDocument();
    });

    test("UI-3b filters in the URL come back as buttons, with their values in the dropdowns", async () => {
        candidatesBackend();
        renderApp("/candidates?nic=1990&nicMatch=startsWith&sex=F");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        expect(screen.getByRole("button", { name: "Filters (2 active)" })).toBeInTheDocument();
        let dropdown = await openFilter(user, "NIC");
        expect(dropdown.getByLabelText("NIC")).toHaveValue("1990");
        expect(dropdown.getByRole("combobox", { name: "NIC match" })).toHaveValue("startsWith");
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Sex");
        expect(dropdown.getByRole("checkbox", { name: "Female" })).toBeChecked();
        await user.keyboard("{Escape}");
        // An older link's identity filter is shown (and can be removed) though the box does not offer it.
        const box = await openBox(user);
        expect(box.queryByRole("checkbox", { name: "NIC" })).toBeNull();
    });

    test("UI-3c an identity filter from an older link can be removed with its x", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2&surname=perera&jobType=Welder");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(bar().getByRole("button", { name: 'Remove filter: Surname contains "perera"' }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", jobType: "Welder" }));
        expect(bar().queryByRole("button", { name: /^Surname/ })).toBeNull();
    });

    test("UI-8 the x on a filter removes only that filter (and goes back to page 1)", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2&search=perera&jobType=Welder&registeredFrom=2026-11-01&registeredTo=2026-11-30&workflowStatus=VISA_SUBMITTED");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(bar().getByRole("button", { name: "Remove filter: Registered: 1 Nov 2026 – 30 Nov 2026" }));
        await waitFor(() => expect(lastQuery(calls).has("registeredFrom")).toBe(false));
        expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "perera", jobType: "Welder", workflowStatus: "VISA_SUBMITTED" });
        expect(bar().queryByRole("button", { name: /^Registered/ })).toBeNull();
        expect(bar().getByRole("button", { name: "Job type: Welder" })).toBeInTheDocument();
    });

    test("UI-8b unticking a filter in the Filters box removes it and its value; an empty one is removed without a request", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?jobType=Welder&sex=M");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        await addFilter(user, "Nationality");
        const before = listQueries(calls).length;
        const box = await openBox(user);
        await user.click(box.getByRole("checkbox", { name: "Nationality" }));
        expect(bar().queryByRole("button", { name: "Nationality" })).toBeNull();
        expect(listQueries(calls).length).toBe(before);
        await user.click(box.getByRole("checkbox", { name: "Sex" }));
        await waitFor(() => expect(lastQuery(calls).has("sex")).toBe(false));
        expect(lastQuery(calls).get("jobType")).toBe("Welder");
    });

    test("UI-9 Clear all filters removes every filter, keeps the quick search, page 1", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=3&search=perera&jobType=Welder&sex=M&name=kamal");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(bar().getByRole("button", { name: "Clear all filters" }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "perera" }));
        expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
        expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    });

    test("UI-10, 11 a filter change resets the page; the quick search keeps the filters (and the filters keep the search)", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2&search=perera");
        await screen.findAllByRole("link", { name: /^CANDIDATE/ }, RENDER_STEP);
        const user = userEvent.setup();
        await addFilter(user, "Job type");
        const dropdown = await openFilter(user, "Job type");
        await user.click(dropdown.getByRole("checkbox", { name: "Welder" }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "perera", jobType: "Welder" }));
        const search = screen.getByRole("combobox", { name: "Search candidates" });
        await user.clear(search);
        await user.type(search, "silva{Enter}");
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "silva", jobType: "Welder" }));
        expect(bar().getByRole("button", { name: "Job type: Welder" })).toBeInTheDocument();
    });

    test("UI-16 moving between pages keeps the filters", async () => {
        const { calls } = candidatesBackend({ respond: (url) => page(250, Number(url.searchParams.get("page") ?? "1")) });
        renderApp("/candidates?jobType=Welder&surname=perera");
        await screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP);
        expect(screen.getByText("250 candidates match the filters (all pages).")).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("button", { name: "Next" }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "2", pageSize: "100", jobType: "Welder", surname: "perera" }));
        expect(await screen.findByRole("link", { name: "CANDIDATE 101" }, RENDER_STEP)).toBeInTheDocument();
        expect(bar().getByRole("button", { name: 'Surname contains "perera"' })).toBeInTheDocument();
    });

    test("UI-12 loading: the current rows stay, dimmed, while the filtered list loads", async () => {
        let release: (() => void) | null = null;
        candidatesBackend({
            respond: (url) => (url.searchParams.has("jobType")
                ? new Promise((resolve) => { release = () => resolve(page(1, 1, 1)); })
                : page(3, 1, 3)),
        });
        renderApp("/candidates");
        await screen.findByRole("link", { name: "CANDIDATE 3" }, RENDER_STEP);
        const user = userEvent.setup();
        await addFilter(user, "Job type");
        const dropdown = await openFilter(user, "Job type");
        await user.click(dropdown.getByRole("checkbox", { name: "Welder" }));
        expect(await screen.findByText("Loading page…")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "CANDIDATE 3" })).toBeInTheDocument();
        await waitFor(() => expect(release).not.toBeNull());
        release!();
        await waitFor(() => expect(screen.queryByRole("link", { name: "CANDIDATE 3" })).toBeNull());
        expect(screen.getByRole("link", { name: "CANDIDATE 1" })).toBeInTheDocument();
    });

    test("UI-13 no results with filters says so (not 'No candidates yet') and offers Clear filters", async () => {
        const { calls } = candidatesBackend({ respond: (url) => (url.searchParams.has("passport") ? page(0, 1, 0) : page(3, 1, 3)) });
        renderApp("/candidates?passport=ZZ");
        expect(await screen.findByText("No candidates match the selected filters.", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByText("No candidates yet")).toBeNull();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Clear filters" }));
        await waitFor(() => expect(lastQuery(calls).has("passport")).toBe(false));
        expect(await screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP)).toBeInTheDocument();
    });
});

describe("Candidates: My allocated (Team Lead)", () => {
    test("a Team Lead toggles the list to their own allocated candidates (analystId = themselves) and back", async () => {
        const { calls } = candidatesBackend({ role: "TEAM_LEAD", options: { ...OPTIONS, officers: [...OPTIONS.officers!, { id: ADMIN.userId, name: ADMIN.name, active: true }] } });
        renderApp("/candidates");
        await screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP);
        const user = userEvent.setup();
        const button = screen.getByRole("button", { name: "My allocated" });
        expect(button).toHaveAttribute("aria-pressed", "false");
        expect(lastQuery(calls).get("analystId")).toBeNull();
        await user.click(button);
        await waitFor(() => expect(lastQuery(calls).get("analystId")).toBe(ADMIN.userId));
        expect(screen.getByRole("button", { name: "My allocated" })).toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByRole("button", { name: "My allocated" }));
        await waitFor(() => expect(lastQuery(calls).get("analystId")).toBeNull());
        expect(screen.getByRole("button", { name: "My allocated" })).toHaveAttribute("aria-pressed", "false");
    });

    for (const role of ["ADMIN", "OWNER", "ANALYST", "JOB_HANDLER"]) {
        test(`${role}: no My allocated button`, async () => {
            candidatesBackend({ role, options: role === "ANALYST" ? ANALYST_OPTIONS : role === "JOB_HANDLER" ? HANDLER_OPTIONS : OPTIONS });
            renderApp("/candidates");
            await screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP);
            expect(screen.queryByRole("button", { name: "My allocated" })).toBeNull();
        });
    }
});

describe("RBAC: what each role is offered (the server checks it too)", () => {
    test("UI-17 ANALYST: filters, but no Allocation, Officer, Client or Agent", async () => {
        candidatesBackend({ role: "ANALYST", options: ANALYST_OPTIONS });
        renderApp("/candidates");
        const user = userEvent.setup();
        const box = await openBox(user);
        expect(box.getByRole("checkbox", { name: "Job type" })).toBeInTheDocument();
        for (const name of ["Allocation", "Officer", "Client", "Agent"]) expect(box.queryByRole("checkbox", { name })).toBeNull();
    });

    test("UI-17 JOB_HANDLER: Client and Agent, no Officer; TEAM_LEAD: everything", async () => {
        candidatesBackend({ role: "JOB_HANDLER", options: HANDLER_OPTIONS });
        const { unmount } = renderApp("/candidates");
        const user = userEvent.setup();
        let box = await openBox(user);
        expect(box.getByRole("checkbox", { name: "Client" })).toBeInTheDocument();
        expect(box.getByRole("checkbox", { name: "Agent" })).toBeInTheDocument();
        expect(box.queryByRole("checkbox", { name: "Officer" })).toBeNull();
        unmount();
        candidatesBackend({ role: "TEAM_LEAD" });
        renderApp("/candidates");
        box = await openBox(user);
        expect(box.getByRole("checkbox", { name: "Officer" })).toBeInTheDocument();
        expect(box.getByRole("checkbox", { name: "Allocation" })).toBeInTheDocument();
    });

    test("UI-17 REGISTRATION_DESK still has no Candidates list (nor its filters)", async () => {
        const { calls } = candidatesBackend({ role: "REGISTRATION_DESK" });
        renderApp("/candidates?jobType=Welder");
        await expectRedirectedHome("REGISTRATION_DESK");
        expect(screen.queryByRole("button", { name: /^Filters/ })).toBeNull();
        expect(listQueries(calls)).toEqual([]);
    });
});

// ---------------------------------------------------------------- Work Allocation

const allocationRow = (n: number, analyst: { analystId: string; name: string; active: boolean } | null = null) => ({
    passportId: `N${String(n).padStart(7, "0")}`, uniqueId: String(n).padStart(4, "0"), name: `ALLOC ${n}`, nic: null, jobTypes: ["Welder"], whatsappNumber: null, contactNumber: null,
    registeredDate: "2026-11-05T04:00:00.000Z", stagesCompleted: 0, stagesTotal: 8, currentStage: "TEST_DETAILS" as const,
    workflowStatus: { code: "REGISTERED" as const, label: "Registered" }, analyst, assignedDate: analyst ? "2026-11-05T04:00:00.000Z" : null,
});
function allocationBackend() {
    return signedInBackend({
        ...asRole("ADMIN"),
        "GET /api/admin/work-allocation/candidates": (url): { status: number; body: AllocationCandidateList } => {
            const allocated = url.searchParams.get("status") === "ALLOCATED";
            const current = Number(url.searchParams.get("page") ?? "1");
            return {
                status: 200,
                body: {
                    items: [allocationRow(current, allocated ? { analystId: "u-anjana", name: "Anjana", active: true } : null)],
                    pagination: { page: current, pageSize: 100, total: 150, totalPages: 2 },
                    filters: { status: allocated ? "ALLOCATED" : "UNALLOCATED", analystId: null, search: null },
                },
            };
        },
        "GET /api/admin/work-allocation/analysts": { status: 200, body: { analysts: [{ analystId: "u-anjana", name: "Anjana", assignedCount: 1 }], unavailableAnalysts: [], unallocatedCount: 150 } },
        "GET /api/admin/candidate-filter-options": { status: 200, body: OPTIONS },
    });
}
const waQueries = (calls: { path: string; url: URL }[]) => calls.filter((c) => c.path.startsWith("/api/admin/work-allocation/candidates")).map((c) => c.url.searchParams);

describe("Work Allocation: Filters per view", () => {
    test("UI-15 Unallocated: the view's own filters (no Officer, no Allocation); each is sent with status=UNALLOCATED", async () => {
        const { calls } = allocationBackend();
        renderApp("/work-allocation");
        await screen.findByText("ALLOC 1", undefined, RENDER_STEP);
        const user = userEvent.setup();
        const box = await openBox(user);
        expect(box.queryByRole("checkbox", { name: "Officer" })).toBeNull();
        expect(box.queryByRole("checkbox", { name: "Allocation" })).toBeNull();
        await user.keyboard("{Escape}");
        await addFilter(user, "Nationality", "Job type", "Registered date");
        let dropdown = await openFilter(user, "Nationality");
        await user.type(dropdown.getByLabelText("Nationality"), "Sri Lankan{Enter}");
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Job type");
        await user.click(dropdown.getByRole("checkbox", { name: "Steel Fixer" }));
        await user.keyboard("{Escape}");
        dropdown = await openFilter(user, "Registered date");
        await user.type(dropdown.getByLabelText("From"), "2026-11-01");
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "UNALLOCATED", page: "1", nationality: "Sri Lankan", jobType: "Steel Fixer", registeredFrom: "2026-11-01" }));
        expect(within(screen.getByRole("region", { name: "Filters" })).getByText("150 candidates match the filters (all pages).")).toBeInTheDocument();
    });

    test("UI-14 Allocated: the Officer filter (one or several) goes to the server as analystId; filters stay while paging", async () => {
        const { calls } = allocationBackend();
        renderApp("/work-allocation?view=allocated&jobType=Welder");
        await screen.findByText("ALLOC 1", undefined, RENDER_STEP);
        const user = userEvent.setup();
        await addFilter(user, "Officer");
        const dropdown = await openFilter(user, "Officer");
        await user.click(dropdown.getByRole("checkbox", { name: "Anjana" }));
        await user.click(dropdown.getByRole("checkbox", { name: "Former (inactive)" }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "ALLOCATED", page: "1", analystId: "u-anjana,u-old", jobType: "Welder" }));
        expect(bar().getByRole("button", { name: "Officer: Anjana, Former (inactive)" })).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: "Analyst" })).toHaveDisplayValue("2 Analysts (Filters)");
        await user.click(within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("button", { name: "Next" }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "ALLOCATED", page: "2", analystId: "u-anjana,u-old", jobType: "Welder" }));
        // Back to Unallocated: the Officer filter no longer applies; the others stay.
        await user.click(screen.getByRole("button", { name: /^Unallocated/ }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "UNALLOCATED", page: "1", jobType: "Welder" }));
    });
});
