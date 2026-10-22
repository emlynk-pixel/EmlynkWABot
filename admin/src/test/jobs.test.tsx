import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { CandidateList } from "../api/candidates";
import type { JobDetails, JobList, JobListItem, JobOptions, JobStatus } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Admin > Jobs: the Processing / Completed / Cancelled views, Job details,
// Add to Job and the active-job conflict, and who sees what. Synthetic data;
// the backend is a stub (the rules themselves are in test/jobManagement.test.js).

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });

const job = (n: number, status: JobStatus = "PROCESSING", extra: Partial<JobListItem> = {}): JobListItem => ({
    jobId: `00000000-0000-4000-8000-00000000000${n}`,
    jobCode: `JOB-2026-00000${n}`,
    companyJobId: null,
    status,
    jobType: { id: "t1", code: "WELDER", name: "Welder" },
    client: { id: "c1", name: "Acme Construction" },
    responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" },
    countryCode: "RO",
    fromCountryCode: "RO",
    vacancies: 5,
    createdAt: "2026-10-01T05:00:00.000Z",
    completedAt: status === "COMPLETED" ? "2026-10-10T05:00:00.000Z" : null,
    cancelledAt: status === "CANCELLED" ? "2026-10-11T05:00:00.000Z" : null,
    cancelReason: status === "CANCELLED" ? "Client withdrew" : null,
    candidateCount: n,
    filled: false,
    ...extra,
});
const page = (items: JobListItem[], view: "processing" | "completed" | "cancelled" = "processing"): JobList => ({
    items,
    pagination: { page: 1, pageSize: 50, total: items.length, totalItems: items.length, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
    counts: { processing: 2, completed: 1, cancelled: 1 },
    filters: { view, search: null },
});
const details = (base: JobListItem, candidates: JobDetails["candidates"] = []): JobDetails => ({ ...base, createdBy: "Test Admin", candidateCount: candidates.length, candidates });
const CAND: JobDetails["candidates"][number] = { passportId: "N0000001", uniqueId: "0001", name: "KAMAL PERERA", nic: "199012345678", assignedAt: "2026-10-02T05:00:00.000Z", workflowStatus: { code: "JOB_ASSIGNED", label: "Job Assigned" } };
const OPTIONS: JobOptions = {
    jobTypes: [{ id: "t1", name: "Welder", code: "WELDER" }],
    clients: [{ id: "c1", name: "Acme Construction", agentIds: ["a1"] }],
    agents: [{ id: "a1", name: "Ion Popescu", countryCode: "RO" }],
};
const SEARCH_RESULT: CandidateList = {
    items: [{ passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: null, jobTypes: [], workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: [] }],
    pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    filters: { search: "saman" },
};

function backend(role = "MANAGER", extra: FetchRoutes = {}) {
    return signedInBackend({
        ...asRole(role),
        "GET /api/admin/jobs": (url) => {
            const view = url.searchParams.get("view") ?? "processing";
            if (view === "completed") return { status: 200, body: page([job(3, "COMPLETED")], "completed") };
            if (view === "cancelled") return { status: 200, body: page([job(4, "CANCELLED")], "cancelled") };
            return { status: 200, body: page([job(2), job(1)]) };
        },
        "GET /api/admin/job-options": { status: 200, body: OPTIONS },
        ...extra,
    });
}
const table = () => screen.findByRole("table", { name: "Jobs" }, RENDER_STEP);
// Job details opens on its Job Details tab; the assigned candidates are on the other tab.
const openCandidatesTab = async (user: ReturnType<typeof userEvent.setup>) => user.click(await screen.findByRole("tab", { name: /^Assigned Candidates/ }, RENDER_STEP));
// New job Step 2 lists the eligible candidates (none here unless a test gives some).
const NO_ELIGIBLE = { "GET /api/admin/candidates": { status: 200, body: { ...SEARCH_RESULT, items: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } } } };

describe("Jobs list", () => {
    test("Processing is the default view: code, type, country, agent, company, candidates, vacancies, status", async () => {
        backend();
        renderApp("/jobs");
        const rows = within(await table()).getAllByRole("row");
        // JOBS-CLEANUP: no Client column (the job keeps its client on the server).
        expect(within(rows[0]).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Job code", "Client Job ID", "Job type", "To Country", "From Country", "Responsible agent", "Candidates", "Vacancies", "Status"]);
        expect(rows).toHaveLength(3);
        const first = within(rows[1]).getAllByRole("cell");
        expect(first.map((c) => c.textContent)).toEqual(["JOB-2026-000002Created 01 Oct 2026", "Not assigned", "Welder", "Romania", "Romania", "Ion Popescu", "2", "2 / 5", "Processing"]);
        expect(within(await table()).queryByText("Acme Construction")).toBeNull();
        expect(within(rows[1]).getByRole("link", { name: "JOB-2026-000002" })).toHaveAttribute("href", "/jobs/00000000-0000-4000-8000-000000000002");
        expect(screen.getByRole("tab", { name: "Processing (2)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "Completed (1)" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Cancelled (1)" })).toBeInTheDocument();
    });

    test("the Completed and Cancelled views show their own jobs", async () => {
        backend();
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.click(screen.getByRole("tab", { name: /^Completed/ }));
        const completed = within(await screen.findByRole("table", { name: "Jobs" })).getAllByRole("row")[1];
        await waitFor(() => expect(within(completed).getByRole("link", { name: "JOB-2026-000003" })).toBeInTheDocument());
        expect(within(completed).getByText("Completed")).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: /^Completed/ })).toHaveAttribute("aria-selected", "true");

        await user.click(screen.getByRole("tab", { name: /^Cancelled/ }));
        await waitFor(() => expect(screen.getByRole("link", { name: "JOB-2026-000004" })).toBeInTheDocument());
        expect(screen.getByText("Cancelled", { selector: "span" })).toBeInTheDocument();
    });

    test("search is sent to the server; an empty result says so", async () => {
        const { calls } = backend("MANAGER", { "GET /api/admin/jobs": (url) => ({ status: 200, body: page(url.searchParams.get("search") ? [] : [job(1)]) }) });
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.type(screen.getByRole("searchbox", { name: "Search jobs" }), "nobody");
        await user.click(screen.getByRole("button", { name: "Search" }));
        expect(await screen.findByText("No jobs match your search")).toBeInTheDocument();
        expect(calls.some((c) => c.path.includes("search=nobody"))).toBe(true);
    });
});

describe("who sees what", () => {
    test("ADMIN and MANAGER get New job; an ANALYST gets the list without it; the sidebar shows Jobs", async () => {
        for (const role of ["ADMIN", "MANAGER"]) {
            backend(role);
            const view = renderApp("/jobs");
            await table();
            expect(screen.getByRole("button", { name: "New job" })).toBeInTheDocument();
            expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
            view.unmount();
        }
        backend("ANALYST");
        renderApp("/jobs");
        await table();
        expect(screen.queryByRole("button", { name: "New job" })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
        expect(screen.getByText("Jobs that include candidates allocated to you.")).toBeInTheDocument();
    });

    test("REGISTRATION_DESK has no Jobs entry and the page is restricted (no request is made)", async () => {
        const { calls } = backend("REGISTRATION_DESK");
        renderApp("/jobs");
        expect(await screen.findByRole("heading", { name: "Access Restricted" }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Jobs" })).not.toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/jobs"))).toBe(false);
    });
});

describe("New job", () => {
    test("needs a type and client; the agent and the country come from the client; opens the new job", async () => {
        const created = details(job(5, "PROCESSING", { candidateCount: 0 }));
        const { calls } = backend("MANAGER", {
            ...NO_ELIGIBLE,
            "POST /api/admin/jobs": { status: 201, body: created },
            [`GET /api/admin/jobs/${created.jobId}`]: { status: 200, body: created },
        });
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.click(screen.getByRole("button", { name: "New job" }));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        const next = await within(dialog).findByRole("button", { name: "Next" });
        expect(next).toBeDisabled();
        await user.selectOptions(await within(dialog).findByLabelText("Job type"), "t1");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        await user.type(within(dialog).getByLabelText(/Vacancies/), "5");
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("Romania");
        await user.click(next);
        await user.click(await within(dialog).findByRole("button", { name: "Create job" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({ jobTypeId: "t1", clientId: "c1", responsibleAgentId: "a1", vacancies: 5, companyJobId: null, fromCountryCode: "RO", candidateIds: [] }));
        expect(await screen.findByRole("heading", { name: /JOB-2026-000005/ }, RENDER_STEP)).toBeInTheDocument();
    });

    test("an invalid vacancies number blocks saving", async () => {
        backend();
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.click(screen.getByRole("button", { name: "New job" }));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        await user.selectOptions(await within(dialog).findByLabelText("Job type"), "t1");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        await user.type(within(dialog).getByLabelText(/Vacancies/), "0");
        expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
    });
});

describe("Job details", () => {
    const base = job(2);
    const path = `/jobs/${base.jobId}`;
    const getJob = (body: JobDetails) => ({ [`GET /api/admin/jobs/${base.jobId}`]: { status: 200, body } });

    test("shows every detail and the candidates, each linking to Candidate Details", async () => {
        backend("MANAGER", getJob(details(base, [CAND])));
        renderApp(path);
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        for (const text of ["JOB-2026-000002", "Welder", "Romania", "Ion Popescu", "5"]) expect(within(list).getAllByText(text).length).toBeGreaterThan(0);
        // JOBS-CLEANUP: Job Details no longer shows the Client.
        expect(within(list).queryByText("Client")).toBeNull();
        expect(within(list).queryByText("Acme Construction")).toBeNull();
        expect(within(list).getByText(/Test Admin/)).toBeInTheDocument();
        await openCandidatesTab(userEvent.setup());
        const rows = within(screen.getByRole("table", { name: "Assigned candidates" })).getAllByRole("row");
        expect(within(rows[1]).getByRole("link", { name: "KAMAL PERERA" })).toHaveAttribute("href", "/candidates/N0000001");
        expect(screen.getByRole("heading", { name: "Assigned candidates (1)" })).toBeInTheDocument();
        for (const name of ["Add to job", "Complete job", "Cancel job"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    });

    test("a completed job shows its history and no change actions; a cancelled one shows the reason", async () => {
        const done = job(3, "COMPLETED");
        backend("MANAGER", { [`GET /api/admin/jobs/${done.jobId}`]: { status: 200, body: details(done, [CAND]) } });
        renderApp(`/jobs/${done.jobId}`);
        await openCandidatesTab(userEvent.setup());
        expect(await screen.findByText(/the assignment history is kept/, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add to job" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Complete job" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "KAMAL PERERA" })).toBeInTheDocument();
    });

    test("cancelled: the reason is shown", async () => {
        const gone = job(4, "CANCELLED");
        backend("ADMIN", { [`GET /api/admin/jobs/${gone.jobId}`]: { status: 200, body: details(gone, [CAND]) } });
        renderApp(`/jobs/${gone.jobId}`);
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("Client withdrew")).toBeInTheDocument();
        expect(within(list).getByText("Cancel reason")).toBeInTheDocument();
    });

    test("an ANALYST sees the job read-only", async () => {
        backend("ANALYST", getJob(details(base, [CAND])));
        renderApp(path);
        await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        for (const name of ["Add to job", "Complete job", "Cancel job"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
        await openCandidatesTab(userEvent.setup());
        expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "KAMAL PERERA" })).toBeInTheDocument();
    });

    test("JOB-PASS-007: the Add candidate search asks the server for candidates who passed the test only, and says so", async () => {
        const { calls } = backend("MANAGER", { ...getJob(details(base, [CAND])), "GET /api/admin/candidates": { status: 200, body: { ...SEARCH_RESULT, items: [] } } });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        expect(within(dialog).getByText("Only candidates who passed the test can be added to a job.")).toBeInTheDocument();
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "failed person");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        expect(await within(dialog).findByText("No eligible candidates found.")).toBeInTheDocument();
        const search = calls.find((c) => c.path.startsWith("/api/admin/candidates?"))!;
        expect(Object.fromEntries(search.url.searchParams)).toMatchObject({ search: "failed person", testResult: "PASS" });
    });

    test("JOB-PASS-008: if the server refuses a candidate who has not passed, its message is shown and nothing is added", async () => {
        const { calls } = backend("MANAGER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/candidates": { status: 200, body: SEARCH_RESULT },
            [`POST /api/admin/jobs/${base.jobId}/candidates`]: { status: 409, body: { message: "Candidate must pass the test before being assigned to a job.", code: "CANDIDATE_TEST_NOT_PASSED" } },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "saman");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add SAMAN SILVA" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("Candidate must pass the test before being assigned to a job.");
        expect(screen.getByRole("tab", { name: "Assigned Candidates (1)" })).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    test("Add to job: search, add, and the active-job conflict is shown (nothing is moved)", async () => {
        const after = details(base, [CAND, { ...CAND, passportId: "N0000002", name: "SAMAN SILVA" }]);
        let attempt = 0;
        const { calls } = backend("MANAGER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/candidates": { status: 200, body: SEARCH_RESULT },
            [`POST /api/admin/jobs/${base.jobId}/candidates`]: () => (++attempt === 1
                ? { status: 409, body: { message: "This candidate is already on the PROCESSING job JOB-2026-000007. Complete or cancel that job, or remove the candidate from it, first.", code: "CANDIDATE_ON_ACTIVE_JOB" } }
                : { status: 201, body: after }),
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "saman");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add SAMAN SILVA" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("already on the PROCESSING job JOB-2026-000007");
        expect(screen.getByRole("tab", { name: "Assigned Candidates (1)" })).toBeInTheDocument();

        await user.click(within(dialog).getByRole("button", { name: "Add SAMAN SILVA" }));
        expect(await within(dialog).findByRole("status")).toHaveTextContent("SAMAN SILVA was added.");
        expect(within(dialog).getByText("On this job")).toBeInTheDocument();
        expect(await screen.findByRole("tab", { name: "Assigned Candidates (2)" })).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ passportId: "N0000002" }, { passportId: "N0000002" }]);
    });

    test("Cancel job needs a reason; Complete asks first", async () => {
        const cancelled = details(job(2, "CANCELLED"), [CAND]);
        const { calls } = backend("MANAGER", {
            ...getJob(details(base, [CAND])),
            [`POST /api/admin/jobs/${base.jobId}/cancel`]: { status: 200, body: cancelled },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Cancel job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Cancel JOB-2026-000002/ });
        const confirm = within(dialog).getByRole("button", { name: "Cancel job" });
        expect(confirm).toBeDisabled();
        await user.type(within(dialog).getByLabelText("Reason for cancelling"), "Client withdrew");
        await user.click(confirm);
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({ reason: "Client withdrew" }));
        expect(await screen.findByText("Cancel reason")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Complete job" })).not.toBeInTheDocument();
    });

    test("Complete job: confirm, then the job shows as completed with its candidates kept", async () => {
        const completed = details(job(2, "COMPLETED"), [CAND]);
        const { calls } = backend("MANAGER", {
            ...getJob(details(base, [CAND])),
            [`POST /api/admin/jobs/${base.jobId}/complete`]: { status: 200, body: completed },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Complete job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Complete JOB-2026-000002/ });
        expect(calls.some((c) => c.method === "POST")).toBe(false);
        await user.click(within(dialog).getByRole("button", { name: "Complete job" }));
        await openCandidatesTab(user);
        expect(await screen.findByText(/the assignment history is kept/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "KAMAL PERERA" })).toBeInTheDocument();
    });

    test("Remove candidate asks first and updates the list", async () => {
        const removed = details(base, []);
        const { calls } = backend("MANAGER", {
            ...getJob(details(base, [CAND])),
            [`DELETE /api/admin/jobs/${base.jobId}/candidates/N0000001`]: { status: 200, body: removed },
        });
        renderApp(path);
        const user = userEvent.setup();
        await openCandidatesTab(user);
        await user.click(await screen.findByRole("button", { name: "Remove KAMAL PERERA from the job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Remove candidate?" });
        await user.click(within(dialog).getByRole("button", { name: "Remove" }));
        expect(await screen.findByText("No candidates are assigned to this job.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    });
});

describe("Client Job ID", () => {
    const base = job(2, "PROCESSING", { companyJobId: "Y26S01" });
    const path = `/jobs/${base.jobId}`;

    test("the list and the details show the internal code and the Client Job ID as two different things", async () => {
        backend("MANAGER", {
            "GET /api/admin/jobs": { status: 200, body: page([base, job(1)]) },
            [`GET /api/admin/jobs/${base.jobId}`]: { status: 200, body: details(base, [CAND]) },
        });
        const view = renderApp("/jobs");
        const rows = within(await table()).getAllByRole("row");
        const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);
        expect(cells(rows[1])[0]).toContain("JOB-2026-000002");
        expect(cells(rows[1])[1]).toBe("Y26S01");
        expect(cells(rows[2])[1]).toBe("Not assigned");
        view.unmount();

        renderApp(path);
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("Internal job code")).toBeInTheDocument();
        expect(within(list).getByText("JOB-2026-000002")).toBeInTheDocument();
        expect(within(list).getByText("Client Job ID")).toBeInTheDocument();
        expect(within(list).getByText("Y26S01")).toBeInTheDocument();
    });

    test("ADMIN and MANAGER can add or change it; the request changes only that field", async () => {
        const changed = details({ ...base, companyJobId: "IL-2026-44" }, [CAND]);
        const { calls } = backend("MANAGER", {
            [`GET /api/admin/jobs/${base.jobId}`]: { status: 200, body: details({ ...base, companyJobId: null }, [CAND]) },
            [`PUT /api/admin/jobs/${base.jobId}`]: { status: 200, body: changed },
        });
        renderApp(path);
        const user = userEvent.setup();
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("Not assigned")).toBeInTheDocument();
        await user.click(within(list).getByRole("button", { name: "Add Client Job ID" }));
        const dialog = await screen.findByRole("dialog", { name: "Client Job ID" });
        const save = within(dialog).getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();
        await user.type(within(dialog).getByLabelText("Client Job ID"), "il-2026-44");
        await user.click(save);
        await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ companyJobId: "il-2026-44" }));
        expect(await within(await screen.findByLabelText("Job details")).findByText("IL-2026-44")).toBeInTheDocument();
        // Same job, same candidates: nothing else was touched.
        expect(screen.getByRole("tab", { name: "Assigned Candidates (1)" })).toBeInTheDocument();
        expect(calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["PUT"]);
    });

    test("a duplicate within the company is shown as the server's message", async () => {
        backend("ADMIN", {
            [`GET /api/admin/jobs/${base.jobId}`]: { status: 200, body: details(base, []) },
            [`PUT /api/admin/jobs/${base.jobId}`]: { status: 409, body: { message: "Another job of this company already has this Client Job ID.", code: "COMPANY_JOB_ID_EXISTS" } },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Change Client Job ID" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "Client Job ID" });
        await user.clear(within(dialog).getByLabelText("Client Job ID"));
        await user.type(within(dialog).getByLabelText("Client Job ID"), "Y26S02");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("already has this Client Job ID");
    });

    test("an Analyst can see it but not change it", async () => {
        backend("ANALYST", { [`GET /api/admin/jobs/${base.jobId}`]: { status: 200, body: details(base, [CAND]) } });
        renderApp(path);
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("Y26S01")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Client Job ID/ })).not.toBeInTheDocument();
    });

    test("New job accepts an optional Client Job ID", async () => {
        const created = details(job(5, "PROCESSING", { candidateCount: 0, companyJobId: "Y26S01" }));
        const { calls } = backend("MANAGER", {
            ...NO_ELIGIBLE,
            "POST /api/admin/jobs": { status: 201, body: created },
            [`GET /api/admin/jobs/${created.jobId}`]: { status: 200, body: created },
        });
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.click(screen.getByRole("button", { name: "New job" }));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        await user.selectOptions(await within(dialog).findByLabelText("Job type"), "t1");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        await user.type(within(dialog).getByLabelText(/Client Job ID/), "Y26S01");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await user.click(await within(dialog).findByRole("button", { name: "Create job" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({ jobTypeId: "t1", clientId: "c1", responsibleAgentId: "a1", vacancies: null, companyJobId: "Y26S01", fromCountryCode: "RO", candidateIds: [] }));
    });
});
