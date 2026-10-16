import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormShareStatus } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend, type FetchRoutes } from "./helpers";

// Candidate > Additional details > Share Form (the public Candidate Form link).
// Synthetic data only; the backend is stubbed (its rules are in
// test/candidateFormShare.test.js).

const DETAILS: CandidateDetails = {
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: null, nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, jobId: null, testResult: null, testDate: null,
        automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    requiredDocuments: [],
};
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };
const SHARE = "/api/admin/candidates/N0000002/form-share";
const URL = "https://form.example.test/#k=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const status = (state: FormShareStatus["state"], extra: Partial<FormShareStatus> = {}): FormShareStatus => ({
    passportId: "N0000002",
    state,
    submittedAt: null,
    link: state === "OPEN" ? { linkId: "l1", createdAt: "2026-10-16T05:00:00.000Z", createdByName: "Test Admin", expiresAt: "2026-10-19T05:00:00.000Z", lockedUntil: null } : null,
    ...extra,
});

function backend(routes: FetchRoutes, role = "ADMIN") {
    return signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role } } },
        "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
        "GET /api/admin/candidates/N0000002/additional-details": { status: 200, body: VIEW },
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

describe("Share Form", () => {
    test("creates the link once, shows it with Copy and WhatsApp, and the form state", async () => {
        const { calls } = backend({
            [`GET ${SHARE}`]: { status: 200, body: status("LOCKED") },
            [`POST ${SHARE}`]: { status: 201, body: { url: URL, linkId: "l1", expiresAt: "2026-10-19T05:00:00.000Z", status: status("OPEN") } },
        });
        const dialog = await openDialog();
        expect(await within(dialog).findByText(/Locked: no active link/)).toBeInTheDocument();
        expect(within(dialog).getByText(/must verify with their own Passport Number and NIC Number/)).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(within(dialog).getByRole("button", { name: "Create share link" }));
        const field = await within(dialog).findByLabelText("Share link for this candidate");
        expect(field).toHaveValue(URL);
        expect(field).toHaveAttribute("readonly");
        expect(within(dialog).getByText(/Shown only now/)).toBeInTheDocument();
        expect(within(dialog).getByText(/Open: the candidate can open the form/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
        // user-event provides the clipboard in tests.
        expect(await navigator.clipboard.readText()).toBe(URL);
        expect(within(dialog).getByRole("button", { name: "Copied" })).toBeInTheDocument();
        const whatsapp = within(dialog).getByRole("link", { name: "Share on WhatsApp" });
        expect(whatsapp.getAttribute("href")).toContain(encodeURIComponent(URL));
        expect(whatsapp).toHaveAttribute("rel", "noopener noreferrer");
        expect(posts(calls)).toEqual([SHARE]);
    });

    test("an open link can be revoked after a confirmation; a new link says it replaces the current one", async () => {
        const { calls } = backend({
            [`GET ${SHARE}`]: { status: 200, body: status("OPEN") },
            [`POST ${SHARE}/revoke`]: { status: 200, body: status("LOCKED") },
        });
        const dialog = await openDialog();
        expect(await within(dialog).findByText(/Link created .* by Test Admin; expires/)).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Create a new link (replaces the current one)" })).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(within(dialog).getByRole("button", { name: "Revoke link" }));
        expect(posts(calls)).toEqual([]);
        await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
        expect(await within(dialog).findByText(/Locked: no active link/)).toBeInTheDocument();
        expect(posts(calls)).toEqual([`${SHARE}/revoke`]);
    });

    test("a submitted form can't be shared again", async () => {
        backend({ [`GET ${SHARE}`]: { status: 200, body: status("SUBMITTED", { submittedAt: "2026-10-16T06:00:00.000Z" }) } });
        const dialog = await openDialog();
        expect(await within(dialog).findByText(/Submitted: the form is locked/)).toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: /Create/ })).toBeNull();
        expect(within(dialog).queryByRole("button", { name: /Revoke/ })).toBeNull();
    });

    test("server errors are shown as they are (e.g. the form is not configured)", async () => {
        backend({
            [`GET ${SHARE}`]: { status: 200, body: status("LOCKED") },
            [`POST ${SHARE}`]: { status: 503, body: { message: "The Candidate Form is not configured, so no link can be created.", code: "FORM_NOT_CONFIGURED" } },
        });
        const dialog = await openDialog();
        await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Create share link" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent(/not configured|Something went wrong/);
        expect(within(dialog).queryByLabelText("Share link for this candidate")).toBeNull();
    });

    test("a role that can't edit the candidate sees no Share Form button", async () => {
        backend({}, "VIEWER");
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("form", { name: "Additional details" }, RENDER_STEP);
        expect(screen.queryByRole("button", { name: "Share Form" })).toBeNull();
    });
});
