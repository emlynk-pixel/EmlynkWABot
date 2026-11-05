import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateList, type CandidateListItem } from "../api/candidates";
import type { CandidateFilterOptions } from "../api/candidateFilters";
import type { AllocationCandidateList } from "../api/workAllocation";
import { ADMIN, RENDER_STEP, expectRedirectedHome, renderApp, signedInBackend } from "./helpers";

// Advanced filters on Admin > Candidates and Work Allocation: the panel, the chips, and exactly what
// is sent to the server (which applies every filter before paging; test/advancedCandidateFilters.test.js).
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
const openPanel = async (user: ReturnType<typeof userEvent.setup>, name: RegExp = /^Advanced filters/) => {
    await user.click(await screen.findByRole("button", { name }, RENDER_STEP));
    return screen.getByRole("dialog", { name: "Advanced filters" });
};
const group = (dialog: HTMLElement, name: string) => within(within(dialog).getByRole("group", { name: new RegExp(`^${name}`) }));
const chips = () => within(screen.getByRole("group", { name: "Active filters" }));

describe("Candidates: Advanced filters", () => {
    test("UI-1..4 the button is there; the panel opens with the first field focused, shows the controls, and closes (Cancel, Escape) without a request", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates");
        await screen.findByRole("link", { name: "CANDIDATE 1" }, RENDER_STEP);
        const user = userEvent.setup();
        let dialog = await openPanel(user);
        expect(screen.getByRole("button", { name: "Advanced filters" })).toHaveAttribute("aria-expanded", "true");
        await waitFor(() => expect(within(dialog).getByLabelText("Full name")).toHaveFocus());
        for (const label of ["Surname", "Other names", "Passport number", "NIC", "WhatsApp number", "Nationality", "Current job code"]) {
            expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
        }
        expect(within(dialog).getByRole("combobox", { name: "Passport number match" })).toHaveValue("contains");
        for (const name of ["Job type", "Status", "Current stage", "Sex", "Officer", "Client", "Agent", "Registered date", "Test date"]) {
            expect(within(dialog).getByRole("group", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
        }
        expect(group(dialog, "Job type").getByRole("checkbox", { name: "Steel Fixer" })).toBeInTheDocument();
        expect(group(dialog, "Officer").getByRole("checkbox", { name: "Former (inactive)" })).toBeInTheDocument();
        expect(within(dialog).getByRole("combobox", { name: "Allocation" })).toBeInTheDocument();
        const before = listQueries(calls).length;
        await user.type(within(dialog).getByLabelText("Surname"), "PERERA");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByRole("button", { name: "Advanced filters" })).toHaveFocus();
        dialog = await openPanel(user);
        expect(within(dialog).getByLabelText("Surname")).toHaveValue("");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(listQueries(calls).length).toBe(before);
    });

    test("UI-5..7 Apply sends every filter together in ONE request, on page 1; the chips show them", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2");
        await screen.findAllByRole("link", { name: /^CANDIDATE/ }, RENDER_STEP);
        const user = userEvent.setup();
        const dialog = await openPanel(user);
        await user.type(within(dialog).getByLabelText("Surname"), "Perera");
        await user.selectOptions(within(dialog).getByRole("combobox", { name: "Passport number match" }), "startsWith");
        await user.type(within(dialog).getByLabelText("Passport number"), "PN");
        await user.click(group(dialog, "Job type").getByRole("checkbox", { name: "Steel Fixer" }));
        await user.click(group(dialog, "Job type").getByRole("checkbox", { name: "Welder" }));
        await user.click(group(dialog, "Status").getByRole("checkbox", { name: "Visa Submitted" }));
        await user.click(group(dialog, "Officer").getByRole("checkbox", { name: "Anjana" }));
        await user.type(group(dialog, "Registered date").getByLabelText(/^From/), "2026-11-01");
        await user.type(group(dialog, "Registered date").getByLabelText(/^To/), "2026-11-30");
        const before = listQueries(calls).length;
        await user.click(within(dialog).getByRole("button", { name: "Apply filters" }));
        await waitFor(() => expect(listQueries(calls).length).toBe(before + 1));
        const query = lastQuery(calls);
        expect(Object.fromEntries(query)).toEqual({
            page: "1", pageSize: "100", surname: "Perera", passport: "PN", passportMatch: "startsWith", jobType: "Steel Fixer,Welder",
            workflowStatus: "VISA_SUBMITTED", analystId: "u-anjana", registeredFrom: "2026-11-01", registeredTo: "2026-11-30",
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(chips().getByText('Surname contains "Perera"')).toBeInTheDocument();
        expect(chips().getByText('Passport number starts with "PN"')).toBeInTheDocument();
        expect(chips().getByText("Job type: Steel Fixer, Welder")).toBeInTheDocument();
        expect(chips().getByText("Status: Visa Submitted")).toBeInTheDocument();
        expect(chips().getByText("Officer: Anjana")).toBeInTheDocument();
        expect(chips().getByText("Registered: 1 Nov 2026 – 30 Nov 2026")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Advanced filters (6 active)" })).toBeInTheDocument();
    });

    test("UI-3b reopening shows the applied filters for editing", async () => {
        candidatesBackend();
        renderApp("/candidates?nic=1990&nicMatch=startsWith&sex=F");
        const user = userEvent.setup();
        const dialog = await openPanel(user, /^Advanced filters \(2 active\)/);
        expect(within(dialog).getByLabelText("NIC")).toHaveValue("1990");
        expect(within(dialog).getByRole("combobox", { name: "NIC match" })).toHaveValue("startsWith");
        expect(group(dialog, "Sex").getByRole("checkbox", { name: "Female" })).toBeChecked();
    });

    test("UI-8 removing one chip removes only that filter (and goes back to page 1)", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2&search=perera&jobType=Welder&registeredFrom=2026-11-01&registeredTo=2026-11-30&workflowStatus=VISA_SUBMITTED");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(chips().getByRole("button", { name: "Remove filter: Registered: 1 Nov 2026 – 30 Nov 2026" }));
        await waitFor(() => expect(lastQuery(calls).has("registeredFrom")).toBe(false));
        expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "perera", jobType: "Welder", workflowStatus: "VISA_SUBMITTED" });
        expect(chips().queryByText(/^Registered/)).toBeNull();
        expect(chips().getByText("Job type: Welder")).toBeInTheDocument();
    });

    test("UI-9 Clear all removes every advanced filter, keeps the quick search, page 1", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=3&search=perera&jobType=Welder&sex=M&name=kamal");
        await screen.findByRole("group", { name: "Active filters" }, RENDER_STEP);
        const user = userEvent.setup();
        await user.click(chips().getByRole("button", { name: "Clear all filters" }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "perera" }));
        expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
        expect(screen.getByRole("button", { name: "Advanced filters" })).toBeInTheDocument();
        // The panel's own Clear all does the same.
        await user.click(screen.getByRole("button", { name: "Advanced filters" }));
        await user.click(group(screen.getByRole("dialog"), "Sex").getByRole("checkbox", { name: "Male" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply filters" }));
        await waitFor(() => expect(lastQuery(calls).get("sex")).toBe("M"));
        await user.click(screen.getByRole("button", { name: "Advanced filters (1 active)" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear all" }));
        await waitFor(() => expect(lastQuery(calls).has("sex")).toBe(false));
    });

    test("UI-10, 11 a filter change resets the page; the quick search keeps the filters (and the filters keep the search)", async () => {
        const { calls } = candidatesBackend();
        renderApp("/candidates?page=2&search=perera");
        await screen.findAllByRole("link", { name: /^CANDIDATE/ }, RENDER_STEP);
        const user = userEvent.setup();
        const dialog = await openPanel(user);
        await user.click(group(dialog, "Job type").getByRole("checkbox", { name: "Welder" }));
        await user.click(within(dialog).getByRole("button", { name: "Apply filters" }));
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "perera", jobType: "Welder" }));
        const search = screen.getByRole("combobox", { name: "Search candidates" });
        await user.clear(search);
        await user.type(search, "silva{Enter}");
        await waitFor(() => expect(Object.fromEntries(lastQuery(calls))).toEqual({ page: "1", pageSize: "100", search: "silva", jobType: "Welder" }));
        expect(chips().getByText("Job type: Welder")).toBeInTheDocument();
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
        expect(chips().getByText('Surname contains "perera"')).toBeInTheDocument();
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
        const dialog = await openPanel(user);
        await user.click(group(dialog, "Job type").getByRole("checkbox", { name: "Welder" }));
        await user.click(within(dialog).getByRole("button", { name: "Apply filters" }));
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

describe("RBAC: what each role is offered (the server checks it too)", () => {
    test("UI-17 ANALYST: filters, but no Allocation, Officer, Client or Agent", async () => {
        candidatesBackend({ role: "ANALYST", options: ANALYST_OPTIONS });
        renderApp("/candidates");
        const user = userEvent.setup();
        const dialog = await openPanel(user);
        expect(within(dialog).getByRole("group", { name: /^Job type/ })).toBeInTheDocument();
        for (const name of [/^Officer/, /^Client/, /^Agent/]) expect(within(dialog).queryByRole("group", { name })).toBeNull();
        expect(within(dialog).queryByRole("combobox", { name: "Allocation" })).toBeNull();
        expect(within(dialog).queryByRole("region", { name: "Allocation" })).toBeNull();
    });

    test("UI-17 JOB_HANDLER: Client and Agent, no Officer; TEAM_LEAD: everything", async () => {
        candidatesBackend({ role: "JOB_HANDLER", options: HANDLER_OPTIONS });
        const { unmount } = renderApp("/candidates");
        const user = userEvent.setup();
        let dialog = await openPanel(user);
        expect(group(dialog, "Client").getByRole("checkbox", { name: "ACME" })).toBeInTheDocument();
        expect(within(dialog).queryByRole("group", { name: /^Officer/ })).toBeNull();
        unmount();
        candidatesBackend({ role: "TEAM_LEAD" });
        renderApp("/candidates");
        dialog = await openPanel(user);
        expect(within(dialog).getByRole("group", { name: /^Officer/ })).toBeInTheDocument();
        expect(within(dialog).getByRole("combobox", { name: "Allocation" })).toBeInTheDocument();
    });

    test("UI-17 REGISTRATION_DESK still has no Candidates list (nor its filters)", async () => {
        const { calls } = candidatesBackend({ role: "REGISTRATION_DESK" });
        renderApp("/candidates?jobType=Welder");
        await expectRedirectedHome("REGISTRATION_DESK");
        expect(screen.queryByRole("button", { name: /^Advanced filters/ })).toBeNull();
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

describe("Work Allocation: Advanced filters per view", () => {
    test("UI-15 Unallocated: the view's own filters (no Officer, no Allocation); Apply sends them with status=UNALLOCATED", async () => {
        const { calls } = allocationBackend();
        renderApp("/work-allocation");
        await screen.findByText("ALLOC 1", undefined, RENDER_STEP);
        const user = userEvent.setup();
        const dialog = await openPanel(user);
        expect(within(dialog).queryByRole("group", { name: /^Officer/ })).toBeNull();
        expect(within(dialog).queryByRole("combobox", { name: "Allocation" })).toBeNull();
        await user.type(within(dialog).getByLabelText("NIC"), "1990");
        await user.click(group(dialog, "Job type").getByRole("checkbox", { name: "Steel Fixer" }));
        await user.type(group(dialog, "Registered date").getByLabelText(/^From/), "2026-11-01");
        await user.click(within(dialog).getByRole("button", { name: "Apply filters" }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "UNALLOCATED", page: "1", nic: "1990", jobType: "Steel Fixer", registeredFrom: "2026-11-01" }));
        expect(within(screen.getByRole("region", { name: "Filters" })).getByText("150 candidates match the filters (all pages).")).toBeInTheDocument();
    });

    test("UI-14 Allocated: the Officer filter (one or several) goes to the server as analystId; filters stay while paging", async () => {
        const { calls } = allocationBackend();
        renderApp("/work-allocation?view=allocated&jobType=Welder");
        await screen.findByText("ALLOC 1", undefined, RENDER_STEP);
        const user = userEvent.setup();
        const dialog = await openPanel(user);
        await user.click(group(dialog, "Officer").getByRole("checkbox", { name: "Anjana" }));
        await user.click(group(dialog, "Officer").getByRole("checkbox", { name: "Former (inactive)" }));
        await user.click(within(dialog).getByRole("button", { name: "Apply filters" }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "ALLOCATED", page: "1", analystId: "u-anjana,u-old", jobType: "Welder" }));
        expect(chips().getByText("Officer: Anjana, Former (inactive)")).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: "Analyst" })).toHaveDisplayValue("2 Analysts (Advanced filters)");
        await user.click(within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("button", { name: "Next" }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "ALLOCATED", page: "2", analystId: "u-anjana,u-old", jobType: "Welder" }));
        // Back to Unallocated: the Officer filter no longer applies; the others stay.
        await user.click(screen.getByRole("button", { name: /^Unallocated/ }));
        await waitFor(() => expect(Object.fromEntries(waQueries(calls).at(-1)!)).toEqual({ status: "UNALLOCATED", page: "1", jobType: "Welder" }));
    });
});
