import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormSubmission, type PendingChange } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// "Candidate submitted: <value> [Confirm]" under the record's own fields, and the
// one-field Confirm. Synthetic data; the backend is a stateful stub (the rules
// themselves are in test/candidateFormFieldConfirm.test.js).

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
const EMPTY_DETAILS = {
    nameAsInPassport: null, permanentAddress: null, birthday: null, tshirtSize: null, pantSize: null, shoeSize: null, fatherAlive: null, fatherFullName: null, fatherBirthday: null,
    motherAlive: null, motherFullName: null, motherBirthday: null, maritalStatus: null, wifeFullName: null, wifeBirthday: null, child1Name: null, child2Name: null, child3Name: null, otherJobSkills: null,
};

const BIRTH: PendingChange = { field: "basic.birthDate", current: "2003-06-05", submitted: "2003-05-06" };
const ADDRESS: PendingChange = { field: "contact.address", current: "1 Main Street", submitted: "12 GALLE ROAD" };
const SHIRT: PendingChange = { field: "measurements.shirtSize", current: null, submitted: "M" };
const submission = (pending: PendingChange[], overrides: Partial<FormSubmission> = {}): FormSubmission => ({
    passportId: "N0000002", formStatus: "SUBMITTED", submittedAt: "2026-10-17T06:30:00.000Z",
    submitted: { "basic.birthDate": "2003-05-06", "contact.address": "12 GALLE ROAD", "contact.email": "new@example.com", "guardian.name": "KAMAL PERERA" },
    original: null, changed: [], pending, ...overrides,
});

// The stub keeps the record and the pending list, and applies a confirmation like the server.
function backend(role = "MANAGER", pending: PendingChange[] = [BIRTH, ADDRESS, SHIRT], extra: FetchRoutes = {}) {
    let record = baseDetails();
    let additional: AdditionalDetailsView = VIEW;
    let open = [...pending];
    const posts: unknown[] = [];
    const stub = signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        [`GET ${PATH}`]: () => ({ status: 200, body: record }),
        [`GET ${PATH}/additional-details`]: () => ({ status: 200, body: additional }),
        [`GET ${PATH}/form-submission`]: () => ({ status: 200, body: submission(open) }),
        [`POST ${PATH}/form-submission/confirm-field`]: (url) => {
            void url;
            return { status: 200, body: submission(open) };
        },
        ...extra,
    });
    return { ...stub, posts, apply: (field: string) => {
        if (field === "basic.birthDate") record = baseDetails({ dateOfBirth: "2003-05-06" });
        if (field === "contact.address") record = baseDetails({ address: "12 GALLE ROAD" });
        if (field === "measurements.shirtSize") additional = { ...VIEW, details: { ...EMPTY_DETAILS, tshirtSize: "M" }, updatedDate: "2026-10-17T07:00:00.000Z" };
        open = open.filter((change) => change.field !== field);
    } };
}
const open = (query = "?stage=CANDIDATE_DETAILS") => renderApp(`/candidates/N0000002${query}`);
const hint = (field: string) => screen.findByTestId(`submitted-hint-${field}`, undefined, RENDER_STEP);

describe("Candidate submitted hints", () => {
    test("CONFIRM-001 / 002 / 017 a changed mapped field shows a compact hint with Confirm; unchanged and unmapped fields show nothing", async () => {
        backend();
        open();
        const birth = await hint("basic.birthDate");
        expect(birth).toHaveTextContent("Candidate submitted: 06 May 2003");
        expect(within(birth).getByRole("button", { name: "Confirm Date of birth" })).toBeInTheDocument();
        expect(await hint("contact.address")).toHaveTextContent("Candidate submitted: 12 GALLE ROAD");
        // The record's own value stays the main value.
        expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-06-05");
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
        // No change submitted for these (or no home in the record): no hint, no button.
        for (const field of ["basic.surname", "basic.sex", "passport.expiryDate", "contact.email", "guardian.name", "contact.district"]) expect(screen.queryByTestId(`submitted-hint-${field}`), field).toBeNull();
        expect(screen.getAllByRole("button", { name: /^Confirm / })).toHaveLength(2);
    });

    test("additional-details fields get the hint too", async () => {
        backend();
        open("?tab=additional");
        expect(await hint("measurements.shirtSize")).toHaveTextContent("Candidate submitted: M");
        expect(within(screen.getByTestId("submitted-hint-measurements.shirtSize")).getByRole("button", { name: "Confirm T-shirt size" })).toBeInTheDocument();
    });

    test("CONFIRM-003 / 004 / 006 / 012 Confirm asks first, sends one field and only the values it saw, then refreshes: that hint is gone, the others stay", async () => {
        const ctl = backend();
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("basic.birthDate")).getByRole("button", { name: "Confirm Date of birth" }));
        const dialog = await screen.findByRole("dialog", { name: "Update Date of birth?" });
        expect(within(dialog).getByText("05 Jun 2003")).toBeInTheDocument();
        expect(within(dialog).getByText("06 May 2003")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(ctl.calls.filter((c) => c.method === "POST")).toHaveLength(0);
        // The hint is not hidden before the server answers.
        expect(screen.getByTestId("submitted-hint-basic.birthDate")).toBeInTheDocument();

        await user.click(within(screen.getByTestId("submitted-hint-basic.birthDate")).getByRole("button", { name: "Confirm Date of birth" }));
        ctl.apply("basic.birthDate"); // what the server does on this POST
        await user.click(within(await screen.findByRole("dialog", { name: "Update Date of birth?" })).getByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(screen.queryByTestId("submitted-hint-basic.birthDate")).toBeNull());
        const posts = ctl.calls.filter((c) => c.method === "POST");
        expect(posts).toHaveLength(1);
        expect(posts[0].path).toBe(`${PATH}/form-submission/confirm-field`);
        expect(posts[0].body).toEqual({ field: "basic.birthDate", expectedCurrentValue: "2003-06-05", expectedSubmittedValue: "2003-05-06" });
        // The record now shows the confirmed value; the other differences are still pending.
        await waitFor(() => expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-05-06"));
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
        expect(screen.getByTestId("submitted-hint-contact.address")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("while it is being confirmed the button is disabled and says Confirming…", async () => {
        let release: () => void = () => {};
        const ctl = backend("ADMIN", [BIRTH], {
            [`POST ${PATH}/form-submission/confirm-field`]: async () => {
                await new Promise<void>((resolve) => { release = resolve; });
                ctl.apply("basic.birthDate");
                return { status: 200, body: submission([]) };
            },
        });
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("basic.birthDate")).getByRole("button", { name: "Confirm Date of birth" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm change" }));
        const busy = await screen.findByRole("button", { name: "Confirming…" });
        expect(busy).toBeDisabled();
        expect(screen.getByTestId("submitted-hint-basic.birthDate")).toBeInTheDocument();
        release();
        await waitFor(() => expect(screen.queryByTestId("submitted-hint-basic.birthDate")).toBeNull());
    });

    test("a stale screen (409) shows the server's message and nothing is hidden or changed", async () => {
        const ctl = backend("MANAGER", [ADDRESS], {
            [`POST ${PATH}/form-submission/confirm-field`]: { status: 409, body: { message: "This value changed since you opened the page. Refresh and review again.", code: "FORM_FIELD_STALE" } },
        });
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("contact.address")).getByRole("button", { name: "Confirm Address" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm change" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("This value changed since you opened the page. Refresh and review again.");
        expect(screen.getByTestId("submitted-hint-contact.address")).toBeInTheDocument();
        expect(ctl.calls.filter((c) => c.method === "POST")).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("another server error is shown near the confirmation, in Admin-safe words", async () => {
        backend("MANAGER", [ADDRESS], { [`POST ${PATH}/form-submission/confirm-field`]: { status: 400, body: { message: "This field cannot be confirmed from the Candidate Form.", code: "FIELD_NOT_CONFIRMABLE" } } });
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("contact.address")).getByRole("button", { name: "Confirm Address" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm change" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("cannot be confirmed");
    });
});

describe("who can confirm (CONFIRM-013 / 014)", () => {
    test("ADMIN and MANAGER get the Confirm button", async () => {
        for (const role of ["ADMIN", "MANAGER"]) {
            backend(role);
            const view = open();
            expect(within(await hint("basic.birthDate")).getByRole("button", { name: "Confirm Date of birth" })).toBeInTheDocument();
            view.unmount();
        }
    });

    test("an Analyst and the Registration Desk see what was submitted but have no Confirm button", async () => {
        for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
            backend(role);
            const view = open();
            expect(await hint("basic.birthDate")).toHaveTextContent("Candidate submitted: 06 May 2003");
            expect(screen.queryByRole("button", { name: /^Confirm / })).toBeNull();
            view.unmount();
        }
    });
});

describe("the full submission panel is gone; only inline hints remain (CLEAN-001 .. 012)", () => {
    test("CLEAN-001 / 002 / 010 there is no Candidate Form submission panel or section card, and no submitted value is repeated elsewhere on the page", async () => {
        backend("ADMIN", [ADDRESS]);
        open();
        await hint("contact.address");
        expect(screen.queryByRole("region", { name: "Candidate Form submission" })).toBeNull();
        expect(screen.queryByText("Candidate Form submission")).toBeNull();
        for (const title of ["Basic & Identification", "Contact & Location", "Work & Skills", "Physical Measurements", "Family Background", "Guardian Details"]) {
            expect(screen.queryByRole("heading", { name: title }), title).toBeNull();
        }
        expect(screen.queryByText(/answers? differ from what the form was prefilled/)).toBeNull();
        expect(screen.queryByText("Changed")).toBeNull();
        expect(screen.queryByText(/Original:/)).toBeNull();
        // Submitted values with no Admin field are not shown at all; a mapped one is shown once, as the hint.
        expect(screen.queryByText(/KAMAL PERERA/)).toBeNull();
        expect(screen.queryByText(/new@example.com/)).toBeNull();
        expect(document.body.textContent?.match(/12 GALLE ROAD/g) ?? []).toHaveLength(1);
    });

    test("CLEAN-003 / 004 / 005 a changed mapped field keeps its inline hint with Confirm; an unchanged one shows nothing", async () => {
        backend("ADMIN", [ADDRESS]);
        open();
        const address = await hint("contact.address");
        expect(address).toHaveTextContent("Candidate submitted: 12 GALLE ROAD");
        expect(within(address).getByRole("button", { name: "Confirm Address" })).toBeInTheDocument();
        expect(screen.queryByTestId("submitted-hint-basic.birthDate")).toBeNull();
        expect(screen.getAllByRole("button", { name: /^Confirm / })).toHaveLength(1);
    });

    test("CLEAN-006 / 007 / 008 / 009 confirming updates the current field and removes only that hint; the others stay; only a GET and the one POST are sent", async () => {
        const ctl = backend("MANAGER", [BIRTH, ADDRESS]);
        const user = userEvent.setup();
        open();
        await user.click(within(await hint("basic.birthDate")).getByRole("button", { name: "Confirm Date of birth" }));
        ctl.apply("basic.birthDate");
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-05-06"));
        expect(screen.queryByTestId("submitted-hint-basic.birthDate")).toBeNull();
        expect(screen.getByTestId("submitted-hint-contact.address")).toBeInTheDocument();
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
        const writes = ctl.calls.filter((c) => c.method !== "GET");
        expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${PATH}/form-submission/confirm-field`]);
        expect(writes[0].body).toEqual({ field: "basic.birthDate", expectedCurrentValue: "2003-06-05", expectedSubmittedValue: "2003-05-06" });
    });

    test("CLEAN-011 the roles are unchanged: Admin and Manager confirm; Analyst and Registration Desk see the hint only", async () => {
        for (const [role, confirms] of [["ADMIN", true], ["MANAGER", true], ["ANALYST", false], ["REGISTRATION_DESK", false]] as const) {
            backend(role, [ADDRESS]);
            const view = open();
            const address = await hint("contact.address");
            expect(address).toHaveTextContent("Candidate submitted: 12 GALLE ROAD");
            expect(within(address).queryByRole("button", { name: "Confirm Address" }) !== null, role).toBe(confirms);
            view.unmount();
        }
    });

    test("CLEAN-012 confirming one field keeps what the Admin has typed in another field (Candidate details)", async () => {
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
        await user.click(within(screen.getByTestId("submitted-hint-basic.birthDate")).getByRole("button", { name: "Confirm Date of birth" }));
        ctl.apply("basic.birthDate");
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(screen.getByLabelText("Date of birth")).toHaveValue("2003-05-06"));
        // The unrelated edits survive the refresh, and the form still knows they are unsaved.
        expect(screen.getByLabelText("Place of birth")).toHaveValue("KANDY");
        expect(screen.getByLabelText("Address")).toHaveValue("Typed but not saved");
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
        expect(screen.getByTestId("submitted-hint-contact.address")).toBeInTheDocument();
    });

    test("CLEAN-012 the same for Additional details: a confirmed T-shirt size does not discard other typing", async () => {
        const ctl = backend("ADMIN", [SHIRT]);
        const user = userEvent.setup();
        open("?tab=additional");
        await hint("measurements.shirtSize");
        await user.type(await screen.findByLabelText("Other job skills"), "Welding");
        await user.click(within(screen.getByTestId("submitted-hint-measurements.shirtSize")).getByRole("button", { name: "Confirm T-shirt size" }));
        ctl.apply("measurements.shirtSize");
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm change" }));
        await waitFor(() => expect(screen.getByLabelText("T-shirt size")).toHaveValue("M"));
        expect(screen.getByLabelText("Other job skills")).toHaveValue("Welding");
        expect(screen.queryByTestId("submitted-hint-measurements.shirtSize")).toBeNull();
    });

    test("a very small status shows only that the form was submitted, and only on Additional details", async () => {
        backend("ADMIN", []);
        const first = open("?tab=additional");
        expect(await screen.findByTestId("form-status", undefined, RENDER_STEP)).toHaveTextContent(/Candidate Form submitted: 17 Oct 2026/);
        first.unmount();
        backend("ADMIN", [], { [`GET ${PATH}/form-submission`]: { status: 200, body: { passportId: "N0000002", formStatus: "LOCKED", submittedAt: null, submitted: null, original: null, changed: [], pending: [] } } });
        open("?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        expect(screen.queryByTestId("form-status")).toBeNull();
    });
});
