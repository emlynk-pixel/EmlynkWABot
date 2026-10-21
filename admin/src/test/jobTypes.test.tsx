import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails, type CandidateList } from "../api/candidates";
import type { JobList, JobOptions, JobTypeList } from "../api/jobs";
import { ADMIN, JOB_TYPE_CHOICES, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// Settings > Job Types, the dynamic job type pickers and "No Preferred Type"
// (JOB-TYPE-*, DYNAMIC-JOB-TYPE-* on screen). Synthetic data; the backend is a stub.

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });
const NO_PREFERENCE = { code: "NO_PREFERENCE", label: "No Preferred Type" };
const managed = (id: string, name: string, isActive = true, jobCount = 0) => ({ id, code: name.toUpperCase().replace(/\W+/g, "_"), name, isActive, jobCount, createdAt: "2026-10-01T05:00:00.000Z", updatedAt: "2026-10-01T05:00:00.000Z" });
const LIST: JobTypeList = { items: [managed("t1", "PLUMBER", true, 2), managed("t2", "Glazier", false, 1)], noPreference: NO_PREFERENCE };

describe("Settings > Job Types", () => {
    test("JOB-TYPE-001 / 005 an ADMIN sees the list (status, jobs), adds a type, renames one, deactivates and activates; No Preferred Type is a system row with no actions", async () => {
        let list = LIST;
        const { calls } = signedInBackend({
            "GET /api/admin/job-types": () => ({ status: 200, body: list }),
            "POST /api/admin/job-types": () => { list = { ...list, items: [...list.items, managed("t3", "Scaffolder")] }; return { status: 201, body: { id: "t3", code: "SCAFFOLDER", name: "Scaffolder" } }; },
            "PATCH /api/admin/job-types/t1": { status: 200, body: managed("t1", "Plumber", true, 2) },
            "PATCH /api/admin/job-types/t2": { status: 200, body: managed("t2", "Glazier", true, 1) },
        });
        renderApp("/settings/job-types");
        const user = userEvent.setup();
        const table = await screen.findByRole("table", { name: "Job types" }, RENDER_STEP);
        const rows = within(table).getAllByRole("row").slice(1);
        expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["No Preferred TypeFor candidates: any job type", "PLUMBER", "Glazier"]);
        expect(within(rows[0]).getByText("System")).toBeInTheDocument();
        expect(within(rows[0]).queryAllByRole("button")).toHaveLength(0);
        expect(within(rows[1]).getByText("Active")).toBeInTheDocument();
        expect(within(rows[2]).getByText("Inactive")).toBeInTheDocument();
        expect(within(rows[1]).getAllByRole("cell")[2]).toHaveTextContent("2");

        await user.type(screen.getByLabelText("New job type"), "  Scaffolder ");
        await user.click(screen.getByRole("button", { name: "Add job type" }));
        expect(await screen.findByText('Added "Scaffolder".')).toBeInTheDocument();
        expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Scaffolder" });

        await user.click(screen.getByRole("button", { name: "Rename PLUMBER" }));
        const rename = screen.getByLabelText("New name for PLUMBER");
        await user.clear(rename);
        await user.type(rename, "Plumber");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText('Renamed to "Plumber".')).toBeInTheDocument();
        expect(calls.find((c) => c.method === "PATCH" && c.path.endsWith("/t1"))!.body).toEqual({ name: "Plumber" });

        await user.click(screen.getByRole("button", { name: "Activate Glazier" }));
        expect(await screen.findByText('"Glazier" is active again.')).toBeInTheDocument();
        expect(calls.find((c) => c.method === "PATCH" && c.path.endsWith("/t2"))!.body).toEqual({ isActive: true });
        // There is no delete anywhere.
        expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    });

    test("JOB-TYPE-004 a case-insensitive duplicate: the server's message is shown and nothing changes", async () => {
        signedInBackend({
            "GET /api/admin/job-types": { status: 200, body: LIST },
            "POST /api/admin/job-types": { status: 409, body: { message: "A job type with this name already exists.", code: "DUPLICATE" } },
        });
        renderApp("/settings/job-types");
        const user = userEvent.setup();
        await screen.findByRole("table", { name: "Job types" }, RENDER_STEP);
        await user.type(screen.getByLabelText("New job type"), "plumber");
        await user.click(screen.getByRole("button", { name: "Add job type" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("A job type with this name already exists.");
        expect(screen.getByRole("button", { name: "Add job type" })).toBeEnabled();
    });

    test("JOB-TYPE-002 a MANAGER (or any non-admin) gets Access Restricted and no Job Types request", async () => {
        for (const role of ["MANAGER", "ANALYST"]) {
            const { calls } = signedInBackend({ ...asRole(role), "GET /api/admin/job-types": { status: 200, body: LIST } });
            const view = renderApp("/settings/job-types");
            expect(await screen.findByText("Access Restricted", undefined, RENDER_STEP)).toBeInTheDocument();
            expect(calls.some((c) => c.path === "/api/admin/job-types")).toBe(false);
            view.unmount();
        }
    });
});

describe("candidate job type picker", () => {
    test("DYNAMIC-JOB-TYPE-001 / 005 / 006 registration offers the server's active list and No Preferred Type; a new type appears with no code change", async () => {
        signedInBackend({ "GET /api/admin/job-type-choices": { status: 200, body: { jobTypes: ["Crane Operator", "PLUMBER"], noPreference: NO_PREFERENCE } } });
        renderApp("/candidates/new");
        const select = await screen.findByLabelText("Job type *", undefined, RENDER_STEP);
        await within(select).findByRole("option", { name: "Crane Operator" });
        expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Select a job type…", "No Preferred Type", "Crane Operator", "PLUMBER"]);
    });

    test("DYNAMIC-JOB-TYPE-006 No Preferred Type stands alone: picking it replaces the types, picking a type replaces it; it is sent as its code", async () => {
        const { calls } = signedInBackend({ "POST /api/admin/candidates": { status: 400, body: { message: "stop here" } } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        const select = await screen.findByLabelText("Job type *", undefined, RENDER_STEP);
        await within(select).findByRole("option", { name: "Driver" });
        await user.selectOptions(select, "Driver");
        await user.selectOptions(select, "Welder");
        expect(screen.getByRole("button", { name: "Remove Driver" })).toBeInTheDocument();
        await user.selectOptions(select, "NO_PREFERENCE");
        expect(screen.queryByRole("button", { name: "Remove Driver" })).toBeNull();
        expect(screen.getByRole("button", { name: "Remove No Preferred Type" })).toBeInTheDocument();
        expect(within(select).queryByRole("option", { name: "No Preferred Type" })).toBeNull();
        // Register: the code is sent, never the label.
        for (const [label, value] of [["Surname *", "SILVA"], ["Other names *", "SAMAN"], ["NIC *", "901234567V"], ["Passport ID *", "n0000002"], ["WhatsApp number *", "94771234567"]]) await user.type(screen.getByLabelText(label), value);
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        await screen.findByText("stop here");
        expect(calls.find((c) => c.method === "POST" && c.path === "/api/admin/candidates")!.body).toMatchObject({ jobTypes: ["NO_PREFERENCE"] });
        // A type replaces it.
        await user.selectOptions(select, "Caregiver");
        expect(screen.queryByRole("button", { name: "Remove No Preferred Type" })).toBeNull();
    });

    test("DYNAMIC-JOB-TYPE-002 / JOB-TYPE-008 Candidate Details: the saved values show (No Preferred Type as its label); a value no longer in the list stays, marked, and is kept on save", async () => {
        const details = (jobTypes: string[]): CandidateDetails => ({
            verification: { details: null, documents: null },
            candidate: {
                passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes, surname: "SILVA", otherNames: "SAMAN",
                dateOfBirth: null, placeOfBirth: null, passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-11", nationality: null, sex: null,
                address: null, jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
            },
            stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null, jobSource: null, jobStatus: null, testResult: null, testDate: null, automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [] })),
            documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
            variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
            jobAssignments: { current: null, history: [] },
            requiredDocuments: [],
        });
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: details(["Uber driver", "Welder"]) },
            "PUT /api/admin/candidates/N0000002": { status: 200, body: details(["Uber driver", "Welder", "Driver"]) },
        });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        const user = userEvent.setup();
        const select = await screen.findByLabelText("Job type *", undefined, RENDER_STEP);
        await within(select).findByRole("option", { name: "Driver" });
        expect(screen.getByRole("button", { name: "Remove Uber driver" }).parentElement).toHaveTextContent("(not in list)");
        expect(screen.getByRole("button", { name: "Remove Welder" }).parentElement).not.toHaveTextContent("(not in list)");
        await user.selectOptions(select, "Driver");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await screen.findByRole("button", { name: "Remove Driver" });
        expect(calls.find((c) => c.method === "PUT" && c.path === "/api/admin/candidates/N0000002")!.body).toMatchObject({ jobTypes: ["Uber driver", "Welder", "Driver"] });
    });

    test("the candidate list shows No Preferred Type as its label", async () => {
        const list: CandidateList = {
            items: [{ passportId: "N0000009", uniqueId: "0009", name: "OPEN CANDIDATE", nic: null, jobTypes: ["NO_PREFERENCE"], workflowStatus: { code: "REGISTERED", label: "Registered" }, stages: CANDIDATE_STAGES.map((stage) => ({ stage, completed: false })) }],
            pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
            filters: { search: null },
        } as CandidateList;
        signedInBackend({ "GET /api/admin/candidates": { status: 200, body: list } });
        renderApp("/candidates");
        const row = (await screen.findByText("OPEN CANDIDATE", undefined, RENDER_STEP)).closest("tr")!;
        expect(within(row).getByText("No Preferred Type")).toBeInTheDocument();
        expect(within(row).queryByText("NO_PREFERENCE")).toBeNull();
    });

    test("a failed choices request says so and can be retried", async () => {
        let fail = true;
        signedInBackend({ "GET /api/admin/job-type-choices": () => (fail ? { status: 500, body: { message: "x" } } : { status: 200, body: JOB_TYPE_CHOICES }) });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        expect(await screen.findByText(/The job types could not be loaded/, undefined, RENDER_STEP)).toBeInTheDocument();
        fail = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await within(screen.getByLabelText("Job type *")).findByRole("option", { name: "Driver" })).toBeInTheDocument();
    });
});

describe("New job", () => {
    test("DYNAMIC-JOB-TYPE-004 / 007 the Job type list is the server's active types; No Preferred Type is never offered for a Job", async () => {
        const OPTIONS: JobOptions = { jobTypes: [{ id: "t1", name: "PLUMBER", code: "PLUMBER" }, { id: "t9", name: "Rebar Worker", code: "REBAR_WORKER" }], clients: [{ id: "c1", name: "Acme", agentIds: ["a1"] }], agents: [{ id: "a1", name: "Ion", countryCode: "RO" }] } as JobOptions;
        const empty: JobList = {
            items: [], pagination: { page: 1, pageSize: 50, total: 0, totalItems: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
            counts: { processing: 0, completed: 0, cancelled: 0 }, filters: { view: "processing", search: null },
        } as JobList;
        signedInBackend({ ...asRole("MANAGER"), "GET /api/admin/jobs": { status: 200, body: empty }, "GET /api/admin/job-options": { status: 200, body: OPTIONS } });
        renderApp("/jobs");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "New job" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: "New job" });
        const select = await within(dialog).findByLabelText("Job type");
        await within(select).findByRole("option", { name: "Rebar Worker" });
        const names = within(select).getAllByRole("option").map((o) => o.textContent);
        expect(names).toContain("PLUMBER");
        expect(names.some((name) => /no preferred/i.test(name ?? ""))).toBe(false);
    });
});
