import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails, type CandidateList } from "../api/candidates";
import type { JobDetails, JobList, JobOptions } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, userWithRole, type FetchRoutes } from "./helpers";

// The JOB_HANDLER role in the Admin (UI-JH-001 to UI-JH-015): Jobs, Agents, Client Management
// and Candidates (read only) in the sidebar, nothing else; candidate pages without a single
// change control; Job, Agent and Client create / edit available; restricted URLs blocked; and
// the Invite User page for ADMIN (any role) and MANAGER (Job Handler only). Synthetic data; the
// backend is a stub (the rules themselves are in test/jobHandlerRole.test.js).

const JH = userWithRole("JOB_HANDLER");
const navLinks = () => within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((link) => link.textContent);
const stages = CANDIDATE_STAGES.map((stage) => ({
    stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null,
    jobSource: null, jobStatus: null, testResult: stage === "TEST_DETAILS" ? ("PASS" as const) : null, testDate: null,
    automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
}));
const STORED = { documentId: "doc-1", originalFilename: "passport.pdf", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-01T00:00:00.000Z" };
const DETAILS = {
    verification: { details: null, documents: null },
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-12", nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages,
    documents: { PASSPORT: STORED, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current: null, history: [] },
    requiredDocuments: (["PASSPORT", "MEDICAL", "POLICE_REPORT", "SCAN"] as const).map((documentType) => ({ documentType, included: documentType === "PASSPORT" })),
} as unknown as CandidateDetails;
const LIST: CandidateList = {
    items: [{ passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })) }],
    pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    filters: { search: null },
};
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const JOB = {
    jobId: JOB_ID, jobCode: "JOB-2026-000001", companyJobId: null, status: "PROCESSING", jobType: { id: "t1", code: "WELDER", name: "Welder" },
    client: { id: "c1", name: "Acme Construction" }, responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" }, countryCode: "RO", fromCountryCode: "RO",
    vacancies: 2, createdAt: "2026-10-01T00:00:00.000Z", completedAt: null, cancelledAt: null, cancelReason: null, candidateCount: 0, filled: false,
} as const;
const JOBS: JobList = { items: [JOB], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 }, counts: { processing: 1, completed: 0, cancelled: 0 }, filters: { view: "processing", search: null } };
const OPTIONS: JobOptions = { jobTypes: [{ id: "t1", name: "Welder", code: "WELDER" }], clients: [{ id: "c1", name: "Acme Construction", agentIds: ["a1"] }], agents: [{ id: "a1", name: "Ion Popescu", countryCode: "RO" }] };
const PAGINATION = { page: 1, pageSize: 25, total: 0, totalPages: 1 };

function backend(user = JH, routes: FetchRoutes = {}) {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user } },
        "GET /api/admin/candidates": { status: 200, body: LIST },
        "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
        "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [], activity: [] } },
        "GET /api/admin/jobs": { status: 200, body: JOBS },
        [`GET /api/admin/jobs/${JOB_ID}`]: { status: 200, body: { ...JOB, createdBy: "Admin", candidates: [] } satisfies JobDetails },
        "GET /api/admin/job-options": { status: 200, body: OPTIONS },
        "GET /api/admin/agents": { status: 200, body: { items: [], pagination: PAGINATION, filters: { search: null, country: null, status: null }, countries: [] } },
        "GET /api/admin/client-management": { status: 200, body: { items: [], pagination: PAGINATION, filters: { search: null, country: null, status: null, agentId: null }, countries: [] } },
        "GET /api/admin/agent-options": { status: 200, body: { agents: [] } },
        "GET /api/admin/client-options": { status: 200, body: { clients: [] } },
        ...routes,
    });
}

describe("navigation", () => {
    test("UI-JH-001 to 006: Candidates, Jobs, Agents and Client Management only; no Settings, Invite User, Audit Logs or dashboards; lands on Jobs", async () => {
        const { calls } = backend();
        renderApp("/");
        expect(await screen.findByRole("table", { name: "Jobs" }, RENDER_STEP)).toBeInTheDocument();
        expect(navLinks()).toEqual(["Candidates", "Jobs", "Agents", "Client Management"]);
        for (const name of ["Settings", "Invite User", "Audit Logs", "Overview", "Need Attention", "Work Allocation", "Daily Report"]) {
            expect(within(screen.getByRole("navigation", { name: "Main navigation" })).queryByRole("link", { name })).not.toBeInTheDocument();
        }
        expect(screen.queryByRole("link", { name: "Register Candidate" })).not.toBeInTheDocument();
        expect(calls.some((c) => c.path.startsWith("/api/admin/overview"))).toBe(false);
    });

    test("UI-JH-009: restricted URLs are blocked, with no request for their data", { timeout: 60_000 }, async () => {
        for (const path of ["/settings", "/settings/job-types", "/settings/invite", "/invitations", "/audit-logs", "/work-allocation", "/documents", "/review", "/police", "/missing-documents", "/reports/daily", "/clients", "/follow-ups", "/candidates/new"]) {
            const { calls } = backend();
            const { unmount } = renderApp(path);
            expect(await screen.findByText(/Access Restricted|Candidate registration is done by/, {}, RENDER_STEP), path).toBeInTheDocument();
            expect(calls.some((c) => /\/api\/admin\/(users|settings|audit-logs|work-allocation|documents|review|police|reports|clients|follow-ups)/.test(c.path)), path).toBe(false);
            unmount();
        }
    });
});

describe("Candidates: read only", () => {
    test("UI-JH-007 / 008: the list opens with no Add candidate; the details page shows the data with no change control", { timeout: 20_000 }, async () => {
        backend();
        const { unmount } = renderApp("/candidates");
        expect(await screen.findByRole("table", { name: "Candidates" }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByText("SAMAN SILVA")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Add candidate" })).not.toBeInTheDocument();
        unmount();

        backend();
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByRole("heading", { name: "SAMAN SILVA" }, RENDER_STEP)).toBeInTheDocument();
        const user = userEvent.setup();
        await waitFor(() => expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0));
        // Every field is disabled, or read-only like the locked WhatsApp number (it is never editable once saved).
        for (const box of screen.getAllByRole("textbox") as HTMLInputElement[]) expect(box.disabled || box.readOnly, box.id).toBe(true);
        for (const name of ["Save changes", "Remove", "Upload", "Replace", "Verify details", "Assign to Job", "Share Form"]) {
            for (const control of screen.queryAllByRole("button", { name: new RegExp(`^${name}`) })) expect(control, name).toBeDisabled();
        }
        expect(screen.queryByRole("button", { name: /^Save changes/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Assign to Job/ })).not.toBeInTheDocument();
        // The call log opens to read: no form to add a call.
        await user.click(screen.getByRole("button", { name: "Call log" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).queryByRole("button", { name: /Add call|Save call|No Answer/i })).not.toBeInTheDocument();
    });
});

describe("Jobs, Agents and Clients: managed", () => {
    test("UI-JH-010: New job, and the job's actions (add, complete, cancel, Client Job ID); no Add job type", async () => {
        backend();
        const { unmount } = renderApp("/jobs");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "New job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        expect(await within(dialog).findByLabelText("Job type")).toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: "Add job type" })).not.toBeInTheDocument();
        unmount();

        backend();
        renderApp(`/jobs/${JOB_ID}`);
        for (const name of ["Add to job", "Complete job", "Cancel job"]) expect(await screen.findByRole("button", { name }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add Client Job ID" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Change From Country" })).toBeInTheDocument();
    });

    test("ADMIN and MANAGER still get Add job type (unchanged)", async () => {
        for (const role of ["ADMIN", "MANAGER"]) {
            backend(userWithRole(role));
            const { unmount } = renderApp("/jobs");
            const user = userEvent.setup();
            await user.click(await screen.findByRole("button", { name: "New job" }, RENDER_STEP));
            expect(await within(await screen.findByRole("dialog", { name: "New job" })).findByRole("button", { name: "Add job type" })).toBeInTheDocument();
            unmount();
        }
    });

    test("UI-JH-011 / 012: Add agent and Add client are available", async () => {
        backend();
        const { unmount } = renderApp("/agents");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add agent" }, RENDER_STEP));
        expect(await screen.findByRole("dialog", { name: "Add agent" })).toBeInTheDocument();
        unmount();
        backend();
        renderApp("/client-management");
        await user.click(await screen.findByRole("button", { name: "Add client" }, RENDER_STEP));
        expect(await screen.findByRole("dialog", { name: "Add client" })).toBeInTheDocument();
    });
});

describe("Invite User", () => {
    const USERS = { users: [{ userId: "u1", name: "Someone", email: "s@example.invalid", role: "ANALYST", status: "ACTIVE", createdDate: "2026-10-01T00:00:00.000Z" }] };

    test("UI-JH-013: ADMIN's role list includes Job Handler (with the user list, unchanged)", async () => {
        backend(ADMIN, { "GET /api/admin/users": { status: 200, body: USERS } });
        renderApp("/settings/invite");
        const select = await screen.findByRole("combobox", { name: /^Role/ }, RENDER_STEP);
        expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Admin", "Manager", "Analyst", "Registration Desk", "Job Handler"]);
        expect(await screen.findByText("Someone")).toBeInTheDocument();
    });

    test("UI-JH-014: MANAGER invites a Job Handler only, from its Invite User page; no user list is requested", async () => {
        const { calls } = backend(userWithRole("MANAGER"), {
            "POST /api/admin/users/invite": { status: 201, body: { outcome: "INVITED", user: { userId: "u9", name: "New Handler", email: "new@example.invalid", role: "JOB_HANDLER", status: "INVITED", createdDate: "2026-10-21T00:00:00.000Z" } } },
        });
        renderApp("/");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("link", { name: "Invite User" }, RENDER_STEP));
        const select = await screen.findByRole("combobox", { name: /^Role/ });
        expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Job Handler"]);
        await user.type(screen.getByPlaceholderText("e.g. Chaminda Silva"), "New Handler");
        await user.type(screen.getByPlaceholderText("e.g. chaminda@example.com"), "new@example.invalid");
        await user.click(screen.getByRole("button", { name: "Send Invitation" }));
        await waitFor(() => expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "New Handler", email: "new@example.invalid", role: "JOB_HANDLER" }));
        expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/admin/users"))).toBe(false);
        expect(screen.queryByRole("heading", { name: "Users" })).not.toBeInTheDocument();
        // Settings stays closed to the MANAGER.
        expect(within(screen.getByRole("navigation", { name: "Main navigation" })).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    });
});

describe("existing roles", () => {
    test("UI-JH-015: ADMIN, MANAGER, ANALYST and REGISTRATION_DESK keep their sidebars (MANAGER plus its Invite User entry)", { timeout: 30_000 }, async () => {
        const expected: Record<string, string[]> = {
            ADMIN: ["Overview", "Documents", "Review Queue", "Candidates", "Need Attention", "Jobs", "Agents", "Client Management", "Work Allocation", "Missing Documents", "Police Workflow", "Daily Report", "Audit Logs", "Settings"],
            MANAGER: ["Overview", "Documents", "Review Queue", "Candidates", "Need Attention", "Jobs", "Agents", "Client Management", "Work Allocation", "Missing Documents", "Police Workflow", "Daily Report", "Invite User"],
            ANALYST: ["Overview", "Documents", "Review Queue", "Candidates", "Need Attention", "Jobs", "Missing Documents", "Police Workflow", "Daily Report"],
            REGISTRATION_DESK: ["Candidates", "Need Attention"],
        };
        for (const [role, links] of Object.entries(expected)) {
            backend(userWithRole(role), { "GET /api/admin/follow-ups": { status: 200, body: { items: [], total: 0 } } });
            const { unmount } = renderApp("/candidates");
            await screen.findByRole("table", { name: "Candidates" }, RENDER_STEP);
            expect(navLinks(), role).toEqual(links);
            unmount();
        }
    });

    test("UI-JH-015: a candidate role still edits candidates (the read-only switch is the JOB_HANDLER's only)", { timeout: 20_000 }, async () => {
        backend(userWithRole("REGISTRATION_DESK"));
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByRole("heading", { name: "SAMAN SILVA" }, RENDER_STEP)).toBeInTheDocument();
        await waitFor(() => expect(screen.getAllByRole("textbox").some((box) => !(box as HTMLInputElement).disabled)).toBe(true));
        expect(screen.getAllByRole("button", { name: /^Remove/ }).length).toBeGreaterThan(0);
    });
});
