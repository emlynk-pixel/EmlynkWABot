import { screen, within } from "@testing-library/react";
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

    describe("document type (police report, affidavit) must be chosen", () => {
        const pdf = () => new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });
        const document = (variant: string | null) => ({ documentId: "doc-1", originalFilename: "old-report.pdf", verificationStatus: "VERIFIED", variant, receivedDate: "2026-09-20T00:00:00.000Z" });
        const rowOf = (select: HTMLElement) => within(select.parentElement!);
        // The variant travels in the upload's description (upload-target).
        const uploads = (calls: { path: string; body: unknown }[]) =>
            calls.filter((c) => c.path.endsWith("/documents/upload-target")).map((c) => (c.body as { variant?: string }).variant);

        test("nothing is preselected; Upload stays disabled until a type is chosen; the chosen type is sent", async () => {
            const uploaded: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, POLICE_REPORT: document("ROMANIA") } };
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
                ...directUploadRoutes("N0000002", uploaded),
            });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            const user = userEvent.setup();

            const police = await screen.findByLabelText("Police report type");
            expect(police).toHaveValue("");
            expect(within(police).getByRole("option", { name: "Select type…" })).toBeInTheDocument();
            expect(within(police).getAllByRole("option").map((o) => o.textContent)).toEqual(["Select type…", "SL Verified", "Romania", "SL Normal"]);
            expect(rowOf(police).getByRole("button", { name: "Upload" })).toBeDisabled();

            const affidavit = screen.getByLabelText("Scan - Affidavit type");
            expect(affidavit).toHaveValue("");
            expect(within(affidavit).getAllByRole("option").map((o) => o.textContent)).toEqual(["Select type…", "English Affidavit", "Sinhala Affidavit"]);
            expect(rowOf(affidavit).getByRole("button", { name: "Upload" })).toBeDisabled();

            // Documents without types are unaffected.
            expect(screen.queryByLabelText("Medical type")).not.toBeInTheDocument();
            expect(screen.getAllByRole("button", { name: "Upload" }).filter((b) => !(b as HTMLButtonElement).disabled)).toHaveLength(2);

            // A file can't be sent before the type is chosen.
            await user.upload(screen.getByLabelText("Police report file"), pdf());
            expect(uploads(calls)).toEqual([]);

            await user.selectOptions(police, "ROMANIA");
            expect(rowOf(police).getByRole("button", { name: "Upload" })).toBeEnabled();
            await user.upload(screen.getByLabelText("Police report file"), pdf());
            await vi.waitFor(() => expect(uploads(calls)).toEqual(["ROMANIA"]));
            expect(await screen.findByText(/old-report\.pdf • Romania/)).toBeInTheDocument();
            expect(calls.find((c) => c.path.endsWith("/documents/finalize"))!.body).toMatchObject({ type: "POLICE_REPORT", variant: "ROMANIA", uploadId: UPLOAD_ID });
            expect(rowOf(police).getByRole("button", { name: "Replace" })).toBeEnabled();
        });

        test("a stored document keeps its type; replacing it sends that type, or a newly chosen one", async () => {
            const stored: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, POLICE_REPORT: document("SL_NORMAL"), AFFIDAVIT: document("SINHALA") } };
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: stored },
                ...directUploadRoutes("N0000002", stored),
            });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            const user = userEvent.setup();

            const police = await screen.findByLabelText("Police report type");
            expect(police).toHaveValue("SL_NORMAL");
            expect(screen.getByLabelText("Scan - Affidavit type")).toHaveValue("SINHALA");
            expect(rowOf(police).getByRole("button", { name: "Replace" })).toBeEnabled();

            await user.upload(screen.getByLabelText("Police report file"), pdf());
            await vi.waitFor(() => expect(uploads(calls)).toHaveLength(1));
            await user.selectOptions(police, "SL_VERIFIED");
            await user.upload(screen.getByLabelText("Police report file"), pdf());
            await vi.waitFor(() => expect(uploads(calls)).toEqual(["SL_NORMAL", "SL_VERIFIED"]));
            await vi.waitFor(() => expect(calls.filter((c) => c.path.endsWith("/documents/finalize"))).toHaveLength(2));
        });

        test("a stored document without a type (e.g. received on WhatsApp) needs one before it is replaced", async () => {
            const stored: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, POLICE_REPORT: document(null) } };
            signedInBackend({ "GET /api/admin/candidates/N0000002": { status: 200, body: stored } });
            renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
            const police = await screen.findByLabelText("Police report type");
            expect(police).toHaveValue("");
            expect(rowOf(police).getByRole("button", { name: "Replace" })).toBeDisabled();
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
