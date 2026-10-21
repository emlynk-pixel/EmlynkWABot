import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AgentDetails, AgentList, AgentListItem } from "../api/agents";
import type { ClientDetails, ClientList, ClientListItem } from "../api/clientManagement";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });
const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-0000000000a2";
const CLIENT_ID = "00000000-0000-4000-8000-0000000000c1";

const agent = (extra: Partial<AgentListItem> = {}): AgentListItem => ({
    agentId: AGENT_ID, name: "Nimal Perera", countryCode: "LK", status: "ACTIVE", contactNumber: "94771234567", whatsappNumber: null,
    email: null, address: null, notes: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    activeClients: 2, processingJobs: 3, completedJobs: 4, cancelledJobs: 1, ...extra,
});
const PAGINATION = { page: 1, pageSize: 25, total: 1, totalPages: 1 };
const agentList = (items: AgentListItem[]): AgentList => ({ items, pagination: { ...PAGINATION, total: items.length }, filters: { search: null, country: null, status: null }, countries: ["LK", "RO"] });
const JOB_ROW = { jobId: "00000000-0000-4000-8000-0000000000d1", jobCode: "JOB-2026-000001", companyJobId: null, status: "PROCESSING" as const, client: { id: CLIENT_ID, name: "Acme Builders" }, jobType: { id: "t1", name: "Welder" }, responsibleAgent: { id: AGENT_ID, name: "Nimal Perera" }, createdAt: "2026-10-02T00:00:00.000Z", completedAt: null, cancelledAt: null };
const agentDetails = (extra: Partial<AgentDetails> = {}): AgentDetails => ({
    ...agent(), clients: [{ clientId: CLIENT_ID, name: "Acme Builders", status: "ACTIVE", processingJobs: 3 }],
    jobs: { processing: [JOB_ROW], completed: [], cancelled: [] }, jobsShownLimit: 50, ...extra,
});

const client = (extra: Partial<ClientListItem> = {}): ClientListItem => ({
    clientId: CLIENT_ID, name: "Acme Builders", status: "ACTIVE", countryCodes: ["LK"],
    agents: [{ agentId: AGENT_ID, name: "Nimal Perera", countryCode: "LK", status: "ACTIVE" }],
    contactPerson: "Mr Silva", contactNumber: null, whatsappNumber: null, email: null, address: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", processingJobs: 1, completedJobs: 2, cancelledJobs: 0, ...extra,
});
const clientList = (items: ClientListItem[]): ClientList => ({ items, pagination: { ...PAGINATION, total: items.length }, filters: { search: null, country: null, status: null, agentId: null }, countries: ["LK"] });
const clientDetails = (extra: Partial<ClientDetails> = {}): ClientDetails => ({
    ...client(), jobs: { processing: [{ ...JOB_ROW, activeCandidates: 2 }], completed: [], cancelled: [] }, jobsShownLimit: 50, ...extra,
});
const AGENT_OPTIONS = { agents: [
    { agentId: AGENT_ID, name: "Nimal Perera", countryCode: "LK", status: "ACTIVE" },
    { agentId: OTHER_AGENT_ID, name: "Ion Popescu", countryCode: "RO", status: "ACTIVE" },
    { agentId: "00000000-0000-4000-8000-0000000000a3", name: "Retired Agent", countryCode: "LK", status: "INACTIVE" },
] };

const CLIENT_OPTIONS = { clients: [{ clientId: CLIENT_ID, name: "Acme Builders", status: "ACTIVE" }] };

function backend(role: string, routes: FetchRoutes = {}) {
    return signedInBackend({ ...asRole(role), "GET /api/admin/agent-options": { status: 200, body: AGENT_OPTIONS }, "GET /api/admin/client-options": { status: 200, body: CLIENT_OPTIONS }, ...routes });
}

describe("navigation and roles", () => {
    test("ADMIN and MANAGER see Agents and Client Management next to the legacy Clients-free sidebar", async () => {
        for (const role of ["ADMIN", "MANAGER"]) {
            backend(role);
            const { unmount } = renderApp("/");
            await screen.findByTestId("admin-name", {}, RENDER_STEP);
            expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
            expect(screen.getByRole("link", { name: "Client Management" })).toHaveAttribute("href", "/client-management");
            unmount();
        }
    });

    test.each(["ANALYST", "REGISTRATION_DESK"])("%s has neither entry and, by URL, gets a restricted page with no API call", async (role) => {
        const { calls } = backend(role);
        renderApp("/agents");
        await screen.findByTestId("admin-name", {}, RENDER_STEP);
        expect(screen.queryByRole("link", { name: "Agents" })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Client Management" })).not.toBeInTheDocument();
        expect(await screen.findByText("Access Restricted", {}, RENDER_STEP)).toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/agents"))).toBe(false);
    });

    test.each(["ANALYST", "REGISTRATION_DESK"])("%s opening /client-management gets a restricted page with no API call", async (role) => {
        const { calls } = backend(role);
        renderApp("/client-management");
        expect(await screen.findByText("Access Restricted", {}, RENDER_STEP)).toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/client-management"))).toBe(false);
    });

    test("the legacy candidate Clients route still opens its own page, not Client Management", async () => {
        backend("MANAGER", { "GET /api/admin/clients": { status: 200, body: { items: [], pagination: PAGINATION, filters: { search: null } } } });
        renderApp("/clients");
        expect(await screen.findByRole("heading", { name: "Clients", level: 1 }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add client" })).not.toBeInTheDocument();
    });
});

describe("Agents list", () => {
    test("shows the agent, country, active clients, processing and completed jobs, status", async () => {
        backend("MANAGER", { "GET /api/admin/agents": { status: 200, body: agentList([agent()]) } });
        renderApp("/agents");
        const table = await screen.findByRole("table", { name: "Agents" }, RENDER_STEP);
        expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Agent", "Country", "Active clients", "Processing jobs", "Completed jobs", "Status", "Actions"]);
        const row = within(table).getAllByRole("row")[1];
        expect(within(row).getAllByRole("cell").map((c) => c.textContent?.trim()).slice(0, 6)).toEqual(["Nimal Perera", "Sri Lanka", "2", "3", "4", "Active"]);
        expect(within(row).getByRole("link", { name: "Nimal Perera" })).toHaveAttribute("href", `/agents/${AGENT_ID}`);
    });

    test("search, country and status filters go to the server", async () => {
        const { calls } = backend("ADMIN", { "GET /api/admin/agents": { status: 200, body: agentList([agent()]) } });
        renderApp("/agents");
        const user = userEvent.setup();
        await screen.findByRole("table", { name: "Agents" }, RENDER_STEP);
        await user.type(screen.getByLabelText("Search agents"), "nimal{enter}");
        await user.selectOptions(screen.getByLabelText("Country"), "RO");
        await user.selectOptions(screen.getByLabelText("Status"), "INACTIVE");
        await waitFor(() => {
            const last = calls.filter((c) => c.path.startsWith("/api/admin/agents?")).at(-1)!;
            expect(Object.fromEntries(last.url.searchParams)).toEqual({ page: "1", search: "nimal", country: "RO", status: "INACTIVE" });
        });
    });

    test("Add agent needs a name and a country, sends the normalised body, and reloads", async () => {
        const { calls } = backend("MANAGER", {
            "GET /api/admin/agents": { status: 200, body: agentList([]) },
            "POST /api/admin/agents": { status: 201, body: agentDetails() },
        });
        renderApp("/agents");
        const user = userEvent.setup();
        await screen.findByText("No agents yet", {}, RENDER_STEP);
        await user.click(screen.getByRole("button", { name: "Add agent" }));
        const dialog = await screen.findByRole("dialog", { name: "Add agent" });
        const save = within(dialog).getByRole("button", { name: "Add agent" });
        expect(save).toBeDisabled();
        await user.type(within(dialog).getByLabelText(/Agent name/), "  Nimal Perera ");
        expect(save).toBeDisabled();
        await user.selectOptions(within(dialog).getByLabelText(/Country/), "LK");
        await user.type(within(dialog).getByLabelText(/Contact number/), "0771234567");
        await within(dialog).findByRole("list", { name: "Clients" });
        await user.click(save);
        await waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({
            name: "Nimal Perera", countryCode: "LK", contactNumber: "0771234567", whatsappNumber: null, email: null, address: null, notes: null, clientIds: [],
        }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    test("a server validation error is shown against the field and the dialog stays open", async () => {
        backend("MANAGER", {
            "GET /api/admin/agents": { status: 200, body: agentList([]) },
            "POST /api/admin/agents": { status: 400, body: { message: "Invalid request body", errors: [{ field: "contactNumber", message: "must be a phone number (for example 0771234567 or +94771234567)" }] } },
        });
        renderApp("/agents");
        const user = userEvent.setup();
        await screen.findByText("No agents yet", {}, RENDER_STEP);
        await user.click(screen.getByRole("button", { name: "Add agent" }));
        const dialog = await screen.findByRole("dialog", { name: "Add agent" });
        await user.type(within(dialog).getByLabelText(/Agent name/), "A");
        await user.selectOptions(within(dialog).getByLabelText(/Country/), "LK");
        await user.type(within(dialog).getByLabelText(/Contact number/), "12");
        await within(dialog).findByRole("list", { name: "Clients" });
        await user.click(within(dialog).getByRole("button", { name: "Add agent" }));
        expect(await within(dialog).findByText(/must be a phone number/)).toBeInTheDocument();
    });

    test("making an agent inactive shows the server's refusal when it has PROCESSING jobs", async () => {
        const { calls } = backend("ADMIN", {
            "GET /api/admin/agents": { status: 200, body: agentList([agent()]) },
            [`PATCH /api/admin/agents/${AGENT_ID}/status`]: { status: 409, body: { message: "This agent has 3 PROCESSING jobs. Complete or cancel them before making the agent inactive.", code: "AGENT_HAS_PROCESSING_JOBS" } },
        });
        renderApp("/agents");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Make inactive Nimal Perera" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Make agent inactive" });
        await user.click(within(dialog).getByRole("button", { name: "Make inactive" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("3 PROCESSING jobs");
        expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "INACTIVE" });
        expect(screen.getByRole("dialog", { name: "Make agent inactive" })).toBeInTheDocument();
    });

    test("there is no delete control anywhere", async () => {
        backend("ADMIN", { "GET /api/admin/agents": { status: 200, body: agentList([agent()]) } });
        renderApp("/agents");
        await screen.findByRole("table", { name: "Agents" }, RENDER_STEP);
        expect(screen.queryByRole("button", { name: /delete|remove/i })).not.toBeInTheDocument();
    });
});

describe("Agent details", () => {
    test("shows the agent, its clients and its jobs by status, linked to the Job record", async () => {
        backend("MANAGER", { [`GET /api/admin/agents/${AGENT_ID}`]: { status: 200, body: agentDetails() } });
        renderApp(`/agents/${AGENT_ID}`);
        expect(await screen.findByRole("heading", { name: "Nimal Perera" }, RENDER_STEP)).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("tab", { name: "Clients (1)" }));
        const clients = screen.getByRole("table", { name: "Clients of this agent" });
        expect(within(clients).getByRole("link", { name: "Acme Builders" })).toHaveAttribute("href", `/client-management/${CLIENT_ID}`);
        await user.click(screen.getByRole("tab", { name: /^Jobs/ }));
        const jobs = screen.getByRole("table", { name: "Jobs of this agent" });
        expect(within(jobs).getByRole("link", { name: "JOB-2026-000001" })).toHaveAttribute("href", `/jobs/${JOB_ROW.jobId}`);
        expect(screen.getByRole("tab", { name: "Processing (3)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "Completed (4)" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Cancelled (1)" })).toBeInTheDocument();
    });

    test("an unknown agent shows a not-found message", async () => {
        backend("MANAGER", { [`GET /api/admin/agents/${AGENT_ID}`]: { status: 404, body: { message: "Agent not found", code: "AGENT_NOT_FOUND" } } });
        renderApp(`/agents/${AGENT_ID}`);
        expect(await screen.findByText("Agent not found.", {}, RENDER_STEP)).toBeInTheDocument();
    });
});

describe("Client Management list", () => {
    test("shows client, country, processing and completed jobs, status (no Responsible agent column)", async () => {
        backend("MANAGER", { "GET /api/admin/client-management": { status: 200, body: clientList([client()]) } });
        renderApp("/client-management");
        const table = await screen.findByRole("table", { name: "Clients" }, RENDER_STEP);
        expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Client", "Country", "Processing jobs", "Completed jobs", "Status", "Actions"]);
        const row = within(table).getAllByRole("row")[1];
        expect(within(row).getAllByRole("cell").map((c) => c.textContent?.trim()).slice(0, 5)).toEqual(["Acme Builders", "Sri Lanka", "1", "2", "Active"]);
        expect(within(row).queryByRole("link", { name: "Nimal Perera" })).not.toBeInTheDocument();
    });

    test("agent, country, status and search filters go to the server", async () => {
        const { calls } = backend("ADMIN", { "GET /api/admin/client-management": { status: 200, body: clientList([client()]) } });
        renderApp("/client-management");
        const user = userEvent.setup();
        await screen.findByRole("table", { name: "Clients" }, RENDER_STEP);
        await user.selectOptions(screen.getByLabelText("Agent"), OTHER_AGENT_ID);
        await user.selectOptions(screen.getByLabelText("Country"), "LK");
        await user.selectOptions(screen.getByLabelText("Status"), "ACTIVE");
        await user.type(screen.getByLabelText("Search clients"), "acme{enter}");
        await waitFor(() => {
            const last = calls.filter((c) => c.path.startsWith("/api/admin/client-management?")).at(-1)!;
            expect(Object.fromEntries(last.url.searchParams)).toEqual({ page: "1", agentId: OTHER_AGENT_ID, country: "LK", status: "ACTIVE", search: "acme" });
        });
    });

    test("Add client: ACTIVE agents can be ticked (inactive ones cannot) and their ids are sent, not names", async () => {
        const { calls } = backend("MANAGER", {
            "GET /api/admin/client-management": { status: 200, body: clientList([]) },
            "POST /api/admin/client-management": { status: 201, body: clientDetails() },
        });
        renderApp("/client-management");
        const user = userEvent.setup();
        await screen.findByText("No clients yet", {}, RENDER_STEP);
        await user.click(screen.getByRole("button", { name: "Add client" }));
        const dialog = await screen.findByRole("dialog", { name: "Add client" });
        const list = await within(dialog).findByRole("list", { name: "Agents" });
        expect(within(list).getAllByRole("checkbox").map((box) => [box.closest("li")!.textContent, (box as HTMLInputElement).disabled])).toEqual([
            ["Nimal PereraSri Lanka", false], ["Ion PopescuRomania", false], ["Retired AgentSri Lanka · inactive", true],
        ]);
        expect(within(dialog).getByRole("button", { name: "Add client" })).toBeDisabled();
        await user.type(within(dialog).getByLabelText(/Client name/), "Acme Builders");
        await user.click(within(list).getByRole("checkbox", { name: /Nimal Perera/ }));
        expect(within(dialog).getByText(/Country: Sri Lanka/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Add client" }));
        await waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({
            name: "Acme Builders", agentIds: [AGENT_ID], contactPerson: null, contactNumber: null, whatsappNumber: null, email: null, address: null,
        }));
    });

    test("editing a client starts with its agents and saves them as the full list", async () => {
        const { calls } = backend("MANAGER", {
            "GET /api/admin/client-management": { status: 200, body: clientList([client()]) },
            [`PATCH /api/admin/client-management/${CLIENT_ID}`]: { status: 200, body: clientDetails() },
        });
        renderApp("/client-management");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Edit Acme Builders" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Edit client" });
        expect(within(dialog).getByRole("checkbox", { name: /Nimal Perera/ })).toBeChecked();
        await user.clear(within(dialog).getByLabelText(/Client name/));
        await user.type(within(dialog).getByLabelText(/Client name/), "Acme Group");
        await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ name: "Acme Group", agentIds: [AGENT_ID] }));
        expect(calls.find((c) => c.method === "PATCH")!.body).not.toHaveProperty("agentId");
    });

    test("making a client inactive shows the server's PROCESSING-jobs refusal", async () => {
        backend("ADMIN", {
            "GET /api/admin/client-management": { status: 200, body: clientList([client()]) },
            [`PATCH /api/admin/client-management/${CLIENT_ID}/status`]: { status: 409, body: { message: "This client has 1 PROCESSING job. Complete or cancel it before making the client inactive.", code: "CLIENT_HAS_PROCESSING_JOBS" } },
        });
        renderApp("/client-management");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Make inactive Acme Builders" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Make client inactive" });
        await user.click(within(dialog).getByRole("button", { name: "Make inactive" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("1 PROCESSING job");
    });
});

describe("Client details", () => {
    test("shows the agents, the jobs by status and links to the Job record", async () => {
        backend("MANAGER", { [`GET /api/admin/client-management/${CLIENT_ID}`]: { status: 200, body: clientDetails() } });
        renderApp(`/client-management/${CLIENT_ID}`);
        expect(await screen.findByRole("heading", { name: "Acme Builders" }, RENDER_STEP)).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("tab", { name: "Agents (1)" }));
        expect(screen.getByRole("link", { name: "Nimal Perera" })).toHaveAttribute("href", `/agents/${AGENT_ID}`);
        await user.click(screen.getByRole("tab", { name: /^Job Details/ }));
        const jobs = screen.getByRole("table", { name: "Jobs of this client" });
        const cells = within(jobs).getAllByRole("row")[1];
        expect(within(cells).getByRole("link", { name: "JOB-2026-000001" })).toHaveAttribute("href", `/jobs/${JOB_ROW.jobId}`);
        expect(within(cells).getByText("Welder")).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Completed (2)" })).toBeInTheDocument();
    });

    test("Edit agents (Agents tab) adds another ACTIVE agent and sends the full list of ids", async () => {
        const { calls } = backend("MANAGER", {
            [`GET /api/admin/client-management/${CLIENT_ID}`]: { status: 200, body: clientDetails() },
            [`PATCH /api/admin/client-management/${CLIENT_ID}`]: { status: 200, body: clientDetails() },
        });
        renderApp(`/client-management/${CLIENT_ID}`);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("tab", { name: "Agents (1)" }, RENDER_STEP));
        await user.click(screen.getByRole("button", { name: "Edit agents" }));
        const dialog = await screen.findByRole("dialog", { name: "Edit client" });
        expect(within(dialog).getByText(/existing jobs keep the agent/i)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("checkbox", { name: /Ion Popescu/ }));
        await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ agentIds: [AGENT_ID, OTHER_AGENT_ID] }));
    });
});
