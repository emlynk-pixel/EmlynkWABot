import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PDFDocument } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails, type VisaSubmissionManifest, type VisaSubmissionSlot } from "../api/candidates";
import { actionLabel } from "../pages/AuditLogsPage";
import { RENDER_STEP, renderApp, signedInBackend, userWithRole, type FetchRoutes } from "./helpers";

// Candidate > Visa submission: the Download of the unsigned file (merged in the browser) and the signed
// PDF upload, for ADMIN (an OWNER too) and TEAM_LEAD only. Synthetic candidates and files; the backend is stubbed.

const PASSPORT_ID = "N0000002";
const BASE = `/api/admin/candidates/${PASSPORT_ID}`;

const DETAILS: CandidateDetails = {
    verification: { details: null, documents: null },
    candidate: {
        passportId: PASSPORT_ID, uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-12", nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: CANDIDATE_STAGES.map((stage) => ({
        stage, completed: false, completedAt: null, notes: null, testAgentName: null, testId: null, jobDate: null, jobCode: null, clientName: null,
        jobSource: null, jobStatus: null, testResult: null, testDate: null, automatic: stage === "CANDIDATE_DETAILS" || stage === "DOCUMENT_SUBMISSION", missing: [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: { POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null } },
    jobAssignments: { current: null, history: [] },
    requiredDocuments: [],
};

const SIGNED = { documentId: "doc-visa", originalFilename: "N0000002 - VISA_SUBMISSION.PDF", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-09T00:00:00.000Z" };
const withSigned = (completed: boolean): CandidateDetails => ({
    ...DETAILS,
    documents: { ...DETAILS.documents, VISA_SUBMISSION: SIGNED },
    stages: DETAILS.stages.map((s) => (s.stage === "VISA_SUBMISSION" ? { ...s, completed } : s)),
});

const SLOTS: [string, string][] = [
    ["PASSPORT", "Passport"], ["SL_NORMAL_POLICE_REPORT", "SL Normal Police Report"], ["SL_VERIFIED_POLICE_REPORT", "SL Verified Police Report"],
    ["ROMANIA_POLICE_REPORT", "Romania Police Report"], ["MEDICAL", "Medical"], ["SCAN", "Scan"],
];
function manifest(statuses: Partial<Record<string, VisaSubmissionSlot["status"]>>): VisaSubmissionManifest {
    return {
        passportId: PASSPORT_ID,
        slots: SLOTS.map(([key, label], i) => {
            const status = statuses[key] ?? "VERIFIED";
            return {
                order: i + 1, key, label, documentType: "MEDICAL", variant: null, status,
                document: status === "VERIFIED" ? { documentId: `doc-${key}`, mimeType: "application/pdf", size: 100, fileUrl: `${BASE}/visa-submission/files/doc-${key}` } : null,
            };
        }),
    };
}

const onePagePdf = async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]);
    return pdf.save();
};

// The candidate's Visa submission stage for a role; the file route answers PDF bytes (the shared stub
// answers JSON only). files[documentId]: that document's bytes (default: a valid one-page PDF).
async function openVisa(role: string, routes: FetchRoutes = {}, files: Record<string, Uint8Array> = {}) {
    const backend = signedInBackend({
        "GET /auth/me": { status: 200, body: { user: userWithRole(role) } },
        [`GET ${BASE}`]: { status: 200, body: DETAILS },
        ...routes,
    });
    const answer = backend.fetchMock.getMockImplementation()!;
    const valid = await onePagePdf();
    backend.fetchMock.mockImplementation(async (input, init) => {
        const response = await answer(input, init);
        const match = /\/visa-submission\/files\/([^/?]+)$/.exec(new URL(String(input), "http://localhost").pathname);
        return match ? new Response((files[match[1]] ?? valid) as BodyInit, { status: 200, headers: { "Content-Type": "application/pdf" } }) : response;
    });
    const saved: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:visa"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    renderApp(`/candidates/${PASSPORT_ID}?stage=VISA_SUBMISSION`);
    expect(await screen.findByRole("heading", { name: "Visa submission" }, RENDER_STEP)).toBeInTheDocument();
    const row = screen.getByText("Visa submission document").closest("div.rounded-xl") as HTMLElement;
    return { ...backend, saved, row };
}

const uploadsOf = (calls: { path: string; method: string }[]) => calls.filter((c) => c.path.includes("/documents/") || c.method === "PUT");
const auditCalls = (calls: { path: string; method: string }[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/visa-submission/merged-download"));
const fileCalls = (calls: { path: string }[]) => calls.filter((c) => c.path.includes("/visa-submission/files/"));

describe("Visa submission: Download", () => {
    test.each(["ADMIN", "OWNER", "TEAM_LEAD"])("%s sees Download beside Upload", async (role) => {
        const { row } = await openVisa(role);
        expect(within(row).getByRole("button", { name: "Download" })).toBeEnabled();
        expect(within(row).getByRole("button", { name: "Upload" })).toBeEnabled();
    });

    test("ANALYST: no Download, the upload is disabled with its reason, no Remove", async () => {
        const { row, calls } = await openVisa("ANALYST", { [`GET ${BASE}`]: { status: 200, body: withSigned(false) } });
        expect(within(row).queryByRole("button", { name: "Download" })).toBeNull();
        expect(within(row).getByRole("button", { name: "Replace" })).toBeDisabled();
        expect(within(row).queryByRole("button", { name: "Remove" })).toBeNull();
        expect(within(row).getByText("Only an Admin or Team Lead can upload or remove the visa submission document.")).toBeInTheDocument();
        expect(calls.some((c) => c.path.includes("/visa-submission/"))).toBe(false);
        // The manual completion form is unchanged.
        expect(screen.getByRole("checkbox", { name: "Stage completed" })).toBeInTheDocument();
    });

    test("every slot verified: merged in slot order, the download audited, then saved; nothing uploaded", async () => {
        const { calls, saved, row } = await openVisa("TEAM_LEAD", {
            [`GET ${BASE}/visa-submission/manifest`]: { status: 200, body: manifest({}) },
            [`POST ${BASE}/visa-submission/merged-download`]: { status: 201, body: { auditId: "a1", passportId: PASSPORT_ID, includedSlots: [], excludedSlots: [] } },
        });
        await userEvent.setup().click(within(row).getByRole("button", { name: "Download" }));
        expect(await screen.findByText(`Downloaded ${PASSPORT_ID}_Visa_Submission_Unsigned.pdf`, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(fileCalls(calls).map((c) => c.path.split("/").pop())).toEqual(SLOTS.map(([key]) => `doc-${key}`));
        expect(auditCalls(calls).map((c) => (c as { body?: unknown }).body)).toEqual([{ includedSlots: SLOTS.map(([key]) => key) }]);
        expect(saved).toEqual([`${PASSPORT_ID}_Visa_Submission_Unsigned.pdf`]);
        expect(uploadsOf(calls)).toEqual([]);
    });

    test("missing and unverified slots: listed for confirmation; Cancel downloads nothing, Download anyway merges the rest", async () => {
        const { calls, saved, row } = await openVisa("ADMIN", {
            [`GET ${BASE}/visa-submission/manifest`]: { status: 200, body: manifest({ ROMANIA_POLICE_REPORT: "UNVERIFIED", MEDICAL: "MISSING" }) },
            [`POST ${BASE}/visa-submission/merged-download`]: { status: 201, body: { auditId: "a1", passportId: PASSPORT_ID, includedSlots: [], excludedSlots: [] } },
        });
        const user = userEvent.setup();
        await user.click(within(row).getByRole("button", { name: "Download" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(within(dialog).getByRole("list", { name: "Documents left out" })).getAllByRole("listitem").map((li) => li.textContent))
            .toEqual(["Romania Police Report (not verified)", "Medical (missing)"]);

        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(fileCalls(calls)).toEqual([]);
        expect(auditCalls(calls)).toEqual([]);

        await user.click(within(row).getByRole("button", { name: "Download" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Download anyway" }));
        await vi.waitFor(() => expect(saved).toHaveLength(1), RENDER_STEP);
        expect((auditCalls(calls)[0] as { body?: unknown }).body).toEqual({ includedSlots: ["PASSPORT", "SL_NORMAL_POLICE_REPORT", "SL_VERIFIED_POLICE_REPORT", "SCAN"] });
    });

    test("no slot verified: an error, nothing fetched or downloaded", async () => {
        const none = Object.fromEntries(SLOTS.map(([key]) => [key, "MISSING" as const]));
        const { calls, saved, row } = await openVisa("ADMIN", { [`GET ${BASE}/visa-submission/manifest`]: { status: 200, body: manifest({ ...none, SCAN: "UNVERIFIED" }) } });
        await userEvent.setup().click(within(row).getByRole("button", { name: "Download" }));
        expect(await screen.findByText(/None of the visa submission documents is verified/)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(fileCalls(calls)).toEqual([]);
        expect(auditCalls(calls)).toEqual([]);
        expect(saved).toEqual([]);
    });

    test("a damaged document: the error names it, and nothing is audited or downloaded", async () => {
        const { calls, saved, row } = await openVisa("ADMIN", { [`GET ${BASE}/visa-submission/manifest`]: { status: 200, body: manifest({}) } }, { "doc-MEDICAL": new TextEncoder().encode("broken") });
        await userEvent.setup().click(within(row).getByRole("button", { name: "Download" }));
        expect(await screen.findByText(/^Medical could not be added to the visa submission file/, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(fileCalls(calls).map((c) => c.path.split("/").pop())).toEqual(["doc-PASSPORT", "doc-SL_NORMAL_POLICE_REPORT", "doc-SL_VERIFIED_POLICE_REPORT", "doc-ROMANIA_POLICE_REPORT", "doc-MEDICAL"]);
        expect(auditCalls(calls)).toEqual([]);
        expect(saved).toEqual([]);
    });

    test("409 SLOT_NOT_VERIFIED: the manifest is read again and the user asked to retry; nothing saved", async () => {
        let reads = 0;
        const { calls, saved, row } = await openVisa("ADMIN", {
            [`GET ${BASE}/visa-submission/manifest`]: () => ({ status: 200, body: ++reads === 1 ? manifest({}) : manifest({ MEDICAL: "UNVERIFIED" }) }),
            [`POST ${BASE}/visa-submission/merged-download`]: { status: 409, body: { message: "A slot changed", code: "SLOT_NOT_VERIFIED" } },
        });
        await userEvent.setup().click(within(row).getByRole("button", { name: "Download" }));
        expect(await screen.findByText(/The documents changed while the file was being prepared \(now: Medical \(not verified\)\)\. Nothing was downloaded\. Click Download to try again\./, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(calls.filter((c) => c.path.endsWith("/visa-submission/manifest"))).toHaveLength(2);
        expect(saved).toEqual([]);
    });

    test("the audit entry fails: the file is not saved, and the user is told", async () => {
        const { saved, row } = await openVisa("ADMIN", {
            [`GET ${BASE}/visa-submission/manifest`]: { status: 200, body: manifest({}) },
            [`POST ${BASE}/visa-submission/merged-download`]: { status: 500, body: {} },
        });
        await userEvent.setup().click(within(row).getByRole("button", { name: "Download" }));
        expect(await screen.findByText(/The download could not be recorded, so the file was not saved/, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(saved).toEqual([]);
    });
});

test("the audit log names the merged download", () => {
    expect(actionLabel("VISA_SUBMISSION_MERGED_DOWNLOAD")).toBe("Visa submission downloaded");
});

describe("Visa submission: signed document upload", () => {
    const UPLOAD_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const SIGNED_PATH = "/storage/v1/object/upload/sign/documents/clients/N0000002/visa/upload_staged.pdf";
    const uploadRoutes = (finalize: { status: number; body: unknown }): FetchRoutes => ({
        [`POST ${BASE}/documents/upload-target`]: { status: 200, body: { uploadId: UPLOAD_ID, uploadUrl: `https://project.supabase.co${SIGNED_PATH}?token=signed`, maxFileSize: 10 * 1024 * 1024 } },
        [`PUT ${SIGNED_PATH}`]: { status: 200, body: {} },
        [`POST ${BASE}/documents/finalize`]: finalize,
    });
    const pdf = () => new File(["%PDF-1.4 signed"], "signed.pdf", { type: "application/pdf" });

    test("PDF only: the picker accepts PDF, and another type is refused before anything is sent", async () => {
        const { calls, row } = await openVisa("ADMIN", uploadRoutes({ status: 200, body: withSigned(false) }));
        const input = screen.getByLabelText("Visa submission document file");
        expect(input).toHaveAttribute("accept", "application/pdf");
        await userEvent.setup({ applyAccept: false }).upload(input, new File(["jpeg"], "photo.jpg", { type: "image/jpeg" }));
        expect(within(row).getByRole("alert")).toHaveTextContent("Only PDF files can be uploaded as the visa submission document.");
        expect(uploadsOf(calls)).toEqual([]);
    });

    test("saved and the stage completed: says so, and the stage shows completed", async () => {
        const { calls } = await openVisa("TEAM_LEAD", uploadRoutes({ status: 200, body: { ...withSigned(true), stageCompletion: { stage: "VISA_SUBMISSION", completed: true, code: null, reason: null } } }));
        await userEvent.setup().upload(screen.getByLabelText("Visa submission document file"), pdf());
        expect(await screen.findByText("Document saved. The Visa submission stage is now completed.")).toBeInTheDocument();
        expect(calls.find((c) => c.path.endsWith("/documents/upload-target"))!.body).toMatchObject({ type: "VISA_SUBMISSION", mimeType: "application/pdf" });
        expect(screen.getByRole("checkbox", { name: "Stage completed" })).toBeChecked();
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    });

    test("saved but not completed: the server's reason is shown", async () => {
        const reason = "The candidate must pass the test before this stage can be completed.";
        await openVisa("ADMIN", uploadRoutes({ status: 200, body: { ...withSigned(false), stageCompletion: { stage: "VISA_SUBMISSION", completed: false, code: "VISA_NEEDS_TEST_PASS", reason } } }));
        await userEvent.setup().upload(screen.getByLabelText("Visa submission document file"), pdf());
        expect(await screen.findByText(`Document saved, but the stage was not completed: ${reason}`)).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Stage completed" })).not.toBeChecked();
    });

    test("FILE_REJECTED: the server's reason is shown", async () => {
        const { row } = await openVisa("ADMIN", uploadRoutes({ status: 422, body: { code: "FILE_REJECTED", message: "The file is not a valid PDF." } }));
        await userEvent.setup().upload(screen.getByLabelText("Visa submission document file"), pdf());
        expect(await within(row).findByRole("alert")).toHaveTextContent("The file is not a valid PDF.");
    });

    test("VISA_SUBMISSION_FORBIDDEN is said plainly", async () => {
        const { row } = await openVisa("ADMIN", uploadRoutes({ status: 403, body: { code: "VISA_SUBMISSION_FORBIDDEN", message: "Insufficient permissions" } }));
        await userEvent.setup().upload(screen.getByLabelText("Visa submission document file"), pdf());
        expect(await within(row).findByRole("alert")).toHaveTextContent("Only an Admin or Team Lead can upload or remove the visa submission document.");
    });

    test("removing the signed document refreshes the stage (reopened by the server)", async () => {
        const { row } = await openVisa("ADMIN", {
            [`GET ${BASE}`]: { status: 200, body: withSigned(true) },
            [`POST ${BASE}/documents/doc-visa/remove`]: { status: 200, body: DETAILS },
        });
        expect(screen.getByRole("checkbox", { name: "Stage completed" })).toBeChecked();
        const user = userEvent.setup();
        await user.click(within(row).getByRole("button", { name: "Remove" }));
        await user.type(screen.getByLabelText(/Reason/), "Wrong signature");
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
        expect(await within(row).findByText(/No file uploaded/)).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Stage completed" })).not.toBeChecked();
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    });
});
