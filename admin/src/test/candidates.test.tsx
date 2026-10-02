import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
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
        dateOfBirth: "1990-03-12", placeOfBirth: "COLOMBO", passportExpiryDate: "2030-05-11", passportIssueDate: null, nationality: null, sex: null,
        address: "1 Main Street", jobExperience: "5 years", whatsappNumber: "94770000002", contactNumber: null,
    },
    stages: stages([false, false, false, true, true, true]).map((s) => ({
        ...s,
        completedAt: null,
        notes: null,
        jobId: null,
        testResult: null,
        testDate: null,
        automatic: s.stage === "CANDIDATE_DETAILS" || s.stage === "DOCUMENT_SUBMISSION",
        missing: s.stage === "CANDIDATE_DETAILS" ? ["passport document"] : s.stage === "DOCUMENT_SUBMISSION" ? ["medical", "police report", "agreement", "affidavit"] : [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_REPORT: null, AGREEMENT: null, AFFIDAVIT: null },
    variantDocuments: {
        POLICE_REPORT: { byVariant: { SL_VERIFIED: null, ROMANIA: null, SL_NORMAL: null }, untyped: null },
        AFFIDAVIT: { byVariant: { ENGLISH: null, SINHALA: null }, untyped: null },
    },
    requiredDocuments: (["PASSPORT", "MEDICAL", "POLICE_REPORT", "AGREEMENT", "AFFIDAVIT"] as const).map((documentType) => ({ documentType, included: documentType === "PASSPORT" })),
};

const VIEWER = { ...ADMIN, role: "VIEWER" };

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
        expect(within(table).getByText("Driver")).toBeInTheDocument();
        expect(within(table).getByText("Welder")).toBeInTheDocument();
        // Current stage = first not completed; the count is completed stages.
        expect(within(table).getByLabelText("Document submission, 2 of 6 stages completed")).toHaveTextContent("Document submission2/6");
        expect(within(table).getByLabelText("Test details, 3 of 6 stages completed")).toHaveTextContent("Test details3/6");
        expect(screen.getByRole("link", { name: "Add candidate" })).toHaveAttribute("href", "/candidates/new");

        await userEvent.setup().type(screen.getByLabelText("Search candidates"), "901234567V{Enter}");
        expect(calls.at(-1)!.path).toBe("/api/admin/candidates?page=1&pageSize=25&search=901234567V");
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
        expect(calls.at(-1)!.path).toBe("/api/admin/candidates?page=1&pageSize=25&search=nobody");
    });

    test("a failed page change shows its error, not the previous page", async () => {
        signedInBackend({
            "GET /api/admin/candidates": (url) => (url.searchParams.get("page") === "2"
                ? { status: 503, body: {} }
                : { status: 200, body: { ...LIST, pagination: { page: 1, pageSize: 25, total: 30, totalPages: 2 } } }),
        });
        renderApp("/candidates");
        await screen.findByRole("table", { name: "Candidates" });
        await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
        expect(screen.queryByText("KAMAL PERERA")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
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
        // Completed by the documents themselves: no checkbox, no Save.
        expect(screen.getByText("Missing: medical, police report, agreement, affidavit")).toBeInTheDocument();
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
        for (const label of ["Medical", "Police report", "Scan - Agreement", "Scan - Affidavit"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
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
            signedInBackend({ "GET /auth/me": { status: 200, body: { admin: VIEWER } }, "GET /api/admin/candidates/N0000002": { status: 200, body: withTest("PASS", "2026-09-28") } });
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
            const affidavit = groupOf("Scan - Affidavit");
            expect(affidavit.getByText("English Affidavit")).toBeInTheDocument();
            expect(affidavit.getByText("Sinhala Affidavit")).toBeInTheDocument();
            expect(affidavit.getAllByRole("button", { name: "Upload" })).toHaveLength(2);

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
                "GET /auth/me": { status: 200, body: { admin: VIEWER } },
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

            expect(await screen.findByText("The file could not be uploaded. Please try again.")).toBeInTheDocument();
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
            signedInBackend({ "GET /auth/me": { status: 200, body: { admin: VIEWER } }, "GET /api/admin/candidates/N0000002": { status: 200, body: withNic } });
            renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
            await screen.findByLabelText("NIC document file");
            expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        });
    });

    test("candidate details: optional fields are empty when not on record; a WhatsApp number on record is read-only", async () => {
        signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS } });
        renderApp("/candidates/N0000002?stage=CANDIDATE_DETAILS");
        expect(await screen.findByLabelText("WhatsApp number")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("WhatsApp number")).toHaveValue("94770000002");
        expect(screen.getByText("Registered WhatsApp numbers cannot be changed.")).toBeInTheDocument();
        expect(screen.getByLabelText("Contact number")).not.toHaveAttribute("readonly");
        expect(screen.getByLabelText("Nationality")).toHaveValue("");
        expect(screen.getByLabelText("Sex")).toHaveValue("");
        expect(screen.getByLabelText("Passport issue date")).toHaveValue("");
        expect(screen.getByText("Missing: passport document")).toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: "Stage completed" })).not.toBeInTheDocument();
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
        return screen.findByRole("dialog", { name: "Call log" });
    };

    test("shows each call's date, time (Sri Lanka) and note, newest first", async () => {
        signedInBackend({
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
            "GET /api/admin/candidates/N0000002/call-logs": { status: 200, body: CALLS },
        });
        renderApp("/candidates/N0000002");
        const dialog = await openCallLog();
        const items = within(await within(dialog).findByRole("list", { name: "Calls" })).getAllByRole("listitem");
        expect(items.map((item) => item.textContent)).toEqual([
            "01 Oct 2026 · 16:45Test AdminSaid the police report is ready",
            "30 Sept 2026 · 10:15Asked about the medical",
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
        expect(await within(dialog).findByText("No calls logged yet.")).toBeInTheDocument();

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
        await within(dialog).findByText("No calls logged yet.");
        fireEvent.change(within(dialog).getByLabelText("Date *"), { target: { value: "2099-01-01" } });
        await userEvent.setup().type(within(dialog).getByLabelText("What the candidate said *"), "x");
        await userEvent.setup().click(within(dialog).getByRole("button", { name: "Add call" }));
        expect(within(dialog).getByText("The call can't be in the future.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    test("a viewer sees the calls but can't add one", async () => {
        signedInBackend({
            "GET /auth/me": { status: 200, body: { admin: VIEWER } },
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

describe("Candidate registration", () => {
    test("required fields and the passport file are checked before anything is sent", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        await userEvent.setup().click(await screen.findByRole("button", { name: "Register candidate" }));
        expect(screen.getByText("Enter the surname.")).toBeInTheDocument();
        expect(screen.getByText("Choose the passport file.")).toBeInTheDocument();
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
        await user.type(await screen.findByLabelText("Surname *"), "SILVA");
        await user.type(screen.getByLabelText("Other names *"), "SAMAN");
        await user.type(screen.getByLabelText("NIC *"), "901234567V");
        await user.type(screen.getByLabelText("Passport ID *"), "n0000002");
        await user.type(screen.getByLabelText("Job type *"), "Driver{Enter}");
        await user.type(screen.getByLabelText("Job experience *"), "5 years");
        await user.type(screen.getByLabelText("Address *"), "1 Main Street");
        await user.upload(screen.getByLabelText("Passport *"), new File(["%PDF-1.4"], "passport.pdf", { type: "application/pdf" }));
    }

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
        await user.type(screen.getByLabelText("Address *"), ", Kandy");
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
            nationality: "", sex: "", dateOfBirth: "", placeOfBirth: "", passportIssueDate: "", passportExpiryDate: "", whatsappNumber: "", contactNumber: "",
        });
        // The passport file went to storage, then was finalized; never to the API.
        expect(calls.find((c) => c.path.endsWith("/documents/upload-target"))!.body).toMatchObject({ type: "PASSPORT", mimeType: "application/pdf", fileName: "passport.pdf" });
        expect(calls.find((c) => c.method === "PUT")!.body).toBeInstanceOf(File);
        expect(calls.find((c) => c.path.endsWith("/documents/finalize"))!.body).toMatchObject({ type: "PASSPORT", uploadId: UPLOAD_ID });
        expect(calls.filter((c) => c.url.pathname.startsWith("/api/") && c.body instanceof File)).toEqual([]);
    });

    test("an optional value that is given is checked: issue date before expiry, phone number format", async () => {
        const { calls } = signedInBackend();
        renderApp("/candidates/new");
        const user = userEvent.setup();
        await fillRequired(user);
        await user.type(screen.getByLabelText("Passport issue date"), "2031-01-01");
        await user.type(screen.getByLabelText("Passport expiry date"), "2030-01-01");
        await user.type(screen.getByLabelText("WhatsApp number"), "12");
        await user.click(screen.getByRole("button", { name: "Register candidate" }));
        expect(screen.getByText("Must be before the expiry date.")).toBeInTheDocument();
        expect(screen.getByText("Enter a phone number, e.g. 0771234567.")).toBeInTheDocument();
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
        candidate: { ...DETAILS.candidate, nationality: "Sri Lankan", sex: "M", contactNumber: null },
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
        expect(screen.getByLabelText("Passport *")).toHaveAttribute("type", "file");
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
        expect(screen.getByLabelText("Address *")).toHaveValue("1 Main Street");
        expect(screen.getByLabelText("Job experience *")).toHaveValue("5 years");
        expect(screen.getByText("Driver")).toBeInTheDocument();
        expect(screen.getByLabelText("Nationality")).toHaveValue("Sri Lankan");
        expect(screen.getByLabelText("Sex")).toHaveValue("M");
        expect(screen.getByLabelText("Date of birth")).toHaveValue("1990-03-12");
        expect(screen.getByLabelText("Passport expiry date")).toHaveValue("2030-05-11");
        expect(screen.getByLabelText("Passport issue date")).toHaveValue("");
        expect(screen.getByLabelText("WhatsApp number")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("WhatsApp number")).toHaveValue("94770000002");
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
        await user.clear(screen.getByLabelText("Address *"));
        await user.type(screen.getByLabelText("Address *"), "2 Lake Road");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByRole("navigation", { name: "Deployment stages" })).toBeInTheDocument();
        const put = calls.find((c) => c.method === "PUT")!;
        expect(put.path).toBe("/api/admin/candidates/N0000002");
        expect(put.body).toMatchObject({ address: "2 Lake Road", surname: "SILVA", nationality: "Sri Lankan", sex: "M", whatsappNumber: "94770000002" });
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
        await user.clear(screen.getByLabelText("Address *"));
        await user.type(screen.getByLabelText("Address *"), "2 Lake Road");
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
        signedInBackend({ "GET /auth/me": { status: 200, body: { admin: VIEWER } } });
        renderApp("/candidates/new");
        expect(await screen.findByText("Candidate registration needs an admin or reviewer account.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Register candidate" })).not.toBeInTheDocument();
    });
});
