import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { CandidateList } from "../api/candidates";
import type { JobDetails, JobList, JobListItem, JobOptions, JobStatus } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes, expectRedirectedHome } from "./helpers";

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
    jobTypes: [
        { id: "t1", name: "Welder", code: "WELDER" },
        { id: "t2", name: "Plumber", code: "PLUMBER" },
        { id: "t3", name: "Aluminium Worker", code: "ALUMINIUM_WORKER" },
    ],
    clients: [{ id: "c1", name: "Acme Construction", agentIds: ["a1"] }],
    agents: [{ id: "a1", name: "Ion Popescu", countryCode: "RO" }],
};
const SEARCH_RESULT: CandidateList = {
    items: [{ passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: null, jobTypes: [], workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: [] }],
    pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    filters: { search: "saman" },
};

function backend(role = "OWNER", extra: FetchRoutes = {}) {
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
const NO_ELIGIBLE = { "GET /api/admin/job-candidate-options": { status: 200, body: { ...SEARCH_RESULT, items: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } } } };

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
        const { calls } = backend("OWNER", { "GET /api/admin/jobs": (url) => ({ status: 200, body: page(url.searchParams.get("search") ? [] : [job(1)]) }) });
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
    test("ADMIN and OWNER get New job and the Jobs entry; an ANALYST has no Jobs area (taken to Candidates, nothing requested)", async () => {
        for (const role of ["ADMIN", "OWNER"]) {
            backend(role);
            const view = renderApp("/jobs");
            await table();
            expect(screen.getByRole("button", { name: "New job" })).toBeInTheDocument();
            expect(screen.getByRole("link", { name: "Jobs" })).toBeInTheDocument();
            view.unmount();
        }
        const { calls } = backend("ANALYST");
        renderApp("/jobs");
        await expectRedirectedHome("ANALYST");
        expect(screen.queryByRole("link", { name: "Jobs" })).not.toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/jobs"))).toBe(false);
    });

    test("REGISTRATION_DESK has no Jobs entry and the page is restricted (no request is made)", async () => {
        const { calls } = backend("REGISTRATION_DESK");
        renderApp("/jobs");
        await expectRedirectedHome("REGISTRATION_DESK");
        expect(screen.queryByRole("link", { name: "Jobs" })).not.toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/jobs"))).toBe(false);
    });
});

describe("New job", () => {
    test("Y26S01 Job sector: right after Job type, optional, Construction or Industrial; the chosen code is sent", async () => {
        const created = details(job(6, "PROCESSING", { candidateCount: 0 }));
        const { calls } = backend("OWNER", {
            ...NO_ELIGIBLE,
            "POST /api/admin/jobs": { status: 201, body: created },
            [`GET /api/admin/jobs/${created.jobId}`]: { status: 200, body: created },
        });
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.click(screen.getByRole("button", { name: "New job" }));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        const sector = await within(dialog).findByLabelText(/Job sector/);
        expect(within(dialog).getByText("(optional)", { selector: "label[for='" + sector.id + "'] span" })).toBeInTheDocument();
        expect([...(sector as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Select a sector…", "Construction", "Industrial"]);
        expect(sector).toHaveValue("");
        // Placed directly after the Job type field, before Client.
        const controls = [...dialog.querySelectorAll("select, input")];
        const typeIndex = controls.indexOf(within(dialog).getByLabelText("Job type"));
        expect(controls.indexOf(sector)).toBe(typeIndex + 1);
        expect(controls.indexOf(within(dialog).getByLabelText("Client"))).toBeGreaterThan(controls.indexOf(sector));
        await user.selectOptions(within(dialog).getByLabelText("Job type"), "t1");
        await user.selectOptions(sector, "Industrial");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await user.click(await within(dialog).findByRole("button", { name: "Create job" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ jobTypeIds: ["t1"], jobSector: "INDUSTRIAL", clientId: "c1" }));
    });

    test("needs a type and client; the agent and the country come from the client; opens the new job", async () => {
        const created = details(job(5, "PROCESSING", { candidateCount: 0 }));
        const { calls } = backend("OWNER", {
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
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({ jobTypeId: "t1", jobTypeIds: ["t1"], jobSector: null, clientId: "c1", responsibleAgentId: "a1", vacancies: 5, companyJobId: null, fromCountryCode: "RO", candidateIds: [] }));
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
        backend("OWNER", getJob(details(base, [CAND])));
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
        backend("OWNER", { [`GET /api/admin/jobs/${done.jobId}`]: { status: 200, body: details(done, [CAND]) } });
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

    test("an ANALYST cannot open a job (taken to Candidates, nothing requested)", async () => {
        const { calls } = backend("ANALYST", getJob(details(base, [CAND])));
        renderApp(path);
        await expectRedirectedHome("ANALYST");
        expect(calls.some((c) => c.path.startsWith("/api/admin/jobs"))).toBe(false);
    });

    test("JOB-PASS-007: the Add candidate search asks the server for candidates who passed the test only, and says so", async () => {
        const { calls } = backend("OWNER", { ...getJob(details(base, [CAND])), "GET /api/admin/job-candidate-options": { status: 200, body: { ...SEARCH_RESULT, items: [] } } });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        expect(within(dialog).getByText("Only candidates who passed the test can be added to a job.")).toBeInTheDocument();
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "failed person");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        expect(await within(dialog).findByText("No eligible candidates found.")).toBeInTheDocument();
        // The job-scoped picker: the server lists only candidates who passed the test (never the Candidates list).
        const search = calls.filter((c) => c.path.startsWith("/api/admin/job-candidate-options?")).at(-1)!;
        expect(Object.fromEntries(search.url.searchParams)).toMatchObject({ search: "failed person", page: "1" });
        expect(calls.some((c) => c.path.startsWith("/api/admin/candidates"))).toBe(false);
    });

    test("Y26S01 Add to job: the list loads as soon as the dialog opens (no search), newest first as the server sends it, and pages on the server", async () => {
        const option = (n: number) => ({ passportId: `N00000${String(n).padStart(2, "0")}`, uniqueId: String(n), name: `CANDIDATE ${n}`, nic: n === 30 ? "199012345678" : null, workflowStatus: { code: "REGISTERED" as const, label: "Registered" } });
        const { calls } = backend("OWNER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/job-candidate-options": (url) => {
                const page = Number(url.searchParams.get("page"));
                const ns = page === 1 ? Array.from({ length: 20 }, (_, i) => 30 - i) : [10, 9];
                return { status: 200, body: { items: ns.map(option), pagination: { page, pageSize: 20, total: 22, totalPages: 2 }, filters: { search: url.searchParams.get("search") } } };
            },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        const list = await within(dialog).findByRole("list", { name: "Candidates found" });
        const names = within(list).getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent);
        expect(names.slice(0, 3)).toEqual(["CANDIDATE 30", "CANDIDATE 29", "CANDIDATE 28"]);
        expect(names).toHaveLength(20);
        expect(within(list).getByText("N0000030 • 199012345678")).toBeInTheDocument();
        const first = calls.filter((c) => c.path.startsWith("/api/admin/job-candidate-options?"))[0];
        expect(Object.fromEntries(first.url.searchParams)).toEqual({ page: "1", pageSize: "20" });
        expect(within(dialog).getByText("Page 1 of 2")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Next page" }));
        expect(await within(dialog).findByText("CANDIDATE 9")).toBeInTheDocument();
        expect(Object.fromEntries(calls.filter((c) => c.path.startsWith("/api/admin/job-candidate-options?")).at(-1)!.url.searchParams)).toEqual({ page: "2", pageSize: "20" });
        // A search starts again on page 1, still on the server; an empty search is the full list again.
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "  nimal  ");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        await vi.waitFor(() => expect(Object.fromEntries(calls.filter((c) => c.path.startsWith("/api/admin/job-candidate-options?")).at(-1)!.url.searchParams)).toEqual({ page: "1", pageSize: "20", search: "nimal" }));
        await user.clear(within(dialog).getByRole("searchbox", { name: "Search candidates" }));
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        await vi.waitFor(() => expect(Object.fromEntries(calls.filter((c) => c.path.startsWith("/api/admin/job-candidate-options?")).at(-1)!.url.searchParams)).toEqual({ page: "1", pageSize: "20" }));
        // The candidate already on the job is marked, not offered again.
        expect(calls.some((c) => c.path.startsWith("/api/admin/candidates"))).toBe(false);
    });

    test("Y26S01 Add to job: typing filters the list on the server as you type (after a short pause, no Search click)", async () => {
        const option = (passportId: string, name: string) => ({ passportId, uniqueId: passportId.slice(-2), name, nic: null, workflowStatus: { code: "REGISTERED" as const, label: "Registered" } });
        const ALL = [option("N0000031", "MANJULA HERATH"), option("N0000032", "SAMPATH KUMARA"), option("N0000033", "MANOJ PERERA")];
        const { calls } = backend("OWNER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/job-candidate-options": (url) => {
                const term = (url.searchParams.get("search") ?? "").toLowerCase();
                const items = ALL.filter((c) => c.name.toLowerCase().includes(term));
                return { status: 200, body: { items, pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 }, filters: { search: term || null } } };
            },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        expect(await within(dialog).findByText("SAMPATH KUMARA")).toBeInTheDocument();
        const optionCalls = () => calls.filter((c) => c.path.startsWith("/api/admin/job-candidate-options?"));
        const before = optionCalls().length;
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "man");
        await vi.waitFor(() => expect(within(dialog).queryByText("SAMPATH KUMARA")).toBeNull());
        expect(within(dialog).getByText("MANJULA HERATH")).toBeInTheDocument();
        expect(within(dialog).getByText("MANOJ PERERA")).toBeInTheDocument();
        // One request for the typed text (debounced), not one per key; on page 1.
        const sent = optionCalls().slice(before).map((c) => Object.fromEntries(c.url.searchParams));
        expect(sent).toEqual([{ page: "1", pageSize: "20", search: "man" }]);
        await user.type(within(dialog).getByRole("searchbox", { name: "Search candidates" }), "oj");
        await vi.waitFor(() => expect(within(dialog).queryByText("MANJULA HERATH")).toBeNull());
        expect(within(dialog).getByText("MANOJ PERERA")).toBeInTheDocument();
        // Search / Enter on the same text asks nothing more.
        const count = optionCalls().length;
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        expect(optionCalls().length).toBe(count);
    });

    test("Y26S01 Add to job: a candidate already on this job shows On this job (no Add)", async () => {
        backend("OWNER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/job-candidate-options": { status: 200, body: { items: [{ passportId: CAND.passportId, uniqueId: "1", name: CAND.name, nic: null, workflowStatus: { code: "REGISTERED", label: "Registered" } }], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }, filters: { search: null } } },
        });
        renderApp(path);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Add candidates to JOB-2026-000002/ });
        expect(await within(dialog).findByText("On this job")).toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: new RegExp(`^Add ${CAND.name}`) })).toBeNull();
        expect(within(dialog).queryByRole("navigation", { name: "Candidate pages" })).toBeNull();
    });

    test("JOB-PASS-008: if the server refuses a candidate who has not passed, its message is shown and nothing is added", async () => {
        const { calls } = backend("OWNER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/job-candidate-options": { status: 200, body: SEARCH_RESULT },
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
        const { calls } = backend("OWNER", {
            ...getJob(details(base, [CAND])),
            "GET /api/admin/job-candidate-options": { status: 200, body: SEARCH_RESULT },
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
        const { calls } = backend("OWNER", {
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
        const { calls } = backend("OWNER", {
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
        const { calls } = backend("OWNER", {
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
        backend("OWNER", {
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

    test("ADMIN and OWNER can add or change it; the request changes only that field", async () => {
        const changed = details({ ...base, companyJobId: "IL-2026-44" }, [CAND]);
        const { calls } = backend("OWNER", {
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

    test("an Analyst cannot open the job, so neither sees nor changes it", async () => {
        const { calls } = backend("ANALYST", { [`GET /api/admin/jobs/${base.jobId}`]: { status: 200, body: details(base, [CAND]) } });
        renderApp(path);
        await expectRedirectedHome("ANALYST");
        expect(screen.queryByText("Y26S01")).not.toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/jobs"))).toBe(false);
    });

    test("New job accepts an optional Client Job ID", async () => {
        const created = details(job(5, "PROCESSING", { candidateCount: 0, companyJobId: "Y26S01" }));
        const { calls } = backend("OWNER", {
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
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({ jobTypeId: "t1", jobTypeIds: ["t1"], jobSector: null, clientId: "c1", responsibleAgentId: "a1", vacancies: null, companyJobId: "Y26S01", fromCountryCode: "RO", candidateIds: [] }));
    });
});

describe("Multiple Job Types UI", () => {
    const multiTypeJob = job(10, "PROCESSING", {
        jobTypes: [
            { id: "t3", code: "ALUMINIUM_WORKER", name: "Aluminium Worker" },
            { id: "t1", code: "WELDER", name: "Welder" },
            { id: "t2", code: "PLUMBER", name: "Plumber" },
        ],
    });

    test("Jobs list displays multiple types cleanly with +N indicator", async () => {
        backend("OWNER", {
            "GET /api/admin/jobs": { status: 200, body: page([multiTypeJob]) },
        });
        renderApp("/jobs");
        const rows = within(await table()).getAllByRole("row");
        const dataRow = rows[1];
        expect(within(dataRow).getByText(/Aluminium Worker, Welder/)).toBeInTheDocument();
        expect(within(dataRow).getByText("+1")).toBeInTheDocument();
        expect(within(dataRow).getByTitle("Aluminium Worker, Welder, Plumber")).toBeInTheDocument();
    });

    test("Job Details displays all Job Types as chips and allows Edit for an Owner", async () => {
        const { calls } = backend("OWNER", {
            [`GET /api/admin/jobs/${multiTypeJob.jobId}`]: { status: 200, body: details(multiTypeJob) },
            [`PUT /api/admin/jobs/${multiTypeJob.jobId}`]: { status: 200, body: details(multiTypeJob) },
        });
        renderApp(`/jobs/${multiTypeJob.jobId}`);
        const user = userEvent.setup();
        const detailsTab = await screen.findByRole("tab", { name: "Job Details" }, RENDER_STEP);
        expect(detailsTab).toHaveAttribute("aria-selected", "true");

        // Displays all 3 chips
        expect(screen.getByText("Aluminium Worker")).toBeInTheDocument();
        expect(screen.getByText("Welder")).toBeInTheDocument();
        expect(screen.getByText("Plumber")).toBeInTheDocument();

        // Edit button
        const editBtn = screen.getByRole("button", { name: "Edit Job types" });
        await user.click(editBtn);

        const dialog = await screen.findByRole("dialog", { name: /Edit Job types/ });
        expect(within(dialog).getByText("Aluminium Worker")).toBeInTheDocument();
        expect(within(dialog).getByText("Welder")).toBeInTheDocument();
        expect(within(dialog).getByText("Plumber")).toBeInTheDocument();

        // Remove Plumber chip
        const removePlumber = within(dialog).getByRole("button", { name: "Remove Plumber" });
        await user.click(removePlumber);
        expect(within(dialog).queryByRole("button", { name: "Remove Plumber" })).not.toBeInTheDocument();

        // Save
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await vi.waitFor(() => {
            const putCall = calls.find((c) => c.method === "PUT");
            expect(putCall).toBeDefined();
            expect(putCall!.body).toEqual({ jobTypeId: "t3", jobTypeIds: ["t3", "t1"] });
        });
    });

    test("Job Details is not the Analyst's (taken to Candidates): no Edit Job types", async () => {
        backend("ANALYST", {
            [`GET /api/admin/jobs/${multiTypeJob.jobId}`]: { status: 200, body: details(multiTypeJob) },
        });
        renderApp(`/jobs/${multiTypeJob.jobId}`);
        await expectRedirectedHome("ANALYST");
        expect(screen.queryByRole("button", { name: "Edit Job types" })).not.toBeInTheDocument();
    });

    test("New Job modal allows multi-selecting job types and removing chips", async () => {
        const created = details(job(11, "PROCESSING", { candidateCount: 0 }));
        const { calls } = backend("OWNER", {
            ...NO_ELIGIBLE,
            "POST /api/admin/jobs": { status: 201, body: created },
            [`GET /api/admin/jobs/${created.jobId}`]: { status: 200, body: created },
        });
        renderApp("/jobs");
        const user = userEvent.setup();
        await table();
        await user.click(screen.getByRole("button", { name: "New job" }));
        const dialog = await screen.findByRole("dialog", { name: "New job" });

        // Select t1 (Welder)
        await user.selectOptions(await within(dialog).findByLabelText("Job type"), "t1");
        expect(within(dialog).getByText("Welder")).toBeInTheDocument();

        // Select t2 (Plumber)
        await user.selectOptions(within(dialog).getByLabelText("Job type"), "t2");
        expect(within(dialog).getByText("Plumber")).toBeInTheDocument();

        // Remove Welder chip
        await user.click(within(dialog).getByRole("button", { name: "Remove Welder" }));
        expect(within(dialog).queryByRole("button", { name: "Remove Welder" })).not.toBeInTheDocument();

        // Add Aluminium Worker (t3)
        await user.selectOptions(within(dialog).getByLabelText("Job type"), "t3");
        expect(within(dialog).getByText("Aluminium Worker")).toBeInTheDocument();

        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        await user.type(within(dialog).getByLabelText(/Vacancies/), "3");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await user.click(await within(dialog).findByRole("button", { name: "Create job" }));

        await vi.waitFor(() => {
            const postCall = calls.find((c) => c.method === "POST");
            expect(postCall).toBeDefined();
            // The recorded body is `unknown` (helpers.tsx): match its fields instead of reading them.
            expect(postCall!.body).toMatchObject({ jobTypeIds: ["t2", "t3"], jobTypeId: "t2" });
        });
    });
});

