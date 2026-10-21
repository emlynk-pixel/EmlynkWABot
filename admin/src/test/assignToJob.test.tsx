import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails } from "../api/candidates";
import type { CandidateJobAssignment, JobList, JobListItem, JobStatus } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Candidate Details > Current processing job > "Assign to Job". Synthetic data;
// the backend is a stub (the assignment rules are in test/jobManagement.test.js).

const PATH = "/candidates/N0000002";
const jobItem = (n: number, status: JobStatus = "PROCESSING", extra: Partial<JobListItem> = {}): JobListItem => ({
    jobId: `00000000-0000-4000-8000-00000000000${n}`, jobCode: `JOB-2026-00000${n}`, companyJobId: n === 2 ? "Y26S01" : null, status,
    jobType: { id: "t1", code: "WELDER", name: n === 2 ? "Welder" : "Plumber" }, client: { id: "c1", name: n === 2 ? "Acme Construction" : "Beta Works" },
    responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" }, countryCode: "RO", fromCountryCode: "RO", vacancies: 5,
    createdAt: "2026-10-01T05:00:00.000Z", completedAt: status === "COMPLETED" ? "2026-10-10T05:00:00.000Z" : null, cancelledAt: null, cancelReason: null,
    candidateCount: 3, filled: false, ...extra,
});
const asAssignment = (job: JobListItem): CandidateJobAssignment => ({ ...job, assignedAt: "2026-10-17T05:00:00.000Z", removed: false, removedAt: null });
const detailsWith = (current: CandidateJobAssignment | null): CandidateDetails => ({
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: null, nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null, jobSource: null, jobStatus: null, testResult: stage === "TEST_DETAILS" ? "PASS" : null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current, history: [] },
    requiredDocuments: [],
    verification: { details: null, documents: null },
});
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };
const page = (items: JobListItem[]): JobList => ({
    items, pagination: { page: 1, pageSize: 50, total: items.length, totalItems: items.length, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
    counts: { processing: items.length, completed: 1, cancelled: 1 }, filters: { view: "processing", search: null },
});
const PROCESSING = [jobItem(2), jobItem(1)];
const COMPLETED = jobItem(3, "COMPLETED");
const CANCELLED = jobItem(4, "CANCELLED");

// A stateful stub: the candidate's details change once the assignment is made.
function backend(role = "MANAGER", opts: { current?: CandidateJobAssignment | null; assign?: FetchRoutes[string] } = {}) {
    let current = opts.current ?? null;
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        "GET /api/admin/candidates/N0000002": () => ({ status: 200, body: detailsWith(current) }),
        "GET /api/admin/candidates/N0000002/additional-details": { status: 200, body: VIEW },
        "GET /api/admin/candidates/N0000002/form-share": { status: 200, body: { passportId: "N0000002", state: "LOCKED", submittedAt: null, link: null } },
        "GET /api/admin/jobs": (url) => {
            const view = url.searchParams.get("view");
            const search = (url.searchParams.get("search") ?? "").toLowerCase();
            const source = view === "completed" ? [COMPLETED] : view === "cancelled" ? [CANCELLED] : PROCESSING;
            return { status: 200, body: page(source.filter((j) => !search || `${j.jobCode} ${j.companyJobId ?? ""} ${j.client.name}`.toLowerCase().includes(search))) };
        },
        [`POST /api/admin/jobs/${PROCESSING[0].jobId}/candidates`]: opts.assign ?? (() => {
            current = asAssignment(PROCESSING[0]);
            return { status: 201, body: { ...PROCESSING[0], createdBy: "Test Admin", candidateCount: 4, candidates: [] } };
        }),
        [`GET /api/admin/jobs/${PROCESSING[0].jobId}/form-share`]: {
            status: 200,
            body: { jobId: PROCESSING[0].jobId, jobCode: "JOB-2026-000002", companyJobId: "Y26S01", company: "Acme Construction", jobType: "Welder", jobStatus: "PROCESSING", state: "NONE", counts: { candidates: 4, submitted: 1, remaining: 3 }, link: null },
        },
    });
}
const card = () => screen.findByRole("region", { name: "Job assignment" }, RENDER_STEP);

describe("Assign to Job (Candidate Details)", () => {
    test("ASSIGN-UI-001 / 002 an unassigned candidate shows Assign to Job to Admin and to Manager", async () => {
        for (const role of ["ADMIN", "MANAGER"]) {
            backend(role);
            const view = renderApp(PATH);
            const region = await card();
            expect(within(region).getByText("Not assigned to a processing job.")).toBeInTheDocument();
            expect(within(region).getByRole("button", { name: "Assign to Job" })).toBeEnabled();
            view.unmount();
        }
    });

    test("ASSIGN-UI-003 / 004 an Analyst and the Registration Desk see the card but no management action", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
            backend(role);
            const view = renderApp(PATH);
            const region = await card();
            expect(within(region).getByText("Not assigned to a processing job.")).toBeInTheDocument();
            expect(within(region).queryByRole("button", { name: /Assign to Job/ })).toBeNull();
            view.unmount();
        }
    });

    test("ASSIGN-UI-005 / 009 the dialog lists only PROCESSING jobs, with context, and asks only for them (completed and cancelled are never offered)", async () => {
        const { calls } = backend();
        renderApp(PATH);
        const user = userEvent.setup();
        await user.click(within(await card()).getByRole("button", { name: "Assign to Job" }));
        const dialog = await screen.findByRole("dialog", { name: "Assign SAMAN SILVA to a job" });
        const list = await within(dialog).findByRole("list", { name: "Processing jobs" });
        const rows = within(list).getAllByRole("listitem");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent("JOB-2026-000002");
        expect(rows[0]).toHaveTextContent("Client Job ID: Y26S01");
        expect(rows[0]).toHaveTextContent("Acme Construction · Welder");
        expect(rows[0]).toHaveTextContent("RO · Ion Popescu");
        expect(rows[1]).toHaveTextContent("Client Job ID: Not assigned");
        for (const code of [COMPLETED.jobCode, CANCELLED.jobCode]) expect(within(dialog).queryByText(new RegExp(code))).toBeNull();
        const listCalls = calls.filter((c) => c.path.startsWith("/api/admin/jobs?"));
        expect(listCalls.length).toBeGreaterThan(0);
        expect(listCalls.every((c) => c.url.searchParams.get("view") === "processing")).toBe(true);
        // Search narrows the list (on the server).
        await user.type(within(dialog).getByRole("searchbox", { name: "Search jobs" }), "beta");
        await user.click(within(dialog).getByRole("button", { name: "Search" }));
        expect(await within(dialog).findByText(/JOB-2026-000001/)).toBeInTheDocument();
        expect(within(dialog).queryByText(/JOB-2026-000002/)).toBeNull();
    });

    test("ASSIGN-UI-006 / 007 selecting a job asks for confirmation, assigns through the existing endpoint, and the card shows the new job", async () => {
        const { calls } = backend();
        renderApp(PATH);
        const user = userEvent.setup();
        const region = await card();
        await user.click(within(region).getByRole("button", { name: "Assign to Job" }));
        const dialog = await screen.findByRole("dialog", { name: "Assign SAMAN SILVA to a job" });
        await user.click(await within(dialog).findByRole("button", { name: "Select JOB-2026-000002" }));
        expect(dialog).toHaveTextContent(/Assign SAMAN SILVA to JOB-2026-000002 (Acme Construction, Welder)?/);
        expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing is sent before the confirmation
        await user.click(within(dialog).getByRole("button", { name: "Confirm assignment" }));
        expect(await within(region).findByRole("link", { name: "JOB-2026-000002" }, RENDER_STEP)).toHaveAttribute("href", "/jobs/00000000-0000-4000-8000-000000000002");
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(within(region).getByText("Y26S01")).toBeInTheDocument();
        expect(within(region).getByText("Acme Construction")).toBeInTheDocument();
        expect(within(region).getByText("Welder")).toBeInTheDocument();
        expect(within(region).getByText("Processing")).toBeInTheDocument();
        expect(within(region).queryByRole("button", { name: "Assign to Job" })).toBeNull();
        expect(within(region).queryByText("Not assigned to a processing job.")).toBeNull();
    });

    test("ASSIGN-UI-008 a candidate already on a processing job has no way to be assigned to another; a stale screen gets the server's CANDIDATE_ON_ACTIVE_JOB message and nothing moves", async () => {
        // Already assigned: read-only card, a link to the job, no Assign action.
        backend("MANAGER", { current: asAssignment(PROCESSING[1]) });
        const first = renderApp(PATH);
        const region = await card();
        expect(within(region).getByRole("link", { name: "JOB-2026-000001" })).toBeInTheDocument();
        expect(within(region).queryByRole("button", { name: /Assign/ })).toBeNull();
        first.unmount();

        // The screen was stale (assigned meanwhile by someone else): the server refuses.
        const { calls } = backend("MANAGER", {
            assign: { status: 409, body: { message: "This candidate is already on the PROCESSING job JOB-2026-000001. Complete or cancel that job, or remove the candidate from it, first.", code: "CANDIDATE_ON_ACTIVE_JOB" } },
        });
        renderApp(PATH);
        const user = userEvent.setup();
        await user.click(within(await card()).getByRole("button", { name: "Assign to Job" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(await within(dialog).findByRole("button", { name: "Select JOB-2026-000002" }));
        await user.click(within(dialog).getByRole("button", { name: "Confirm assignment" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("already on the PROCESSING job JOB-2026-000001");
        // Still open, still unassigned, nothing was moved or retried.
        expect(within(await card()).getByText("Not assigned to a processing job.")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    test("ASSIGN-UI-010 after assigning, the Share Form offers the job-group link for the new job without a reload", async () => {
        backend();
        renderApp(`${PATH}?tab=additional`);
        const user = userEvent.setup();
        const form = await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        // Before: the group action is disabled with the reason.
        await user.click(within(form).getByRole("button", { name: "Share Form" }));
        let dialog = await screen.findByRole("dialog", { name: "Share the Candidate Form" });
        let group = await within(dialog).findByRole("region", { name: "Job group" });
        expect(within(group).getByRole("button", { name: "Create job-group link" })).toBeDisabled();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        await user.click(within(await card()).getByRole("button", { name: "Assign to Job" }));
        const assign = await screen.findByRole("dialog", { name: "Assign SAMAN SILVA to a job" });
        await user.click(await within(assign).findByRole("button", { name: "Select JOB-2026-000002" }));
        await user.click(within(assign).getByRole("button", { name: "Confirm assignment" }));
        await within(await card()).findByRole("link", { name: "JOB-2026-000002" }, RENDER_STEP);

        await user.click(within(screen.getByRole("form", { name: "Additional details" })).getByRole("button", { name: "Share Form" }));
        dialog = await screen.findByRole("dialog", { name: "Share the Candidate Form" });
        group = await within(dialog).findByRole("region", { name: "Job group" });
        expect(await within(group).findByText("Y26S01")).toBeInTheDocument();
        expect(within(group).getByText("JOB-2026-000002")).toBeInTheDocument();
        expect(within(group).getByRole("button", { name: "Create job-group link" })).toBeEnabled();
    });

    test("ASSIGN-UI-011 the old candidate_stages.job_id is never written: the only change sent is the job-candidate assignment", async () => {
        const { calls } = backend();
        renderApp(`${PATH}?stage=TEST_DETAILS`);
        const user = userEvent.setup();
        const region = await card();
        await user.click(within(region).getByRole("button", { name: "Assign to Job" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(await within(dialog).findByRole("button", { name: "Select JOB-2026-000002" }));
        await user.click(within(dialog).getByRole("button", { name: "Confirm assignment" }));
        await within(region).findByRole("link", { name: "JOB-2026-000002" }, RENDER_STEP);
        const writes = calls.filter((c) => c.method !== "GET");
        expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /api/admin/jobs/${PROCESSING[0].jobId}/candidates`]);
        expect(writes[0].body).toEqual({ passportId: "N0000002" });
        expect(JSON.stringify(writes)).not.toMatch(/jobId"?:|stages/);
    });

    test("ASSIGN-UI-012 a candidate whose Test result is not PASS cannot be assigned: the button is disabled and says why", async () => {
        for (const testResult of [null, "FAIL"] as const) {
            const { calls } = signedInBackend({
                "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "MANAGER" } } },
                "GET /api/admin/candidates/N0000002": () => {
                    const details = detailsWith(null);
                    return { status: 200, body: { ...details, stages: details.stages.map((s) => (s.stage === "TEST_DETAILS" ? { ...s, testResult } : s)) } };
                },
                "GET /api/admin/candidates/N0000002/additional-details": { status: 200, body: VIEW },
                "GET /api/admin/candidates/N0000002/form-share": { status: 200, body: { passportId: "N0000002", state: "LOCKED", submittedAt: null, link: null } },
            });
            const view = renderApp(PATH);
            const region = await card();
            expect(within(region).getByRole("button", { name: "Assign to Job" })).toBeDisabled();
            expect(within(region).getByText(/Only a candidate whose Test result is PASS can be assigned/)).toBeInTheDocument();
            expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
            view.unmount();
        }
    });

    test("the Job Details page keeps its own Add to job action (one assignment mechanism)", async () => {
        const job = PROCESSING[0];
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "MANAGER" } } },
            [`GET /api/admin/jobs/${job.jobId}`]: { status: 200, body: { ...job, createdBy: "Test Admin", candidates: [] } },
        });
        renderApp(`/jobs/${job.jobId}`);
        expect(await screen.findByRole("button", { name: "Add to job" }, RENDER_STEP)).toBeInTheDocument();
    });
});
