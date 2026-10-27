import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type AdditionalDetailsView, type CandidateDetails, type FormSubmission, type PendingChange } from "../api/candidates";
import { ADMIN, RENDER_STEP, renderApp, signedInBackend } from "./helpers";

// The Candidate Form's Personal Details and parents' alive answers in Admin (Additional details tab):
// the read-only "Submitted on the Candidate Form" card, and Mother / Father Alive offered for Confirm
// like the other mapped fields. Synthetic data; the backend is a stub (the server's rules are in
// test/candidateFormPersonalDetails.test.js).

const PATH = "/api/admin/candidates/N0000002";
const DETAILS: CandidateDetails = {
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
const FATHER: PendingChange = { field: "family.fatherAlive", current: null, submitted: "NO" };

const NEW_ANSWERS = {
    "contact.cityInRomania": "Cluj-Napoca", "contact.distanceToBucharestKm": "323", "basic.bloodGroup": "O+", "basic.height": "5'9\"", "basic.heightCm": "175.3",
    "basic.weight": "70.5", "basic.drivingLicence": "YES", "basic.canReadDrawings": "NO", "basic.teamLeadingSkills": "YES", "basic.otherLanguages": "ENGLISH, ROMANIAN",
    "family.fatherAlive": "NO", "family.motherAlive": "YES",
};
const submission = (submitted: Record<string, string | null>, pending: PendingChange[] = []): FormSubmission => ({
    passportId: "N0000002", formStatus: "SUBMITTED", submittedAt: "2026-10-17T06:30:00.000Z", submitted, original: null, changed: [], pending,
});
function backend(body: FormSubmission) {
    signedInBackend({
        "GET /auth/me": { status: 200, body: { user: { ...ADMIN, role: "MANAGER" } } },
        [`GET ${PATH}`]: { status: 200, body: DETAILS },
        [`GET ${PATH}/additional-details`]: { status: 200, body: VIEW },
        [`GET ${PATH}/form-submission`]: { status: 200, body },
    });
}
const value = (card: HTMLElement, label: string) => within(card).getByText(label).nextElementSibling?.textContent;

describe("Admin: submitted Personal Details", () => {
    test("every new answer is shown with professional labels, units and Yes / No words; the distance is labelled approximate", async () => {
        backend(submission(NEW_ANSWERS, [FATHER]));
        renderApp("/candidates/N0000002?tab=additional");
        const card = await screen.findByTestId("submitted-personal-details", undefined, RENDER_STEP);
        expect(value(card, "City in Romania")).toBe("Cluj-Napoca");
        expect(value(card, "Distance to Bucharest")).toBe("Approx. 323 km (straight line)");
        expect(value(card, "Blood Group")).toBe("O+");
        expect(value(card, "Height")).toBe("5'9\" (≈ 175.3 cm)");
        expect(value(card, "Weight")).toBe("70.5 kg");
        expect(value(card, "Driving Licence")).toBe("Yes");
        expect(value(card, "Can Read Drawings")).toBe("No");
        expect(value(card, "Team Leading Skills")).toBe("Yes");
        expect(value(card, "Other Languages")).toBe("ENGLISH, ROMANIAN");
        expect(value(card, "Mother Alive")).toBe("Yes");
        expect(value(card, "Father Alive")).toBe("No");
        expect(within(card).queryByRole("button")).toBeNull();
        // Father Alive differs from the record: the usual hint with Confirm, on the record's own field.
        const hint = await screen.findByTestId("submitted-hint-family.fatherAlive");
        expect(hint).toHaveTextContent("Candidate submitted: No");
        expect(within(hint).getByRole("button", { name: "Confirm Father alive" })).toBeInTheDocument();
    });

    test("a field with no home of its own in Admin is confirmed from the card; the others there offer no button", async () => {
        const BLOOD: PendingChange = { field: "basic.bloodGroup", current: null, submitted: "O+" };
        const GUARDIAN: PendingChange = { field: "guardian.name", current: null, submitted: "KAMAL PERERA" };
        backend(submission({ ...NEW_ANSWERS, "guardian.name": "KAMAL PERERA", "contact.email": "a@example.com" }, [BLOOD, GUARDIAN]));
        renderApp("/candidates/N0000002?tab=additional");
        const card = await screen.findByTestId("submitted-personal-details", undefined, RENDER_STEP);
        expect(value(card, "Guardian Name")).toBe("KAMAL PERERA");
        expect(value(card, "Email")).toBe("a@example.com");
        expect(within(card).getByTestId("submitted-hint-basic.bloodGroup")).toHaveTextContent("Candidate submitted: O+");
        expect(within(card).getByRole("button", { name: "Confirm Blood Group" })).toBeInTheDocument();
        expect(within(card).getByRole("button", { name: "Revoke Guardian Name" })).toBeInTheDocument();
        // Only the two pending fields have buttons (Distance is derived; Father / Mother Alive are confirmed above).
        expect(within(card).getAllByRole("button")).toHaveLength(4);
    });

    test("an unlisted city has no distance, N/A says not applicable, and an older submission shows no card", async () => {
        backend(submission({ ...NEW_ANSWERS, "contact.cityInRomania": "Satu Nou", "contact.distanceToBucharestKm": null, "basic.otherLanguages": "N/A" }));
        const first = renderApp("/candidates/N0000002?tab=additional");
        const card = await screen.findByTestId("submitted-personal-details", undefined, RENDER_STEP);
        expect(value(card, "Distance to Bucharest")).toBe("Not available for this city");
        expect(value(card, "Other Languages")).toBe("N/A");
        first.unmount();

        backend(submission({ "basic.fullName": "SAMAN SILVA", "contact.cityInRomania": null }));
        renderApp("/candidates/N0000002?tab=additional");
        await screen.findByTestId("form-status", undefined, RENDER_STEP);
        expect(screen.queryByTestId("submitted-personal-details")).toBeNull();
    });
});
