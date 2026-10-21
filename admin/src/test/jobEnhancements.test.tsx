import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { CandidateList, CandidateListItem } from "../api/candidates";
import type { JobDetails, JobListItem, JobOptions } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Job Management enhancements (UI-JOB-001 to UI-JOB-016): the Job details tabs, the
// assigned candidates' Status and Passport / NIC column, To / From Country, the vacancy
// count shown as it is (23 / 20, Filled), and New job in two steps with candidate
// selection. Synthetic data; the backend is a stub (the rules themselves are in
// test/jobManagementEnhancements.test.js).

const JOB_ID = "00000000-0000-4000-8000-000000000009";
const baseJob: JobListItem = {
    jobId: JOB_ID, jobCode: "JOB-2026-000009", companyJobId: null, status: "PROCESSING",
    jobType: { id: "t1", code: "WELDER", name: "Welder" }, client: { id: "c1", name: "Acme Construction" },
    responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" }, countryCode: "RO", fromCountryCode: "LK", vacancies: 20,
    createdAt: "2026-10-01T05:00:00.000Z", completedAt: null, cancelledAt: null, cancelReason: null, candidateCount: 2, filled: false,
};
const member = (n: number, extra: Partial<JobDetails["candidates"][number]> = {}): JobDetails["candidates"][number] => ({
    passportId: `N000000${n}`, uniqueId: `000${n}`, name: `PERSON ${n}`, nic: `20000000000${n}`, assignedAt: "2026-10-02T05:00:00.000Z",
    workflowStatus: { code: "JOB_ASSIGNED", label: "Job Assigned" }, ...extra,
});
const details = (extra: Partial<JobDetails> = {}): JobDetails => ({
    ...baseJob, createdBy: "Test Admin",
    candidates: [member(1), member(2, { nic: null, workflowStatus: { code: "FORM_SUBMITTED", label: "Form Submitted" } })],
    ...extra,
});
const OPTIONS: JobOptions = {
    jobTypes: [{ id: "t1", name: "Welder", code: "WELDER" }],
    clients: [{ id: "c1", name: "Acme Construction", agentId: "a1", countryCode: "RO" }, { id: "c2", name: "Berlin Bau", agentId: "a2", countryCode: "DE" }],
    agents: [{ id: "a1", name: "Ion Popescu", countryCode: "RO" }, { id: "a2", name: "Hans Weber", countryCode: "DE" }],
};
const eligible = (n: number, extra: Partial<CandidateListItem> = {}): CandidateListItem => ({
    passportId: `P000000${n}`, uniqueId: `100${n}`, name: `ELIGIBLE ${n}`, nic: n === 1 ? null : `19900000000${n}`, jobTypes: n === 3 ? ["NO_PREFERENCE"] : ["Carpenter"],
    workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: [], ...extra,
});
const ELIGIBLE: CandidateList = { items: [1, 2, 3].map((n) => eligible(n)), pagination: { page: 1, pageSize: 50, total: 3, totalPages: 1 }, filters: { search: null } };

function backend(extra: FetchRoutes = {}) {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "MANAGER" } } },
        "GET /api/admin/jobs": { status: 200, body: { items: [baseJob], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 }, counts: { processing: 1, completed: 0, cancelled: 0 }, filters: { view: "processing", search: null } } },
        [`GET /api/admin/jobs/${JOB_ID}`]: { status: 200, body: details() },
        "GET /api/admin/job-options": { status: 200, body: OPTIONS },
        "GET /api/admin/candidates": { status: 200, body: ELIGIBLE },
        ...extra,
    });
}

describe("Job details tabs, Status and Passport / NIC", () => {
    test("UI-JOB-001: the Job Details tab opens by default (the candidates table is on the other tab)", async () => {
        backend();
        renderApp(`/jobs/${JOB_ID}`);
        const detailsTab = await screen.findByRole("tab", { name: "Job Details" }, RENDER_STEP);
        expect(detailsTab).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "Assigned Candidates (2)" })).toHaveAttribute("aria-selected", "false");
        expect(screen.getByLabelText("Job details")).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Assigned candidates" })).not.toBeInTheDocument();
        // The job actions stay above the tabs, on every tab.
        for (const name of ["Add to job", "Complete job", "Cancel job"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    });

    test("UI-JOB-002: the Assigned Candidates tab shows the table, and switching back keeps the details", async () => {
        backend();
        renderApp(`/jobs/${JOB_ID}`);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("tab", { name: "Assigned Candidates (2)" }, RENDER_STEP));
        expect(screen.getByRole("tab", { name: "Assigned Candidates (2)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("table", { name: "Assigned candidates" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Job details")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add to job" })).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Job Details" }));
        expect(screen.getByLabelText("Job details")).toBeInTheDocument();
    });

    test("UI-JOB-003/004/005: a Status column with each candidate's workflow status, one Passport / NIC column, no NIC column", async () => {
        backend();
        renderApp(`/jobs/${JOB_ID}`);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("tab", { name: /^Assigned Candidates/ }, RENDER_STEP));
        const rows = within(screen.getByRole("table", { name: "Assigned candidates" })).getAllByRole("row");
        const headers = within(rows[0]).getAllByRole("columnheader").map((h) => h.textContent);
        expect(headers).toEqual(["Name", "Passport / NIC", "Status", "Assigned", "Actions"]);
        expect(headers).not.toContain("NIC");
        expect(headers).not.toContain("Passport ID");
        const first = within(rows[1]).getAllByRole("cell");
        expect(first[1]).toHaveTextContent("N0000001NIC: 200000000001");
        expect(first[2]).toHaveTextContent("Job Assigned");
        // A missing NIC shows the passport only: no "NIC:" label, never "null" / "undefined".
        const second = within(rows[2]).getAllByRole("cell");
        expect(second[1].textContent).toBe("N0000002");
        expect(second[2]).toHaveTextContent("Form Submitted");
        expect(screen.getByRole("table", { name: "Assigned candidates" }).textContent).not.toMatch(/null|undefined/);
        // The candidate link and the Remove action are unchanged.
        expect(within(rows[1]).getByRole("link", { name: "PERSON 1" })).toHaveAttribute("href", "/candidates/N0000001");
        expect(within(rows[1]).getByRole("button", { name: "Remove PERSON 1 from the job" })).toBeInTheDocument();
    });

    test("vacancies over the target are shown as they are (23 / 20) and Filled", async () => {
        const many = Array.from({ length: 23 }, (_, n) => member(n + 1, { passportId: `N${String(n + 1).padStart(7, "0")}` }));
        backend({ [`GET /api/admin/jobs/${JOB_ID}`]: { status: 200, body: details({ candidates: many, candidateCount: 23, filled: true }) } });
        renderApp(`/jobs/${JOB_ID}`);
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("23 / 20")).toBeInTheDocument();
        expect(within(list).getByText("Filled")).toBeInTheDocument();
        expect(within(list).getByText("20")).toBeInTheDocument();
        // The job's own status is unchanged by Filled.
        expect(within(list).getByText("Processing")).toBeInTheDocument();
    });

    test("To Country and From Country by name; From Country changes from the details (To Country never)", async () => {
        const { calls } = backend({ [`PUT /api/admin/jobs/${JOB_ID}`]: { status: 200, body: details({ fromCountryCode: "IN" }) } });
        renderApp(`/jobs/${JOB_ID}`);
        const user = userEvent.setup();
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("To Country").nextSibling).toHaveTextContent("Romania");
        expect(within(list).getByText("From Country").nextSibling).toHaveTextContent("Sri Lanka");
        await user.click(within(list).getByRole("button", { name: "Change From Country" }));
        const dialog = await screen.findByRole("dialog", { name: "From Country" });
        await user.selectOptions(within(dialog).getByLabelText(/From Country/), "IN");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ fromCountryCode: "IN" }));
        expect(await within(await screen.findByLabelText("Job details")).findByText("India")).toBeInTheDocument();
    });

    test("a job from before From Country shows it as not recorded", async () => {
        backend({ [`GET /api/admin/jobs/${JOB_ID}`]: { status: 200, body: details({ fromCountryCode: null }) } });
        renderApp(`/jobs/${JOB_ID}`);
        const list = await screen.findByLabelText("Job details", undefined, RENDER_STEP);
        expect(within(list).getByText("From Country").nextSibling).toHaveTextContent("Not recorded");
    });
});

describe("New job in two steps", () => {
    async function openNewJob() {
        renderApp("/jobs");
        const user = userEvent.setup();
        await screen.findByRole("table", { name: "Jobs" }, RENDER_STEP);
        await user.click(screen.getByRole("button", { name: "New job" }));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        await within(dialog).findByLabelText("Job type");
        return { user, dialog };
    }
    async function fillStepOne(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, vacancies = "2") {
        await user.selectOptions(within(dialog).getByLabelText("Job type"), "t1");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        await user.type(within(dialog).getByLabelText(/Vacancies/), vacancies);
    }

    test("UI-JOB-006: To Country is the selected client's country and follows a change of client", async () => {
        backend();
        const { user, dialog } = await openNewJob();
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("Taken from the selected client");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c1");
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("Romania");
        await user.selectOptions(within(dialog).getByLabelText("Client"), "c2");
        expect(within(dialog).getByTestId("job-to-country")).toHaveTextContent("Germany");
        expect(within(dialog).queryByRole("combobox", { name: /To Country/ })).not.toBeInTheDocument();
    });

    test("UI-JOB-007: From Country defaults to Romania and can be changed", async () => {
        backend();
        const { user, dialog } = await openNewJob();
        const from = within(dialog).getByLabelText(/From Country/) as HTMLSelectElement;
        expect(from.value).toBe("RO");
        await user.selectOptions(from, "LK");
        expect(from.value).toBe("LK");
    });

    test("UI-JOB-008/009: Step 1 shows Next (not Create job); Next opens Candidate Selection without saving anything", async () => {
        const { calls } = backend();
        const { user, dialog } = await openNewJob();
        expect(within(dialog).queryByRole("button", { name: "Create job" })).not.toBeInTheDocument();
        expect(within(dialog).getByText(/1\. Job details/).closest("li")).toHaveAttribute("aria-current", "step");
        await fillStepOne(user, dialog);
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        expect(await within(dialog).findByRole("list", { name: "Eligible candidates" })).toBeInTheDocument();
        expect(within(dialog).getByText(/2\. Select candidates/).closest("li")).toHaveAttribute("aria-current", "step");
        expect(within(dialog).getByRole("button", { name: "Create job" })).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("UI-JOB-010/011/012: the eligible list is the server's PASS and not-on-a-processing-job list, with identity and Status", async () => {
        const { calls } = backend();
        const { user, dialog } = await openNewJob();
        await fillStepOne(user, dialog);
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        const list = await within(dialog).findByRole("list", { name: "Eligible candidates" });
        const request = calls.find((c) => c.path.startsWith("/api/admin/candidates?"))!;
        // FAIL candidates and those actively on a job are left out by the server (testResult=PASS, available=true).
        expect(Object.fromEntries(request.url.searchParams)).toMatchObject({ testResult: "PASS", available: "true" });
        const items = within(list).getAllByRole("listitem");
        expect(items).toHaveLength(3);
        expect(items[1]).toHaveTextContent("ELIGIBLE 2");
        expect(items[1]).toHaveTextContent("P0000002 • NIC: 199000000002");
        expect(items[1]).toHaveTextContent("Registered");
        expect(items[0].textContent).not.toMatch(/NIC|null|undefined/);
    });

    test("UI-JOB-013/014/015: several candidates, more than the vacancies, are sent with the job in one Create job", async () => {
        const created = details({ candidateCount: 3, filled: true });
        const { calls } = backend({ "POST /api/admin/jobs": { status: 201, body: created } });
        const { user, dialog } = await openNewJob();
        await fillStepOne(user, dialog, "2");
        await user.selectOptions(within(dialog).getByLabelText(/From Country/), "LK");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await within(dialog).findByRole("list", { name: "Eligible candidates" });
        expect(within(dialog).getByTestId("selected-count")).toHaveTextContent("No candidates selected");
        for (const name of ["ELIGIBLE 1", "ELIGIBLE 2", "ELIGIBLE 3"]) await user.click(within(dialog).getByRole("checkbox", { name: new RegExp(name) }));
        expect(within(dialog).getByTestId("selected-count")).toHaveTextContent("3 selected for 2 vacancies (more than the vacancies is allowed)");
        // Unticking and ticking again counts once.
        await user.click(within(dialog).getByRole("checkbox", { name: /ELIGIBLE 3/ }));
        await user.click(within(dialog).getByRole("checkbox", { name: /ELIGIBLE 3/ }));
        await user.click(within(dialog).getByRole("button", { name: "Create job" }));
        await vi.waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({
            jobTypeId: "t1", clientId: "c1", responsibleAgentId: "a1", vacancies: 2, companyJobId: null, fromCountryCode: "LK",
            candidateIds: ["P0000001", "P0000002", "P0000003"],
        }));
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
        expect(await screen.findByRole("heading", { name: /JOB-2026-000009/ }, RENDER_STEP)).toBeInTheDocument();
    });

    test("a refusal from the server (a candidate taken meanwhile) is shown and nothing is navigated to", async () => {
        backend({ "POST /api/admin/jobs": { status: 409, body: { code: "CANDIDATE_ON_ACTIVE_JOB", message: "P0000001: This candidate is already on the PROCESSING job JOB-2026-000004. Nothing was created." } } });
        const { user, dialog } = await openNewJob();
        await fillStepOne(user, dialog);
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await user.click(await within(dialog).findByRole("checkbox", { name: /ELIGIBLE 1/ }));
        await user.click(within(dialog).getByRole("button", { name: "Create job" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nothing was created");
        expect(within(dialog).getByRole("checkbox", { name: /ELIGIBLE 1/ })).toBeChecked();
    });

    test("UI-JOB-016: Back returns to Step 1 with every value kept, and the selection is kept too", async () => {
        backend();
        const { user, dialog } = await openNewJob();
        await fillStepOne(user, dialog, "7");
        await user.selectOptions(within(dialog).getByLabelText(/From Country/), "IN");
        await user.type(within(dialog).getByLabelText(/Client Job ID/), "Y26S09");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        await user.click(await within(dialog).findByRole("checkbox", { name: /ELIGIBLE 2/ }));
        await user.click(within(dialog).getByRole("button", { name: "Back" }));
        expect((within(dialog).getByLabelText("Job type") as HTMLSelectElement).value).toBe("t1");
        expect((within(dialog).getByLabelText("Client") as HTMLSelectElement).value).toBe("c1");
        expect((within(dialog).getByLabelText(/From Country/) as HTMLSelectElement).value).toBe("IN");
        expect(within(dialog).getByLabelText(/Vacancies/)).toHaveValue("7");
        expect(within(dialog).getByLabelText(/Client Job ID/)).toHaveValue("Y26S09");
        await user.click(within(dialog).getByRole("button", { name: "Next" }));
        expect(await within(dialog).findByRole("checkbox", { name: /ELIGIBLE 2/ })).toBeChecked();
    });
});
