import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails, type CandidateList } from "../api/candidates";
import { stepTones } from "../components/candidate/CandidateStepper";
import { ADMIN, renderApp, signedInBackend } from "./helpers";

// Synthetic candidates only.
const stages = (done: boolean[]) => CANDIDATE_STAGES.map((stage, i) => ({ stage, completed: done[i] }));

const LIST: CandidateList = {
    items: [
        { passportId: "N0000001", uniqueId: "0001", name: "KAMAL PERERA", nic: "199012345678", jobTypes: ["Driver", "Welder"], stages: stages([true, true, false, false, false, false]) },
        { passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: null, jobTypes: [], stages: stages([false, false, false, true, true, true]) },
    ],
    pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
    filters: { search: null },
};

const DETAILS: CandidateDetails = {
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", address: "1 Main Street", jobExperience: "5 years", whatsappNumber: null,
    },
    stages: stages([false, false, false, true, true, true]).map((s) => ({ ...s, completedAt: null, notes: null })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_REPORT: null, AGREEMENT: null, AFFIDAVIT: null },
    requiredDocuments: (["PASSPORT", "MEDICAL", "POLICE_REPORT", "AGREEMENT", "AFFIDAVIT"] as const).map((documentType) => ({ documentType, included: documentType === "PASSPORT" })),
};

const VIEWER = { ...ADMIN, role: "VIEWER" };

describe("stepper colours", () => {
    test("stages completed after an incomplete one are 'out of order'", () => {
        expect(stepTones(stages([false, false, false, true, true, true]))).toEqual(["incomplete", "incomplete", "incomplete", "complete-out-of-order", "complete-out-of-order", "complete-out-of-order"]);
        expect(stepTones(stages([true, true, false, true, false, false]))).toEqual(["complete", "complete", "incomplete", "complete-out-of-order", "incomplete", "incomplete"]);
        expect(stepTones(stages([true, true, true, true, true, true]))).toEqual(Array(6).fill("complete"));
    });
});

describe("Candidates list", () => {
    test("lists candidates with progress and searches through the API", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/candidates": { status: 200, body: LIST } });
        renderApp("/candidates");
        const table = await screen.findByRole("table", { name: "Candidates" });
        expect(within(table).getByRole("link", { name: "KAMAL PERERA" })).toHaveAttribute("href", "/candidates/N0000001");
        expect(within(table).getByText("Driver, Welder")).toBeInTheDocument();
        expect(within(table).getByRole("img", { name: "2 of 6 stages completed" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Add candidate" })).toHaveAttribute("href", "/candidates/new");

        await userEvent.setup().type(screen.getByLabelText("Search candidates"), "901234567V{Enter}");
        expect(calls.at(-1)!.path).toBe("/api/admin/candidates?page=1&pageSize=25&search=901234567V");
    });

    test("a viewer cannot add candidates", async () => {
        signedInBackend({ "GET /auth/me": { status: 200, body: { admin: VIEWER } }, "GET /api/admin/candidates": { status: 200, body: LIST } });
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        expect(screen.queryByRole("link", { name: "Add candidate" })).not.toBeInTheDocument();
    });
});

describe("Candidate deployment", () => {
    test("opens on the first incomplete stage; every stage can be selected", async () => {
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS } });
        renderApp("/candidates/N0000002");
        const stepper = await screen.findByRole("navigation", { name: "Deployment stages" });
        expect(within(stepper).getByRole("button", { name: "1. Test details (incomplete)" })).toHaveAttribute("aria-current", "step");
        expect(within(stepper).getByRole("button", { name: "4. IVS interview (completed out of order)" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Test details" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Call log" })).toBeInTheDocument();

        await userEvent.setup().click(within(stepper).getByRole("button", { name: /^3\. Document submission/ }));
        expect(await screen.findByRole("heading", { name: "Document submission" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Export PDF" })).toBeInTheDocument();
        expect(screen.getByLabelText("All 5 required documents are included")).toBeDisabled();
        for (const label of ["Medical", "Police report", "Scan - Agreement", "Scan - Affidavit"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    });
});

describe("Candidate registration", () => {
    test("required fields and the passport file are checked before anything is sent", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Register candidate" }));
        expect(screen.getByText("Enter the surname.")).toBeInTheDocument();
        expect(screen.getByText("Choose the passport file.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("an already registered passport links to that candidate", async () => {
        const { calls } = signedInBackend({ "POST /api/admin/candidates": { status: 409, body: { message: "A candidate with this passport ID is already registered.", code: "CANDIDATE_EXISTS" } } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Surname *"), "SILVA");
        await user.type(screen.getByLabelText("Other names *"), "SAMAN");
        await user.type(screen.getByLabelText("NIC *"), "901234567V");
        await user.type(screen.getByLabelText("Passport ID *"), "n0000002");
        await user.type(screen.getByLabelText("Job type *"), "Driver{Enter}");
        await user.type(screen.getByLabelText("Job experience *"), "5 years");
        await user.type(screen.getByLabelText("Address *"), "1 Main Street");
        await user.upload(screen.getByLabelText("Passport *"), new File(["%PDF-1.4"], "passport.pdf", { type: "application/pdf" }));
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        expect(await screen.findByText("A candidate with this passport ID is already registered.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open the registered candidate" })).toHaveAttribute("href", "/candidates/N0000002");
        expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ passportId: "N0000002", surname: "SILVA", jobTypes: ["Driver"], nic: "901234567V" });
    });

    test("a viewer sees no registration form", async () => {
        signedInBackend({ "GET /auth/me": { status: 200, body: { admin: VIEWER } } });
        renderApp("/candidates/new");
        expect(await screen.findByText("Candidate registration needs an admin or reviewer account.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Register candidate" })).not.toBeInTheDocument();
    });
});
