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
        automatic: s.stage === "CANDIDATE_DETAILS" || s.stage === "DOCUMENT_SUBMISSION",
        missing: s.stage === "CANDIDATE_DETAILS" ? ["passport document"] : s.stage === "DOCUMENT_SUBMISSION" ? ["medical", "police report", "agreement", "affidavit"] : [],
    })),
    documents: { PASSPORT: null, NIC: null, SKILL_VIDEO: null, MEDICAL: null, POLICE_SLIP: null, POLICE_REPORT: null, AGREEMENT: null, AFFIDAVIT: null },
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

    describe("document type (police report, affidavit) must be chosen", () => {
        const pdf = () => new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });
        const document = (variant: string | null) => ({ documentId: "doc-1", originalFilename: "old-report.pdf", verificationStatus: "VERIFIED", variant, receivedDate: "2026-09-20T00:00:00.000Z" });
        const rowOf = (select: HTMLElement) => within(select.parentElement!);
        const uploads = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST").map((c) => c.path);

        test("nothing is preselected; Upload stays disabled until a type is chosen; the chosen type is sent", async () => {
            const uploaded: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, POLICE_REPORT: document("ROMANIA") } };
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS },
                "POST /api/admin/candidates/N0000002/documents": { status: 200, body: uploaded },
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
            expect(screen.getAllByRole("button", { name: "Upload" }).filter((b) => !(b as HTMLButtonElement).disabled)).toHaveLength(3);

            // A file can't be sent before the type is chosen.
            await user.upload(screen.getByLabelText("Police report file"), pdf());
            expect(uploads(calls)).toEqual([]);

            await user.selectOptions(police, "ROMANIA");
            expect(rowOf(police).getByRole("button", { name: "Upload" })).toBeEnabled();
            await user.upload(screen.getByLabelText("Police report file"), pdf());
            await vi.waitFor(() => expect(uploads(calls)).toEqual(["/api/admin/candidates/N0000002/documents?type=POLICE_REPORT&variant=ROMANIA"]));
            expect(await screen.findByText(/old-report\.pdf • Romania/)).toBeInTheDocument();
            expect(rowOf(police).getByRole("button", { name: "Replace" })).toBeEnabled();
        });

        test("a stored document keeps its type; replacing it sends that type, or a newly chosen one", async () => {
            const stored: CandidateDetails = { ...DETAILS, documents: { ...DETAILS.documents, POLICE_REPORT: document("SL_NORMAL"), AFFIDAVIT: document("SINHALA") } };
            const { calls } = signedInBackend({
                "GET /api/admin/candidates/N0000002": { status: 200, body: stored },
                "POST /api/admin/candidates/N0000002/documents": { status: 200, body: stored },
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
            await vi.waitFor(() => expect(uploads(calls)).toEqual([
                "/api/admin/candidates/N0000002/documents?type=POLICE_REPORT&variant=SL_NORMAL",
                "/api/admin/candidates/N0000002/documents?type=POLICE_REPORT&variant=SL_VERIFIED",
            ]));
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
            "POST /api/admin/candidates/N0000002/documents": { status: 201, body: DETAILS },
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
        expect(calls.some((c) => c.path === "/api/admin/candidates/N0000002/documents?type=PASSPORT")).toBe(true);
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
        expect(await screen.findByText("Candidate registration needs an admin or analyst account.")).toBeInTheDocument();
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
            "GET /auth/me": { status: 200, body: { admin: VIEWER } },
            "GET /api/admin/candidates/N0000002": { status: 200, body: DETAILS }
        });
        renderApp("/candidates/N0000002?stage=DOCUMENT_SUBMISSION");
        await screen.findByRole("heading", { name: "Document submission" });
        const row = screen.getByText("Police slip").closest("div.border") as HTMLElement;
        expect(within(row!).getByRole("button", { name: "Upload" })).toBeDisabled();
    });
});
