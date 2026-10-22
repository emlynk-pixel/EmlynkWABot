import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AgentDetails, AgentList } from "../api/agents";
import type { JobDetails } from "../api/jobs";
import { breadcrumbTrail } from "../components/Breadcrumbs";
import { CLIENT_DETAILS, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// The one breadcrumb of the admin shell (components/Breadcrumbs.tsx): above
// every page and its tabs, clickable back to the section and to Admin.

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const AGENT: AgentDetails = {
    agentId: AGENT_ID, name: "Nimal Perera", countryCode: "LK", status: "ACTIVE", contactNumber: "94771234567", whatsappNumber: null,
    email: null, address: null, notes: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    activeClients: 0, processingJobs: 0, completedJobs: 0, cancelledJobs: 0, clients: [], jobs: { processing: [], completed: [], cancelled: [] }, jobsShownLimit: 50,
};
const AGENTS: AgentList = { items: [AGENT], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 }, filters: { search: null, country: null, status: null }, countries: ["LK"] };
const JOB: JobDetails = {
    jobId: JOB_ID, jobCode: "JOB-2026-000001", companyJobId: null, status: "PROCESSING",
    jobType: { id: "t1", code: "WELDER", name: "Welder" }, client: { id: "c1", name: "Acme Construction" }, responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" },
    countryCode: "RO", fromCountryCode: "RO", vacancies: 5, createdAt: "2026-10-01T05:00:00.000Z", completedAt: null, cancelledAt: null, cancelReason: null,
    filled: false, createdBy: "Test Admin", candidateCount: 0, candidates: [],
};

function backend() {
    return signedInBackend({
        "GET /api/admin/agents": { status: 200, body: AGENTS },
        [`GET /api/admin/agents/${AGENT_ID}`]: { status: 200, body: AGENT },
        "GET /api/admin/agent-options": { status: 200, body: { agents: [] } },
        "GET /api/admin/client-options": { status: 200, body: { clients: [] } },
        [`GET /api/admin/jobs/${JOB_ID}`]: { status: 200, body: JOB },
        "GET /api/admin/clients/N1234567": { status: 200, body: CLIENT_DETAILS },
    });
}
const breadcrumb = () => screen.getByRole("navigation", { name: "Breadcrumb" });
const crumbs = () => within(breadcrumb()).getAllByRole("listitem").map((item) => item.textContent?.replace(/^\//, "").trim());

describe("the trail", () => {
    test("comes from the URL: Admin > section > page; a record's name once the page gives it", () => {
        expect(breadcrumbTrail("/", null)).toEqual([{ label: "Admin", to: "/" }, { label: "Overview" }]);
        expect(breadcrumbTrail("/jobs", null)).toEqual([{ label: "Admin", to: "/" }, { label: "Jobs" }]);
        expect(breadcrumbTrail("/jobs/abc", "JOB-1")).toEqual([{ label: "Admin", to: "/" }, { label: "Jobs", to: "/jobs" }, { label: "JOB-1" }]);
        expect(breadcrumbTrail("/jobs/abc", null).at(-1)).toEqual({ label: "Details" });
        expect(breadcrumbTrail("/client-management/x", "Acme")[1]).toEqual({ label: "Client Management", to: "/client-management" });
        expect(breadcrumbTrail("/clients/N1", "K (N1)")[1]).toEqual({ label: "Clients", to: "/clients" });
        expect(breadcrumbTrail("/candidates/new", null).at(-1)).toEqual({ label: "Register Candidate" });
        expect(breadcrumbTrail("/settings/job-types", null)).toEqual([{ label: "Admin", to: "/" }, { label: "Settings", to: "/settings" }, { label: "Job Types" }]);
        expect(breadcrumbTrail("/reports/daily", null)).toEqual([{ label: "Admin", to: "/" }, { label: "Daily Report" }]);
        expect(breadcrumbTrail("/nowhere", null).at(-1)).toEqual({ label: "Page not found" });
    });
});

describe("BREADCRUMB-001: only one breadcrumb per page", () => {
    for (const path of ["/", "/agents", `/agents/${AGENT_ID}`, `/jobs/${JOB_ID}`, "/clients/N1234567"]) {
        test(path, async () => {
            backend();
            renderApp(path);
            await screen.findByRole("heading", { level: 1 }, RENDER_STEP);
            expect(screen.getAllByRole("navigation", { name: "Breadcrumb" })).toHaveLength(1);
            expect(within(screen.getByRole("banner")).queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
        });
    }

    test("a details page names its record in the breadcrumb (not a second one of its own)", async () => {
        backend();
        renderApp("/clients/N1234567");
        await screen.findByRole("heading", { name: "KAMAL NIMAL PERERA" }, RENDER_STEP);
        await waitFor(() => expect(crumbs()).toEqual(["Admin", "Clients", "KAMAL NIMAL PERERA (N1234567)"]), RENDER_STEP);
        expect(within(breadcrumb()).getByText("KAMAL NIMAL PERERA (N1234567)")).toHaveAttribute("aria-current", "page");
    });
});

describe("BREADCRUMB-002: the links navigate", () => {
    test("Agent details > Agents opens the list; Admin opens the Overview", async () => {
        backend();
        renderApp(`/agents/${AGENT_ID}`);
        await screen.findByRole("heading", { name: "Nimal Perera" }, RENDER_STEP);
        await waitFor(() => expect(crumbs()).toEqual(["Admin", "Agents", "Nimal Perera"]), RENDER_STEP);
        const user = userEvent.setup();
        await user.click(within(breadcrumb()).getByRole("link", { name: "Agents" }));
        expect(await screen.findByRole("table", { name: "Agents" }, RENDER_STEP)).toBeInTheDocument();
        await waitFor(() => expect(crumbs()).toEqual(["Admin", "Agents"]), RENDER_STEP);
        await user.click(within(breadcrumb()).getByRole("link", { name: "Admin" }));
        expect(await screen.findByRole("list", { name: "Clients by completeness" }, RENDER_STEP)).toBeInTheDocument();
        await waitFor(() => expect(crumbs()).toEqual(["Admin", "Overview"]), RENDER_STEP);
    });

    test("Job details > Jobs links back to the Jobs list", async () => {
        backend();
        renderApp(`/jobs/${JOB_ID}`);
        await screen.findByRole("heading", { name: /JOB-2026-000001/ }, RENDER_STEP);
        expect(within(breadcrumb()).getByRole("link", { name: "Jobs" })).toHaveAttribute("href", "/jobs");
        await waitFor(() => expect(crumbs()).toEqual(["Admin", "Jobs", "JOB-2026-000001"]), RENDER_STEP);
    });
});

describe("BREADCRUMB-003: horizontal tabs sit below the breadcrumb", () => {
    for (const [path, tabs] of [[`/agents/${AGENT_ID}`, "Agent sections"], [`/jobs/${JOB_ID}`, "Job sections"]] as const) {
        test(path, async () => {
            backend();
            renderApp(path);
            const tablist = await screen.findByRole("tablist", { name: tabs }, RENDER_STEP);
            expect(breadcrumb().compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(breadcrumb().contains(tablist)).toBe(false);
        });
    }
});
