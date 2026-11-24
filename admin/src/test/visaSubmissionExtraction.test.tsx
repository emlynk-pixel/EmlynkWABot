import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtractionPreview } from "../api/visaSubmissionExtraction";
import { actionLabel } from "../pages/AuditLogsPage";
import { EXTRACTION_RETRY, ZIP_TOO_LARGE_MESSAGE } from "../pages/VisaSubmissionPage";
import { RENDER_STEP, SESSION_TOKEN, expectRedirectedHome, renderApp, signedInBackend, userWithRole, type FetchRoutes } from "./helpers";

// Visa Submission page (Phase 2): extracting a Job's signed submissions in batches the browser drives,
// and the VISA SUBMISSION/ folder browser. ADMIN (an OWNER too) and TEAM_LEAD only. Synthetic jobs,
// candidates and files; the backend is stubbed.

const API = "/api/admin/visa-submission";
const JOBS = `GET ${API}/extraction/jobs`;
const JOB_ID = "1f0c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const PREVIEW = `GET ${API}/extraction/jobs/${JOB_ID}`;
const EXTRACT = `POST ${API}/extraction/jobs/${JOB_ID}/extract`;
const STORAGE = `GET ${API}/storage`;

const CLIENT = { id: "client-1", name: "ACME BUILDERS" };
const JOB = { jobId: JOB_ID, jobCode: "JC-001", companyJobId: "CJ-9", status: "PROCESSING", client: CLIENT, primaryTrade: "Welder", eligibleCount: 5 };
const EMPTY_JOB = { ...JOB, jobId: "2f0c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", jobCode: "JC-002", companyJobId: null, eligibleCount: 0 };

const candidate = (n: number) => ({ passportId: `N000000${n}`, firstName: `FIRST${n}`, otherName: `LAST${n}`, documentId: `doc-${n}`, uploadedAt: "2026-11-20T00:00:00.000Z" });
const preview = (count: number, batchSize = 2): ExtractionPreview => ({
    job: { jobId: JOB_ID, jobCode: "JC-001", companyJobId: "CJ-9", status: "PROCESSING", client: CLIENT, primaryTrade: "Welder" },
    date: "2026-11-24",
    folder: "VISA SUBMISSION/2026-11-24/Plan B",
    files: { candidateDetails: "ACME BUILDERS - Candidate Details.xlsx", extraDetails: "ACME BUILDERS - Extra Details.xlsx" },
    candidates: Array.from({ length: count }, (_, i) => candidate(i + 1)),
    skipped: [{ passportId: "N0000099", reason: "INVALID_PASSPORT_NUMBER", message: "The passport number is not valid" }],
    batchSize,
    maxBatchSize: 15,
});
const batch = (over: Partial<{ extracted: string[]; skipped: { passportId: string; reason: string; message: string }[]; failed: string[]; deferred: string[] }>) => ({
    status: 200,
    body: {
        date: "2026-11-24", folder: "VISA SUBMISSION/2026-11-24/Plan B", processed: 0, remaining: 0,
        extracted: (over.extracted ?? []).map((passportId) => ({ passportId, documentId: `doc-${passportId}`, file: `${passportId}.pdf` })),
        skipped: over.skipped ?? [],
        failed: (over.failed ?? []).map((passportId) => ({ passportId, reason: "PDF_COPY_FAILED" })),
        deferred: over.deferred ?? [],
    },
});
const BUSY = { status: 409, body: { message: "Extraction in progress, try again", code: "EXTRACTION_IN_PROGRESS" } };
// Answers in turn (the last one repeats).
const sequence = (...answers: { status: number; body?: unknown }[]) => {
    let i = 0;
    return () => answers[Math.min(i++, answers.length - 1)];
};

const ROOT = { root: "VISA SUBMISSION", path: "", entries: [{ name: "2026-11-24", type: "folder", size: null, updatedAt: null }], truncated: false };
const DAY = { root: "VISA SUBMISSION", path: "2026-11-24", entries: [{ name: "Plan B", type: "folder", size: null, updatedAt: null }], truncated: false };
const PLAN_B = {
    root: "VISA SUBMISSION", path: "2026-11-24/Plan B", truncated: true,
    entries: [
        { name: "N0000001.pdf", type: "file", size: 2048, updatedAt: "2026-11-24T05:00:00.000Z" },
        { name: "archive", type: "folder", size: null, updatedAt: null },
    ],
};
const storage = (folders: Record<string, unknown> = { "": ROOT, "2026-11-24": DAY, "2026-11-24/Plan B": PLAN_B }) => (url: URL) => {
    const body = folders[url.searchParams.get("path") ?? ""];
    return body ? { status: 200, body } : { status: 404, body: { message: "Folder not found", code: "FOLDER_NOT_FOUND" } };
};

async function openPage(role = "ADMIN", routes: FetchRoutes = {}) {
    const backend = signedInBackend({
        "GET /auth/me": { status: 200, body: { user: userWithRole(role) } },
        [JOBS]: { status: 200, body: { jobs: [JOB, EMPTY_JOB] } },
        [STORAGE]: storage(),
        ...routes,
    });
    const saved: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:visa"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    const view = renderApp("/visa-submission");
    expect(await screen.findByRole("heading", { name: "Visa Submission", level: 1 }, RENDER_STEP)).toBeInTheDocument();
    return { ...backend, saved, view };
}

const extractBodies = (calls: { method: string; url: URL; body: unknown }[]) =>
    calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/extract")).map((c) => (c.body as { passportIds: string[] }).passportIds);
const countOf = (calls: { method: string; url: URL }[], pathname: string) => calls.filter((c) => c.method === "GET" && c.url.pathname === pathname).length;

// True when a beforeunload handler asks the browser to confirm leaving.
const leaveWarned = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
};

// Selects JC-001, loads the preview and confirms.
async function startExtraction() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Select job JC-001 / CJ-9" }, RENDER_STEP));
    await user.click(screen.getByRole("button", { name: "Extract Completed Candidates" }));
    const dialog = await screen.findByRole("dialog", undefined, RENDER_STEP);
    await user.click(within(dialog).getByRole("button", { name: "Extract" }));
    return user;
}

const DEFAULT_RETRY = { ...EXTRACTION_RETRY };
beforeEach(() => { EXTRACTION_RETRY.delayMs = 0; });
afterEach(() => { Object.assign(EXTRACTION_RETRY, DEFAULT_RETRY); });

describe("Visa Submission: navigation and access", () => {
    const navLink = () => within(screen.getByRole("navigation", { name: "Main navigation" })).queryByRole("link", { name: "Visa Submission" });

    test.each(["ADMIN", "OWNER", "TEAM_LEAD"])("%s sees the sidebar entry and opens the page", { timeout: 20_000 }, async (role) => {
        const { calls } = await openPage(role);
        expect(navLink()).toBeInTheDocument();
        await screen.findByRole("radio", { name: "Select job JC-001 / CJ-9" }, RENDER_STEP);
        expect(countOf(calls, `${API}/extraction/jobs`)).toBeGreaterThan(0);
    });

    test.each(["ANALYST", "REGISTRATION_DESK", "JOB_HANDLER"])("%s: no sidebar entry; the URL is blocked with no request", { timeout: 20_000 }, async (role) => {
        const { calls } = signedInBackend({ "GET /auth/me": { status: 200, body: { user: userWithRole(role) } }, "GET /api/admin/candidates": { status: 200, body: { items: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 }, filters: { search: null } } } });
        renderApp("/visa-submission");
        await expectRedirectedHome(role);
        expect(navLink()).toBeNull();
        expect(calls.some((c) => c.path.startsWith(API))).toBe(false);
    });
});

describe("Visa Submission: Extract", () => {
    test("lists the jobs; the button needs a job with eligible candidates", { timeout: 20_000 }, async () => {
        await openPage();
        const rows = await screen.findAllByTestId("extraction-job", undefined, RENDER_STEP);
        expect(rows).toHaveLength(2);
        expect(within(rows[0]).getByText("JC-001 / CJ-9")).toBeInTheDocument();
        expect(within(rows[0]).getByText("ACME BUILDERS")).toBeInTheDocument();
        expect(within(rows[0]).getByText("Welder")).toBeInTheDocument();
        expect(within(rows[0]).getByText("5")).toBeInTheDocument();
        expect(within(rows[1]).getByText("JC-002")).toBeInTheDocument();
        const button = screen.getByRole("button", { name: "Extract Completed Candidates" });
        expect(button).toBeDisabled();
        const user = userEvent.setup();
        await user.click(screen.getByRole("radio", { name: "Select job JC-002" }));
        expect(button).toBeDisabled();
        expect(screen.getByText("Nothing eligible to extract for JC-002.")).toBeInTheDocument();
        await user.click(screen.getByRole("radio", { name: "Select job JC-001 / CJ-9" }));
        expect(button).toBeEnabled();
    });

    test("no jobs: an empty state", { timeout: 20_000 }, async () => {
        await openPage("ADMIN", { [JOBS]: { status: 200, body: { jobs: [] } } });
        expect(await screen.findByText("No jobs to extract", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Extract Completed Candidates" })).toBeNull();
    });

    test("the preview is confirmed first: candidates in order, warnings, folder and files; Cancel sends nothing", { timeout: 20_000 }, async () => {
        const { calls } = await openPage("ADMIN", { [PREVIEW]: { status: 200, body: preview(3) } });
        const user = userEvent.setup();
        await user.click(await screen.findByRole("radio", { name: "Select job JC-001 / CJ-9" }, RENDER_STEP));
        await user.click(screen.getByRole("button", { name: "Extract Completed Candidates" }));
        const dialog = await screen.findByRole("dialog", undefined, RENDER_STEP);
        expect(within(dialog).getByRole("heading", { name: "Extract 3 candidates?" })).toBeInTheDocument();
        const items = within(within(dialog).getByRole("list", { name: "Candidates to extract" })).getAllByRole("listitem").map((li) => li.textContent);
        expect(items).toEqual(["N0000001 · FIRST1 LAST1", "N0000002 · FIRST2 LAST2", "N0000003 · FIRST3 LAST3"]);
        expect(within(dialog).getByText("N0000099: The passport number is not valid")).toBeInTheDocument();
        expect(within(dialog).getByText("VISA SUBMISSION/2026-11-24/Plan B")).toBeInTheDocument();
        expect(within(dialog).getByText(/ACME BUILDERS - Candidate Details\.xlsx/)).toBeInTheDocument();
        expect(within(dialog).getByText(/ACME BUILDERS - Extra Details\.xlsx/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(extractBodies(calls)).toEqual([]);
    });

    test("a preview with nothing to extract: no dialog, the reasons shown", { timeout: 20_000 }, async () => {
        const { calls } = await openPage("ADMIN", { [PREVIEW]: { status: 200, body: preview(0) } });
        const user = userEvent.setup();
        await user.click(await screen.findByRole("radio", { name: "Select job JC-001 / CJ-9" }, RENDER_STEP));
        await user.click(screen.getByRole("button", { name: "Extract Completed Candidates" }));
        expect(await screen.findByText("Nothing to extract for JC-001 / CJ-9.", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByText("N0000099: The passport number is not valid")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(extractBodies(calls)).toEqual([]);
    });

    test("batches of batchSize, sent in turn: progress, deferred re-queued, 409 retried, failed shown and not retried; then the summary and refresh", { timeout: 30_000 }, async () => {
        const answers = sequence(
            batch({ extracted: ["N0000001"], deferred: ["N0000002"] }),
            BUSY,
            batch({ extracted: ["N0000002"], failed: ["N0000003"] }),
            batch({ extracted: ["N0000004"], skipped: [{ passportId: "N0000005", reason: "ALREADY_EXTRACTED", message: "Already extracted" }] }),
        );
        const backend = await openPage("ADMIN", { [PREVIEW]: { status: 200, body: preview(5) }, [EXTRACT]: answers });
        // Hold the first batch to observe the progress and the leave-page warning.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const inner = backend.fetchMock.getMockImplementation()!;
        let first = true;
        backend.fetchMock.mockImplementation(async (input, init) => {
            if (first && init?.method === "POST") { first = false; await gate; }
            return inner(input, init);
        });
        const jobsBefore = countOf(backend.calls, `${API}/extraction/jobs`);
        const storageBefore = countOf(backend.calls, `${API}/storage`);
        expect(leaveWarned()).toBe(false);

        await startExtraction();
        expect(await screen.findByText("Batch 1 of 3", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByText("Do not close this tab until the extraction finishes.")).toBeInTheDocument();
        expect(leaveWarned()).toBe(true);
        release();

        const result = await screen.findByRole("region", { name: "Extraction result" }, RENDER_STEP);
        expect(extractBodies(backend.calls)).toEqual([["N0000001", "N0000002"], ["N0000002", "N0000003"], ["N0000002", "N0000003"], ["N0000004", "N0000005"]]);
        expect(within(result).getByText("Extraction finished.")).toBeInTheDocument();
        expect(within(result).getByText("Extracted 3 · Skipped 1 · Failed 1")).toBeInTheDocument();
        expect(within(result).getByText("N0000003: The signed visa submission PDF could not be copied. Extract this job again later to retry.")).toBeInTheDocument();
        expect(within(result).getByText("N0000005: Already extracted")).toBeInTheDocument();
        expect(within(within(result).getByRole("list", { name: "Warnings" })).getByText("N0000099: The passport number is not valid")).toBeInTheDocument();
        expect(leaveWarned()).toBe(false);
        await waitFor(() => {
            expect(countOf(backend.calls, `${API}/extraction/jobs`)).toBeGreaterThan(jobsBefore);
            expect(countOf(backend.calls, `${API}/storage`)).toBeGreaterThan(storageBefore);
        }, RENDER_STEP);
        expect(backend.calls.filter((c) => c.method === "POST").every((c) => c.headers.Authorization === `Bearer ${SESSION_TOKEN}`)).toBe(true);
    });

    test("409 every time: retried a bounded number of times, then a clear error with Retry", { timeout: 20_000 }, async () => {
        const { calls } = await openPage("ADMIN", { [PREVIEW]: { status: 200, body: preview(2) }, [EXTRACT]: BUSY });
        await startExtraction();
        expect(await screen.findByText("Another extraction of this job is still running. Wait a minute, then retry.", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(extractBodies(calls)).toHaveLength(EXTRACTION_RETRY.maxAttempts);
        expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
        expect(leaveWarned()).toBe(false);
    });

    test("502 EXCEL_UPDATE_FAILED stops the run with a message; Retry resumes from that batch", { timeout: 20_000 }, async () => {
        const answers = sequence(
            batch({ extracted: ["N0000001", "N0000002"] }),
            { status: 502, body: { message: "Excel update failed", code: "EXCEL_UPDATE_FAILED" } },
            batch({ extracted: ["N0000003", "N0000004"] }),
            batch({ extracted: ["N0000005"] }),
        );
        const { calls } = await openPage("ADMIN", { [PREVIEW]: { status: 200, body: preview(5) }, [EXTRACT]: answers });
        const user = await startExtraction();
        expect(await screen.findByText(/The Excel files could not be updated, so the extraction stopped at batch 2\. Retrying is safe/, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(extractBodies(calls)).toEqual([["N0000001", "N0000002"], ["N0000003", "N0000004"]]);
        expect(screen.getByText("Extraction stopped before the end.")).toBeInTheDocument();
        expect(leaveWarned()).toBe(false);

        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText("Extraction finished.", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(extractBodies(calls).slice(2)).toEqual([["N0000003", "N0000004"], ["N0000005"]]);
        expect(screen.getByText("Extracted 5 · Skipped 0 · Failed 0")).toBeInTheDocument();
    });

    test("the leave-page warning is removed when the page is left mid-run", { timeout: 20_000 }, async () => {
        const backend = await openPage("ADMIN", { [PREVIEW]: { status: 200, body: preview(2) }, [EXTRACT]: batch({ extracted: ["N0000001", "N0000002"] }) });
        const inner = backend.fetchMock.getMockImplementation()!;
        backend.fetchMock.mockImplementation(async (input, init) => (init?.method === "POST" ? new Promise<Response>(() => {}) : inner(input, init)));
        await startExtraction();
        await screen.findByText("Batch 1 of 1", undefined, RENDER_STEP);
        expect(leaveWarned()).toBe(true);
        backend.view.unmount();
        expect(leaveWarned()).toBe(false);
    });
});

describe("Visa Submission: Files", () => {
    test("browses dates > Plan B > files, folders first, with breadcrumbs and the truncated notice", { timeout: 20_000 }, async () => {
        const { calls } = await openPage();
        const user = userEvent.setup();
        const crumbs = () => within(screen.getByRole("navigation", { name: "Folder path" }));
        expect(crumbs().getByText("VISA SUBMISSION")).toHaveAttribute("aria-current", "page");
        // No ZIP of the whole root.
        expect(screen.queryByRole("button", { name: "Download ZIP" })).toBeNull();

        await user.click(await screen.findByRole("button", { name: "2026-11-24" }, RENDER_STEP));
        await user.click(await screen.findByRole("button", { name: "Plan B" }, RENDER_STEP));
        await screen.findByText("N0000001.pdf", undefined, RENDER_STEP);
        expect(calls.filter((c) => c.url.pathname === `${API}/storage`).map((c) => c.url.search)).toEqual(["", "?path=2026-11-24", "?path=2026-11-24%2FPlan%20B"]);
        const names = screen.getAllByTestId("storage-entry").map((row) => row.querySelector("td")!.textContent);
        expect(names).toEqual(["archive", "N0000001.pdf"]);
        expect(screen.getByText("2 KB")).toBeInTheDocument();
        expect(screen.getByText(/Only the first 2 entries of this folder are shown/)).toBeInTheDocument();
        expect(crumbs().getByText("Plan B")).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("button", { name: "Download ZIP" })).toBeEnabled();

        await user.click(crumbs().getByRole("button", { name: "2026-11-24" }));
        expect(await screen.findByRole("button", { name: "Plan B" }, RENDER_STEP)).toBeInTheDocument();
        await user.click(crumbs().getByRole("button", { name: "VISA SUBMISSION" }));
        expect(await screen.findByRole("button", { name: "2026-11-24" }, RENDER_STEP)).toBeInTheDocument();
    });

    test("a file and a folder ZIP download with auth and the server's file name", { timeout: 20_000 }, async () => {
        const { calls, saved } = await openPage("ADMIN", {
            [`GET ${API}/storage/file`]: { status: 200, body: "pdf", headers: { "Content-Disposition": 'attachment; filename="N0000001.pdf"' } },
            [`GET ${API}/storage/zip`]: { status: 200, body: "zip", headers: { "Content-Disposition": 'attachment; filename="2026-11-24 - Plan B.zip"' } },
        });
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "2026-11-24" }, RENDER_STEP));
        await user.click(await screen.findByRole("button", { name: "Plan B" }, RENDER_STEP));
        await user.click(await screen.findByRole("button", { name: "Download N0000001.pdf" }, RENDER_STEP));
        await waitFor(() => expect(saved).toEqual(["N0000001.pdf"]));
        await user.click(screen.getByRole("button", { name: "Download ZIP" }));
        await waitFor(() => expect(saved).toEqual(["N0000001.pdf", "2026-11-24 - Plan B.zip"]));
        const file = calls.find((c) => c.url.pathname === `${API}/storage/file`)!;
        const zip = calls.find((c) => c.url.pathname === `${API}/storage/zip`)!;
        expect(file.url.search).toBe("?path=2026-11-24%2FPlan%20B%2FN0000001.pdf");
        expect(zip.url.search).toBe("?path=2026-11-24%2FPlan%20B");
        expect([file.headers.Authorization, zip.headers.Authorization]).toEqual([`Bearer ${SESSION_TOKEN}`, `Bearer ${SESSION_TOKEN}`]);
    });

    test("ZIP_TOO_LARGE: download the files individually", { timeout: 20_000 }, async () => {
        const { saved } = await openPage("ADMIN", { [`GET ${API}/storage/zip`]: { status: 413, body: { message: "Too large", code: "ZIP_TOO_LARGE" } } });
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "2026-11-24" }, RENDER_STEP));
        await user.click(await screen.findByRole("button", { name: "Download ZIP" }, RENDER_STEP));
        expect(await screen.findByText(ZIP_TOO_LARGE_MESSAGE, undefined, RENDER_STEP)).toBeInTheDocument();
        expect(saved).toEqual([]);
    });

    test("FOLDER_NOT_FOUND: a clear message and the way back to the root", { timeout: 20_000 }, async () => {
        await openPage("ADMIN", { [STORAGE]: storage({ "": ROOT }) });
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "2026-11-24" }, RENDER_STEP));
        expect(await screen.findByText("This folder no longer exists.", undefined, RENDER_STEP)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Back to VISA SUBMISSION" }));
        expect(await screen.findByRole("button", { name: "2026-11-24" }, RENDER_STEP)).toBeInTheDocument();
    });

    test("STORAGE_UNAVAILABLE: a clear message with Try again", { timeout: 20_000 }, async () => {
        await openPage("ADMIN", { [STORAGE]: { status: 502, body: { message: "Storage unavailable", code: "STORAGE_UNAVAILABLE" } } });
        expect(await screen.findByText("File storage is unavailable right now. Try again in a moment.", undefined, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    test("an empty root: an empty state", { timeout: 20_000 }, async () => {
        await openPage("ADMIN", { [STORAGE]: { status: 200, body: { root: "VISA SUBMISSION", path: "", entries: [], truncated: false } } });
        expect(await screen.findByText("No visa submissions yet", undefined, RENDER_STEP)).toBeInTheDocument();
    });
});

test("the audit log names the Phase 2 actions", () => {
    expect(actionLabel("VISA_SUBMISSION_EXTRACTION")).toBe("Visa submission extracted");
    expect(actionLabel("VISA_SUBMISSION_FILE_DOWNLOAD")).toBe("Visa submission file downloaded");
    expect(actionLabel("VISA_SUBMISSION_ZIP_DOWNLOAD")).toBe("Visa submission ZIP downloaded");
});
