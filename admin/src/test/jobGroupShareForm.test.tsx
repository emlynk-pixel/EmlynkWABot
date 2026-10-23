import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormShareStatus } from "../api/candidates";
import type { CandidateJobAssignment, JobGroupShareStatus } from "../api/jobs";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Share Form > "Share link for the job group", and the Client Job ID on a Job.
// Synthetic data; the backend is stubbed (the rules are in test/jobGroupShare.test.js).

const JOB_ID = "00000000-0000-4000-8000-000000000007";
const JOB: CandidateJobAssignment = {
    jobId: JOB_ID, jobCode: "JOB-2026-000007", companyJobId: "Y26S01", status: "PROCESSING",
    jobType: { id: "t1", code: "WELDER", name: "Welder" }, client: { id: "c1", name: "Acme Construction" },
    responsibleAgent: { id: "a1", name: "Ion Popescu", countryCode: "RO" }, countryCode: "RO", fromCountryCode: "RO", vacancies: 5,
    createdAt: "2026-10-01T05:00:00.000Z", completedAt: null, cancelledAt: null, cancelReason: null,
    assignedAt: "2026-10-02T05:00:00.000Z", removed: false, removedAt: null,
};
const detailsWith = (current: CandidateJobAssignment | null): CandidateDetails => ({
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: null, nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null, jobSource: null, jobStatus: null, testResult: null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current, history: [] },
    requiredDocuments: [],
    verification: { details: null, documents: null },
});
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };
const PERSONAL: FormShareStatus = { passportId: "N0000002", state: "LOCKED", submittedAt: null, link: null };
const GROUP = `/api/admin/jobs/${JOB_ID}/form-share`;
const GROUP_URL = "https://form.example.test/#k=GroupGroupGroupGroupGroupGroupGroupGroupGrou";
const group = (state: "OPEN" | "NONE", extra: Partial<JobGroupShareStatus> = {}): JobGroupShareStatus => ({
    jobId: JOB_ID, jobCode: "JOB-2026-000007", companyJobId: "Y26S01", client: "Acme Construction", jobType: "Welder", jobStatus: "PROCESSING", state,
    counts: { candidates: 4, submitted: 1, remaining: 3 },
    link: state === "OPEN" ? { linkId: "g1", createdAt: "2026-10-17T05:00:00.000Z", createdByName: "Test Admin", expiresAt: "2026-10-20T05:00:00.000Z", lockedUntil: null } : null,
    ...extra,
});

function backend(current: CandidateJobAssignment | null, routes: FetchRoutes = {}, role = "ADMIN") {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        "GET /api/admin/candidates/N0000002": { status: 200, body: detailsWith(current) },
        "GET /api/admin/candidates/N0000002/additional-details": { status: 200, body: VIEW },
        "GET /api/admin/candidates/N0000002/form-share": { status: 200, body: PERSONAL },
        ...routes,
    });
}
async function openDialog() {
    renderApp("/candidates/N0000002?tab=additional");
    const form = await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
    await userEvent.setup().click(within(form).getByRole("button", { name: "Share Form" }));
    return screen.findByRole("dialog", { name: "Share the Candidate Form" });
}
const posts = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST").map((c) => c.path);

describe("Share Form: job group", () => {
    test("without a PROCESSING job the group action is disabled and says why", async () => {
        const { calls } = backend(null);
        const dialog = await openDialog();
        const section = await within(dialog).findByRole("region", { name: "Job group" });
        expect(within(section).getByText(/not on a processing job/)).toBeInTheDocument();
        expect(within(section).getByRole("button", { name: "Create job-group link" })).toBeDisabled();
        expect(calls.some((c) => c.path.includes("/jobs/"))).toBe(false);
    });

    test("with a PROCESSING job it shows the job code, Client Job ID, client, type and the counts", async () => {
        backend(JOB, { [`GET ${GROUP}`]: { status: 200, body: group("NONE") } });
        const dialog = await openDialog();
        const section = await within(dialog).findByRole("region", { name: "Job group" });
        for (const text of ["JOB-2026-000007", "Y26S01", "Acme Construction", "Welder"]) expect(await within(section).findByText(text)).toBeInTheDocument();
        expect(await within(section).findByText("Candidates on the job")).toBeInTheDocument();
        expect(within(section).getByText("4")).toBeInTheDocument();
        expect(within(section).getByText("Already submitted")).toBeInTheDocument();
        expect(within(section).getByText("No active group link.")).toBeInTheDocument();
        expect(within(section).getByRole("button", { name: "Create job-group link" })).toBeEnabled();
    });

    test("a missing Client Job ID is shown as not assigned", async () => {
        backend({ ...JOB, companyJobId: null }, { [`GET ${GROUP}`]: { status: 200, body: group("NONE", { companyJobId: null }) } });
        const section = await within(await openDialog()).findByRole("region", { name: "Job group" });
        expect(within(section).getByText("Not assigned")).toBeInTheDocument();
    });

    test("creating needs a confirmation, then shows the link once with Copy and WhatsApp; closing the dialog discards it", async () => {
        const { calls } = backend(JOB, {
            [`GET ${GROUP}`]: { status: 200, body: group("NONE") },
            [`POST ${GROUP}`]: { status: 201, body: { url: GROUP_URL, linkId: "g1", expiresAt: "2026-10-20T05:00:00.000Z", status: group("OPEN") } },
        });
        const dialog = await openDialog();
        const user = userEvent.setup();
        const section = await within(dialog).findByRole("region", { name: "Job group" });
        const start = await within(section).findByRole("button", { name: "Create job-group link" });
        await user.click(start);
        expect(posts(calls)).toEqual([]);
        expect(within(section).getByText(/Open the form for everyone on JOB-2026-000007/)).toBeInTheDocument();
        await user.click(within(section).getByRole("button", { name: "Not now" }));
        expect(posts(calls)).toEqual([]);

        await user.click(within(section).getByRole("button", { name: "Create job-group link" }));
        await user.click(within(section).getByRole("button", { name: "Yes, create link" }));
        const field = await within(section).findByLabelText("Job-group link");
        expect(field).toHaveValue(GROUP_URL);
        expect(field).toHaveAttribute("readonly");
        expect(within(section).getByText(/Shown only now/)).toBeInTheDocument();
        await user.click(within(section).getByRole("button", { name: "Copy group link" }));
        expect(await navigator.clipboard.readText()).toBe(GROUP_URL);
        expect(within(section).getByRole("link", { name: "Share group link on WhatsApp" }).getAttribute("href")).toContain(encodeURIComponent(GROUP_URL));
        expect(within(section).getByText(/A group link is open/)).toBeInTheDocument();
        expect(posts(calls)).toEqual([GROUP]);

        // Closing and reopening: the secret is gone and cannot be read back.
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        const again = await openDialog();
        expect(within(again).queryByDisplayValue(GROUP_URL)).toBeNull();
        expect(screen.queryByText(GROUP_URL)).toBeNull();
    });

    test("an open group link can be revoked after a confirmation; a new one says it replaces the current one", async () => {
        const { calls } = backend(JOB, {
            [`GET ${GROUP}`]: { status: 200, body: group("OPEN") },
            [`POST ${GROUP}/revoke`]: { status: 200, body: group("NONE") },
        });
        const dialog = await openDialog();
        const user = userEvent.setup();
        const section = await within(dialog).findByRole("region", { name: "Job group" });
        expect(await within(section).findByText(/A group link is open \(created .* by Test Admin; expires/)).toBeInTheDocument();
        expect(within(section).getByRole("button", { name: "Create a new group link (replaces the current one)" })).toBeInTheDocument();
        await user.click(within(section).getByRole("button", { name: "Revoke group link" }));
        expect(posts(calls)).toEqual([]);
        await user.click(within(section).getByRole("button", { name: "Revoke group link" }));
        expect(await within(section).findByText("No active group link.")).toBeInTheDocument();
        expect(posts(calls)).toEqual([`${GROUP}/revoke`]);
    });

    test("the submitted count comes from the server's counts", async () => {
        backend(JOB, { [`GET ${GROUP}`]: { status: 200, body: group("NONE", { counts: { candidates: 9, submitted: 6, remaining: 3 } }) } });
        const section = await within(await openDialog()).findByRole("region", { name: "Job group" });
        expect(await within(section).findByText("9")).toBeInTheDocument();
        expect(within(section).getByText("6")).toBeInTheDocument();
    });

    test("server refusals are shown (the job was completed meanwhile)", async () => {
        backend(JOB, {
            [`GET ${GROUP}`]: { status: 200, body: group("NONE") },
            [`POST ${GROUP}`]: { status: 409, body: { message: "Job JOB-2026-000007 is completed; a job-group link works only for a PROCESSING job.", code: "JOB_NOT_PROCESSING" } },
        });
        const section = await within(await openDialog()).findByRole("region", { name: "Job group" });
        const user = userEvent.setup();
        await user.click(await within(section).findByRole("button", { name: "Create job-group link" }));
        await user.click(within(section).getByRole("button", { name: "Yes, create link" }));
        expect(await within(section).findByRole("alert")).toHaveTextContent(/works only for a PROCESSING job/);
    });

    test("only ADMIN and MANAGER see the group action; an Analyst keeps the personal link only", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
            const { calls } = backend(JOB, {}, role);
            const view = renderApp("/candidates/N0000002?tab=additional");
            const form = await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
            await userEvent.setup().click(within(form).getByRole("button", { name: "Share Form" }));
            const dialog = await screen.findByRole("dialog", { name: "Share the Candidate Form" });
            expect(await within(dialog).findByRole("button", { name: "Create share link" })).toBeInTheDocument();
            expect(within(dialog).queryByRole("region", { name: "Job group" })).toBeNull();
            expect(calls.some((c) => c.path.includes("/jobs/"))).toBe(false);
            view.unmount();
        }
    });

    test("the personal link still works next to it", async () => {
        const { calls } = backend(JOB, {
            [`GET ${GROUP}`]: { status: 200, body: group("NONE") },
            "POST /api/admin/candidates/N0000002/form-share": { status: 201, body: { url: GROUP_URL, linkId: "l1", expiresAt: "2026-10-20T05:00:00.000Z", status: { ...PERSONAL, state: "OPEN" } } },
        });
        const dialog = await openDialog();
        await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Create share link" }));
        expect(await within(dialog).findByLabelText("Share link for this candidate")).toBeInTheDocument();
        expect(posts(calls)).toEqual(["/api/admin/candidates/N0000002/form-share"]);
    });
});
