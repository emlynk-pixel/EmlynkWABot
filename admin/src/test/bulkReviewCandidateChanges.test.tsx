import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormSubmission, type PendingChange } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Confirm All / Reject All in the Candidate details / Additional details footers. Synthetic data; the
// backend is a stateful stub (the transaction and its rules are in test/candidateFormBulkReview.test.js).

const PATH = "/api/admin/candidates/N0000002";
const baseDetails = (overrides: Partial<CandidateDetails["candidate"]> = {}): CandidateDetails => ({
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "2003-06-05", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-11", nationality: null, sex: "M",
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null, ...overrides,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null, jobSource: null, jobStatus: null, testResult: null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current: null, history: [] },
    requiredDocuments: [],
    verification: { details: null, documents: null },
});
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };

const BIRTH: PendingChange = { field: "basic.birthDate", current: "2003-06-05", submitted: "2003-05-06" };
const ADDRESS: PendingChange = { field: "contact.address", current: "1 Main Street", submitted: "12 GALLE ROAD" };
const SHOE: PendingChange = { field: "measurements.shoeSize", current: "41", submitted: "42" };
const submission = (pending: PendingChange[], reviews: FormSubmission["reviews"] = []): FormSubmission => ({
    passportId: "N0000002", formStatus: "SUBMITTED", submittedAt: "2026-10-17T06:30:00.000Z",
    submitted: { "basic.birthDate": "2003-05-06", "contact.address": "12 GALLE ROAD", "measurements.shoeSize": "42" },
    original: null, changed: [], pending, reviews,
});

// The stub applies Confirm All / Reject All like the server: every pending change at once.
function backend(role = "ADMIN", pending: PendingChange[] = [BIRTH, ADDRESS, SHOE], extra: FetchRoutes = {}) {
    let record = baseDetails();
    let open = [...pending];
    let reviews: FormSubmission["reviews"] = [];
    const decideAll = (status: "CONFIRMED" | "REJECTED") => {
        if (status === "CONFIRMED") record = baseDetails({ dateOfBirth: "2003-05-06", address: "12 GALLE ROAD" });
        reviews = open.map((change) => ({ field: change.field, status }));
        open = [];
        return { status: 200, body: submission([], reviews) };
    };
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        [`GET ${PATH}`]: () => ({ status: 200, body: record }),
        [`GET ${PATH}/additional-details`]: () => ({ status: 200, body: VIEW }),
        [`GET ${PATH}/form-submission`]: () => ({ status: 200, body: submission(open, reviews) }),
        [`POST ${PATH}/form-submission/confirm-all`]: () => decideAll("CONFIRMED"),
        [`POST ${PATH}/form-submission/reject-all`]: () => decideAll("REJECTED"),
        ...extra,
    });
}
const openPage = () => renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
const card = () => screen.findByTestId("candidate-form-changes", undefined, RENDER_STEP);
const posts = (ctl: ReturnType<typeof backend>) => ctl.calls.filter((c) => c.method === "POST");
const SENT = { changes: [BIRTH, ADDRESS, SHOE].map((c) => ({ field: c.field, expectedCurrentValue: c.current, expectedSubmittedValue: c.submitted })) };

describe("Candidate Form changes: Confirm All / Reject All", () => {
    test("BULK-UI-001 while changes are pending, Confirm All and Reject All sit in the form's footer, left of Cancel (Candidate details and Additional details)", async () => {
        backend();
        const { unmount } = openPage();
        const bar = await card();
        expect(bar).toHaveAccessibleName("3 Candidate Form changes to review");
        const order = (footer: HTMLElement) => within(footer).getAllByRole("button").map((button) => button.textContent);
        expect(order(bar.parentElement as HTMLElement)).toEqual(["Confirm All", "Reject All", "Cancel", "Save changes"]);
        unmount();
        renderApp("/candidates/N0000002?tab=additional");
        const additional = await card();
        expect(order(additional.parentElement as HTMLElement)).toEqual(["Confirm All", "Reject All", "Cancel", "Save additional details"]);
        // Not repeated anywhere else on the page.
        expect(screen.getAllByRole("button", { name: "Confirm All" })).toHaveLength(1);
    });

    test("BULK-UI-002 hidden when the submission has no pending change, and for a record with no Candidate Form at all", async () => {
        backend("ADMIN", []);
        openPage();
        await screen.findByLabelText("Date of birth", undefined, RENDER_STEP);
        expect(screen.queryByTestId("candidate-form-changes")).toBeNull();
        expect(screen.queryByRole("button", { name: "Confirm All" })).toBeNull();
    });

    test("BULK-UI-003 RBAC: only the roles that may confirm Candidate Form changes see the buttons", async () => {
        for (const [role, sees] of [["ADMIN", true], ["OWNER", true], ["TEAM_LEAD", true], ["ANALYST", true], ["JOB_HANDLER", false]] as const) {
            backend(role);
            const { unmount } = openPage();
            // Every role still sees the inline hint (the submission itself is readable).
            await screen.findByTestId("submitted-hint-contact.address", undefined, RENDER_STEP);
            expect(screen.queryByTestId("candidate-form-changes") !== null, role).toBe(sees);
            expect(screen.queryByRole("button", { name: "Confirm All" }) !== null, role).toBe(sees);
            expect(screen.queryByRole("button", { name: "Reject All" }) !== null, role).toBe(sees);
            unmount();
        }
    });

    test("BULK-UI-004 Confirm All lists every change (Field / Current / Submitted), sends exactly what it showed in ONE request, then the bar and the hints go", async () => {
        const ctl = backend();
        const user = userEvent.setup();
        openPage();
        await user.click(within(await card()).getByRole("button", { name: "Confirm All" }));
        const dialog = await screen.findByRole("dialog", { name: "Confirm all 3 Candidate Form changes?" });
        const rows = within(dialog).getAllByRole("row").slice(1).map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));
        expect(rows).toEqual([["Date of birth", "05 Jun 2003", "06 May 2003"], ["Address", "1 Main Street", "12 GALLE ROAD"], ["Shoe size (EU)", "41", "42"]]);
        expect(dialog).toHaveTextContent("If any one cannot be applied, nothing is changed.");
        // Cancel sends nothing.
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(posts(ctl)).toHaveLength(0);

        await user.click(within(await card()).getByRole("button", { name: "Confirm All" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm all" }));
        await waitFor(() => expect(screen.queryByTestId("candidate-form-changes")).toBeNull());
        expect(posts(ctl)).toHaveLength(1);
        expect(posts(ctl)[0].path).toBe(`${PATH}/form-submission/confirm-all`);
        expect(posts(ctl)[0].body).toEqual(SENT);
        // Refreshed: the record holds the confirmed values, no hint is left.
        await waitFor(() => expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-05-06"));
        expect(screen.getByLabelText("Address")).toHaveValue("12 GALLE ROAD");
        expect(screen.queryByTestId("submitted-hint-contact.address")).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("BULK-UI-005 Reject All asks first, sends one request, keeps the record, and leaves a rejected note per field", async () => {
        const ctl = backend();
        const user = userEvent.setup();
        openPage();
        await user.click(within(await card()).getByRole("button", { name: "Reject All" }));
        const dialog = await screen.findByRole("dialog", { name: "Reject all 3 Candidate Form changes?" });
        expect(dialog).toHaveTextContent("The current values are kept.");
        await user.click(within(dialog).getByRole("button", { name: "Reject all" }));
        await waitFor(() => expect(screen.queryByTestId("candidate-form-changes")).toBeNull());
        expect(posts(ctl).map((p) => [p.path, p.body])).toEqual([[`${PATH}/form-submission/reject-all`, SENT]]);
        expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-06-05");
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
        expect(await screen.findByTestId("rejected-note-contact.address")).toHaveTextContent("Candidate change rejected");
    });

    test("BULK-UI-006 double-submit protection: while the request runs the button is disabled and says Confirming…; a second click sends nothing", async () => {
        let release: () => void = () => {};
        const ctl = backend("ADMIN", [BIRTH, ADDRESS, SHOE], {
            [`POST ${PATH}/form-submission/confirm-all`]: async () => {
                await new Promise<void>((resolve) => { release = resolve; });
                return { status: 200, body: submission([]) };
            },
        });
        const user = userEvent.setup();
        openPage();
        await user.click(within(await card()).getByRole("button", { name: "Confirm All" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Confirm all" }));
        const busy = await within(dialog).findByRole("button", { name: "Confirming…" });
        expect(busy).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
        await user.click(busy);
        expect(posts(ctl)).toHaveLength(1);
        release();
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(posts(ctl)).toHaveLength(1);
    });

    test("BULK-UI-007 a refused request (409: nothing decided) shows the server's message and reloads the current state", async () => {
        const message = "Nothing was confirmed (family.spouse.fullName): A spouse is recorded only when the civil status is Married. Confirm the civil status first. Review that change on its own, then use Confirm All again.";
        const ctl = backend("ADMIN", [BIRTH, ADDRESS, SHOE], {
            [`POST ${PATH}/form-submission/confirm-all`]: { status: 409, body: { message, code: "FORM_FIELD_PREREQUISITE" } },
        });
        const user = userEvent.setup();
        openPage();
        await user.click(within(await card()).getByRole("button", { name: "Confirm All" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm all" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(message);
        const gets = () => ctl.calls.filter((c) => c.method === "GET" && c.path === `${PATH}/form-submission`).length;
        await waitFor(() => expect(gets()).toBeGreaterThan(1));
        // Nothing changed: the bar and every hint are still there.
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(await card()).toBeInTheDocument();
        expect(screen.getByTestId("submitted-hint-contact.address")).toBeInTheDocument();
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
    });

    test("BULK-UI-008 the per-field Confirm / Revoke are still there next to the bulk buttons", async () => {
        backend();
        openPage();
        await card();
        const address = screen.getByTestId("submitted-hint-contact.address");
        expect(within(address).getByRole("button", { name: "Confirm Address" })).toBeInTheDocument();
        expect(within(address).getByRole("button", { name: "Revoke Address" })).toBeInTheDocument();
    });
});
