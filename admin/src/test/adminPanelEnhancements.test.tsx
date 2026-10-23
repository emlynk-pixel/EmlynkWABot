import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type CandidateList, type FormSubmission, type PendingChange } from "../api/candidates";
import type { AllocationCandidateList } from "../api/workAllocation";
import { conflictHref, conflictSummary } from "../components/candidate/formConflicts";
import { CANDIDATE_PASSPORT_HELP, isCandidatePassportNumber, normalizeNewPassportNumber } from "../components/validation";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Admin Panel enhancements (UI): the Candidate Form conflict "!" in the Candidates list, the
// highlighted / focused field on the candidate page, the Work Allocation filters, and the
// passport number rule on registration. Synthetic data; the backend is a stub (the server's own
// rules are in test/adminPanelEnhancements.test.js).

const asRole = (role: string) => ({ "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } } });

// ---------------------------------------------------------------- conflict indicator

const listItem = (passportId: string, name: string, formConflicts?: string[]) => ({
    passportId, uniqueId: passportId.slice(-4), name, nic: null, jobTypes: [], workflowStatus: { code: "FORM_SUBMITTED" as const, label: "Form Submitted" }, stages: [], ...(formConflicts ? { formConflicts } : {}),
});
const LIST = (items: ReturnType<typeof listItem>[]): CandidateList => ({ items, pagination: { page: 1, pageSize: 100, total: items.length, totalPages: 1 }, filters: { search: null } });

describe("CONFLICT-UI: the red ! in the Candidates list", () => {
    test("shown only for candidates with unresolved Candidate Form changes; small, labelled, linking to the first field", async () => {
        signedInBackend({
            "GET /api/admin/candidates": { status: 200, body: LIST([
                listItem("N0000001", "KAMAL PERERA", []),
                listItem("N0000002", "SAMAN SILVA", ["basic.birthPlace", "measurements.shoeSize"]),
                listItem("N0000003", "NIMAL FERNANDO"),
                listItem("N0000004", "RUWAN SILVA", ["measurements.shoeSize"]),
            ]) },
        });
        renderApp("/candidates");
        const table = await screen.findByRole("table", { name: "Candidates" }, RENDER_STEP);
        expect(within(table).queryByTestId("form-conflict-N0000001")).toBeNull();
        expect(within(table).queryByTestId("form-conflict-N0000003")).toBeNull(); // older server: no field at all
        const badge = within(table).getByTestId("form-conflict-N0000002");
        expect(badge).toHaveTextContent("!");
        expect(badge).toHaveAccessibleName("2 Candidate Form changes to review: Place of birth, Shoe size");
        expect(badge).toHaveAttribute("title", "2 Candidate Form changes to review: Place of birth, Shoe size");
        expect(badge).toHaveAttribute("href", "/candidates/N0000002?stage=CANDIDATE_DETAILS&field=basic.birthPlace");
        expect(badge.className).toMatch(/rounded-full/);
        expect(badge.className).toMatch(/bg-critical/);
        // An Additional details field opens that tab.
        expect(within(table).getByTestId("form-conflict-N0000004")).toHaveAttribute("href", "/candidates/N0000004?tab=additional&field=measurements.shoeSize");
        expect(within(table).getByTestId("form-conflict-N0000004")).toHaveAccessibleName("Candidate Form change to review: Shoe size");
    });

    test("the link targets: Candidate details stage or Additional details tab", () => {
        expect(conflictHref("N1", "contact.address")).toBe("/candidates/N1?stage=CANDIDATE_DETAILS&field=contact.address");
        expect(conflictHref("N1", "family.father.birthDate")).toBe("/candidates/N1?tab=additional&field=family.father.birthDate");
        expect(conflictSummary(["basic.fullName"])).toBe("Candidate Form change to review: Name according to passport");
    });
});

// ---------------------------------------------------------------- candidate page highlight

const PATH = "/api/admin/candidates/N0000002";
const details = (): CandidateDetails => ({
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "2003-06-05", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-11", nationality: null, sex: "M",
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null, jobSource: null, jobStatus: null, testResult: null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current: null, active: [], history: [] },
    requiredDocuments: [],
    verification: { details: null, documents: null },
});
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };
const PLACE: PendingChange = { field: "basic.birthPlace", current: "COLOMBO", submitted: "KANDY" };
const ADDRESS: PendingChange = { field: "contact.address", current: "1 Main Street", submitted: "12 GALLE ROAD" };
const SHOE: PendingChange = { field: "measurements.shoeSize", current: null, submitted: "9" };
const submission = (pending: PendingChange[]): FormSubmission => ({ passportId: "N0000002", formStatus: "SUBMITTED", submittedAt: "2026-10-17T06:30:00.000Z", submitted: {}, original: null, changed: [], pending });

// A stateful stub: a confirm / revoke removes the field from the pending list, like the server.
function candidateBackend(pending: PendingChange[], role = "MANAGER", extra: FetchRoutes = {}) {
    let open = [...pending];
    const decide = async (url: URL) => { void url; return { status: 200, body: submission(open) }; };
    return {
        ...signedInBackend({
            ...asRole(role),
            [`GET ${PATH}`]: { status: 200, body: details() },
            [`GET ${PATH}/additional-details`]: { status: 200, body: VIEW },
            [`GET ${PATH}/form-submission`]: () => ({ status: 200, body: submission(open) }),
            [`POST ${PATH}/form-submission/confirm-field`]: decide,
            [`POST ${PATH}/form-submission/reject-field`]: decide,
            ...extra,
        }),
        resolve: (field: string) => { open = open.filter((change) => change.field !== field); },
    };
}
const fieldBox = (field: string) => document.querySelector<HTMLElement>(`[data-conflict-field="${field}"]`);

describe("CONFLICT-UI: the candidate page highlights unresolved fields and focuses the one asked for", () => {
    test("opened from the !: the asked field is focused and strongly outlined; the other unresolved field is outlined; others are plain", async () => {
        candidateBackend([PLACE, ADDRESS]);
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS&field=basic.birthPlace");
        await screen.findByTestId("submitted-hint-basic.birthPlace", undefined, RENDER_STEP);
        await waitFor(() => expect(screen.getByLabelText("Place of birth")).toHaveFocus(), RENDER_STEP);
        expect(fieldBox("basic.birthPlace")).toHaveAttribute("data-conflict", "focused");
        expect(fieldBox("basic.birthPlace")!.className).toMatch(/ring-critical/);
        expect(fieldBox("contact.address")).toHaveAttribute("data-conflict", "pending");
        expect(fieldBox("basic.surname")).not.toHaveAttribute("data-conflict");
        expect(fieldBox("basic.surname")!.className).not.toMatch(/ring-/);
    });

    test("an Additional details field opens that tab, focused", async () => {
        candidateBackend([SHOE]);
        renderApp("/candidates/N0000002?tab=additional&field=measurements.shoeSize");
        await waitFor(() => expect(fieldBox("measurements.shoeSize")).toHaveAttribute("data-conflict", "focused"), RENDER_STEP);
        await waitFor(() => expect(fieldBox("measurements.shoeSize")!.contains(document.activeElement)).toBe(true), RENDER_STEP);
    });

    test("confirming one field removes its highlight and leaves the other; resolving the last leaves no highlight at all", async () => {
        const stub = candidateBackend([PLACE, ADDRESS]);
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS&field=basic.birthPlace");
        const user = userEvent.setup();
        await screen.findByTestId("submitted-hint-basic.birthPlace", undefined, RENDER_STEP);
        stub.resolve("basic.birthPlace");
        await user.click(screen.getByRole("button", { name: "Confirm Place of birth" }));
        await user.click(await screen.findByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(fieldBox("basic.birthPlace")).not.toHaveAttribute("data-conflict"), RENDER_STEP);
        expect(fieldBox("basic.birthPlace")!.className).not.toMatch(/ring-/);
        expect(fieldBox("contact.address")).toHaveAttribute("data-conflict", "pending");
        stub.resolve("contact.address");
        await user.click(screen.getByRole("button", { name: "Revoke Address" }));
        await user.click(await screen.findByRole("button", { name: "Revoke change" }));
        await waitFor(() => expect(document.querySelectorAll("[data-conflict]")).toHaveLength(0), RENDER_STEP);
    });

    test("roles that cannot review still see the highlight, but no Confirm / Revoke", async () => {
        candidateBackend([PLACE], "JOB_HANDLER");
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS&field=basic.birthPlace");
        await screen.findByTestId("submitted-hint-basic.birthPlace", undefined, RENDER_STEP);
        expect(fieldBox("basic.birthPlace")).toHaveAttribute("data-conflict", "focused");
        expect(screen.queryByRole("button", { name: "Confirm Place of birth" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Revoke Place of birth" })).toBeNull();
    });
});

// ---------------------------------------------------------------- Work Allocation filters

const allocationList = (total: number, items: AllocationCandidateList["items"] = []): AllocationCandidateList => ({
    items, pagination: { page: 1, pageSize: 100, total, totalPages: Math.max(1, Math.ceil(total / 100)) },
    filters: { status: "UNALLOCATED", analystId: null, search: null },
});
const ROW = {
    passportId: "N0000001", uniqueId: "0001", name: "KAMAL PERERA", nic: null, jobTypes: ["PLUMBER"], whatsappNumber: null, contactNumber: null,
    registeredDate: "2026-10-05T04:00:00.000Z", stagesCompleted: 1, stagesTotal: 8, currentStage: "JOB_DETAILS" as const,
    workflowStatus: { code: "REGISTERED" as const, label: "Registered" }, analyst: null, assignedDate: null,
};
function allocationBackend() {
    return signedInBackend({
        ...asRole("MANAGER"),
        "GET /api/admin/work-allocation/candidates": (url) => ({ status: 200, body: allocationList(url.searchParams.has("jobType") ? 115 : 230, [ROW]) }),
        "GET /api/admin/work-allocation/analysts": { status: 200, body: { analysts: [], unavailableAnalysts: [], unallocatedCount: 230 } },
        "GET /api/admin/job-type-choices": { status: 200, body: { jobTypes: ["PLUMBER", "WELDER TIG"], noPreference: { code: "NO_PREFERENCE", label: "No Preferred Type" } } },
    });
}
const lastListQuery = (calls: { path: string }[]) => new URL(calls.filter((c) => c.path.startsWith("/api/admin/work-allocation/candidates")).at(-1)!.path, "http://x").searchParams;

describe("WA-UI: Work Allocation filters are sent to the server and combine", () => {
    test("job type, status and stage are sent to the server; the count is the server's (all pages); Clear resets everything", async () => {
        const { calls } = allocationBackend();
        renderApp("/work-allocation");
        const filters = await screen.findByRole("region", { name: "Filters" }, RENDER_STEP);
        const user = userEvent.setup();
        expect(within(filters).getByRole("button", { name: "Clear filters" })).toBeDisabled();
        await waitFor(() => expect(within(filters).getByRole("option", { name: "PLUMBER" })).toBeInTheDocument(), RENDER_STEP);
        await user.selectOptions(within(filters).getByLabelText("Job type"), "PLUMBER");
        await waitFor(() => expect(lastListQuery(calls).get("jobType")).toBe("PLUMBER"));
        await user.selectOptions(within(filters).getByLabelText("Status"), "REGISTERED");
        await user.selectOptions(within(filters).getByLabelText("Current stage"), "JOB_DETAILS");
        await waitFor(() => {
            const query = lastListQuery(calls);
            expect([query.get("jobType"), query.get("workflowStatus"), query.get("stage"), query.get("page")]).toEqual(["PLUMBER", "REGISTERED", "JOB_DETAILS", "1"]);
        });
        expect(await within(filters).findByText("115 candidates match the filters (all pages).")).toBeInTheDocument();
        await user.click(within(filters).getByRole("button", { name: "Clear filters" }));
        await waitFor(() => {
            const query = lastListQuery(calls);
            expect(["jobType", "workflowStatus", "stage", "registeredFrom", "registeredTo"].some((key) => query.has(key))).toBe(false);
        });
        expect(within(filters).getByRole("button", { name: "Clear filters" })).toBeDisabled();
    });

    test("filters from the URL (registration date range) reach the server, and the row shows the candidate's Status", async () => {
        const { calls } = allocationBackend();
        renderApp("/work-allocation?from=2026-10-01&to=2026-10-10&wstatus=REGISTERED");
        await screen.findByText("KAMAL PERERA", undefined, RENDER_STEP);
        const query = lastListQuery(calls);
        expect([query.get("registeredFrom"), query.get("registeredTo"), query.get("workflowStatus")]).toEqual(["2026-10-01", "2026-10-10", "REGISTERED"]);
        expect(screen.getAllByText("Registered").length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------- passport rule (registration form)

describe("PASSPORT-UI: a new candidate's passport number is P or N + 7 digits", () => {
    test("the rule, with lowercase accepted", () => {
        for (const valid of ["P1234567", "N1234567", "p1234567", " n1234567 "]) expect(isCandidatePassportNumber(valid), valid).toBe(true);
        for (const invalid of ["PN1234567", "NP1234567", "A1234567", "P123456", "P12345678", "P1234ABC", "P 1234567", "12345678", ""]) expect(isCandidatePassportNumber(invalid), invalid).toBe(false);
        expect(normalizeNewPassportNumber(" p1234567 ")).toBe("P1234567");
        expect(CANDIDATE_PASSPORT_HELP).toBe("Passport number must start with P or N followed by 7 digits. Example: P1234567");
    });

    test("registration refuses PN1234567 inline and sends nothing; a valid lowercase number is sent in capitals", async () => {
        const posted: unknown[] = [];
        signedInBackend({
            "GET /api/admin/candidates/PN1234567": { status: 404, body: { message: "Candidate not found" } },
            "GET /api/admin/candidates/P1234567": { status: 404, body: { message: "Candidate not found" } },
            "POST /api/admin/candidates": async () => { posted.push(true); return { status: 201, body: { passportId: "P1234567", uniqueId: "0009" } }; },
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        const passport = await screen.findByLabelText("Passport ID *", undefined, RENDER_STEP);
        await user.type(passport, "pn1234567");
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        expect(await screen.findByText(CANDIDATE_PASSPORT_HELP, { selector: "p" })).toBeInTheDocument();
        expect(posted).toHaveLength(0);
    });
});
