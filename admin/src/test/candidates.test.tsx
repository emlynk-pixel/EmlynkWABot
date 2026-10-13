import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CANDIDATE_STAGES, type CandidateDetails, type CandidateList } from "../api/candidates";
import { FIELD_HINTS, whatsappFromLocal, whatsappLocalPart } from "../components/candidate/CandidateFields";
import { stepTones } from "../components/candidate/CandidateStepper";
import { ADMIN, renderApp, signedInBackend, userWithRole } from "./helpers";

// Synthetic candidates only.
const stages = (done: boolean[]) => CANDIDATE_STAGES.map((stage, i) => ({ stage, completed: done[i] }));

const LIST: CandidateList = {
    items: [
        { passportId: "N0000001", uniqueId: "0001", name: "KAMAL PERERA", nic: "199012345678", jobTypes: ["Driver", "Welder"], stages: stages([true, true, false, false, false, false, false]) },
        { passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: null, jobTypes: [], stages: stages([false, false, false, true, true, true, true]) },
    ],
    pagination: { page: 1, pageSize: 100, total: 2, totalPages: 1 },
    filters: { search: null },
};

const DETAILS: CandidateDetails = {
    candidate: {
        passportId: "N0000002", uniqueId: "0002", name: "SAMAN SILVA", nic: "901234567V", jobTypes: ["Driver"], surname: "SILVA", otherNames: "SAMAN",
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: "2020-05-12", nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: stages([false, false, false, true, true, true, true]).map((s) => ({
        ...s,
        completedAt: null,
        notes: null,
        jobId: null,
        testResult: null,
        testDate: null,
        automatic: s.stage === "CANDIDATE_DETAILS" || s.stage === "DOCUMENT_SUBMISSION",
        missing: s.stage === "CANDIDATE_DETAILS" ? ["passport document"] : s.stage === "DOCUMENT_SUBMISSION" ? ["medical", "police report", "scans"] : [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, SCAN: null, VISA_SUBMISSION: null },
    variantDocuments: {
        POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null },
    },
    requiredDocuments: (["PASSPORT", "MEDICAL", "POLICE_REPORT", "SCAN"] as const).map((documentType) => ({ documentType, included: documentType === "PASSPORT" })),
};

// A signed-in user without candidate permissions: the retired VIEWER role
// (the backend refuses it too). Every application role, REGISTRATION_DESK
// included, manages candidates; this checks the read-only rendering.
const VIEWER = { ...ADMIN, role: "VIEWER" };
const DESK = { ...ADMIN, role: "REGISTRATION_DESK" };

// A document upload: the API issues a signed URL for one staged object
// (upload-target), the browser PUTs the file there, straight to storage, and
// the API records it (finalize). The stub routes by path, so the storage
// host is a stand-in.
const UPLOAD_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SIGNED_PATH = "/storage/v1/object/upload/sign/documents/clients/N0000002/medical/upload_staged.pdf";
const SIGNED_URL = `https://project.supabase.co${SIGNED_PATH}?token=signed`;
function directUploadRoutes(passportId: string, finalized: CandidateDetails, { storageStatus = 200 } = {}) {
    return {
        [`POST /api/admin/candidates/${passportId}/documents/upload-target`]: { status: 200, body: { uploadId: UPLOAD_ID, uploadUrl: SIGNED_URL, maxFileSize: 10 * 1024 * 1024 } },
        [`PUT ${SIGNED_PATH}`]: { status: storageStatus, body: {} },
        [`POST /api/admin/candidates/${passportId}/documents/finalize`]: { status: 200, body: finalized },
    };
}

describe("stepper colours", () => {
    test("stages completed after an incomplete one are 'out of order'", () => {
        expect(stepTones(stages([false, false, false, true, true, true, true]))).toEqual(["incomplete", "incomplete", "incomplete", "complete-out-of-order", "complete-out-of-order", "complete-out-of-order", "complete-out-of-order"]);
        expect(stepTones(stages([true, true, false, true, false, false, false]))).toEqual(["complete", "complete", "incomplete", "complete-out-of-order", "incomplete", "incomplete", "incomplete"]);
        expect(stepTones(stages([true, true, true, true, true, true, true]))).toEqual(Array(7).fill("complete"));
    });
});

describe("Candidates list", () => {
    test("lists candidates with progress and searches through the API", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/candidates": { status: 200, body: LIST } });
        renderApp("/candidates");
        const table = await screen.findByRole("table", { name: "Candidates" });
        expect(within(table).getByRole("link", { name: "KAMAL PERERA" })).toHaveAttribute("href", "/candidates/N0000001");
        expect(within(table).getByText("Driver")).toBeInTheDocument();
        expect(within(table).getByText("Welder")).toBeInTheDocument();
        // Current stage = first not completed; the count is completed stages.
        expect(within(table).getByLabelText("Document submission, 2 of 7 stages completed")).toHaveTextContent("Document submission2/7");
        expect(within(table).getByLabelText("Test details, 4 of 7 stages completed")).toHaveTextContent("Test details4/7");
        expect(screen.getByRole("link", { name: "Add candidate" })).toHaveAttribute("href", "/candidates/new");

        await userEvent.setup().type(screen.getByLabelText("Search candidates"), "901234567V{Enter}");
        expect(calls.at(-1)!.path).toBe("/api/admin/candidates?page=1&pageSize=100&search=901234567V");
    });

    test("a failed search shows its error and Try again, not the previous results", async () => {
        let failing = true;
        const { calls } = signedInBackend({
            "GET /api/admin/candidates": (url) => (url.searchParams.get("search") && failing ? { status: 503, body: {} } : { status: 200, body: LIST }),
        });
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Search candidates"), "nobody{Enter}");

        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Candidates" })).not.toBeInTheDocument();
        expect(screen.queryByText("KAMAL PERERA")).not.toBeInTheDocument();
        expect(screen.queryByText(/candidates? match|No candidates yet/)).not.toBeInTheDocument();

        failing = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("table", { name: "Candidates" })).toBeInTheDocument();
        expect(calls.at(-1)!.path).toBe("/api/admin/candidates?page=1&pageSize=100&search=nobody");
    });

    test("a failed page change shows its error, not the previous page", async () => {
        signedInBackend({
            "GET /api/admin/candidates": (url) => (url.searchParams.get("page") === "2"
                ? { status: 503, body: {} }
                : { status: 200, body: { ...LIST, pagination: { page: 1, pageSize: 100, total: 130, totalPages: 2 } } }),
        });
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
        expect(screen.queryByText("KAMAL PERERA")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    test("a viewer cannot add candidates", async () => {
        signedInBackend({ "GET /auth/me": { status: 200, body: { user: VIEWER } }, "GET /api/admin/candidates": { status: 200, body: LIST } });
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
        expect(within(stepper).getByRole("button", { name: "5. Visa submission (completed out of order)" })).toBeInTheDocument();
        expect(within(stepper).getByRole("button", { name: "6. Visa approval (completed out of order)" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Test details" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Call log" })).toBeInTheDocument();

        await userEvent.setup().click(within(stepper).getByRole("button", { name: /^4\. Document submission/ }));
        expect(await screen.findByRole("heading", { name: "Document submission" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Export PDF" })).toBeInTheDocument();
        // Completed by the documents themselves: no checkbox, no Save.
        expect(screen.getByText("Missing: medical, police report, scans")).toBeInTheDocument();
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
        for (const label of ["Medical", "Police report", "Scans"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    });

    describe("Test details: result and date", () => {
        const withTest = (testResult: "PASS" | "FAIL" | null, testDate: string | null, extra: { notes?: string; completed?: boolean; jobId?: string } = {}): CandidateDetails => ({
            ...DETAILS,
            stages: DETAILS.stages.map((s) => (s.stage === "TEST_DETAILS" ? { ...s, testResult, testDate, jobId: extra.jobId ?? null, notes: extra.notes ?? null, completed: extra.completed ?? false } : s)),
        });

        test("the client name comes from the record; the job ID is entered; nothing is preselected; all three are saved", async () => {
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
                "PUT /api/admin/candidates/N0000002/stages/TEST_DETAILS": { status: 200, body: withTest("PASS", "2026-09-28", { jobId: "JOB-2026-014" }) },
            });
            renderApp("/candidates/N0000002?stage=TEST_DETAILS");
            const user = userEvent.setup();

            expect(await screen.findByLabelText("Client name")).toHaveValue("SAMAN SILVA");
            expect(screen.getByLabelText("Client name")).toHaveAttribute("readonly");
            expect(screen.getByLabelText("Job ID")).toHaveValue("");
            expect(screen.getByLabelText("Job ID")).not.toHaveAttribute("readonly");
            expect(screen.getByLabelText("Test result")).toHaveValue("");
            expect(within(screen.getByLabelText("Test result")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Select result…", "Pass", "Fail"]);
            expect(screen.getByLabelText("Test date")).toHaveValue("");
            expect(screen.getByLabelText("Notes")).toBeInTheDocument();
            expect(screen.getByRole("checkbox", { name: "Stage completed" })).not.toBeChecked();

            await user.type(screen.getByLabelText("Job ID"), " JOB-2026-014 ");
            await user.selectOptions(screen.getByLabelText("Test result"), "PASS");
            await user.type(screen.getByLabelText("Test date"), "2026-09-28");
            await user.click(screen.getByRole("button", { name: "Save changes" }));

            await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ notes: null, completed: false, jobId: "JOB-2026-014", testResult: "PASS", testDate: "2026-09-28" }));
            await vi.waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled());
            expect(screen.getByLabelText("Job ID")).toHaveValue("JOB-2026-014");
            expect(screen.getByLabelText("Test result")).toHaveValue("PASS");
            expect(screen.getByLabelText("Test date")).toHaveValue("2026-09-28");
        });

        test("a saved result and date are shown again; saving other changes keeps the saved date, never today's", async () => {
            const saved = withTest("FAIL", "2026-09-20", { notes: "Retest booked", completed: true, jobId: "JOB-2026-009" });
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: saved },
                "PUT /api/admin/candidates/N0000002/stages/TEST_DETAILS": { status: 200, body: saved },
            });
            renderApp("/candidates/N0000002?stage=TEST_DETAILS");
            const user = userEvent.setup();

            expect(await screen.findByLabelText("Test result")).toHaveValue("FAIL");
            expect(screen.getByLabelText("Job ID")).toHaveValue("JOB-2026-009");
            expect(screen.getByLabelText("Test date")).toHaveValue("2026-09-20");
            expect(screen.getByLabelText("Notes")).toHaveValue("Retest booked");
            expect(screen.getByRole("checkbox", { name: "Stage completed" })).toBeChecked();

            await user.selectOptions(screen.getByLabelText("Test result"), "PASS");
            await user.type(screen.getByLabelText("Job ID"), "X");
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.getByLabelText("Test result")).toHaveValue("FAIL");
            expect(screen.getByLabelText("Job ID")).toHaveValue("JOB-2026-009");

            await user.type(screen.getByLabelText("Notes"), " (done)");
            await user.click(screen.getByRole("button", { name: "Save changes" }));
            await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ notes: "Retest booked (done)", completed: true, jobId: "JOB-2026-009", testResult: "FAIL", testDate: "2026-09-20" }));
        });

        test("the other admin-completed stages stay notes and completion only", async () => {
            signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS } });
            renderApp("/candidates/N0000002?stage=IVS_INTERVIEW");
            expect(await screen.findByRole("heading", { name: "IVS interview" })).toBeInTheDocument();
            expect(screen.getByLabelText("Notes")).toBeInTheDocument();
            expect(screen.queryByLabelText("Test result")).not.toBeInTheDocument();
            expect(screen.queryByLabelText("Test date")).not.toBeInTheDocument();
            expect(screen.queryByLabelText("Client name")).not.toBeInTheDocument();
            expect(screen.queryByLabelText("Job ID")).not.toBeInTheDocument();
        });

        test("a viewer sees the test details but can't change them", async () => {
            signedInBackend({ "GET /auth/me": { status: 200, body: { user: VIEWER } }, "GET /api/admin/candidates/N0000002": { status: 200, body: withTest("PASS", "2026-09-28") } });
            renderApp("/candidates/N0000002?stage=TEST_DETAILS");
            expect(await screen.findByLabelText("Test result")).toBeDisabled();
            expect(screen.getByLabelText("Test result")).toHaveValue("PASS");
            expect(screen.getByLabelText("Test date")).toBeDisabled();
            expect(screen.getByLabelText("Job ID")).toBeDisabled();
            expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
        });
    });

    describe("police reports and affidavits: one row per variant, any or all can be on record", () => {
        const pdf = (name = "report.pdf") => new File([`%PDF-1.4 ${name}`], name, { type: "application/pdf" });
        const document = (id: string, variant: string | null, name = `${id}.pdf`) => ({ documentId: id, originalFilename: name, verificationStatus: "VERIFIED", variant, receivedDate: "2026-09-20T00:00:00.000Z" });
        const groupOf = (name: string) => within(screen.getByRole("region", { name }));
        // The variant travels in the upload's description (upload-target).
        const uploads = (calls: { path: string; body: unknown }[]) =>
            calls.filter((c) => c.path.endsWith("/documents/upload-target")).map((c) => (c.body as { variant?: string }).variant);
        const withPolice = (byVariant: Record<string, ReturnType<typeof document> | null>, untyped: ReturnType<typeof document> | null = null): CandidateDetails => ({
            ...DETAILS,
            variantDocuments: { ...DETAILS.variantDocuments, POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null, ...byVariant }, untyped } },
        });

        test("every variant has its own Upload, with no type to choose; each upload sends its own variant", async () => {
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
                ...directUploadRoutes("N0000002", withPolice({ ROMANIA: document("r1", "ROMANIA") })),
            });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            const user = userEvent.setup();

            await screen.findByRole("region", { name: "Police report" });
            expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
            const police = groupOf("Police report");
            expect(police.getByText("SL Verified")).toBeInTheDocument();
            expect(police.getByText("Romania")).toBeInTheDocument();
            expect(police.getByText("SL Normal")).toBeInTheDocument();
            expect(police.getAllByRole("button", { name: "Upload" })).toHaveLength(3);


            await user.upload(screen.getByLabelText("Police report (Romania) file"), pdf());
            await vi.waitFor(() => expect(uploads(calls)).toEqual(["ROMANIA"]));
            expect(calls.find((c) => c.path.endsWith("/documents/finalize"))!.body).toMatchObject({ type: "POLICE_REPORT", variant: "ROMANIA", uploadId: UPLOAD_ID });
            // Romania now has its file; the other two are still free to upload.
            expect(await police.findByText(/r1\.pdf/)).toBeInTheDocument();
            expect(police.getAllByRole("button", { name: "Upload" })).toHaveLength(2);
            expect(police.getAllByRole("button", { name: "Replace" })).toHaveLength(1);
        });

        test("all three police reports on record: each shows its own file, Replace and Remove; replacing one sends only its variant", async () => {
            const all = withPolice({ SL_VERIFIED: document("v", "SL_VERIFIED", "verified.pdf"), ROMANIA: document("r", "ROMANIA", "romania.pdf"), SL_NORMAL: document("n", "SL_NORMAL", "normal.pdf") });
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: all },
                ...directUploadRoutes("N0000002", all),
            });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            await screen.findByRole("region", { name: "Police report" });
            const police = groupOf("Police report");
            for (const name of ["verified.pdf", "romania.pdf", "normal.pdf"]) expect(police.getByText(new RegExp(name.replace(".", "\\.")))).toBeInTheDocument();
            expect(police.getAllByRole("button", { name: "Replace" })).toHaveLength(3);
            expect(police.getAllByRole("button", { name: "Remove" })).toHaveLength(3);
            expect(police.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();

            await userEvent.setup().upload(screen.getByLabelText("Police report (SL Normal) file"), pdf("new-normal.pdf"));
            await vi.waitFor(() => expect(uploads(calls)).toEqual(["SL_NORMAL"]));
        });

        test("removing one police report asks for that variant by name", async () => {
            const all = withPolice({ SL_VERIFIED: document("v", "SL_VERIFIED", "verified.pdf"), ROMANIA: document("r", "ROMANIA", "romania.pdf") });
            signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: all } });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            await screen.findByRole("region", { name: "Police report" });
            await userEvent.setup().click(groupOf("Police report").getAllByRole("button", { name: "Remove" })[1]);
            const dialog = await screen.findByRole("dialog", { name: "Remove Police report (Romania)?" });
            expect(within(dialog).getByText("romania.pdf")).toBeInTheDocument();
        });

        test("a police report without a type (e.g. received on WhatsApp) is listed and can be removed, not replaced; typed ones can still be uploaded", async () => {
            signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: withPolice({}, document("wa", null, "whatsapp-report.jpg")) } });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            await screen.findByRole("region", { name: "Police report" });
            const police = groupOf("Police report");
            expect(police.getByText("Type not set")).toBeInTheDocument();
            expect(police.getByText(/whatsapp-report\.jpg/)).toBeInTheDocument();
            expect(police.getAllByRole("button", { name: "Upload" })).toHaveLength(3);
            expect(police.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
            expect(police.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
        });

        test("a viewer sees the files but can't upload or remove", async () => {
            signedInBackend({
                "GET /auth/me": { status: 200, body: { user: VIEWER } },
                "GET /api/admin/candidates/N0000002": { status: 200, body: withPolice({ ROMANIA: document("r", "ROMANIA", "romania.pdf") }) },
            });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            await screen.findByRole("region", { name: "Police report" });
            const police = groupOf("Police report");
            expect(police.getByText(/romania\.pdf/)).toBeInTheDocument();
            for (const button of police.getAllByRole("button")) expect(button).toBeDisabled();
        });
    });

    describe("uploads go from the browser straight to storage", () => {
        const medical = () => new File(["%PDF-1.4 medical"], "medical.pdf", { type: "application/pdf" });
        const withMedical: CandidateDetails = {
            ...DETAILS,
            documents: { ...DETAILS.documents, MEDICAL: { documentId: "doc-m", originalFilename: "medical.pdf", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-01T00:00:00.000Z" } },
        };

        test("the API gets only the description; the file is PUT to the signed URL; then the upload is finalized", async () => {
            const { calls } = signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS }, ...directUploadRoutes("N0000002", withMedical) });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            const file = medical();
            await userEvent.setup().upload(await screen.findByLabelText("Medical file"), file);

            expect(await screen.findByText(/medical\.pdf •/)).toBeInTheDocument();
            const uploadCalls = calls.filter((c) => c.method !== "GET");
            expect(uploadCalls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
                "POST /api/admin/candidates/N0000002/documents/upload-target",
                `PUT ${SIGNED_PATH}`,
                "POST /api/admin/candidates/N0000002/documents/finalize",
            ]);
            const [target, put, finalize] = uploadCalls;
            expect(target.body).toEqual({ type: "MEDICAL", mimeType: "application/pdf", fileName: "medical.pdf", fileSize: file.size });
            expect(put.url.href).toBe(SIGNED_URL);
            expect(put.body).toBe(file);
            expect(put.headers).toEqual({ "Content-Type": "application/pdf" });
            expect(finalize.body).toEqual({ type: "MEDICAL", mimeType: "application/pdf", fileName: "medical.pdf", uploadId: UPLOAD_ID });
            // No request to the API carries the file.
            expect(calls.filter((c) => c.url.pathname.startsWith("/api/") && c.body instanceof File)).toEqual([]);
        });

        test("a failed upload to storage is shown and nothing is finalized; the file can be chosen again", async () => {
            const { calls } = signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS }, ...directUploadRoutes("N0000002", withMedical, { storageStatus: 403 }) });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            const user = userEvent.setup();
            await user.upload(await screen.findByLabelText("Medical file"), medical());

            expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
            expect(calls.some((c) => c.url.pathname.endsWith("/documents/finalize"))).toBe(false);
            expect(screen.getAllByText("No file uploaded").length).toBeGreaterThan(0);
            const upload = within(screen.getByLabelText("Medical file").parentElement!).getByRole("button", { name: "Upload" });
            expect(upload).toBeEnabled();
        });

        test("a file the API refuses (e.g. a PDF as the skill video) is never sent to storage", async () => {
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
                "POST /api/admin/candidates/N0000002/documents/upload-target": { status: 422, body: { message: "This file type is not accepted. Use MP4, MOV or WebM.", code: "FILE_REJECTED" } },
            });
            renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
            await userEvent.setup({ applyAccept: false }).upload(await screen.findByLabelText("Skill video file"), new File(["%PDF-1.4"], "skills.pdf", { type: "application/pdf" }));

            expect(await screen.findByText("This file type is not accepted. Use MP4, MOV or WebM.")).toBeInTheDocument();
            expect(calls.some((c) => c.method === "PUT")).toBe(false);
            expect(calls.some((c) => c.url.pathname.endsWith("/documents/finalize"))).toBe(false);
        });
    });

    describe("removing a document", () => {
        const stored = (documentId: string, name: string) => ({ documentId, originalFilename: name, verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-01T00:00:00.000Z" });
        const withNic: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, NIC: stored("doc-nic", "nic-scan.pdf") } };
        const rowOf = (fileLabel: string) => within(screen.getByLabelText(fileLabel).closest("div.rounded-lg") as HTMLElement);

        test("only a stored document has Remove; the reason is required; removing empties the row and says Removed", async () => {
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: withNic },
                "POST /api/admin/candidates/N0000002/documents/doc-nic/remove": { status: 200, body: DETAILS },
            });
            renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
            const user = userEvent.setup();

            await screen.findByLabelText("NIC document file");
            expect(rowOf("Passport file").queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
            expect(rowOf("Skill video file").queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

            await user.click(rowOf("NIC document file").getByRole("button", { name: "Remove" }));
            const dialog = screen.getByRole("dialog", { name: "Remove NIC document?" });
            expect(dialog).toHaveTextContent("nic-scan.pdf will be deleted permanently");

            await user.click(within(dialog).getByRole("button", { name: "Remove" }));
            expect(within(dialog).getByText("Enter the reason for removing this file.")).toBeInTheDocument();
            expect(calls.some((c) => c.path.endsWith("/remove")), "nothing sent without a reason").toBe(false);

            await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(calls.some((c) => c.path.endsWith("/remove"))).toBe(false);

            await user.click(rowOf("NIC document file").getByRole("button", { name: "Remove" }));
            await user.type(screen.getByLabelText("Reason *"), "Wrong person's NIC");
            await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));

            await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            expect(calls.find((c) => c.path.endsWith("/remove"))!.body).toEqual({ reason: "Wrong person's NIC" });
            expect(rowOf("NIC document file").getByRole("status")).toHaveTextContent("Removed");
            expect(rowOf("NIC document file").getByText("No file uploaded")).toBeInTheDocument();
            expect(rowOf("NIC document file").getByRole("button", { name: "Upload" })).toBeEnabled();
            expect(rowOf("NIC document file").queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        });

        test("a refused removal is shown in the dialog and nothing changes", async () => {
            signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: withNic },
                "POST /api/admin/candidates/N0000002/documents/doc-nic/remove": { status: 404, body: { message: "This document is no longer on record for this candidate. Refresh the page.", code: "DOCUMENT_NOT_FOUND" } },
            });
            renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
            const user = userEvent.setup();
            await screen.findByLabelText("NIC document file");
            await user.click(rowOf("NIC document file").getByRole("button", { name: "Remove" }));
            await user.type(screen.getByLabelText("Reason *"), "Duplicate");
            await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));

            expect(await within(screen.getByRole("dialog")).findByText("This document is no longer on record for this candidate. Refresh the page.")).toBeInTheDocument();
            expect(rowOf("NIC document file").getByText(/^nic-scan\.pdf •/)).toBeInTheDocument();
            expect(rowOf("NIC document file").queryByRole("status")).not.toBeInTheDocument();
        });

        test("a viewer has no Remove", async () => {
            signedInBackend({ "GET /auth/me": { status: 200, body: { user: VIEWER } }, "GET /api/admin/candidates/N0000002": { status: 200, body: withNic } });
            renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
            await screen.findByLabelText("NIC document file");
            expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        });
    });

    test("candidate details: optional fields are empty when not on record; a WhatsApp number on record is read-only", async () => {
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS } });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByLabelText("WhatsApp number *")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("WhatsApp number *")).toHaveValue("94770000002");
        expect(screen.getByLabelText("WhatsApp number *")).toHaveAccessibleDescription("Prefix +");
        expect(screen.getByText("Registered WhatsApp numbers cannot be changed.")).toBeInTheDocument();
        expect(screen.getByLabelText("Contact number")).not.toHaveAttribute("readonly");
        expect(screen.getByLabelText("Nationality")).toHaveValue("");
        expect(screen.getByLabelText("Sex")).toHaveValue("");
        expect(screen.getByLabelText("Passport issue date *")).toHaveValue("2020-05-12");
        expect(screen.getByText("Missing: passport document")).toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: "Stage completed" })).not.toBeInTheDocument();
    });

    test("candidate details: the address is optional; a missing WhatsApp number doesn't block saving and is shown as needed to complete the stage", async () => {
        const incomplete: CandidateDetails = { ...DETAILS, candidate: { ...DETAILS.candidate, address: null, whatsappNumber: null } };
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: incomplete },
            "PUT /api/admin/candidates/N0000002": { status: 200, body: incomplete },
        });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        const user = userEvent.setup();
        expect(await screen.findByLabelText("Address")).toHaveValue("");
        expect(screen.queryByLabelText("Address *")).toBeNull();
        await user.type(screen.getByLabelText("Contact number"), "0112345678");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/admin/candidates/N0000002")).toBe(true));
        expect(screen.getByLabelText("Address")).toHaveAttribute("aria-invalid", "false");
        expect(screen.getAllByText("Required to complete Candidate details.")).toHaveLength(1); // the WhatsApp number only
    });

    test("candidate details shows completed (stepper green) once the record has everything", async () => {
        const done: CandidateDetails = {
            ...DETAILS,
            stages: DETAILS.stages.map((s) => (s.stage === "CANDIDATE_DETAILS" ? { ...s, completed: true, missing: [] } : s)),
        };
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: done } });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByText("Stage completed")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "2. Candidate details (completed out of order)" })).toBeInTheDocument();
    });
});

describe("Call log", () => {
    const CALLS = {
        items: [
            { callLogId: "c2", note: "Said the police report is ready", calledAt: "2026-10-01T11:15:00.000Z", adminName: "Test Admin" },
            { callLogId: "c1", note: "Asked about the medical", calledAt: "2026-09-30T04:45:00.000Z", adminName: null },
        ],
    };
    const openCallLog = async () => {
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        return screen.findByRole("dialog", { name: "Call Logs" });
    };

    test("shows each call's date, time (Sri Lanka) and note, newest first", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const items = within(await within(dialog).findByRole("list", { name: "Candidate history" })).getAllByRole("listitem");
        expect(items.map((item) => item.textContent)).toEqual([
            "01 Oct 2026 · 16:45Call logTest AdminSaid the police report is ready",
            "30 Sept 2026 · 10:15Call logAsked about the medical",
        ]);
    });

    test("a new call takes a date, a time and what the candidate said; it defaults to now", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": { status: 201, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect(await within(dialog).findByText("No candidate history yet.")).toBeInTheDocument();

        const date = within(dialog).getByLabelText("Date *");
        const time = within(dialog).getByLabelText("Time *");
        expect(date).toHaveValue(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date()));
        expect((time as HTMLInputElement).value).toMatch(/^\d{2}:\d{2}$/);
        expect(within(dialog).getByRole("button", { name: "Add call" })).toBeDisabled();

        fireEvent.change(date, { target: { value: "2026-10-01" } });
        fireEvent.change(time, { target: { value: "16:45" } });
        await userEvent.setup().type(within(dialog).getByLabelText("What the candidate said *"), "Said the police report is ready");
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "Add call" }));

        expect(await within(dialog).findByText("Said the police report is ready")).toBeInTheDocument();
        const post = calls.find((c) => c.method === "POST")!;
        expect(post.body).toEqual({ note: "Said the police report is ready", calledAt: "2026-10-01T16:45:00+05:30" });
        expect(within(dialog).getByLabelText("What the candidate said *")).toHaveValue("");
    });

    test("a call in the future is refused before anything is sent", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        fireEvent.change(within(dialog).getByLabelText("Date *"), { target: { value: "2099-01-01" } });
        await userEvent.setup().type(within(dialog).getByLabelText("What the candidate said *"), "x");
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "Add call" }));
        expect(within(dialog).getByText("The call can't be in the future.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("opens as a drawer on the candidate page with the candidate summary and call count", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect(dialog).toHaveAttribute("aria-modal", "true");
        expect(dialog).toHaveAccessibleDescription("Calls and candidate activity, newest first.");
        // The candidate page stays underneath; no navigation.
        expect(screen.getByRole("heading", { level: 1, name: "SAMAN SILVA" })).toBeInTheDocument();
        const summary = within(dialog).getByLabelText("Candidate");
        expect(within(summary).getByText("SAMAN SILVA")).toBeInTheDocument();
        expect(within(summary).getByText("N0000002")).toBeInTheDocument();
        expect(within(summary).getByText("94770000002")).toBeInTheDocument();
        expect(within(dialog).getByRole("heading", { name: "Candidate History" })).toBeInTheDocument();
        expect(await within(dialog).findByText("2 calls")).toBeInTheDocument();
        expect(within(dialog).getByRole("heading", { name: "Add New Call Log" })).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Close call logs" })).toHaveFocus();
    });

    test("long notes wrap inside the drawer instead of scrolling sideways", async () => {
        const long = "x".repeat(400);
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [{ callLogId: "c3", note: long, calledAt: "2026-10-01T11:15:00.000Z", adminName: "Test Admin" }] } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const note = await within(dialog).findByText(long);
        // jsdom has no layout, so check the wrapping rules are applied.
        expect(note.className).toContain("whitespace-pre-wrap");
        expect(note.className).toContain("break-words");
        expect(note.className).toContain("[overflow-wrap:anywhere]");
        expect(dialog.className).toContain("overflow-x-hidden");
    });

    test("shows a loading state, then an error with a retry that reloads the calls", async () => {
        let release!: () => void;
        let attempt = 0;
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": () => {
                attempt += 1;
                if (attempt > 1) return { status: 200, body: CALLS };
                return new Promise((resolve) => {
                    release = () => resolve({ status: 403, body: { message: "Calls could not be loaded." } });
                });
            },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect(await within(dialog).findByText("Loading history…")).toBeInTheDocument();
        release();
        expect(await within(dialog).findByText("Calls could not be loaded.")).toBeInTheDocument();
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "Try again" }));
        expect(await within(dialog).findByText("Asked about the medical")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "GET" && c.path.endsWith("/call-logs"))).toHaveLength(2);
    });

    test("the note, date and time are required before anything is sent", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        const note = within(dialog).getByLabelText("What the candidate said *");
        await user.type(note, "   ");
        expect(within(dialog).getByRole("button", { name: "Add call" })).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText("Time *"), { target: { value: "" } });
        await user.type(note, "ok");
        await user.click(within(dialog).getByRole("button", { name: "Add call" }));
        expect(within(dialog).getByText("Enter the date and time of the call.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("a call is sent once even if the form is submitted again while saving", async () => {
        let release!: () => void;
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": () => new Promise((resolve) => {
                release = () => resolve({ status: 201, body: CALLS });
            }),
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        fireEvent.change(within(dialog).getByLabelText("Date *"), { target: { value: "2026-10-01" } });
        fireEvent.change(within(dialog).getByLabelText("Time *"), { target: { value: "16:45" } });
        await userEvent.setup().type(within(dialog).getByLabelText("What the candidate said *"), "Said the police report is ready");
        const form = within(dialog).getByRole("form", { name: "Add New Call Log" });
        fireEvent.submit(form);
        fireEvent.submit(form);
        expect(await within(dialog).findByRole("button", { name: "Saving…" })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "Close call logs" })).toBeDisabled();
        release();
        expect(await within(dialog).findByText("2 calls")).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
        expect(calls.find((c) => c.method === "POST")!.body).toEqual({ note: "Said the police report is ready", calledAt: "2026-10-01T16:45:00+05:30" });
    });

    test("the close button and Escape close the drawer, staying on the page and returning focus to Call log", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        let dialog = await openCallLog();
        await user.click(within(dialog).getByRole("button", { name: "Close call logs" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await vi.waitFor(() => expect(screen.getByRole("button", { name: "Call log" })).toHaveFocus());

        dialog = await openCallLog();
        await within(dialog).findByText("Asked about the medical");
        await user.keyboard("{Escape}");
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.getByRole("heading", { level: 1, name: "SAMAN SILVA" })).toBeInTheDocument();
    });

    test("a viewer sees the calls but can't add one", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: VIEWER } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect(await within(dialog).findByText("Asked about the medical")).toBeInTheDocument();
        expect(within(dialog).queryByLabelText("What the candidate said *")).not.toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: "Add call" })).not.toBeInTheDocument();
    });
});

describe("Call log: Need attention and current documents", () => {
    const DOCUMENT_STATUS = [
        { documentType: "PASSPORT", variant: null, uploaded: true, verificationStatus: "VERIFIED", receivedDate: "2026-10-05T05:00:00.000Z" },
        { documentType: "MEDICAL", variant: null, uploaded: false, verificationStatus: null, receivedDate: null },
        { documentType: "POLICE_REPORT", variant: "SL_VERIFIED", uploaded: true, verificationStatus: "REVIEW_REQUIRED", receivedDate: "2026-10-06T05:00:00.000Z" },
        { documentType: "SCAN", variant: null, uploaded: false, verificationStatus: null, receivedDate: null },
    ];
    const CALLS = {
        items: [
            { callLogId: "c2", note: "Medical not uploaded yet", calledAt: "2026-10-01T11:15:00.000Z", adminName: "Test Admin", followUp: null },
            { callLogId: "c1", note: "Passport not uploaded", calledAt: "2026-09-30T04:45:00.000Z", adminName: null, followUp: null },
        ],
        documentStatus: DOCUMENT_STATUS,
    };
    const FOLLOW_UP = { followUpId: "f-1", callLogId: "c1", status: "OPEN", flaggedAt: "2026-10-07T05:00:00.000Z" };
    const openCallLog = async () => {
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        return screen.findByRole("dialog", { name: "Call Logs" });
    };
    const callItem = async (dialog: HTMLElement, note: string) => {
        const items = within(await within(dialog).findByRole("list", { name: "Candidate history" })).getAllByRole("listitem");
        return items.find((item) => item.textContent?.includes(note))!;
    };

    test("2-3. the Current Documents block is gone from the drawer; the candidate summary stays", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect(await callItem(dialog, "Passport not uploaded")).toBeTruthy();
        expect(within(dialog).queryByRole("list", { name: "Current documents" })).toBeNull();
        expect(within(dialog).queryByText(/of 4 uploaded/)).toBeNull();
        const summary = within(dialog).getByLabelText("Candidate");
        expect(within(summary).getByText("SAMAN SILVA")).toBeInTheDocument();
        expect(within(summary).getByText("N0000002")).toBeInTheDocument();
    });

    test("16-17. no Need attention text button in the call body: a compact flag beside the caller", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const item = await callItem(dialog, "Medical not uploaded yet");
        expect(within(item).queryByRole("button", { name: "Need attention" })).toBeNull();
        expect(within(item).queryByText("Need attention")).toBeNull();
        const flagButton = within(item).getByRole("button", { name: "Mark as needs attention" });
        expect(flagButton).toHaveAttribute("title", "Mark as needs attention");
        expect(flagButton.textContent).toBe("");
        // In the header row, beside the caller's name.
        expect(flagButton.parentElement).toContainElement(within(item).getByText("Test Admin"));
    });

    test("1-4, 18. the flag marks the call once (the existing follow-up); the call stays in the history and shows Needs attention", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
            "POST /api/admin/candidates/N0000002/call-logs/c1/follow-up": { status: 201, body: { followUp: FOLLOW_UP } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const item = await callItem(dialog, "Passport not uploaded");
        const button = within(item).getByRole("button", { name: "Mark as needs attention" });
        fireEvent.click(button);
        fireEvent.click(button);

        const open = await within(item).findByRole("img", { name: "Needs attention" });
        expect(open).toHaveAttribute("title", "Needs attention");
        expect(within(item).queryByRole("button", { name: /needs attention/i })).toBeNull();
        expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/follow-up")).map((c) => c.path)).toEqual(["/api/admin/candidates/N0000002/call-logs/c1/follow-up"]);
        // Still in the history, unchanged; the other call can still be flagged.
        expect(within(item).getByText("Passport not uploaded")).toBeInTheDocument();
        expect(within(await callItem(dialog, "Medical not uploaded yet")).getByRole("button", { name: "Mark as needs attention" })).toBeInTheDocument();
        expect(within(await within(dialog).findByRole("list", { name: "Candidate history" })).getAllByRole("listitem")).toHaveLength(2);
    });

    test("19-20. an open follow-up shows the active flag (no second flag); a completed one shows as completed and can be flagged again", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": {
                status: 200,
                body: {
                    ...CALLS,
                    items: [
                        { ...CALLS.items[0], followUp: { followUpId: "f-0", status: "COMPLETED", flaggedAt: "2026-10-02T05:00:00.000Z" } },
                        { ...CALLS.items[1], followUp: { followUpId: "f-1", status: "OPEN", flaggedAt: "2026-10-07T05:00:00.000Z" } },
                    ],
                },
            },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const flaggedItem = await callItem(dialog, "Passport not uploaded");
        expect(within(flaggedItem).getByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        expect(within(flaggedItem).queryByRole("button")).toBeNull();
        const completedItem = await callItem(dialog, "Medical not uploaded yet");
        const again = within(completedItem).getByRole("button", { name: "Follow-up completed. Mark as needs attention again" });
        expect(again).toHaveAttribute("title", "Follow-up completed (mark again)");
    });

    test("a viewer sees the follow-up states but no flag action", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: VIEWER } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": {
                status: 200,
                body: { items: [{ ...CALLS.items[0], followUp: { followUpId: "f-0", status: "COMPLETED", flaggedAt: "2026-10-02T05:00:00.000Z" } }, { ...CALLS.items[1], followUp: { followUpId: "f-1", status: "OPEN", flaggedAt: "2026-10-07T05:00:00.000Z" } }] },
            },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect(within(await callItem(dialog, "Passport not uploaded")).getByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        expect(within(await callItem(dialog, "Medical not uploaded yet")).getByRole("img", { name: "Follow-up completed" })).toBeInTheDocument();
        expect(within(within(dialog).getByRole("list", { name: "Candidate history" })).queryByRole("button")).toBeNull();
    });

    test("already marked elsewhere (409): the calls are reloaded and it shows as flagged", async () => {
        let flagged = false;
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": () => ({
                status: 200,
                body: { ...CALLS, items: CALLS.items.map((c) => (flagged && c.callLogId === "c1" ? { ...c, followUp: { followUpId: "f-9", status: "OPEN", flaggedAt: "2026-10-07T05:00:00.000Z" } } : c)) },
            }),
            "POST /api/admin/candidates/N0000002/call-logs/c1/follow-up": () => {
                flagged = true;
                return { status: 409, body: { message: "This call is already marked for follow-up.", code: "FOLLOW_UP_EXISTS" } };
            },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await userEvent.setup().click(within(await callItem(dialog, "Passport not uploaded")).getByRole("button", { name: "Mark as needs attention" }));
        expect(await within(await callItem(dialog, "Passport not uploaded")).findByRole("img", { name: "Needs attention" })).toBeInTheDocument();
    });

    test("22, 30. adding a call without Need Attention sends the call only", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [], documentStatus: DOCUMENT_STATUS } },
            "POST /api/admin/candidates/N0000002/call-logs": { status: 201, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        expect(within(dialog).getByText("Add a call log or wait for candidate activity to appear.")).toBeInTheDocument();
        await userEvent.setup().type(within(dialog).getByLabelText("What the candidate said *"), "Medical not uploaded yet");
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "Add call" }));
        expect(await within(dialog).findByText("Medical not uploaded yet")).toBeInTheDocument();
        const posts = calls.filter((c) => c.method === "POST");
        expect(posts.map((c) => c.path)).toEqual(["/api/admin/candidates/N0000002/call-logs"]);
        expect(posts[0].body).not.toHaveProperty("needsAttention");
    });

    test("21, 23-24. Need Attention sits between No Answer and Add call; with it the one request creates the call and its follow-up", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": {
                status: 201,
                body: { items: [{ ...CALLS.items[1], followUp: { followUpId: "f-1", status: "OPEN", flaggedAt: "2026-10-07T05:00:00.000Z" } }] },
            },
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        const form = within(dialog).getByRole("form", { name: "Add New Call Log" });
        const footer = within(form).getByRole("button", { name: "Add call" }).parentElement!;
        expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "No Answer", "Need Attention", "Add call"]);

        const toggle = within(form).getByRole("button", { name: "Need Attention" });
        expect(toggle).toHaveAttribute("aria-pressed", "false");
        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        await user.type(within(dialog).getByLabelText("What the candidate said *"), "Passport not uploaded");
        await user.click(within(form).getByRole("button", { name: "Add call" }));

        expect(await within(await callItem(dialog, "Passport not uploaded")).findByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        const posts = calls.filter((c) => c.method === "POST");
        expect(posts).toHaveLength(1);
        expect(posts[0].path).toBe("/api/admin/candidates/N0000002/call-logs");
        expect(posts[0].body).toMatchObject({ note: "Passport not uploaded", needsAttention: true });
        // No separate flag request; the toggle resets for the next call.
        expect(calls.some((c) => c.path.endsWith("/follow-up"))).toBe(false);
        expect(toggle).toHaveAttribute("aria-pressed", "false");
    });
});

describe("Candidate History: calls and candidate activity", () => {
    const CALLS = {
        items: [
            { callLogId: "c2", note: "Passport is not uploaded. Need upload before 15 October.", calledAt: "2026-10-11T05:59:00.000Z", adminName: "Shamal Sathsara", followUp: null },
            { callLogId: "c1", note: "Called candidate regarding missing documents.", calledAt: "2026-10-07T06:16:00.000Z", adminName: "Shamal Sathsara", followUp: null },
        ],
        activity: [
            { activityId: "document:d1", kind: "DOCUMENT_RECEIVED", occurredAt: "2026-10-10T10:12:00.000Z", actorName: null, source: "WHATSAPP", documentType: "PASSPORT", variant: null, stage: null, fields: [] },
            { activityId: "audit:a1", kind: "DETAILS_UPDATED", occurredAt: "2026-10-10T10:10:00.000Z", actorName: "Test Admin", source: null, documentType: null, variant: null, stage: null, fields: ["address", "contactNumber"] },
            { activityId: "document:d2", kind: "DOCUMENT_RECEIVED", occurredAt: "2026-10-09T04:00:00.000Z", actorName: "Test Admin", source: "STAFF", documentType: "POLICE_REPORT", variant: "SL_VERIFIED", stage: null, fields: [] },
            { activityId: "audit:a2", kind: "STAGE_COMPLETED", occurredAt: "2026-10-08T04:00:00.000Z", actorName: "Test Admin", source: null, documentType: null, variant: null, stage: "IVS_INTERVIEW", fields: [] },
            { activityId: "audit:a3", kind: "DETAILS_UPDATED", occurredAt: "2026-10-01T04:00:00.000Z", actorName: "Test Admin", source: null, documentType: null, variant: null, stage: null, fields: ["whatsappNumber"] },
        ],
        activityTruncated: false,
    };
    const openCallLog = async () => {
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        return screen.findByRole("dialog", { name: "Call Logs" });
    };
    const historyItems = async (dialog: HTMLElement) => within(await within(dialog).findByRole("list", { name: "Candidate history" })).getAllByRole("listitem");

    test("4-7, 9-11, 13-14. calls and activity in one timeline, newest first; activity is short, attributed only when on record, and styled apart", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const items = await historyItems(dialog);
        expect(items.map((item) => item.textContent)).toEqual([
            "11 Oct 2026 · 11:29Call logShamal SathsaraPassport is not uploaded. Need upload before 15 October.",
            "10 Oct 2026 · 15:42Candidate activityvia WhatsAppPassport uploaded",
            "10 Oct 2026 · 15:40Candidate activityby Test AdminCandidate details updatedAddress, Contact number",
            "09 Oct 2026 · 09:30Candidate activityby Test AdminPolice report - SL Verified uploaded",
            "08 Oct 2026 · 09:30Candidate activityby Test AdminIVS interview marked complete",
            "07 Oct 2026 · 11:46Call logShamal SathsaraCalled candidate regarding missing documents.",
            "01 Oct 2026 · 09:30Candidate activityby Test AdminWhatsApp number updated",
        ]);
        expect(items.map((item) => item.getAttribute("data-kind"))).toEqual([
            "call-log", "candidate-activity", "candidate-activity", "candidate-activity", "candidate-activity", "call-log", "candidate-activity",
        ]);
        // Distinguishable: an answered call is amber-tinted, activity green-tinted (the theme's tokens).
        expect(items[1].className).toContain("bg-verified-bg");
        expect(items[0].className).toContain("bg-review-bg");
        // A WhatsApp document never names a staff member.
        expect(items[1].textContent).not.toContain("Test Admin");
        expect(screen.queryByText("Showing the latest candidate activity only.")).toBeNull();
    });

    test("an activity with no actor or source on record says neither", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": {
                status: 200,
                body: {
                    items: [],
                    activity: [
                        { activityId: "document:d9", kind: "DOCUMENT_RECEIVED", occurredAt: "2026-10-01T04:00:00.000Z", actorName: null, source: null, documentType: "SCAN", variant: null, stage: null, fields: [] },
                        { activityId: "stage:FINALIZING_JOB", kind: "STAGE_COMPLETED", occurredAt: "2026-09-01T04:00:00.000Z", actorName: null, source: null, documentType: null, variant: null, stage: "FINALIZING_JOB", fields: [] },
                    ],
                    activityTruncated: true,
                },
            },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        expect((await historyItems(dialog)).map((item) => item.textContent)).toEqual([
            "01 Oct 2026 · 09:30Candidate activityScan uploaded",
            "01 Sept 2026 · 09:30Candidate activityFinalizing the job marked complete",
        ]);
        expect(within(dialog).getByText("Showing the latest candidate activity only.")).toBeInTheDocument();
        expect(within(dialog).queryByText("No candidate history yet.")).toBeNull();
    });

    test("flagging a call keeps the activity in the timeline", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
            "POST /api/admin/candidates/N0000002/call-logs/c1/follow-up": { status: 201, body: { followUp: { followUpId: "f-1", callLogId: "c1", status: "OPEN", flaggedAt: "2026-10-12T05:00:00.000Z" } } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const item = (await historyItems(dialog)).find((i) => i.textContent?.includes("missing documents"))!;
        await userEvent.setup().click(within(item).getByRole("button", { name: "Mark as needs attention" }));
        expect(await within(dialog).findByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        expect(await historyItems(dialog)).toHaveLength(7);
    });
});

describe("Call log: No Answer", () => {
    const WITH_NO_ANSWER = {
        items: [
            { callLogId: "n1", note: "", outcome: "NO_ANSWER", calledAt: "2026-10-13T04:06:00.000Z", adminName: "Shamal Sathsara", followUp: null },
            { callLogId: "c1", note: "Asked about the medical", outcome: "ANSWERED", calledAt: "2026-10-12T04:45:00.000Z", adminName: "Test Admin", followUp: null },
        ],
        activity: [
            { activityId: "document:d1", kind: "DOCUMENT_RECEIVED", occurredAt: "2026-10-12T10:12:00.000Z", actorName: null, source: "WHATSAPP", documentType: "PASSPORT", variant: null, stage: null, fields: [] },
        ],
    };
    const openCallLog = async () => {
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        return screen.findByRole("dialog", { name: "Call Logs" });
    };
    const posts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST");

    test("1. the No Answer button is in Add New Call Log, between Close and Need Attention, with an accessible name and a visible label", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        const form = within(dialog).getByRole("form", { name: "Add New Call Log" });
        const button = within(form).getByRole("button", { name: "No Answer" });
        expect(button).toBeEnabled();
        expect(button.textContent).toBe("No Answer");
        expect(within(form).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "No Answer", "Need Attention", "Add call"]);
        // Secondary, not the primary action.
        expect(button.className).not.toContain("bg-primary");
        expect(within(form).getByRole("button", { name: "Add call" }).className).toContain("bg-primary");
    });

    test("2-4, 6, 12. No Answer needs no note; it sends the selected date and time and nothing else; one request, one call, no follow-up", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": { status: 201, body: { items: [WITH_NO_ANSWER.items[0]] } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        fireEvent.change(within(dialog).getByLabelText("Date *"), { target: { value: "2026-10-12" } });
        fireEvent.change(within(dialog).getByLabelText("Time *"), { target: { value: "09:36" } });
        expect(within(dialog).getByLabelText("What the candidate said *")).toHaveValue("");
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "No Answer" }));

        await vi.waitFor(() => expect(within(dialog).getByText("No Answer", { selector: "[data-outcome]" })).toBeInTheDocument());
        expect(posts(calls)).toHaveLength(1);
        expect(posts(calls)[0].path).toBe("/api/admin/candidates/N0000002/call-logs");
        expect(posts(calls)[0].body).toEqual({ outcome: "NO_ANSWER", calledAt: "2026-10-12T09:36:00+05:30" });
        expect(calls.some((c) => c.path.endsWith("/follow-up"))).toBe(false);
        expect(within(dialog).queryByText("Enter the date and time of the call.")).toBeNull();
    });

    test("15. two quick clicks send one request; the buttons are disabled while it saves", async () => {
        let release!: () => void;
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": () => new Promise((resolve) => {
                release = () => resolve({ status: 201, body: { items: [WITH_NO_ANSWER.items[0]] } });
            }),
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        const button = within(dialog).getByRole("button", { name: "No Answer" });
        fireEvent.click(button);
        fireEvent.click(button);
        await vi.waitFor(() => expect(within(dialog).getByRole("button", { name: "No Answer" })).toBeDisabled());
        expect(within(dialog).getByRole("button", { name: "Saving…" })).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "Need Attention" })).toBeDisabled();
        release();
        await vi.waitFor(() => expect(within(dialog).getByRole("button", { name: "No Answer" })).toBeEnabled());
        expect(posts(calls)).toHaveLength(1);
    });

    test("7-9. the history shows a compact No Answer (icon and text, neutral), with no note body, sorted by time with the calls and activity", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: WITH_NO_ANSWER },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const items = within(await within(dialog).findByRole("list", { name: "Candidate history" })).getAllByRole("listitem");
        expect(items.map((item) => item.textContent)).toEqual([
            "13 Oct 2026 · 09:36Call logShamal SathsaraNo Answer",
            "12 Oct 2026 · 15:42Candidate activityvia WhatsAppPassport uploaded",
            "12 Oct 2026 · 10:15Call logTest AdminAsked about the medical",
        ]);
        const badge = within(items[0]).getByText("No Answer");
        expect(badge).toHaveAttribute("data-outcome", "NO_ANSWER");
        expect(badge.querySelector("svg")).not.toBeNull();
        // An outcome, not an error: red is the icon and a thin outline only; the words keep the normal text colour.
        expect(badge.className).toContain("text-ink-soft");
        expect(badge.className).not.toContain("text-critical");
        expect(badge.querySelector(".text-critical")).not.toBeNull();
        // Two lines only: the date row and the badge (a note would be a third).
        expect(items[0].querySelectorAll("p")).toHaveLength(2);
    });

    test("13. a No Answer call can be flagged with the same flag as any call", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: WITH_NO_ANSWER },
            "POST /api/admin/candidates/N0000002/call-logs/n1/follow-up": { status: 201, body: { followUp: { followUpId: "f-1", callLogId: "n1", status: "OPEN", flaggedAt: "2026-10-13T05:00:00.000Z" } } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const item = (await within(dialog).findAllByRole("listitem")).find((i) => i.textContent?.includes("No Answer"))!;
        await userEvent.setup().click(within(item).getByRole("button", { name: "Mark as needs attention" }));
        expect(await within(item).findByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        expect(posts(calls).map((c) => c.path)).toEqual(["/api/admin/candidates/N0000002/call-logs/n1/follow-up"]);
        // Still in the history, with no note.
        expect(within(item).getByText("No Answer")).toBeInTheDocument();
    });

    test("12. with Need Attention on, No Answer sends it in the same single request", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": { status: 201, body: { items: [{ ...WITH_NO_ANSWER.items[0], followUp: { followUpId: "f-1", status: "OPEN", flaggedAt: "2026-10-13T05:00:00.000Z" } }] } },
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        await user.click(within(dialog).getByRole("button", { name: "Need Attention" }));
        await user.click(within(dialog).getByRole("button", { name: "No Answer" }));
        expect(await within(dialog).findByRole("img", { name: "Needs attention" })).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(1);
        expect(posts(calls)[0].body).toMatchObject({ outcome: "NO_ANSWER", needsAttention: true });
        expect(posts(calls)[0].body).not.toHaveProperty("note");
    });

    test("10-11. Add call still needs a note and sends it without an outcome; a note typed before No Answer is kept for the next call", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
            "POST /api/admin/candidates/N0000002/call-logs": { status: 201, body: WITH_NO_ANSWER },
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        const addCall = within(dialog).getByRole("button", { name: "Add call" });
        expect(addCall).toBeDisabled();
        fireEvent.submit(within(dialog).getByRole("form", { name: "Add New Call Log" }));
        expect(posts(calls)).toHaveLength(0);

        await user.type(within(dialog).getByLabelText("What the candidate said *"), "Will bring the medical");
        await user.click(within(dialog).getByRole("button", { name: "No Answer" }));
        await vi.waitFor(() => expect(posts(calls)).toHaveLength(1));
        expect(posts(calls)[0].body).not.toHaveProperty("note");
        expect(within(dialog).getByLabelText("What the candidate said *")).toHaveValue("Will bring the medical");

        await user.click(within(dialog).getByRole("button", { name: "Add call" }));
        await vi.waitFor(() => expect(posts(calls)).toHaveLength(2));
        expect(posts(calls)[1].body).toMatchObject({ note: "Will bring the medical" });
        expect(posts(calls)[1].body).not.toHaveProperty("outcome");
    });

    test("No Answer is refused before anything is sent when the date is in the future", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("No candidate history yet.");
        fireEvent.change(within(dialog).getByLabelText("Date *"), { target: { value: "2099-01-01" } });
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "No Answer" }));
        expect(within(dialog).getByText("The call can't be in the future.")).toBeInTheDocument();
        expect(posts(calls)).toHaveLength(0);
    });

    test("a viewer has no form, so no No Answer button", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: VIEWER } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: WITH_NO_ANSWER },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("Asked about the medical");
        expect(within(dialog).queryByRole("button", { name: "No Answer" })).toBeNull();
    });

    test("the Need Attention page shows a flagged No Answer call as No Answer, not as an empty row", async () => {
        // Same data shape as GET /api/admin/follow-ups; rendered through the real page.
        const item = { followUpId: "f-1", status: "OPEN", flaggedAt: "2026-10-13T05:00:00.000Z", flaggedByName: "Test Admin", completedAt: null, completedByName: null, callLog: { callLogId: "n1", note: "", outcome: "NO_ANSWER", calledAt: "2026-10-13T04:06:00.000Z", adminName: "Shamal Sathsara" } };
        signedInBackend({
            "GET /api/admin/follow-ups": { status: 200, body: { status: "OPEN", total: 1, truncated: false, groups: [{ candidate: { passportId: "N0000002", uniqueId: "U2", name: "SAMAN SILVA", whatsappNumber: null, contactNumber: null }, documentStatus: [], followUps: [item] }] } },
        });
        renderApp("/follow-ups");
        const row = (await screen.findAllByText("No Answer"))[0].closest("li")!;
        expect(row.textContent).toContain("No Answer");
        expect(row.querySelectorAll("p")[1]?.textContent).toContain("No Answer");
    });
});

describe("Candidate History: colour by event type", () => {
    const BODY = {
        items: [
            { callLogId: "n1", note: "", outcome: "NO_ANSWER", calledAt: "2026-10-13T04:06:00.000Z", adminName: "Shamal Sathsara", followUp: null },
            { callLogId: "c3", note: "Passport not uploaded", outcome: "ANSWERED", calledAt: "2026-10-12T04:45:00.000Z", adminName: "Test Admin", followUp: { followUpId: "f1", status: "OPEN", flaggedAt: "2026-10-12T05:00:00.000Z" } },
            { callLogId: "c2", note: "Medical sorted", outcome: "ANSWERED", calledAt: "2026-10-11T04:45:00.000Z", adminName: "Test Admin", followUp: { followUpId: "f0", status: "COMPLETED", flaggedAt: "2026-10-11T05:00:00.000Z" } },
            { callLogId: "c1", note: "Asked about the scan", outcome: "ANSWERED", calledAt: "2026-10-10T04:45:00.000Z", adminName: "Test Admin", followUp: null },
        ],
        activity: [
            { activityId: "document:d1", kind: "DOCUMENT_RECEIVED", occurredAt: "2026-10-09T10:12:00.000Z", actorName: null, source: "WHATSAPP", documentType: "PASSPORT", variant: null, stage: null, fields: [] },
        ],
    };
    const openHistory = async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: BODY },
        });
        renderApp("/candidates/N0000002");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        const dialog = await screen.findByRole("dialog", { name: "Call Logs" });
        return within(await within(dialog).findByRole("list", { name: "Candidate history" })).getAllByRole("listitem");
    };

    test("1-3. No Answer is red-toned, a call log amber-toned, candidate activity green-toned, each with a thin left accent, from the theme's tokens", async () => {
        const [noAnswer, call, , , activity] = await openHistory();
        const classes = (el: Element) => el.className.split(/\s+/);
        expect(noAnswer).toHaveAttribute("data-tone", "no-answer");
        expect(classes(noAnswer)).toEqual(expect.arrayContaining(["bg-critical-bg", "border-l-critical", "border-l-[3px]"]));
        expect(call).toHaveAttribute("data-tone", "call");
        expect(classes(call)).toEqual(expect.arrayContaining(["bg-review-bg", "border-l-review", "border-l-[3px]"]));
        expect(activity).toHaveAttribute("data-tone", "activity");
        expect(classes(activity)).toEqual(expect.arrayContaining(["bg-verified-bg", "border-l-verified", "border-l-[3px]"]));
        // Activity's icon is green; an answered call's small call icon is amber.
        expect(activity.querySelector(".text-verified")).not.toBeNull();
        expect(call.querySelector(".text-review")).not.toBeNull();
    });

    test("light and dark: only the theme's tokens, never fixed colours, saturated fills or coloured body text", async () => {
        const items = await openHistory();
        for (const item of items) {
            // Tokens switch with the theme (index.css); no palette colours that would only suit one theme.
            expect(item.outerHTML).not.toMatch(/\b(bg|text|border)-(red|amber|yellow|orange|green|emerald|lime)-\d{2,3}\b|#[0-9a-f]{3,6}\b|rgb\(/i);
            // Only the soft -bg token fills a card; the strong colours are accents.
            expect(item.className).not.toMatch(/\bbg-(critical|review|verified)(\s|$)/);
            // Body text keeps the normal ink colours.
            for (const p of item.querySelectorAll("p")) expect(p.className).not.toMatch(/text-(critical|review|verified)\b/);
        }
    });

    test("8. the type is also in words and icons, never colour alone: Call log, Candidate activity, No Answer", async () => {
        const items = await openHistory();
        expect(items.filter((i) => i.getAttribute("data-kind") === "call-log").every((i) => i.textContent!.includes("Call log"))).toBe(true);
        expect(items[4].textContent).toContain("Candidate activity");
        expect(within(items[0]).getByText("No Answer").querySelector("svg")).not.toBeNull();
    });

    test("4-5. the flag: amber and filled when open, a muted check when completed, an outline when not flagged; each with a name", async () => {
        const items = await openHistory();
        const open = within(items[1]).getByRole("img", { name: "Needs attention" });
        expect(open.className).toContain("text-review");
        const completed = items[2].querySelector("button[aria-label^='Follow-up completed']")!;
        expect(completed.className).toContain("text-ink-subtle");
        expect(completed.className.split(/\s+/)).not.toContain("text-review");
        const none = within(items[3]).getByRole("button", { name: "Mark as needs attention" });
        expect(none.className).toContain("text-ink-subtle");
        // Red is reserved for No Answer: the flag never uses it.
        for (const el of [open, completed, none]) expect(el.className).not.toContain("critical");
    });
});

describe("Call log drawer: closing", () => {
    const openCallLog = async () => {
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        return screen.findByRole("dialog", { name: "Call Logs" });
    };
    const CALLS = { items: [{ callLogId: "c1", note: "Asked about the medical", calledAt: "2026-09-30T04:45:00.000Z", adminName: null }] };

    test("25-28. a click on the page outside the drawer closes it; clicks and text selection inside don't; X and Close still close", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        let dialog = await openCallLog();
        await within(dialog).findByText("Asked about the medical");

        // Inside: a note, the date input, a button that does not close, the form.
        await user.click(within(dialog).getByText("Asked about the medical"));
        await user.click(within(dialog).getByLabelText("Date *"));
        await user.click(within(dialog).getByRole("button", { name: "Need Attention" }));
        // A selection started inside and released over the backdrop.
        const backdrop = screen.getByTestId("call-log-backdrop");
        fireEvent.mouseDown(within(dialog).getByText("Asked about the medical"));
        fireEvent.mouseUp(backdrop);
        fireEvent.click(backdrop.parentElement!);
        expect(screen.getByRole("dialog", { name: "Call Logs" })).toBeInTheDocument();

        await user.click(backdrop);
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.getByRole("heading", { level: 1, name: "SAMAN SILVA" })).toBeInTheDocument();

        dialog = await openCallLog();
        await user.click(within(dialog).getByRole("button", { name: "Close call logs" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        dialog = await openCallLog();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    test("layout: history takes the free height and scrolls on its own; the compact form keeps every field and button; responsive width and date/time", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        await within(dialog).findByText("Asked about the medical");
        // jsdom has no layout: check the layout rules are applied (real sizes were checked in a browser).
        const classes = (element: Element) => element.className.split(/\s+/);
        expect(classes(dialog)).toEqual(expect.arrayContaining(["h-full", "max-h-dvh", "flex-col", "overflow-x-hidden", "w-full", "sm:w-[min(92vw,600px)]", "2xl:w-[640px]"]));

        const history = screen.getByTestId("candidate-history-scroll");
        expect(history).toContainElement(within(dialog).getByRole("list", { name: "Candidate history" }));
        expect(classes(history)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto", "overflow-x-hidden"]));
        expect(classes(history.closest("section")!)).toContain("flex-1");
        expect(within(dialog).queryByRole("list", { name: "Current documents" })).toBeNull();

        const form = within(dialog).getByRole("form", { name: "Add New Call Log" });
        expect(classes(form)).toContain("shrink-0");
        expect(within(form).getByRole("heading", { name: "Add New Call Log" })).toBeInTheDocument();
        for (const label of ["Date *", "Time *", "What the candidate said *"]) expect(within(form).getByLabelText(label)).toBeInTheDocument();
        expect(within(form).getByLabelText("What the candidate said *")).toHaveAttribute("rows", "2");
        expect(classes(within(form).getByLabelText("Date *"))).toContain("h-9");
        // Date and time side by side, stacked only on a very narrow screen.
        expect(classes(screen.getByTestId("call-log-when"))).toEqual(expect.arrayContaining(["grid-cols-1", "min-[340px]:grid-cols-2"]));
        // Every button keeps its name and a 32px height.
        for (const name of ["Close", "No Answer", "Need Attention", "Add call"]) expect(classes(within(form).getByRole("button", { name }))).toContain("h-8");
    });

    test("29. the backdrop does not close the drawer while a call is being saved", async () => {
        let release!: () => void;
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
            "POST /api/admin/candidates/N0000002/call-logs": () => new Promise((resolve) => {
                release = () => resolve({ status: 201, body: CALLS });
            }),
        });
        renderApp("/candidates/N0000002");
        const user = userEvent.setup();
        const dialog = await openCallLog();
        await within(dialog).findByText("Asked about the medical");
        await user.type(within(dialog).getByLabelText("What the candidate said *"), "x");
        await user.click(within(dialog).getByRole("button", { name: "Add call" }));
        await within(dialog).findByRole("button", { name: "Saving…" });
        await user.click(screen.getByTestId("call-log-backdrop"));
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog", { name: "Call Logs" })).toBeInTheDocument();
        release();
        await within(dialog).findByRole("button", { name: "Add call" });
    });
});

describe("Candidate registration", () => {
    test("required fields (including the WhatsApp number) are checked before anything is sent; the address and passport file are not required", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Register candidate" }));
        expect(screen.getByText("Enter the surname.")).toBeInTheDocument();
        expect(screen.getByText("Enter the WhatsApp number.")).toBeInTheDocument();
        expect(screen.queryByText("Choose the passport file.")).not.toBeInTheDocument();
        expect(screen.queryByText("Enter the address.")).not.toBeInTheDocument();
        expect(screen.getByLabelText("WhatsApp number *")).toBeInTheDocument();
        expect(screen.getByLabelText("Address")).toBeInTheDocument(); // no required mark at registration
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    // The fields registration requires, nothing else.
    async function fillRegistrationMinimum(user: ReturnType<typeof userEvent.setup>) {
        await user.type(await screen.findByLabelText("Surname *"), "SILVA");
        await user.type(screen.getByLabelText("Other names *"), "SAMAN");
        await user.type(screen.getByLabelText("NIC *"), "901234567V");
        await user.type(screen.getByLabelText("Passport ID *"), "n0000002");
        await user.type(screen.getByLabelText("Job type *"), "Driver{Enter}");
        await user.type(screen.getByLabelText("Job experience *"), "5 years");
        await user.type(screen.getByLabelText("WhatsApp number *"), "94771234567");
        await user.type(screen.getByLabelText("Passport issue date *"), "2020-01-15");
        await user.type(screen.getByLabelText("Passport expiry date *"), "2030-01-14");
    }

    async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
        await fillRegistrationMinimum(user);
        await user.type(screen.getByLabelText("Address"), "1 Main Street");
        await user.upload(screen.getByLabelText("Passport"), new File(["%PDF-1.4"], "passport.pdf", { type: "application/pdf" }));
    }

    test("registers with the WhatsApp number but no address and no passport file; nothing is uploaded", async () => {
        let created = false;
        const { calls } = signedInBackend({
            "POST /api/admin/candidates": () => { created = true; return { status: 201, body: { passportId: "N0000002", uniqueId: "0002" } }; },
            "GET /api/admin/candidates/N0000002": () => (created ? { status: 200, body: DETAILS } : { status: 404, body: { message: "Candidate not found" } }),
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRegistrationMinimum(user);
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        expect(await screen.findByRole("navigation", { name: "Deployment stages" })).toBeInTheDocument();
        expect(calls.find((c) => c.method === "POST" && c.path === "/api/admin/candidates")!.body).toMatchObject({ address: "", whatsappNumber: "94771234567", passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14" });
        expect(calls.some((c) => c.path.includes("/documents/"))).toBe(false);
    });

    test("a file that failed at registration is reported until it's uploaded; the upload says Saved; form edits still save to the same records", async () => {
        const doc = (name: string) => ({ documentId: name, originalFilename: name, verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-01T00:00:00.000Z" });
        const withPassport: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, PASSPORT: doc("passport.pdf") } };
        const withVideo: CandidateDetails = { ...withPassport, documents: { ...withPassport.documents, SKILL_VIDEO: doc("skills.mp4") } };
        let created = false;
        let targets = 0;
        let finalizes = 0;
        const { calls } = signedInBackend({
            "POST /api/admin/candidates": () => { created = true; return { status: 201, body: { passportId: "N0000002", uniqueId: "0002" } }; },
            "GET /api/admin/candidates/N0000002": () => (created ? { status: 200, body: withPassport } : { status: 404, body: { message: "Candidate not found" } }),
            // Registration: the passport goes through, the skill video doesn't; on the candidate page it does.
            "POST /api/admin/candidates/N0000002/documents/upload-target": () => {
                targets += 1;
                return targets === 2
                    ? { status: 422, body: { message: "The file could not be uploaded. Please try again.", code: "FILE_REJECTED" } }
                    : { status: 200, body: { uploadId: UPLOAD_ID, uploadUrl: SIGNED_URL } };
            },
            [`PUT ${SIGNED_PATH}`]: { status: 200, body: {} },
            "POST /api/admin/candidates/N0000002/documents/finalize": () => { finalizes += 1; return { status: 200, body: finalizes === 1 ? withPassport : withVideo }; },
            "PUT /api/admin/candidates/N0000002/stages/CANDIDATE_DETAILS": { status: 200, body: withVideo },
            "PUT /api/admin/candidates/N0000002": { status: 200, body: withVideo },
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRequired(user);
        await user.upload(screen.getByLabelText("Skill video"), new File(["video"], "skills.mp4", { type: "video/mp4" }));
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        const notice = await screen.findByText(/The candidate was registered, but these files were not uploaded/);
        expect(notice).toHaveTextContent("Skill video: The file could not be uploaded. Please try again.");
        expect(notice).not.toHaveTextContent("Passport");

        // Uploaded here: the report goes, and the row says it's saved. Save changes has nothing to save.
        await user.upload(screen.getByLabelText("Skill video file"), new File(["video"], "skills.mp4", { type: "video/mp4" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Saved");
        expect(screen.queryByText(/these files were not uploaded/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

        // Editing the form enables Save; saving updates the existing records (PUTs), never creates new ones.
        const postsBefore = calls.filter((c) => c.method === "POST").length;
        await user.type(screen.getByLabelText("Comment"), "Called back");
        await user.type(screen.getByLabelText("Address"), ", Kandy");
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await vi.waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.path.startsWith("/api/"))).toHaveLength(2));
        expect(calls.find((c) => c.method === "PUT" && c.path === "/api/admin/candidates/N0000002")!.body).toMatchObject({ address: "1 Main Street, Kandy" });
        expect(calls.find((c) => c.path.endsWith("/stages/CANDIDATE_DETAILS"))!.body).toEqual({ notes: "Called back" });
        expect(calls.filter((c) => c.method === "POST").length, "nothing new is created").toBe(postsBefore);
    });

    test("registers with only the required fields; the optional passport and contact details are sent empty", async () => {
        let created = false;
        const { calls } = signedInBackend({
            "POST /api/admin/candidates": () => { created = true; return { status: 201, body: { passportId: "N0000002", uniqueId: "0002" } }; },
            ...directUploadRoutes("N0000002", DETAILS),
            "GET /api/admin/candidates/N0000002": () => (created ? { status: 200, body: DETAILS } : { status: 404, body: { message: "Candidate not found" } }),
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRequired(user);
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        expect(await screen.findByRole("navigation", { name: "Deployment stages" })).toBeInTheDocument();
        expect(calls.find((c) => c.method === "POST" && c.path === "/api/admin/candidates")!.body).toMatchObject({
            nationality: "", sex: "", dateOfBirth: "", placeOfBirth: "", contactNumber: "",
            passportIssueDate: "2020-01-15", passportExpiryDate: "2030-01-14", whatsappNumber: "94771234567",
        });
        // The passport file went to storage, then was finalized; never to the API.
        expect(calls.find((c) => c.path.endsWith("/documents/upload-target"))!.body).toMatchObject({ type: "PASSPORT", mimeType: "application/pdf", fileName: "passport.pdf" });
        expect(calls.find((c) => c.method === "PUT")!.body).toBeInstanceOf(File);
        expect(calls.find((c) => c.path.endsWith("/documents/finalize"))!.body).toMatchObject({ type: "PASSPORT", uploadId: UPLOAD_ID });
        expect(calls.filter((c) => c.url.pathname.startsWith("/api/") && c.body instanceof File)).toEqual([]);
    });

    test("values are checked: issue date before expiry, the WhatsApp number after +, the contact number", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRequired(user);
        await user.clear(screen.getByLabelText("Passport issue date *"));
        await user.type(screen.getByLabelText("Passport issue date *"), "2031-01-01");
        await user.clear(screen.getByLabelText("Passport expiry date *"));
        await user.type(screen.getByLabelText("Passport expiry date *"), "2030-01-01");
        await user.clear(screen.getByLabelText("WhatsApp number *"));
        await user.type(screen.getByLabelText("WhatsApp number *"), "12");
        await user.type(screen.getByLabelText("Contact number"), "12");
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        expect(screen.getByText("Must be before the expiry date.")).toBeInTheDocument();
        expect(screen.getByText("Enter the mobile number with country code after +, e.g. 94771234567.")).toBeInTheDocument();
        expect(screen.getByText("Enter a phone number, e.g. 0771234567.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("the passport issue and expiry dates are required to register", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRequired(user);
        await user.clear(screen.getByLabelText("Passport issue date *"));
        await user.clear(screen.getByLabelText("Passport expiry date *"));
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        expect(screen.getByText("Enter the passport issue date.")).toBeInTheDocument();
        expect(screen.getByText("Enter the passport expiry date.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("an already registered passport links to that candidate", async () => {
        const { calls } = signedInBackend({ "POST /api/admin/candidates": { status: 409, body: { message: "A candidate with this passport ID is already registered.", code: "CANDIDATE_EXISTS" } } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRequired(user);
        await user.click(screen.getByRole("button", { name: "Register candidate" }));

        expect(await screen.findByText("A candidate with this passport ID is already registered.")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open the registered candidate" })).toHaveAttribute("href", "/candidates/N0000002");
        expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ passportId: "N0000002", surname: "SILVA", jobTypes: ["Driver"], nic: "901234567V" });
    });

    // An existing candidate: some optional values, a passport and a medical
    // report on record, no NIC document or skill video, progress on stage 4.
    const EXISTING: CandidateDetails = {
        ...DETAILS,
        // Registered before the passport dates were required: no issue date.
        candidate: { ...DETAILS.candidate, nationality: "Sri Lankan", sex: "M", contactNumber: null, passportIssueDate: null },
        documents: {
            ...DETAILS.documents,
            PASSPORT: { documentId: "doc-passport", originalFilename: "passport-scan.pdf", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-09-20T00:00:00.000Z" },
            MEDICAL: { documentId: "doc-medical", originalFilename: "medical.pdf", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-09-21T00:00:00.000Z" },
        },
        stages: DETAILS.stages.map((s) => (s.stage === "CANDIDATE_DETAILS" ? { ...s, notes: "Prefers morning calls" } : s)),
    };

    test("passport ID not on record: lookup on leaving the field, then the normal new-candidate form", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "n7654321");
        await user.tab();
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/admin/candidates/N7654321")).toBe(true));
        expect(screen.getByLabelText("Passport ID *")).not.toHaveAttribute("readonly");
        expect(screen.queryByText(/Existing candidate found/)).not.toBeInTheDocument();
        expect(screen.getByLabelText("Passport")).toHaveAttribute("type", "file");
        expect(screen.getByRole("button", { name: "Register candidate" })).toBeInTheDocument();
        expect(calls.filter((c) => c.path.startsWith("/api/admin/candidates/")).length).toBe(1);
    });

    test("passport ID on record: details, comment and stored documents are loaded; missing documents stay uploadable", async () => {
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: EXISTING } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "n0000002");
        await user.tab();

        expect(await screen.findByText("Existing candidate found — details loaded.")).toBeInTheDocument();
        expect(screen.getByLabelText("Passport ID *")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("Surname *")).toHaveValue("SILVA");
        expect(screen.getByLabelText("Other names *")).toHaveValue("SAMAN");
        expect(screen.getByLabelText("NIC *")).toHaveValue("901234567V");
        expect(screen.getByLabelText("Address")).toHaveValue("1 Main Street");
        expect(screen.getByLabelText("Job experience *")).toHaveValue("5 years");
        expect(screen.getByText("Driver")).toBeInTheDocument();
        expect(screen.getByLabelText("Nationality")).toHaveValue("Sri Lankan");
        expect(screen.getByLabelText("Sex")).toHaveValue("M");
        expect(screen.getByLabelText("Date of birth")).toHaveValue("1990-03-12");
        expect(screen.getByLabelText("Passport expiry date *")).toHaveValue("2030-05-11");
        expect(screen.getByLabelText("Passport issue date *")).toHaveValue("");
        expect(screen.getByLabelText("WhatsApp number *")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("WhatsApp number *")).toHaveValue("94770000002");
        expect(screen.getByText("Registered WhatsApp numbers cannot be changed.")).toBeInTheDocument();
        expect(screen.getByLabelText("Contact number")).toHaveValue("");
        expect(screen.getByLabelText("Comment")).toHaveValue("Prefers morning calls");

        expect(screen.getByText(/passport-scan\.pdf/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Upload" })).toHaveLength(2);
        expect(screen.getAllByText("No file uploaded")).toHaveLength(2);
        expect(screen.getByText("Also on record: Medical")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    });

    test("saving a loaded candidate updates their record; nothing is registered or uploaded", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: EXISTING },
            "PUT /api/admin/candidates/N0000002": { status: 200, body: EXISTING },
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "N0000002");
        await user.tab();
        await screen.findByText("Existing candidate found — details loaded.");
        await user.clear(screen.getByLabelText("Address"));
        await user.type(screen.getByLabelText("Address"), "2 Lake Road");
        // This older record has no passport issue date: it must be filled in before saving.
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(screen.getByText("Enter the passport issue date.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "PUT")).toBe(false);
        await user.type(screen.getByLabelText("Passport issue date *"), "2020-05-12");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByRole("navigation", { name: "Deployment stages" })).toBeInTheDocument();
        const put = calls.find((c) => c.method === "PUT")!;
        expect(put.path).toBe("/api/admin/candidates/N0000002");
        expect(put.body).toMatchObject({ address: "2 Lake Road", surname: "SILVA", nationality: "Sri Lankan", sex: "M", whatsappNumber: "94770000002", passportIssueDate: "2020-05-12" });
        expect(calls.some((c) => c.method === "POST")).toBe(false);
        expect(calls.some((c) => c.path.includes("/stages/")), "stage progress untouched (comment unchanged)").toBe(false);
    });

    // L2: the field is read-only, so the UI itself can never send a changed
    // value — this covers the server explicitly refusing one anyway (e.g. a
    // stale client or a direct API call), rather than it appearing to work.
    test("a WHATSAPP_LOCKED response from the server is shown, not treated as success", async () => {
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: EXISTING },
            "PUT /api/admin/candidates/N0000002": { status: 409, body: { message: "The WhatsApp number is already set for this candidate and cannot be changed here.", code: "WHATSAPP_LOCKED" } },
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "N0000002");
        await user.tab();
        await screen.findByText("Existing candidate found — details loaded.");
        await user.clear(screen.getByLabelText("Address"));
        await user.type(screen.getByLabelText("Address"), "2 Lake Road");
        await user.type(screen.getByLabelText("Passport issue date *"), "2020-05-12");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("The WhatsApp number is already set for this candidate and cannot be changed here.")).toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Deployment stages" })).not.toBeInTheDocument();
        expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    test("register pressed straight after typing an existing passport ID loads that candidate instead of creating one", async () => {
        const { calls } = signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: EXISTING } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "N0000002");
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        expect(await screen.findByText("Existing candidate found — details loaded.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
        expect(calls.filter((c) => c.path === "/api/admin/candidates/N0000002")).toHaveLength(1);
    });

    test("a failed lookup is shown and can be retried", async () => {
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 503, body: {} } });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText("Passport ID *"), "N0000002");
        await user.tab();
        expect(await screen.findByText("The passport ID could not be checked.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    test("a viewer sees no registration form", async () => {
        signedInBackend({ "GET /auth/me": { status: 200, body: { user: VIEWER } } });
        renderApp("/candidates/new");
        expect(await screen.findByText("Candidate registration needs a staff account with access to Candidates.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Register candidate" })).not.toBeInTheDocument();
    });
});

describe("Candidate Document Submission: Police Slip", () => {
    test("shows Police slip row with Upload when none exists", async () => {
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS } });
        renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
        await screen.findByRole("heading", { name: "Document submission" });
        expect(screen.getByText("Police slip")).toBeInTheDocument();
        // Since no required flag is on Police slip, there's no asterisk
        expect(screen.queryByText("Police slip *")).not.toBeInTheDocument();
        const row = screen.getByText("Police slip").closest("div.border") as HTMLElement;
        expect(within(row).getByText("No file uploaded", { selector: "p.truncate" })).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Upload" })).toBeInTheDocument();
    });

    test("shows filename and Replace when Police slip exists", async () => {
        const withSlip = {
            ...DETAILS,
            documents: {
                ...DETAILS.documents,
                POLICE_SLIP: { documentId: "doc-1", originalFilename: "slip.pdf", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-02T10:00:00.000Z" }
            }
        };
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: withSlip } });
        renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
        await screen.findByRole("heading", { name: "Document submission" });
        expect(screen.getByText("slip.pdf • 02 Oct 2026")).toBeInTheDocument();
        const row = screen.getByText("Police slip").closest("div.border") as HTMLElement;
        expect(within(row!).getByRole("button", { name: "Replace" })).toBeInTheDocument();
    });

    test("VIEWER cannot upload a Police slip", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { user: VIEWER } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS }
        });
        renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
        await screen.findByRole("heading", { name: "Document submission" });
        const row = screen.getByText("Police slip").closest("div.border") as HTMLElement;
        expect(within(row!).getByRole("button", { name: "Upload" })).toBeDisabled();
    });
});

describe("REGISTRATION_DESK: the whole Candidates area", () => {
    const asDesk = (routes: Record<string, { status: number; body?: unknown }> = {}) =>
        signedInBackend({ "GET /auth/me": { status: 200, body: { user: DESK } }, "GET /api/admin/candidates": { status: 200, body: LIST }, ...routes });
    const nav = () => within(screen.getByRole("navigation", { name: "Main navigation" }));

    test("sees Candidates and Need Attention in the sidebar and nothing ADMIN-only; no separate registration link; no Review Queue bell", async () => {
        const { calls } = asDesk();
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        expect(nav().getAllByRole("link").map((l) => l.textContent)).toEqual(["Candidates", "Need Attention"]);
        for (const name of ["Invite User", "Change Roles", "Audit Logs", "Settings", "Review Queue", "Overview"]) {
            expect(nav().queryByRole("link", { name })).toBeNull();
        }
        expect(screen.queryByRole("link", { name: /register candidate|new candidate/i })).toBeNull();
        expect(screen.queryByRole("button", { name: /notification/i })).toBeNull();
        expect(calls.some((c) => c.path.startsWith("/api/admin/review"))).toBe(false);
    });

    test("registers from the Candidates page: Add candidate opens the registration form", async () => {
        asDesk();
        renderApp("/candidates");
        const add = await screen.findByRole("link", { name: "Add candidate" });
        expect(add).toHaveAttribute("href", "/candidates/new");
        await userEvent.setup().click(add);
        expect(await screen.findByRole("button", { name: "Register candidate" })).toBeEnabled();
        expect(screen.getByLabelText("Passport ID *")).toBeEnabled();
    });

    test("can edit details, upload and remove documents and save stages", async () => {
        const withNic: CandidateDetails = {
            ...DETAILS,
            documents: { ...DETAILS.documents, NIC: { documentId: "doc-n", originalFilename: "nic.pdf", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-01T00:00:00.000Z" } },
        };
        asDesk({ "GET /api/admin/candidates/N0000002": { status: 200, body: withNic } });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByLabelText("Surname *")).toBeEnabled();
        expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
        for (const upload of screen.getAllByRole("button", { name: /Upload|Replace/ })) expect(upload).toBeEnabled();

        const user = userEvent.setup();
        await user.click(within(screen.getByRole("navigation", { name: "Deployment stages" })).getByRole("button", { name: /^6\. Visa approval/ }));
        expect(await screen.findByRole("checkbox", { name: "Stage completed" })).toBeEnabled();
        expect(screen.getByLabelText("Notes")).toBeEnabled();
    });

    test("can read and add calls", async () => {
        asDesk({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: { items: [] } },
        });
        renderApp("/candidates/N0000002");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Call log" }));
        const dialog = await screen.findByRole("dialog", { name: "Call Logs" });
        expect(await within(dialog).findByLabelText("What the candidate said *")).toBeEnabled();
        expect(within(dialog).getByRole("button", { name: "Add call" })).toBeInTheDocument();
    });
});

describe("other roles are unchanged", () => {
    for (const role of ["ADMIN", "MANAGER", "ANALYST"]) {
        test(`${role}: Add candidate on the Candidates page, no separate header registration link, the notification bell`, async () => {
            signedInBackend({ "GET /auth/me": { status: 200, body: { user: userWithRole(role) } }, "GET /api/admin/candidates": { status: 200, body: LIST } });
            renderApp("/candidates");
            expect(await screen.findByRole("link", { name: "Add candidate" })).toHaveAttribute("href", "/candidates/new");
            expect(screen.queryByRole("link", { name: /register candidate/i })).toBeNull();
            expect(screen.getByRole("button", { name: /notification/i })).toBeInTheDocument();
            const links = within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link").map((l) => l.textContent);
            expect(links).toContain("Review Queue");
            expect(links.includes("Settings")).toBe(role === "ADMIN");
        });
    }
});

describe("WhatsApp number: fixed + prefix", () => {
    test("normalization and input handling for +94, +91, +971, and arbitrary country codes", () => {
        // +94 (Sri Lanka)
        expect(whatsappFromLocal("94771234567")).toBe("94771234567");
        expect(whatsappFromLocal("+94 77 123 4567")).toBe("94771234567");
        expect(whatsappFromLocal("+94771234567")).toBe("94771234567");

        // +91 (India)
        expect(whatsappFromLocal("919876543210")).toBe("919876543210");
        expect(whatsappFromLocal("+91 987 654 3210")).toBe("919876543210");
        expect(whatsappFromLocal("+919876543210")).toBe("919876543210");

        // +971 (UAE)
        expect(whatsappFromLocal("971501234567")).toBe("971501234567");
        expect(whatsappFromLocal("+971 50 123 4567")).toBe("971501234567");
        expect(whatsappFromLocal("+971501234567")).toBe("971501234567");

        // Arbitrary valid country codes (+44 UK, +1 US, etc.)
        expect(whatsappFromLocal("447700900123")).toBe("447700900123");
        expect(whatsappFromLocal("+44 7700 900123")).toBe("447700900123");
        expect(whatsappFromLocal("+1 202 555 0123")).toBe("12025550123");

        // "00" international prefix stripped
        expect(whatsappFromLocal("00919876543210")).toBe("919876543210");
        expect(whatsappFromLocal("0094771234567")).toBe("94771234567");

        // Non-digits and empty inputs
        expect(whatsappFromLocal("abc")).toBe("");
        expect(whatsappFromLocal("")).toBe("");
        expect(whatsappFromLocal("+")).toBe("");
    });

    test("existing saved numbers load correctly for any country code (+94, +91, +971, arbitrary, and legacy local)", () => {
        // Sri Lanka +94
        expect(whatsappLocalPart("94771234567")).toBe("94771234567");
        expect(whatsappLocalPart("+94771234567")).toBe("94771234567");

        // India +91
        expect(whatsappLocalPart("919876543210")).toBe("919876543210");
        expect(whatsappLocalPart("+919876543210")).toBe("919876543210");

        // UAE +971
        expect(whatsappLocalPart("971501234567")).toBe("971501234567");
        expect(whatsappLocalPart("+971501234567")).toBe("971501234567");

        // Arbitrary country code (+44 UK)
        expect(whatsappLocalPart("447700900123")).toBe("447700900123");
        expect(whatsappLocalPart("+447700900123")).toBe("447700900123");

        // Legacy local Sri Lankan mobile numbers
        expect(whatsappLocalPart("0771234567")).toBe("94771234567");
    });

    test("the prefix + is fixed and outside the input; + cannot be removed; users can enter any mobile number with (+)", async () => {
        let created = false;
        const { calls } = signedInBackend({
            "POST /api/admin/candidates": () => { created = true; return { status: 201, body: { passportId: "N0000002", uniqueId: "0002" } }; },
            "GET /api/admin/candidates/N0000002": () => (created ? { status: 200, body: DETAILS } : { status: 404, body: { message: "Candidate not found" } }),
        });
        renderApp("/candidates/new");
        const user = userEvent.setup();
        const whatsapp = await screen.findByLabelText("WhatsApp number *");
        expect(whatsapp).toHaveAccessibleDescription("Prefix +");
        expect(whatsapp).toHaveValue("");
        const prefix = whatsapp.parentElement!.querySelector('[aria-hidden="true"]') as HTMLElement;
        expect(prefix).toHaveTextContent(/^\+$/);
        expect(prefix.tagName).not.toBe("INPUT");

        // + cannot be removed by typing, select-all + delete, or clear
        await user.type(whatsapp, "94771234567");
        expect(whatsapp).toHaveValue("94771234567");
        await user.clear(whatsapp);
        expect(whatsapp).toHaveValue("");
        expect(prefix).toHaveTextContent(/^\+$/);

        // Users can enter any mobile number with (+) - +94
        await user.click(whatsapp);
        await user.paste("+94 77 123 4567");
        expect(whatsapp).toHaveValue("94771234567");
        expect(prefix).toHaveTextContent(/^\+$/);

        // Users can enter any mobile number with (+) - +91 (India)
        await user.clear(whatsapp);
        await user.paste("+91 987 654 3210");
        expect(whatsapp).toHaveValue("919876543210");
        expect(prefix).toHaveTextContent(/^\+$/);

        // Users can enter any mobile number with (+) - +971 (UAE)
        await user.clear(whatsapp);
        await user.paste("+971 50 123 4567");
        expect(whatsapp).toHaveValue("971501234567");
        expect(prefix).toHaveTextContent(/^\+$/);

        // Users can enter any mobile number with (+) - arbitrary (+44 UK)
        await user.clear(whatsapp);
        await user.paste("+447700900123");
        expect(whatsapp).toHaveValue("447700900123");
        expect(prefix).toHaveTextContent(/^\+$/);

        await user.type(screen.getByLabelText("Surname *"), "SILVA");
        await user.type(screen.getByLabelText("Other names *"), "SAMAN");
        await user.type(screen.getByLabelText("NIC *"), "901234567V");
        await user.type(screen.getByLabelText("Passport ID *"), "N0000002");
        await user.type(screen.getByLabelText("Job type *"), "Driver{Enter}");
        await user.type(screen.getByLabelText("Job experience *"), "5 years");
        await user.type(screen.getByLabelText("Passport issue date *"), "2020-01-15");
        await user.type(screen.getByLabelText("Passport expiry date *"), "2030-01-14");
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        await screen.findByRole("navigation", { name: "Deployment stages" });
        expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ whatsappNumber: "447700900123" });
    });

    test("existing saved numbers for +94, +91, +971, and arbitrary country codes load read-only with the fixed + prefix", async () => {
        // Arbitrary (+44)
        const foreign: CandidateDetails = { ...DETAILS, candidate: { ...DETAILS.candidate, whatsappNumber: "447700900123" } };
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: foreign } });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        const whatsapp = await screen.findByLabelText("WhatsApp number *");
        expect(whatsapp).toHaveValue("447700900123");
        expect(whatsapp).toHaveAttribute("readonly");
        expect(screen.getByText("+")).toBeInTheDocument();
        expect(screen.queryByText("+94")).toBeNull();
    });

    test("an older number on record in local format loads into the prefix and is kept unchanged on save", async () => {
        const local: CandidateDetails = { ...DETAILS, candidate: { ...DETAILS.candidate, whatsappNumber: "0771234567" } };
        const { calls } = signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: local },
            "PUT /api/admin/candidates/N0000002": { status: 200, body: local },
        });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        const user = userEvent.setup();
        expect(await screen.findByLabelText("WhatsApp number *")).toHaveValue("94771234567");
        await user.type(screen.getByLabelText("Contact number"), "0112345678");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
        expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ whatsappNumber: "0771234567" });
    });
});

describe("field hints", () => {
    const HINTED = ["Passport ID", "WhatsApp number", "Passport issue date", "Passport expiry date"];

    test("a small ! hint beside each of the four fields, with its text on hover, focus or tap", async () => {
        signedInBackend();
        renderApp("/candidates/new");
        await screen.findByLabelText("Passport ID *");
        for (const label of HINTED) {
            const hint = screen.getByRole("button", { name: `About ${label}` });
            expect(hint).toHaveTextContent("!");
            expect(hint).toHaveAttribute("type", "button");
        }
        const user = userEvent.setup();
        await user.hover(screen.getByRole("button", { name: "About Passport ID" }));
        expect(screen.getByRole("tooltip")).toHaveTextContent(FIELD_HINTS.passportId);
        await user.unhover(screen.getByRole("button", { name: "About Passport ID" }));
        expect(screen.queryByRole("tooltip")).toBeNull();
    });

    test("keyboard: Tab focuses a hint and shows its text as the button's description; Escape hides it", async () => {
        signedInBackend();
        renderApp("/candidates/new");
        await screen.findByLabelText("Passport ID *");
        const hint = screen.getByRole("button", { name: "About WhatsApp number" });
        act(() => hint.focus());
        expect(hint).toHaveAccessibleDescription(FIELD_HINTS.whatsappNumber);
        await userEvent.setup().keyboard("{Escape}");
        expect(screen.queryByRole("tooltip")).toBeNull();
    });

    test("the hints state the rules actually applied (passport 6-9 letters and digits, no fixed prefix; mobile with country code; dates required)", () => {
        expect(FIELD_HINTS.passportId).toMatch(/6 to 9 letters and digits/);
        expect(FIELD_HINTS.passportId).not.toMatch(/\bPN\b/);
        expect(FIELD_HINTS.whatsappNumber).toMatch(/\+/);
        expect(FIELD_HINTS.passportIssueDate).toMatch(/Required/);
        expect(FIELD_HINTS.passportExpiryDate).toMatch(/Required/);
    });
});

describe("Visa submission document", () => {
    const visaFile = () => new File(["%PDF-1.4 visa"], "visa-form.pdf", { type: "application/pdf" });

    test("the Visa submission stage has its own upload row; a candidate role uploads through the existing direct upload", async () => {
        const uploaded: CandidateDetails = {
            ...DETAILS,
            documents: { ...DETAILS.documents, VISA_SUBMISSION: { documentId: "doc-visa", originalFilename: "N0000002 - VISA_SUBMISSION.PDF", verificationStatus: "VERIFIED", variant: null, receivedDate: "2026-10-09T00:00:00.000Z" } },
        };
        const { calls } = signedInBackend({
            "GET /auth/me": { status: 200, body: { user: DESK } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            ...directUploadRoutes("N0000002", uploaded),
        });
        renderApp("/candidates/N0000002?stage=VISA_SUBMISSION");
        expect(await screen.findByRole("heading", { name: "Visa submission" })).toBeInTheDocument();
        const row = screen.getByText("Visa submission document").closest("div.rounded-lg") as HTMLElement;
        expect(within(row).getByText(/No file uploaded/)).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Upload" })).toBeEnabled();
        const completedBefore = (screen.getByRole("checkbox", { name: "Stage completed" }) as HTMLInputElement).checked;

        await userEvent.setup().upload(screen.getByLabelText("Visa submission document file"), visaFile());
        await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/documents/finalize"))).toBe(true));
        expect(calls.find((c) => c.path.endsWith("/documents/upload-target"))!.body).toMatchObject({ type: "VISA_SUBMISSION", mimeType: "application/pdf" });
        expect(await within(row).findByText(/VISA_SUBMISSION\.PDF/)).toBeInTheDocument();
        // Completion stays manual: the upload doesn't change it.
        expect((screen.getByRole("checkbox", { name: "Stage completed" }) as HTMLInputElement).checked).toBe(completedBefore);
    });

    test("read-only for a user without candidate permissions", async () => {
        signedInBackend({ "GET /auth/me": { status: 200, body: { user: VIEWER } }, "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS } });
        renderApp("/candidates/N0000002?stage=VISA_SUBMISSION");
        await screen.findByRole("heading", { name: "Visa submission" });
        const row = screen.getByText("Visa submission document").closest("div.rounded-lg") as HTMLElement;
        expect(within(row).getByRole("button", { name: "Upload" })).toBeDisabled();
    });
});
