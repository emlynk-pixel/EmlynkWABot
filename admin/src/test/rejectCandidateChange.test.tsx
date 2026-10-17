import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormSubmission, type PendingChange } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// "Candidate submitted: <value> [Confirm] [Revoke]". Revoke dismisses ONE proposed value and leaves the
// record as it is; Confirm applies it. Both share one review state on the server (tested in
// test/candidateFormFieldReject.test.js). Synthetic data; the backend is a stateful stub.

const PATH = "/api/admin/candidates/N0000002";
const baseDetails = (overrides: Partial<CandidateDetails["candidate"]> = {}): CandidateDetails => ({
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "2003-06-05", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-11", nationality: null, sex: "M",
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null, ...overrides,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, legacyJobId: null, testResult: null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current: null, history: [] },
    requiredDocuments: [],
});
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };
const BIRTH: PendingChange = { field: "basic.birthDate", current: "2003-06-05", submitted: "2003-05-06" };
const ADDRESS: PendingChange = { field: "contact.address", current: "1 Main Street", submitted: "12 GALLE ROAD" };

function backend(role = "MANAGER", pending: PendingChange[] = [BIRTH, ADDRESS], extra: FetchRoutes = {}) {
    let record = baseDetails();
    let open = [...pending];
    let reviews: { field: string; status: "CONFIRMED" | "REJECTED" }[] = [];
    const state = (): FormSubmission => ({
        passportId: "N0000002", formStatus: "SUBMITTED", submittedAt: "2026-10-17T06:30:00.000Z",
        submitted: { "basic.birthDate": "2003-05-06", "contact.address": "12 GALLE ROAD" }, original: null, changed: [], pending: open, reviews,
    });
    const stub = signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        [`GET ${PATH}`]: () => ({ status: 200, body: record }),
        [`GET ${PATH}/additional-details`]: { status: 200, body: VIEW },
        [`GET ${PATH}/form-submission`]: () => ({ status: 200, body: state() }),
        [`POST ${PATH}/form-submission/reject-field`]: () => ({ status: 200, body: state() }),
        [`POST ${PATH}/form-submission/confirm-field`]: () => ({ status: 200, body: state() }),
        ...extra,
    });
    return {
        ...stub,
        // What the server does for each decision.
        reject: (field: string) => { open = open.filter((c) => c.field !== field); reviews = [...reviews, { field, status: "REJECTED" }]; },
        confirm: (field: string) => {
            if (field === "basic.birthDate") record = baseDetails({ dateOfBirth: "2003-05-06" });
            if (field === "contact.address") record = baseDetails({ address: "12 GALLE ROAD" });
            open = open.filter((c) => c.field !== field);
            reviews = [...reviews, { field, status: "CONFIRMED" }];
        },
    };
}
const open = () => renderApp(`/candidates/N0000002?stage=CANDIDATE_DETAILS`);
const hint = (field: string) => screen.findByTestId(`submitted-hint-${field}`, undefined, RENDER_STEP);
const posts = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST");

describe("Revoke next to Confirm", () => {
    test("REJECT-001 a pending changed field shows Candidate submitted with both Confirm and Revoke", async () => {
        backend();
        open();
        const birth = await hint("basic.birthDate");
        expect(birth).toHaveTextContent("Candidate submitted: 06 May 2003");
        expect(within(birth).getByRole("button", { name: "Confirm Date of birth" })).toBeInTheDocument();
        expect(within(birth).getByRole("button", { name: "Revoke Date of birth" })).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(2);
    });

    test("REJECT-002 / 003 / 005 / 006 / 007 Revoke asks first; then the record is unchanged, only a reject request is sent, the hint becomes a small rejected note and the others stay", async () => {
        const ctl = backend();
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("basic.birthDate")).getByRole("button", { name: "Revoke Date of birth" }));
        const dialog = await screen.findByRole("dialog", { name: "Revoke the candidate's Date of birth?" });
        expect(within(dialog).getByText("05 Jun 2003")).toBeInTheDocument();
        expect(within(dialog).getByText("06 May 2003")).toBeInTheDocument();
        expect(within(dialog).getByText(/The current value is kept/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(posts(ctl.calls)).toHaveLength(0);
        expect(screen.getByTestId("submitted-hint-basic.birthDate")).toBeInTheDocument(); // nothing is hidden before the server answers

        await user.click(within(screen.getByTestId("submitted-hint-basic.birthDate")).getByRole("button", { name: "Revoke Date of birth" }));
        ctl.reject("basic.birthDate");
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke change" }));
        await waitFor(() => expect(screen.queryByTestId("submitted-hint-basic.birthDate")).toBeNull());
        // The request: one POST to reject-field with only the field key and the values the screen saw.
        const sent = posts(ctl.calls);
        expect(sent.map((c) => c.path)).toEqual([`${PATH}/form-submission/reject-field`]);
        expect(ctl.calls.filter((c) => c.method === "POST")[0]).toMatchObject({ body: { field: "basic.birthDate", expectedCurrentValue: "2003-06-05", expectedSubmittedValue: "2003-05-06" } });
        // The record keeps its value; a small read-only note replaces the buttons (REJECT-006).
        expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-06-05");
        const note = await screen.findByTestId("rejected-note-basic.birthDate");
        expect(note).toHaveTextContent("Candidate change rejected");
        expect(screen.queryByRole("button", { name: "Confirm Date of birth" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Revoke Date of birth" })).toBeNull();
        // Other pending changes are untouched (REJECT-007).
        const address = screen.getByTestId("submitted-hint-contact.address");
        expect(within(address).getByRole("button", { name: "Confirm Address" })).toBeInTheDocument();
        expect(within(address).getByRole("button", { name: "Revoke Address" })).toBeInTheDocument();
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
    });

    test("while it is being rejected the button says Rejecting… and is disabled", async () => {
        let release: () => void = () => {};
        const ctl = backend("ADMIN", [BIRTH], {
            [`POST ${PATH}/form-submission/reject-field`]: async () => {
                await new Promise<void>((resolve) => { release = resolve; });
                ctl.reject("basic.birthDate");
                return { status: 200, body: {} };
            },
        });
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("basic.birthDate")).getByRole("button", { name: "Revoke Date of birth" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke change" }));
        expect(await screen.findByRole("button", { name: "Rejecting…" })).toBeDisabled();
        expect(screen.getByTestId("submitted-hint-basic.birthDate")).toBeInTheDocument();
        release();
        await waitFor(() => expect(screen.queryByTestId("submitted-hint-basic.birthDate")).toBeNull());
    });

    test("REJECT-008 Confirm still works on another field after a Revoke", async () => {
        const ctl = backend();
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("basic.birthDate")).getByRole("button", { name: "Revoke Date of birth" }));
        ctl.reject("basic.birthDate");
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke change" }));
        await screen.findByTestId("rejected-note-basic.birthDate");
        await user.click(within(screen.getByTestId("submitted-hint-contact.address")).getByRole("button", { name: "Confirm Address" }));
        ctl.confirm("contact.address");
        await user.click(within(await screen.findByRole("dialog", { name: "Update Address?" })).getByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(screen.getByLabelText("Address")).toHaveValue("12 GALLE ROAD"));
        expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-06-05");
        expect(posts(ctl.calls).map((c) => c.path)).toEqual([`${PATH}/form-submission/reject-field`, `${PATH}/form-submission/confirm-field`]);
    });

    test("REJECT-010 a stale Revoke (someone else decided first) shows the server's message and changes nothing on screen", async () => {
        const ctl = backend("MANAGER", [ADDRESS], {
            [`POST ${PATH}/form-submission/reject-field`]: { status: 409, body: { message: "This change was already confirmed. Refresh and review again.", code: "FORM_FIELD_REVIEW_STALE" } },
        });
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("contact.address")).getByRole("button", { name: "Revoke Address" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke change" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("This change was already confirmed. Refresh and review again.");
        expect(screen.getByTestId("submitted-hint-contact.address")).toBeInTheDocument();
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
        expect(posts(ctl.calls)).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});

describe("who can revoke (REJECT-011 / 012)", () => {
    test("ADMIN and MANAGER get Revoke; an Analyst and the Registration Desk see the hint and no buttons", async () => {
        for (const [role, can] of [["ADMIN", true], ["MANAGER", true], ["ANALYST", false], ["REGISTRATION_DESK", false]] as const) {
            backend(role, [ADDRESS]);
            const view = open();
            const address = await hint("contact.address");
            expect(address).toHaveTextContent("Candidate submitted: 12 GALLE ROAD");
            expect(within(address).queryByRole("button", { name: "Revoke Address" }) !== null, role).toBe(can);
            expect(within(address).queryByRole("button", { name: "Confirm Address" }) !== null, role).toBe(can);
            view.unmount();
        }
    });
});

describe("unsaved Admin typing (REJECT-016)", () => {
    test("rejecting one field does not discard what the Admin is typing in another", async () => {
        const ctl = backend("MANAGER", [BIRTH, ADDRESS]);
        const user = userEvent.setup();
        open();
        await hint("basic.birthDate");
        const place = screen.getByLabelText("Place of birth");
        await user.clear(place);
        await user.type(place, "KANDY");
        const address = screen.getByLabelText("Address");
        await user.clear(address);
        await user.type(address, "Typed but not saved");
        await user.click(within(screen.getByTestId("submitted-hint-basic.birthDate")).getByRole("button", { name: "Revoke Date of birth" }));
        ctl.reject("basic.birthDate");
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke change" }));
        await screen.findByTestId("rejected-note-basic.birthDate");
        expect(screen.getByLabelText("Place of birth")).toHaveValue("KANDY");
        expect(screen.getByLabelText("Address")).toHaveValue("Typed but not saved");
        expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-06-05");
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
        // The hint for the field with unsaved typing is still there, with its buttons.
        expect(within(screen.getByTestId("submitted-hint-contact.address")).getByRole("button", { name: "Revoke Address" })).toBeInTheDocument();
    });
});
