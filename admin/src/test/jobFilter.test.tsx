import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AgentDetails, AgentJobRow } from "../api/agents";
import type { JobList, JobListItem, JobStatus, JobView } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Jobs open on Processing, or on All when there is no Processing job; every
// view can still be picked, and search / pagination work as before.

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });
const job = (n: number, status: JobStatus): JobListItem => ({
    jobId: `00000000-0000-4000-8000-00000000000${n}`, jobCode: `JOB-2026-00000${n}`, companyJobId: null, status,
    jobType: { id: "t1", code: "WELDER", name: "Welder" }, client: { id: "c1", name: "Acme Construction" }, responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" },
    countryCode: "RO", fromCountryCode: "RO", vacancies: 5, createdAt: `2026-10-0${n}T05:00:00.000Z`,
    completedAt: status === "COMPLETED" ? "2026-10-10T05:00:00.000Z" : null, cancelledAt: status === "CANCELLED" ? "2026-10-11T05:00:00.000Z" : null,
    cancelReason: status === "CANCELLED" ? "Client withdrew" : null, candidateCount: 1, filled: false,
});

// A stub of GET /api/admin/jobs over a fixed set of jobs (status filter, search, two pages of one).
function jobsBackend(jobs: JobListItem[], { pageSize = 50 } = {}, extra: FetchRoutes = {}) {
    return signedInBackend({
        ...asRole("MANAGER"),
        "GET /api/admin/jobs": (url) => {
            const view = (url.searchParams.get("view") ?? "processing") as JobView;
            const search = url.searchParams.get("search");
            const pageNumber = Number(url.searchParams.get("page") ?? "1");
            const matching = jobs.filter((j) => (view === "all" || j.status.toLowerCase() === view) && (!search || j.jobCode.includes(search)));
            const total = matching.length;
            const body: JobList = {
                items: matching.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
                pagination: { page: pageNumber, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
                counts: {
                    processing: jobs.filter((j) => j.status === "PROCESSING").length,
                    completed: jobs.filter((j) => j.status === "COMPLETED").length,
                    cancelled: jobs.filter((j) => j.status === "CANCELLED").length,
                },
                filters: { view, search },
            };
            return { status: 200, body };
        },
        ...extra,
    });
}
const codes = async () => within(await screen.findByRole("table", { name: "Jobs" }, RENDER_STEP)).getAllByRole("link").map((link) => link.textContent);
const jobCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.startsWith("/api/admin/jobs?")).map((c) => c.path);

describe("JOB-FILTER-001: Processing jobs show by default", () => {
    test("with Processing jobs, the list opens on Processing only", async () => {
        const { calls } = jobsBackend([job(1, "PROCESSING"), job(2, "COMPLETED"), job(3, "PROCESSING")]);
        renderApp("/jobs");
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000001", "JOB-2026-000003"]), RENDER_STEP);
        expect(screen.getByRole("tab", { name: "Processing (2)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "All (3)" })).toHaveAttribute("aria-selected", "false");
        expect(jobCalls(calls).every((path) => path.includes("view=processing"))).toBe(true);
    });
});

describe("JOB-FILTER-002: no Processing jobs, All jobs show instead", () => {
    test("the list switches to All automatically, never an empty Processing list", async () => {
        const { calls } = jobsBackend([job(1, "COMPLETED"), job(2, "CANCELLED")]);
        renderApp("/jobs");
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000001", "JOB-2026-000002"]), RENDER_STEP);
        expect(screen.getByRole("tab", { name: "All (2)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.queryByText("No processing jobs")).not.toBeInTheDocument();
        expect(jobCalls(calls).some((path) => path.includes("view=all"))).toBe(true);
    });

    test("with no jobs at all, the empty Processing list stays (nothing to fall back to)", async () => {
        const { calls } = jobsBackend([]);
        renderApp("/jobs");
        expect(await screen.findByText("No processing jobs", {}, RENDER_STEP)).toBeInTheDocument();
        expect(jobCalls(calls).some((path) => path.includes("view=all"))).toBe(false);
    });
});

describe("JOB-FILTER-003: every filter can still be picked", () => {
    test("after the fall back: Processing (kept, even empty), Completed, Cancelled and All", async () => {
        jobsBackend([job(1, "COMPLETED"), job(2, "CANCELLED")]);
        renderApp("/jobs");
        await waitFor(async () => expect(await codes()).toHaveLength(2), RENDER_STEP);
        const user = userEvent.setup();

        await user.click(screen.getByRole("tab", { name: "Processing (0)" }));
        expect(await screen.findByText("No processing jobs", {}, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Processing (0)" })).toHaveAttribute("aria-selected", "true");

        await user.click(screen.getByRole("tab", { name: "Completed (1)" }));
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000001"]), RENDER_STEP);

        await user.click(screen.getByRole("tab", { name: "Cancelled (1)" }));
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000002"]), RENDER_STEP);

        await user.click(screen.getByRole("tab", { name: "All (2)" }));
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000001", "JOB-2026-000002"]), RENDER_STEP);
    });

    test("a view given in the URL is used as is", async () => {
        jobsBackend([job(1, "COMPLETED"), job(2, "PROCESSING")]);
        renderApp("/jobs?view=completed");
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000001"]), RENDER_STEP);
        expect(screen.getByRole("tab", { name: "Completed (1)" })).toHaveAttribute("aria-selected", "true");
    });
});

describe("JOB-FILTER-004: search and pagination are unchanged", () => {
    test("search goes to the server with the current view; Next asks for page 2 of the same view", async () => {
        const { calls } = jobsBackend([job(1, "COMPLETED"), job(2, "CANCELLED"), job(3, "COMPLETED")], { pageSize: 2 });
        renderApp("/jobs");
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000001", "JOB-2026-000002"]), RENDER_STEP);
        const user = userEvent.setup();

        await user.click(within(screen.getByRole("navigation", { name: "Pagination" })).getByRole("button", { name: "Next" }));
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000003"]), RENDER_STEP);
        expect(jobCalls(calls).some((path) => path.includes("view=all") && path.includes("page=2"))).toBe(true);

        await user.type(screen.getByRole("searchbox", { name: "Search jobs" }), "000003");
        await user.click(screen.getByRole("button", { name: "Search" }));
        await waitFor(async () => expect(await codes()).toEqual(["JOB-2026-000003"]), RENDER_STEP);
        const last = jobCalls(calls).at(-1)!;
        expect(last).toContain("search=000003");
        expect(last).toContain("view=all");
        expect(last).toContain("page=1");
    });
});

describe("Agent details: the Jobs tab follows the same default", () => {
    const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
    const row = (n: number, status: JobStatus): AgentJobRow => ({
        jobId: `00000000-0000-4000-8000-0000000000d${n}`, jobCode: `JOB-2026-00000${n}`, companyJobId: null, status,
        client: { id: "c1", name: "Acme Builders" }, jobType: { id: "t1", name: "Welder" }, responsibleAgent: { id: AGENT_ID, name: "Nimal Perera" },
        createdAt: `2026-10-0${n}T00:00:00.000Z`, completedAt: null, cancelledAt: null,
    } as AgentJobRow);
    const agent = (jobs: AgentDetails["jobs"]): AgentDetails => ({
        agentId: AGENT_ID, name: "Nimal Perera", countryCode: "LK", status: "ACTIVE", contactNumber: null, whatsappNumber: null, email: null, address: null, notes: null,
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", activeClients: 0,
        processingJobs: jobs.processing.length, completedJobs: jobs.completed.length, cancelledJobs: jobs.cancelled.length,
        clients: [], jobs, jobsShownLimit: 50,
    });
    const open = (body: AgentDetails) => {
        signedInBackend({ ...asRole("MANAGER"), [`GET /api/admin/agents/${AGENT_ID}`]: { status: 200, body }, "GET /api/admin/agent-options": { status: 200, body: { agents: [] } }, "GET /api/admin/client-options": { status: 200, body: { clients: [] } } });
        renderApp(`/agents/${AGENT_ID}`);
    };
    const agentCodes = async () => within(await screen.findByRole("table", { name: "Jobs of this agent" }, RENDER_STEP)).getAllByRole("link").map((link) => link.textContent);

    test("Processing first when it has jobs", async () => {
        open(agent({ processing: [row(1, "PROCESSING")], completed: [row(2, "COMPLETED")], cancelled: [] }));
        expect(await agentCodes()).toEqual(["JOB-2026-000001"]);
        expect(screen.getByRole("tab", { name: "Processing (1)" })).toHaveAttribute("aria-selected", "true");
    });

    test("All (newest first) when there is no Processing job; Processing can still be picked", async () => {
        open(agent({ processing: [], completed: [row(1, "COMPLETED")], cancelled: [row(2, "CANCELLED")] }));
        expect(await agentCodes()).toEqual(["JOB-2026-000002", "JOB-2026-000001"]);
        expect(screen.getByRole("tab", { name: "All (2)" })).toHaveAttribute("aria-selected", "true");
        await userEvent.setup().click(screen.getByRole("tab", { name: "Processing (0)" }));
        expect(screen.getByText("No processing jobs.")).toBeInTheDocument();
    });
});
