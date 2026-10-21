import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { AgentDetails, AgentList, AgentListItem } from "../api/agents";
import type { ClientDetails, ClientList, ClientListItem } from "../api/clientManagement";
import type { JobDetails, JobOptions } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Agent <-> Client many-to-many in the Admin (UI-REL-001 to UI-REL-011): several clients on an
// agent and several agents on a client (create and edit, preselected), every agent on Client
// details, no Responsible agent column in the client list, horizontal tabs on both details pages
// (Job Details / Jobs first), and New job choosing the responsible agent of a multi-agent client.
// Synthetic data; the backend is a stub (the rules are in test/agentClientManyToMany.test.js).
// UI-REL-012 (375px layout) is checked in a real browser: jsdom has no layout.

const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const A3 = "00000000-0000-4000-8000-0000000000a3";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const PAGINATION = { page: 1, pageSize: 25, total: 1, totalPages: 1 };

const ref = (agentId: string, name: string, countryCode: string) => ({ agentId, name, countryCode, status: "ACTIVE" as const });
const AGENT_OPTIONS = { agents: [ref(A1, "Nimal Perera", "LK"), ref(A2, "Ion Popescu", "RO"), { ...ref(A3, "Retired Agent", "LK"), status: "INACTIVE" as const }] };
const CLIENT_OPTIONS = { clients: [{ clientId: C1, name: "Acme Builders", status: "ACTIVE" }, { clientId: C2, name: "Beta Foods", status: "ACTIVE" }] };

const agentItem = (extra: Partial<AgentListItem> = {}): AgentListItem => ({
    agentId: A1, name: "Nimal Perera", countryCode: "LK", status: "ACTIVE", contactNumber: null, whatsappNumber: null, email: null, address: null, notes: "Prefers email",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", activeClients: 2, processingJobs: 1, completedJobs: 0, cancelledJobs: 0, ...extra,
});
const JOB_ROW = { jobId: "00000000-0000-4000-8000-0000000000d1", jobCode: "JOB-2026-000001", companyJobId: null, status: "PROCESSING" as const, client: { id: C1, name: "Acme Builders" }, jobType: { id: "t1", name: "Welder" }, responsibleAgent: { id: A1, name: "Nimal Perera" }, createdAt: "2026-10-02T00:00:00.000Z", completedAt: null, cancelledAt: null };
const agentDetails = (extra: Partial<AgentDetails> = {}): AgentDetails => ({
    ...agentItem(),
    clients: [{ clientId: C1, name: "Acme Builders", status: "ACTIVE", processingJobs: 1 }, { clientId: C2, name: "Beta Foods", status: "ACTIVE", processingJobs: 0 }],
    jobs: { processing: [JOB_ROW], completed: [], cancelled: [] }, jobsShownLimit: 50, ...extra,
});
const clientItem = (extra: Partial<ClientListItem> = {}): ClientListItem => ({
    clientId: C1, name: "Acme Builders", status: "ACTIVE", agents: [ref(A2, "Ion Popescu", "RO"), ref(A1, "Nimal Perera", "LK")], countryCodes: ["LK", "RO"],
    contactPerson: "Mr Silva", contactNumber: null, whatsappNumber: null, email: null, address: "Colombo 3",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", processingJobs: 1, completedJobs: 0, cancelledJobs: 0, ...extra,
});
const clientDetails = (extra: Partial<ClientDetails> = {}): ClientDetails => ({ ...clientItem(), jobs: { processing: [{ ...JOB_ROW, activeCandidates: 3 }], completed: [], cancelled: [] }, jobsShownLimit: 50, ...extra });
const agentList = (items: AgentListItem[]): AgentList => ({ items, pagination: { ...PAGINATION, total: items.length }, filters: { search: null, country: null, status: null }, countries: ["LK"] });
const clientList = (items: ClientListItem[]): ClientList => ({ items, pagination: { ...PAGINATION, total: items.length }, filters: { search: null, country: null, status: null, agentId: null }, countries: ["LK", "RO"] });

function backend(routes: FetchRoutes = {}) {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "MANAGER" } } },
        "GET /api/admin/agent-options": { status: 200, body: AGENT_OPTIONS },
        "GET /api/admin/client-options": { status: 200, body: CLIENT_OPTIONS },
        ...routes,
    });
}

describe("Agent: several clients", () => {
    test("UI-REL-001: Add agent selects several clients (each once) and sends their ids", async () => {
        const { calls } = backend({ "GET /api/admin/agents": { status: 200, body: agentList([]) }, "POST /api/admin/agents": { status: 201, body: agentDetails() } });
        renderApp("/agents");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add agent" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Add agent" });
        await user.type(within(dialog).getByLabelText(/Agent name/), "Nimal Perera");
        await user.selectOptions(within(dialog).getByLabelText(/^Country/), "LK");
        const list = await within(dialog).findByRole("list", { name: "Clients" });
        await user.click(within(list).getByRole("checkbox", { name: "Acme Builders" }));
        await user.click(within(list).getByRole("checkbox", { name: "Beta Foods" }));
        const chips = within(dialog).getByRole("list", { name: "Selected clients" });
        expect(within(chips).getAllByRole("listitem").map((li) => li.textContent?.replace("×", ""))).toEqual(["Acme Builders", "Beta Foods"]);
        // Removing a chip unticks it; ticking again adds it once.
        await user.click(within(chips).getByRole("button", { name: "Remove Beta Foods" }));
        expect(within(list).getByRole("checkbox", { name: "Beta Foods" })).not.toBeChecked();
        await user.click(within(list).getByRole("checkbox", { name: "Beta Foods" }));
        await user.click(within(dialog).getByRole("button", { name: "Add agent" }));
        await waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ name: "Nimal Perera", countryCode: "LK", clientIds: [C1, C2] }));
    });

    test("UI-REL-002: Edit agent (from the list) loads and preselects every current client; unticking one sends the reduced list", async () => {
        const { calls } = backend({
            "GET /api/admin/agents": { status: 200, body: agentList([agentItem()]) },
            [`GET /api/admin/agents/${A1}`]: { status: 200, body: agentDetails() },
            [`PATCH /api/admin/agents/${A1}`]: { status: 200, body: agentDetails() },
        });
        renderApp("/agents");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Edit Nimal Perera" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
        const list = await within(dialog).findByRole("list", { name: "Clients" });
        expect(within(list).getByRole("checkbox", { name: "Acme Builders" })).toBeChecked();
        expect(within(list).getByRole("checkbox", { name: "Beta Foods" })).toBeChecked();
        await user.click(within(list).getByRole("checkbox", { name: "Beta Foods" }));
        await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ clientIds: [C1] }));
    });
});

describe("Client: several agents", () => {
    test("UI-REL-003: Add client selects several active agents; inactive ones cannot be ticked; the countries follow", async () => {
        const { calls } = backend({ "GET /api/admin/client-management": { status: 200, body: clientList([]) }, "POST /api/admin/client-management": { status: 201, body: clientDetails() } });
        renderApp("/client-management");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add client" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Add client" });
        await user.type(within(dialog).getByLabelText(/Client name/), "Acme Builders");
        const list = within(dialog).getByRole("list", { name: "Agents" });
        expect(within(list).getByRole("checkbox", { name: /Retired Agent/ })).toBeDisabled();
        await user.click(within(list).getByRole("checkbox", { name: /Nimal Perera/ }));
        await user.click(within(list).getByRole("checkbox", { name: /Ion Popescu/ }));
        expect(within(dialog).getByText(/Country: Sri Lanka, Romania/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Add client" }));
        await waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ name: "Acme Builders", agentIds: [A1, A2] }));
    });

    test("UI-REL-004: Edit client preselects every agent; removing one sends exactly the others; none left blocks saving", async () => {
        const { calls } = backend({
            "GET /api/admin/client-management": { status: 200, body: clientList([clientItem()]) },
            [`PATCH /api/admin/client-management/${C1}`]: { status: 200, body: clientDetails() },
        });
        renderApp("/client-management");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Edit Acme Builders" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Edit client" });
        const chips = within(dialog).getByRole("list", { name: "Selected agents" });
        expect(within(chips).getAllByRole("listitem").map((li) => li.textContent?.replace("×", ""))).toEqual(["Ion Popescu", "Nimal Perera"]);
        await user.click(within(chips).getByRole("button", { name: "Remove Ion Popescu" }));
        await user.click(within(chips).getByRole("button", { name: "Remove Nimal Perera" }));
        expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
        await user.click(within(dialog).getByRole("checkbox", { name: /Nimal Perera/ }));
        await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ agentIds: [A1] }));
    });

    test("UI-REL-006: the client list has no Responsible agent column; the Agent filter still works", async () => {
        const { calls } = backend({ "GET /api/admin/client-management": { status: 200, body: clientList([clientItem()]) } });
        renderApp("/client-management");
        const user = userEvent.setup();
        const table = await screen.findByRole("table", { name: "Clients" }, RENDER_STEP);
        const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
        expect(headers).not.toContain("Responsible agent");
        expect(headers).toEqual(["Client", "Country", "Processing jobs", "Completed jobs", "Status", "Actions"]);
        const cells = within(within(table).getAllByRole("row")[1]).getAllByRole("cell");
        expect(cells).toHaveLength(headers.length);
        expect(cells[1].textContent).toBe("Sri Lanka, Romania");
        await user.selectOptions(screen.getByLabelText("Agent"), A2);
        await waitFor(() => expect(calls.filter((c) => c.path.startsWith("/api/admin/client-management?")).at(-1)!.url.searchParams.get("agentId")).toBe(A2));
    });
});

describe("Client details tabs", () => {
    test("UI-REL-007 / 008: horizontal tabs, Job Details first and open by default", async () => {
        backend({ [`GET /api/admin/client-management/${C1}`]: { status: 200, body: clientDetails() } });
        renderApp(`/client-management/${C1}`);
        const tablist = await screen.findByRole("tablist", { name: "Client sections" }, RENDER_STEP);
        expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Job Details (1)", "Client Details", "Agents (2)"]);
        expect(within(tablist).getByRole("tab", { name: "Job Details (1)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("table", { name: "Jobs of this client" })).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Agents of this client" })).not.toBeInTheDocument();
    });

    test("UI-REL-005: the Agents tab lists ALL the client's agents (none marked primary); Client Details keeps every field", async () => {
        backend({ [`GET /api/admin/client-management/${C1}`]: { status: 200, body: clientDetails() } });
        renderApp(`/client-management/${C1}`);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("tab", { name: "Agents (2)" }, RENDER_STEP));
        const table = screen.getByRole("table", { name: "Agents of this client" });
        const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((c) => c.textContent));
        expect(rows).toEqual([["Ion Popescu", "Romania", "Active"], ["Nimal Perera", "Sri Lanka", "Active"]]);
        expect(screen.queryByText(/primary|main agent/i)).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: /responsible agent/i })).not.toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Client Details" }));
        for (const label of ["Country", "Contact person", "Contact number", "WhatsApp number", "Email", "Address", "Created"]) expect(screen.getByText(label)).toBeInTheDocument();
        expect(screen.getByText("Sri Lanka, Romania")).toBeInTheDocument();
        expect(screen.getByText("Colombo 3")).toBeInTheDocument();
    });

    test("UI-REL-011: Edit and the status action still work from the Client details page", async () => {
        const { calls } = backend({
            [`GET /api/admin/client-management/${C1}`]: { status: 200, body: clientDetails({ processingJobs: 0 }) },
            [`PATCH /api/admin/client-management/${C1}/status`]: { status: 200, body: clientDetails({ status: "INACTIVE" }) },
            [`PATCH /api/admin/client-management/${C1}`]: { status: 200, body: clientDetails() },
        });
        renderApp(`/client-management/${C1}`);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Edit" }, RENDER_STEP));
        const edit = await screen.findByRole("dialog", { name: "Edit client" });
        await user.clear(within(edit).getByLabelText(/Contact person/));
        await user.type(within(edit).getByLabelText(/Contact person/), "Ms Perera");
        await user.click(within(edit).getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && !c.path.endsWith("/status"))!.body).toMatchObject({ contactPerson: "Ms Perera", agentIds: [A2, A1] }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Make inactive" }));
        const status = await screen.findByRole("dialog", { name: "Make client inactive" });
        await user.click(within(status).getByRole("button", { name: "Make inactive" }));
        await waitFor(() => expect(calls.find((c) => c.path.endsWith("/status"))!.body).toEqual({ status: "INACTIVE" }));
    });
});

describe("Agent details tabs", () => {
    test("UI-REL-009 / 010: horizontal tabs, Jobs first and open by default; the other tabs keep the details and clients", async () => {
        backend({ [`GET /api/admin/agents/${A1}`]: { status: 200, body: agentDetails() } });
        renderApp(`/agents/${A1}`);
        const tablist = await screen.findByRole("tablist", { name: "Agent sections" }, RENDER_STEP);
        expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Jobs (1)", "Agent Details", "Clients (2)"]);
        expect(within(tablist).getByRole("tab", { name: "Jobs (1)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("table", { name: "Jobs of this agent" })).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(within(tablist).getByRole("tab", { name: "Agent Details" }));
        expect(screen.getByText("Prefers email")).toBeInTheDocument();
        await user.click(within(tablist).getByRole("tab", { name: "Clients (2)" }));
        expect(within(screen.getByRole("table", { name: "Clients of this agent" })).getAllByRole("link").map((l) => l.textContent)).toEqual(["Acme Builders", "Beta Foods"]);
    });

    test("UI-REL-011: Edit clients and the status action still work from the Agent details page", async () => {
        const { calls } = backend({
            [`GET /api/admin/agents/${A1}`]: { status: 200, body: agentDetails() },
            [`PATCH /api/admin/agents/${A1}`]: { status: 200, body: agentDetails() },
            [`PATCH /api/admin/agents/${A1}/status`]: { status: 409, body: { message: "This agent has 1 PROCESSING job.", code: "AGENT_HAS_PROCESSING_JOBS" } },
        });
        renderApp(`/agents/${A1}`);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("tab", { name: "Clients (2)" }, RENDER_STEP));
        await user.click(screen.getByRole("button", { name: "Edit clients" }));
        const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
        expect(await within(dialog).findByRole("checkbox", { name: "Beta Foods" })).toBeChecked();
        await user.click(within(dialog).getByRole("checkbox", { name: "Acme Builders" }));
        await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && !c.path.endsWith("/status"))!.body).toMatchObject({ clientIds: [C2] }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Make inactive" }));
        const status = await screen.findByRole("dialog", { name: "Make agent inactive" });
        await user.click(within(status).getByRole("button", { name: "Make inactive" }));
        expect(await within(status).findByRole("alert")).toHaveTextContent("1 PROCESSING job");
    });
});

describe("New job for a client with several agents", () => {
    const OPTIONS: JobOptions = {
        jobTypes: [{ id: "t1", name: "Welder", code: "WELDER" }],
        clients: [{ id: "c1", name: "Shared Co", agentIds: ["a1", "a2"] }, { id: "c2", name: "Solo Co", agentIds: ["a1"] }],
        agents: [{ id: "a1", name: "Nimal Perera", countryCode: "LK" }, { id: "a2", name: "Ion Popescu", countryCode: "RO" }],
    };
    const created = { jobId: "00000000-0000-4000-8000-000000000009", jobCode: "JOB-2026-000009" } as JobDetails;

    test("the responsible agent must be chosen (nothing pre-picked); the To Country is the chosen agent's; a one-agent client needs no choice", async () => {
        const { calls } = backend({
            "GET /api/admin/jobs": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, counts: { processing: 0, completed: 0, cancelled: 0 }, filters: { view: "processing", search: null } } },
            "GET /api/admin/job-options": { status: 200, body: OPTIONS },
            "GET /api/admin/candidates": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, filters: { search: null } } },
            "POST /api/admin/jobs": { status: 201, body: created },
            [`GET /api/admin/jobs/${created.jobId}`]: { status: 404, body: { message: "Job not found" } },
        });
        renderApp("/jobs");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "New job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        await user.selectOptions(await within(dialog).findByLabelText("Job type"), "t1");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c2");
        expect(within(dialog).getByTestId("job-agent")).toHaveTextContent("Nimal Perera (LK)");
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("Sri Lanka");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        const agentSelect = within(dialog).getByLabelText("Responsible agent") as HTMLSelectElement;
        expect(agentSelect.value).toBe("");
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("The chosen agent's country");
        expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
        await user.selectOptions(agentSelect, "a2");
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("Romania");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await user.click(await within(dialog).findByRole("button", { name: "Create job" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ clientId: "c1", responsibleAgentId: "a2" }));
    });
});
