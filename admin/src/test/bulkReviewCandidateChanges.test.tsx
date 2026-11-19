import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormSubmission, type PendingChange } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// Candidate Form changes are reviewed one field at a time only: there is no Confirm All / Reject All.
// Synthetic data.

const PATH = "/api/admin/candidates/N0000002";
const details: CandidateDetails = {
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
    jobAssignments: { current: null, history: [] },
    requiredDocuments: [],
    verification: { details: null, documents: null },
};
const VIEW: AdditionalDetailsView = { passportId: "N0000002", details: null, suggested: { nameAsInPassport: null, permanentAddress: null, birthday: null }, updatedDate: null };
const ADDRESS: PendingChange = { field: "contact.address", current: "1 Main Street", submitted: "12 GALLE ROAD" };
const SHOE: PendingChange = { field: "measurements.shoeSize", current: "41", submitted: "42" };
const submission: FormSubmission = {
    passportId: "N0000002", formStatus: "SUBMITTED", submittedAt: "2026-10-17T06:30:00.000Z",
    submitted: { "contact.address": "12 GALLE ROAD", "measurements.shoeSize": "42" },
    original: null, changed: [], pending: [ADDRESS, SHOE], reviews: [],
};

describe("Candidate Form changes: no bulk review", () => {
    test("BULK-UI-001 a reviewer with pending changes gets no Confirm All / Reject All in Candidate details or Additional details, only the per-field controls", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: ADMIN } },
            [`GET ${PATH}`]: { status: 200, body: details },
            [`GET ${PATH}/additional-details`]: { status: 200, body: VIEW },
            [`GET ${PATH}/form-submission`]: { status: 200, body: submission },
        });
        const { unmount } = renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        await screen.findByRole("button", { name: "Confirm Address" }, RENDER_STEP);
        expect(screen.queryByRole("button", { name: /^(confirm|reject) all$/i })).toBeNull();
        unmount();

        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByRole("button", { name: "Confirm Shoe size (EU)" }, RENDER_STEP);
        expect(screen.queryByRole("button", { name: /^(confirm|reject) all$/i })).toBeNull();
    });
});
