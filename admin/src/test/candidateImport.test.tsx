import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ImportPreview } from "../api/candidateImport";
import { UPDATE_SHEET_HINT } from "../pages/SettingsPage";
import { RENDER_STEP, renderApp, signedInBackend, userWithRole, type FetchRoutes, expectRedirectedHome } from "./helpers";

// Settings -> Google Sheet Sync -> Upload. SYNTHETIC rows only; the backend is stubbed.
// The binary .xlsx read (read-excel-file) is replaced in the dialog flow; the column extraction
// and file checks it feeds are tested for real below.

const readWorkbookMock = vi.hoisted(() => vi.fn());
vi.mock("../components/importWorkbook", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../components/importWorkbook")>()),
    readWorkbook: readWorkbookMock,
}));
const { checkWorkbookFile, extractRows, guardWorkbookRead, WorkbookError } = await import("../components/importWorkbook");
// The validation sheet is built from the chosen file in the browser (tested in validationWorkbook.test.ts).
const downloadValidationMock = vi.hoisted(() => vi.fn());
vi.mock("../components/validationWorkbook", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../components/validationWorkbook")>()),
    downloadValidationWorkbook: downloadValidationMock,
}));

const STATUS = {
    worker: { online: true, lastHeartbeatAt: "2026-10-28T09:00:00.000Z" }, configured: true, writeGate: "ENABLED", target: "…id / Mirror",
    integration: { state: "OK", lastErrorClass: null, lastErrorCode: null, lastErrorAt: null }, queue: { pending: 0, processing: 0, failed: 0 },
    lastSuccessfulSyncAt: null, lastReconciliation: null, lastSuccessfulReconciliationAt: null, lastConnectionTest: null,
    activeRuns: { reconcile: null, testConnection: null },
    destination: { available: [{ key: "default", name: "Main Mirror", hint: "…id", tabName: "Mirror" }, { key: "test", name: "Test Mirror", hint: "…t", tabName: "Mirror" }], activeKey: "default", requestedKey: null, lastSwitch: null },
};
const BASE = "/api/admin/settings/sheet-sync";
const ALLOWED = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "NIC NUMBER", "WHATSAPP NUMBER", "BIRTH DATE", "JOB ROLE"];
const REQUIRED = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME"];

const asRole = (role: string, routes: FetchRoutes = {}) =>
    signedInBackend({ "GET /auth/me": { status: 200, body: { user: userWithRole(role) } }, [`GET ${BASE}/status`]: { status: 200, body: STATUS }, ...routes });

beforeEach(() => {
    readWorkbookMock.mockReset();
    downloadValidationMock.mockReset();
});

describe("Upload button and roles", () => {
    test("1. ADMIN sees Upload (with its hint) next to Test Connection and Sync Now", async () => {
        asRole("ADMIN");
        renderApp("/settings/sheet-sync");
        const button = await screen.findByRole("button", { name: "Upload" }, RENDER_STEP);
        expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sync Now" })).toBeInTheDocument();
        expect(button).toHaveAccessibleDescription(UPDATE_SHEET_HINT);
        expect(UPDATE_SHEET_HINT).toBe("Upload an existing candidate sheet to validate and import candidate records into Emlynk, then sync them to the Candidate Operational Mirror.");
        await userEvent.setup().hover(button);
        expect(screen.getByRole("tooltip")).toHaveTextContent(UPDATE_SHEET_HINT);
        expect(screen.getByRole("tooltip")).toBeVisible();
    });

    test("2/3. OWNER (an ADMIN permission) opens Google Sheet Sync and gets Upload, Test Connection and Sync Now", async () => {
        asRole("OWNER");
        renderApp("/settings/sheet-sync");
        expect(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sync Now" })).toBeInTheDocument();
    });

    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`4/5. ${role}: no Upload, no Settings data`, async () => {
            const { calls } = asRole(role);
            renderApp("/settings/sheet-sync");
            await expectRedirectedHome(role);
            expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
            expect(calls.some((c) => c.path.startsWith(BASE))).toBe(false);
        });
    }
});

describe("the workbook file (read in the browser)", () => {
    const xlsx = (name: string, bytes: number[] = [0x50, 0x4b, 0x03, 0x04, 0, 0], type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") => new File([new Uint8Array(bytes)], name, { type });

    test("6. unsupported files are refused before anything is read or sent", async () => {
        await expect(checkWorkbookFile(xlsx("legacy.xlsx"))).resolves.toBeUndefined();
        for (const file of [xlsx("legacy.csv", [0x61], "text/csv"), xlsx("legacy.xlsm"), xlsx("legacy.xls", [0xd0, 0xcf]), xlsx("legacy.xlsx", [0x61, 0x62, 0x63, 0x64]), xlsx("legacy.xlsx", [], ""), xlsx("legacy.xlsx", undefined, "application/pdf")]) {
            await expect(checkWorkbookFile(file), file.name).rejects.toBeInstanceOf(WorkbookError);
        }
    });

    test("7/8. only the allow-listed columns are extracted; missing required headings are named; empty rows skipped; Excel row numbers kept", () => {
        const data = [
            ["Passport Number", "SURNAME", "LOAN APPLY AMOUNT", "Birth Date", "ACTIVE STATUS", "other name"],
            ["N9000001", "SYNTHSURNAME", "999", new Date(Date.UTC(1990, 2, 5)), "INACTIVE", "SYNTH GIVEN"],
            [null, null, "5", null, null, null],
            ["N9000002", "SYNTHSURNAMETWO", "", "05.03.1991", "", "SYNTH TWO"],
        ];
        const { headers, rows, missingRequired } = extractRows(data, { allowed: ALLOWED, required: REQUIRED });
        expect(missingRequired).toEqual([]);
        expect(headers).toContain("LOAN APPLY AMOUNT");
        expect(rows).toEqual([
            { rowNumber: 2, values: { "PASSPORT NUMBER": "N9000001", SURNAME: "SYNTHSURNAME", "BIRTH DATE": "1990-03-05", "OTHER NAME": "SYNTH GIVEN" } },
            { rowNumber: 4, values: { "PASSPORT NUMBER": "N9000002", SURNAME: "SYNTHSURNAMETWO", "BIRTH DATE": "05.03.1991", "OTHER NAME": "SYNTH TWO" } },
        ]);
        expect(JSON.stringify(rows)).not.toMatch(/999|INACTIVE/);
        expect(extractRows([["PASSPORT NUMBER", "OTHER NAME"], ["N9000001", "X"]], { allowed: ALLOWED, required: REQUIRED }).missingRequired).toEqual(["SURNAME"]);
        expect(() => extractRows([["PASSPORT NUMBER"], ["a"], ["b"], ["c"]], { allowed: ALLOWED, required: REQUIRED, maxRows: 2 })).toThrow(WorkbookError);
    });
});

// The reader's Web Worker is blocked by a page policy without worker-src blob: (the 2026-11 production
// hang): it must fail with a readable message, never wait for ever.
describe("the workbook reader guard (stalled or blocked reader)", () => {
    test("a result passes through; the reader's own error passes through", async () => {
        await expect(guardWorkbookRead(async () => 42, { target: null })).resolves.toBe(42);
        await expect(guardWorkbookRead(async () => { throw new Error("boom"); }, { target: null })).rejects.toThrow("boom");
    });

    test("a reader that never answers is stopped with a readable message after the timeout", async () => {
        vi.useFakeTimers();
        try {
            const result = guardWorkbookRead(() => new Promise(() => {}), { timeoutMs: 1000, target: null });
            const assertion = expect(result).rejects.toThrow(/took too long.*Nothing was uploaded/);
            await vi.advanceTimersByTimeAsync(1000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    test("a securitypolicyviolation for the blob worker fails at once, naming the page policy", async () => {
        const target = new EventTarget();
        const result = guardWorkbookRead(() => new Promise(() => {}), { timeoutMs: 60_000, target });
        const violation = Object.assign(new Event("securitypolicyviolation"), { blockedURI: "blob", effectiveDirective: "worker-src" });
        target.dispatchEvent(violation);
        await expect(result).rejects.toThrow(/security policy/);
    });

    test("a violation of an unrelated directive is ignored; a late result after a timeout is ignored", async () => {
        const target = new EventTarget();
        const result = guardWorkbookRead(async () => "ok", { target });
        target.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI: "https://x.test/img.png", effectiveDirective: "img-src" }));
        await expect(result).resolves.toBe("ok");
        vi.useFakeTimers();
        try {
            let finish: (value: string) => void = () => {};
            const late = guardWorkbookRead(() => new Promise<string>((resolve) => { finish = resolve; }), { timeoutMs: 10, target: null });
            const assertion = expect(late).rejects.toBeInstanceOf(WorkbookError);
            await vi.advanceTimersByTimeAsync(10);
            await assertion;
            finish("too late");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the dialog while a sheet is being read", () => {
    test("Cancel and Esc work while reading; the abandoned read cannot reopen or change anything", async () => {
        let finishRead: (value: unknown) => void = () => {};
        readWorkbookMock.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
        const { calls } = asRole("ADMIN", { [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } } });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        expect(await within(dialog).findByText("Reading and checking the sheet…")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        finishRead({ headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME"], rows: [{ rowNumber: 2, values: { "PASSPORT NUMBER": "N1", SURNAME: "S", "OTHER NAME": "O" } }], missingRequired: [] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls.filter((c) => c.path.endsWith("/import/preview"))).toEqual([]);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("a read error is shown in the dialog (not an endless wait) and another file can be chosen", async () => {
        readWorkbookMock.mockRejectedValue(new WorkbookError("This browser blocked the spreadsheet reader (a page security policy). Nothing was uploaded."));
        asRole("ADMIN", { [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } } });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        expect(await within(dialog).findByText(/blocked the spreadsheet reader/)).toBeInTheDocument();
        expect(within(dialog).getByLabelText("Candidate sheet (.xlsx)")).toBeEnabled();
        expect(within(dialog).queryByText("Reading and checking the sheet…")).toBeNull();
    });
});

describe("the import flow", () => {
    const ROWS = [
        { rowNumber: 2, values: { "PASSPORT NUMBER": "N9000001", SURNAME: "SYNTHSURNAME", "OTHER NAME": "SYNTH GIVEN" } },
        { rowNumber: 3, values: { "PASSPORT NUMBER": "N90000012", SURNAME: "SYNTHSURNAMETWO", "OTHER NAME": "SYNTH TWO" } },
        { rowNumber: 4, values: { "PASSPORT NUMBER": "N9000003", SURNAME: "SYNTHSURNAMETHREE", "OTHER NAME": "" } },
    ];
    const PREVIEW: ImportPreview = {
        importId: "00000000-0000-4000-8000-0000000000aa", chunkSize: 2, chunkCount: 2, expiresAt: "2026-10-29T00:00:00.000Z",
        summary: { totalRows: 3, new: 2, existing: 0, willFill: 0, noChange: 0, valid: 1, warnings: 1, invalid: 1, duplicates: 0, conflicts: 0, skippedVerified: 0, unknownJobRoles: 0, legacyPassportFormat: 1, whatsappConflicts: 0, fieldsDiffering: 0, ignoredSourceColumns: 90 },
        columns: { missingRequired: [], supported: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME"], ignored: [], systemGenerated: [], unresolved: ["FATHER NAME"], unknown: [] },
        problems: [
            { rowNumber: 3, passport: "N9*****12", status: "WARNING", action: "CREATE", codes: ["LEGACY_PASSPORT_FORMAT"] },
            { rowNumber: 4, passport: "N9****03", status: "INVALID", action: "NONE", codes: ["MISSING_OTHER_NAMES"] },
        ],
        problemsTruncated: false,
    };

    test("upload -> preview (nothing saved) -> explicit confirm -> chunks one at a time -> result and sync requested", async () => {
        readWorkbookMock.mockResolvedValue({ headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "LOAN APPLY AMOUNT"], rows: ROWS, missingRequired: [] });
        const chunk = (created: number, invalid = 0) => ({ status: 200, body: { chunkIndex: 0, status: "COMMITTED", counts: { rows: created + invalid, created, invalid, warnings: created === 1 ? 1 : 0 }, failures: [] } });
        const { calls } = asRole("ADMIN", {
            [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } },
            [`POST ${BASE}/import/preview`]: { status: 200, body: PREVIEW },
            [`POST ${BASE}/import/${PREVIEW.importId}/chunks/0`]: chunk(2),
            [`POST ${BASE}/import/${PREVIEW.importId}/chunks/1`]: chunk(0, 1),
            [`POST ${BASE}/import/${PREVIEW.importId}/finish`]: { status: 200, body: { importId: PREVIEW.importId, status: "COMPLETED", totalRows: 3, counts: { created: 2, invalid: 1, warnings: 1 }, syncRunId: "run-1", sync: { requested: true, runId: "run-1", alreadyActive: false } } },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

        // Preview: counts and masked problem rows; nothing committed yet.
        const preview = await within(dialog).findByRole("group", { name: "Import preview" }).catch(() => within(dialog).getByLabelText("Import preview"));
        expect(within(preview).getByText("New candidates").nextSibling).toHaveTextContent("2");
        expect(within(dialog).getByText("N9*****12")).toBeInTheDocument();
        expect(within(dialog).getByText("Missing other names")).toBeInTheDocument();
        expect(within(dialog).queryByText("N90000012")).toBeNull();
        expect(within(dialog).getByText(/FATHER NAME/)).toBeInTheDocument();
        expect(calls.filter((c) => c.path.includes("/chunks/") || c.path.endsWith("/finish"))).toEqual([]);
        expect(calls.find((c) => c.path.endsWith("/import/preview"))!.body).toEqual({ fileName: "legacy.xlsx", headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "LOAN APPLY AMOUNT"], rows: ROWS });

        await user.click(within(dialog).getByRole("button", { name: "Confirm import (2 candidates)" }));
        expect(await within(dialog).findByText("Import completed.")).toBeInTheDocument();
        const chunkCalls = calls.filter((c) => c.path.includes("/chunks/"));
        expect(chunkCalls.map((c) => [c.path.split("/").pop(), (c.body as { rows: unknown[] }).rows.length])).toEqual([["0", 2], ["1", 1]]);
        expect(calls.filter((c) => c.path.endsWith("/finish"))).toHaveLength(1);
        const result = within(dialog).getByLabelText("Import result");
        expect(within(result).getByText("Created").nextSibling).toHaveTextContent("2");
        expect(within(dialog).getByText(/Google Sheet sync was requested/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    test("Jobs from this upload: grouped by Interview date + Unique number; a NEW Job's last two digits are edited, saved and checked before the import", async () => {
        readWorkbookMock.mockResolvedValue({ headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "UNIQUE NUMBER"], rows: ROWS, missingRequired: [] });
        const group = (from: number, suffix: string | null, state: "NEW" | "EXISTING" | "ERROR", extra = {}) => ({
            key: `2026-07-11|${from / 100}`, interviewDate: "2026-07-11", from, to: from + 99, prefix: "JOB-2026-0711", suffix, jobCode: suffix ? `JOB-2026-0711${suffix}` : null,
            state, codes: [], messages: [], candidates: 2, passed: 2, clientName: "Synth Builders", agentName: "Synth Agency", existingJobCode: state === "EXISTING" ? `JOB-2026-0711${suffix}` : null, edited: false, ...extra,
        });
        const groups = [group(3100, "01", "EXISTING"), group(3200, "02", "NEW"), group(3300, null, "ERROR", { messages: ["Candidates of this group name different companies: no Job"] })];
        const { calls } = asRole("ADMIN", {
            [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } },
            [`POST ${BASE}/import/preview`]: { status: 200, body: { ...PREVIEW, summary: { ...PREVIEW.summary, jobsToCreate: 1, jobsReused: 1, jobMembers: 4 }, jobGroups: groups } },
            [`PUT ${BASE}/import/${PREVIEW.importId}/job-groups`]: { status: 200, body: { jobGroups: [groups[0], { ...groups[1], suffix: "05", jobCode: "JOB-2026-071105", edited: true }, groups[2]] } },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx"));

        const table = await within(dialog).findByRole("table", { name: "Jobs from this upload" });
        const rows = within(table).getAllByTestId("job-group");
        expect(rows.map((r) => r.textContent)).toEqual([
            expect.stringContaining("3100–3199JOB-2026-071101"), expect.stringContaining("3200–3299"), expect.stringContaining("Candidates of this group name different companies"),
        ]);
        expect(within(rows[0]).queryByRole("textbox"), "an existing Job keeps its ID").toBeNull();
        const digits = within(rows[1]).getByRole("textbox", { name: /Last two digits of the Job for 3200–3299/ });
        expect(within(rows[1]).getByText("JOB-2026-071102")).toBeInTheDocument();

        await user.clear(digits);
        await user.type(digits, "0x5");
        expect(digits).toHaveValue("05");
        expect(within(rows[1]).getByText("JOB-2026-071105")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: /^Confirm import/ }), "the edit must be saved first").toBeDisabled();
        await user.click(within(dialog).getByRole("button", { name: "Save Job IDs" }));
        await waitFor(() => expect(calls.find((c) => c.path.endsWith("/job-groups"))?.body).toEqual({ suffixes: { "2026-07-11|32": "05" } }));
        expect(await within(dialog).findByText(/\(changed\)/)).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Confirm import (2 candidates, 4 Job assignments)" })).toBeEnabled();
    });

    test("preview with issues: readable reasons, the automatic actions, and a validation sheet built from the chosen file (no server download)", async () => {
        readWorkbookMock.mockResolvedValue({ headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "OFFICER"], rows: ROWS, missingRequired: [] });
        const rowIssues = [
            { rowNumber: 3, errors: [], warnings: ["Passport number is in the old format (8 digits)"] },
            { rowNumber: 4, errors: ["Other name is missing", "Officer does not match a system user"], warnings: ["NIC number is missing"] },
        ];
        const preview: ImportPreview = {
            ...PREVIEW,
            problems: [
                { ...PREVIEW.problems[0], errors: [], warnings: rowIssues[0].warnings },
                { ...PREVIEW.problems[1], errors: rowIssues[1].errors, warnings: rowIssues[1].warnings },
            ],
            rowIssues,
            actions: {
                officers: [{ sheetName: "John", userName: "John Silva", rows: 2 }], officerAssignments: [{ userName: "John Silva", rows: 2 }],
                clients: [{ name: "ABC Construction Ltd", action: "CREATE", rows: 2 }], agents: [{ name: "XYZ Agency", action: "REUSE", rows: 2 }],
                visa: { VISA_SUBMITTED: 1, DEPARTED: 0 }, tests: 2, testsBlankResultAsPass: 1,
            },
        };
        const { calls } = asRole("ADMIN", {
            [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: [...ALLOWED, "OFFICER"], required: REQUIRED } },
            [`POST ${BASE}/import/preview`]: { status: 200, body: preview },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        const file = new File(["x"], "legacy.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), file);

        expect(await within(dialog).findByText("Other name is missing; Officer does not match a system user; NIC number is missing")).toBeInTheDocument();
        const actions = within(dialog).getByRole("list", { name: "Automatic actions" });
        expect(within(actions).getByText('Officer "John" → John Silva (2 rows)')).toBeInTheDocument();
        expect(within(actions).getByText("2 candidates will be assigned to John Silva")).toBeInTheDocument();
        expect(within(actions).getByText('Company "ABC Construction Ltd" → new Client will be created')).toBeInTheDocument();
        expect(within(actions).getByText('Agent "XYZ Agency" → existing Agent matched')).toBeInTheDocument();
        expect(within(actions).getByText('VISA STATUS "Submit" → Visa Submitted (1 candidate)')).toBeInTheDocument();
        expect(within(actions).getByText("Interview result blank → PASS (1 candidate)")).toBeInTheDocument();

        const requestsBefore = calls.length;
        await user.click(within(dialog).getByRole("button", { name: "Download validation sheet" }));
        expect(downloadValidationMock).toHaveBeenCalledTimes(1);
        expect(downloadValidationMock.mock.calls[0][0]).toBe(file);
        expect(downloadValidationMock.mock.calls[0][1]).toEqual(rowIssues);
        expect(calls.length).toBe(requestsBefore);
    });

    test("no errors or warnings: no validation sheet is offered", async () => {
        readWorkbookMock.mockResolvedValue({ headers: ["PASSPORT NUMBER", "SURNAME", "OTHER NAME"], rows: ROWS.slice(0, 1), missingRequired: [] });
        asRole("ADMIN", {
            [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } },
            [`POST ${BASE}/import/preview`]: { status: 200, body: { ...PREVIEW, problems: [], rowIssues: [] } },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx"));
        expect(await within(dialog).findByLabelText("Import preview")).toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: "Download validation sheet" })).toBeNull();
    });

    test("6/7. a sheet without a required heading is refused in the browser: the problem is shown and nothing is sent", async () => {
        readWorkbookMock.mockResolvedValue({ headers: ["PASSPORT NUMBER", "OTHER NAME"], rows: [{ rowNumber: 2, values: { "PASSPORT NUMBER": "N9000001", "OTHER NAME": "SYNTH" } }], missingRequired: ["SURNAME"] });
        const { calls } = asRole("ADMIN", { [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } } });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx"));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("The sheet is missing required headings: SURNAME.");
        expect(calls.some((c) => c.path.endsWith("/import/preview"))).toBe(false);
    });
});

// Duplicate-upload protection as the person sees it (the server's own protection is tested in
// test/candidateImportConcurrency.test.js).
describe("duplicate upload protection", () => {
    const IMPORT_ID = "6f1e0c3a-8b7d-4c2e-9a41-5d3b2f9e7a10";
    const rowsOf = (count: number) => Array.from({ length: count }, (_, k) => ({ rowNumber: k + 2, values: { "PASSPORT NUMBER": `N9${String(k).padStart(6, "0")}`, SURNAME: "S", "OTHER NAME": "O" } }));
    const ACTIVE = { importId: IMPORT_ID, status: "COMMITTING", fileName: "legacy.xlsx", totalRows: 250, chunkSize: 100, chunkCount: 3, committedChunks: [0], ownedByYou: true, stale: false, updatedAt: "2026-11-09T04:00:00.000Z" };
    const SOURCE = { [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } } };
    const SUMMARY = { new: 1, existing: 0, willFill: 0, noChange: 0, valid: 1, warnings: 0, invalid: 0, duplicates: 0, conflicts: 0, skippedVerified: 0, unknownJobRoles: 0, legacyPassportFormat: 0, whatsappConflicts: 0, fieldsDiffering: 0, ignoredSourceColumns: 0 };
    const PREVIEW_OK = (rows: number) => ({
        status: 200,
        body: {
            importId: IMPORT_ID, chunkSize: 100, chunkCount: 1, expiresAt: "2026-11-10T00:00:00.000Z", summary: { ...SUMMARY, totalRows: rows, new: rows, valid: rows },
            columns: { missingRequired: [], supported: [], ignored: [], systemGenerated: [], unresolved: [], unknown: [] }, problems: [], problemsTruncated: false,
        },
    });
    const openDialog = async () => {
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        return { user, dialog: await screen.findByRole("dialog", { name: /^Upload: import candidates/ }) };
    };
    const xlsx = () => new File(["x"], "legacy.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const headers = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME"];

    test("each file choice sends one Idempotency-Key with the preview request", async () => {
        readWorkbookMock.mockResolvedValue({ headers, rows: rowsOf(1), missingRequired: [] });
        const { calls } = asRole("ADMIN", { ...SOURCE, [`POST ${BASE}/import/preview`]: PREVIEW_OK(1) });
        const { user, dialog } = await openDialog();
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), xlsx());
        await within(dialog).findByLabelText("Import preview");
        const previews = calls.filter((c) => c.path.endsWith("/import/preview"));
        expect(previews).toHaveLength(1);
        expect(previews[0].headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    });

    test("while a sheet is being checked the file chooser is disabled: a second choice cannot send a second request", async () => {
        readWorkbookMock.mockImplementation(() => new Promise(() => {}));
        asRole("ADMIN", SOURCE);
        const { user, dialog } = await openDialog();
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), xlsx());
        await within(dialog).findByText("Reading and checking the sheet…");
        expect(within(dialog).getByLabelText("Candidate sheet (.xlsx)")).toBeDisabled();
    });

    test("your own import in progress is explained; Abort that import stops it and clears the notice", async () => {
        const { calls } = asRole("ADMIN", {
            ...SOURCE,
            [`GET ${BASE}/import/active`]: { status: 200, body: { active: ACTIVE } },
            [`POST ${BASE}/import/${IMPORT_ID}/abort`]: { status: 200, body: { importId: IMPORT_ID, status: "ABORTED", totalRows: 250, counts: { created: 100 }, syncRunId: null } },
        });
        const { user, dialog } = await openDialog();
        const notice = await within(dialog).findByRole("alert", { name: "Import in progress" });
        expect(notice).toHaveTextContent("You have an import in progress: legacy.xlsx, 1 of 3 parts saved.");
        expect(within(dialog).getByLabelText("Candidate sheet (.xlsx)")).toBeEnabled();
        await user.click(within(notice).getByRole("button", { name: "Abort that import" }));
        await waitFor(() => expect(within(dialog).queryByRole("alert", { name: "Import in progress" })).toBeNull());
        expect(calls.filter((c) => c.path.endsWith("/abort"))).toHaveLength(1);
    });

    test("another administrator's import never blocks yours: with none of your own, no notice and the file chooser is enabled", async () => {
        asRole("ADMIN", { ...SOURCE, [`GET ${BASE}/import/active`]: { status: 200, body: { active: null } } });
        const { dialog } = await openDialog();
        expect(within(dialog).getByLabelText("Candidate sheet (.xlsx)")).toBeEnabled();
        expect(within(dialog).queryByRole("alert", { name: "Import in progress" })).toBeNull();
    });

    test("your own stopped import says it has stopped and can be aborted", async () => {
        asRole("ADMIN", { ...SOURCE, [`GET ${BASE}/import/active`]: { status: 200, body: { active: { ...ACTIVE, stale: true } } } });
        const { dialog } = await openDialog();
        const notice = await within(dialog).findByRole("alert", { name: "Import in progress" });
        expect(notice).toHaveTextContent("and it has stopped");
        expect(within(notice).getByRole("button", { name: "Abort that import" })).toBeEnabled();
    });

    test("choosing the file of your unfinished import offers to continue it: only the remaining parts are sent, then finish", async () => {
        readWorkbookMock.mockResolvedValue({ headers, rows: rowsOf(250), missingRequired: [] });
        const chunk = (n: number, rows: number) => ({ status: 200, body: { chunkIndex: n, status: "COMMITTED", counts: { rows, created: rows }, failures: [] } });
        const { calls } = asRole("ADMIN", {
            ...SOURCE,
            [`POST ${BASE}/import/preview`]: { status: 409, body: { message: "This file is already being imported. Resume that import or abort it first.", code: "IMPORT_ALREADY_ACTIVE", details: { importId: IMPORT_ID, status: "COMMITTING", chunkSize: 100, chunkCount: 3, committedChunks: [0], stale: false } } },
            [`POST ${BASE}/import/${IMPORT_ID}/chunks/1`]: chunk(1, 100),
            [`POST ${BASE}/import/${IMPORT_ID}/chunks/2`]: chunk(2, 50),
            [`POST ${BASE}/import/${IMPORT_ID}/finish`]: { status: 200, body: { importId: IMPORT_ID, status: "COMPLETED", totalRows: 250, counts: { created: 250 }, syncRunId: "run-1", sync: { requested: true, runId: "run-1", alreadyActive: false } } },
        });
        const { user, dialog } = await openDialog();
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), xlsx());
        expect(await within(dialog).findByText(/This file is already being imported: 1 of 3 parts are saved/)).toBeInTheDocument();
        expect(calls.filter((c) => c.path.includes("/chunks/"))).toEqual([]);
        await user.click(within(dialog).getByRole("button", { name: "Continue import" }));
        expect(await within(dialog).findByText("Import completed.")).toBeInTheDocument();
        const sent = calls.filter((c) => c.path.includes("/chunks/"));
        expect(sent.map((c) => [c.path.split("/").pop(), (c.body as { rows: unknown[] }).rows.length])).toEqual([["1", 100], ["2", 50]]);
        expect(calls.filter((c) => c.path.endsWith("/finish"))).toHaveLength(1);
    });

    test("another import started first: the confirm is refused with the reason, nothing is finished, and the preview stays", async () => {
        readWorkbookMock.mockResolvedValue({ headers, rows: rowsOf(2), missingRequired: [] });
        const { calls } = asRole("ADMIN", {
            ...SOURCE,
            [`POST ${BASE}/import/preview`]: PREVIEW_OK(2),
            [`POST ${BASE}/import/${IMPORT_ID}/chunks/0`]: { status: 409, body: { message: "You have another import in progress. Resume it or abort it first.", code: "IMPORT_IN_PROGRESS", details: {} } },
        });
        const { user, dialog } = await openDialog();
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), xlsx());
        await within(dialog).findByLabelText("Import preview");
        await user.click(within(dialog).getByRole("button", { name: /^Confirm import/ }));
        expect(await within(dialog).findByText(/You have another import in progress/)).toBeInTheDocument();
        expect(within(dialog).getByLabelText("Import preview")).toBeInTheDocument();
        expect(calls.filter((c) => c.path.endsWith("/finish"))).toEqual([]);
    });

    test("an import that stops part way is NOT finished from the dialog (all or nothing): it stays open to continue, or is undone automatically", async () => {
        readWorkbookMock.mockResolvedValue({ headers, rows: rowsOf(250), missingRequired: [] });
        const { calls } = asRole("ADMIN", {
            ...SOURCE,
            [`POST ${BASE}/import/preview`]: { status: 200, body: { ...PREVIEW_OK(250).body, chunkSize: 100, chunkCount: 3 } },
            [`POST ${BASE}/import/${IMPORT_ID}/chunks/0`]: { status: 200, body: { chunkIndex: 0, status: "COMMITTED", counts: { rows: 100, created: 100 }, failures: [] } },
            [`POST ${BASE}/import/${IMPORT_ID}/chunks/1`]: { status: 503, body: { message: "Service unavailable" } },
        });
        const { user, dialog } = await openDialog();
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), xlsx());
        await within(dialog).findByLabelText("Import preview");
        await user.click(within(dialog).getByRole("button", { name: /^Confirm import/ }));
        expect(await within(dialog).findByText(/otherwise everything it imported is undone automatically/)).toBeInTheDocument();
        expect(calls.filter((c) => c.path.endsWith("/finish"))).toEqual([]);
        expect(within(dialog).getByLabelText("Candidate sheet (.xlsx)")).toBeEnabled();
    });

    test("an import the server is already undoing: the reason is shown, nothing is finished, and the notice says it is being undone", async () => {
        readWorkbookMock.mockResolvedValue({ headers, rows: rowsOf(2), missingRequired: [] });
        const { calls } = asRole("ADMIN", {
            ...SOURCE,
            [`POST ${BASE}/import/preview`]: PREVIEW_OK(2),
            [`POST ${BASE}/import/${IMPORT_ID}/chunks/0`]: { status: 409, body: { message: "This import stopped before it finished, so it is being undone automatically. Nothing from it is kept. Upload the sheet again to import it.", code: "IMPORT_RECOVERY_STARTED" } },
        });
        const { user, dialog } = await openDialog();
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), xlsx());
        await within(dialog).findByLabelText("Import preview");
        await user.click(within(dialog).getByRole("button", { name: /^Confirm import/ }));
        expect(await within(dialog).findByText(/it is being undone automatically/)).toBeInTheDocument();
        expect(calls.filter((c) => c.path.endsWith("/finish"))).toEqual([]);
    });

    test("an import under automatic recovery is announced as being undone (not as a rollback to continue)", async () => {
        asRole("ADMIN", { ...SOURCE, [`GET ${BASE}/import/active`]: { status: 200, body: { active: { ...ACTIVE, status: "ROLLING_BACK", recovery: "ROLLING_BACK" } } } });
        const { dialog } = await openDialog();
        const notice = await within(dialog).findByRole("alert", { name: "Rollback in progress" });
        expect(notice).toHaveTextContent("stopped before it finished, so it is being undone automatically");
        expect(within(notice).getByRole("button", { name: "View progress" })).toBeEnabled();
    });
});

// Rolling back an import: review, explicit confirmation, run, report. Counts, record kinds, sheet rows and codes only.
describe("rollback of an import", () => {
    const IMPORT_ID = "6f1e0c3a-8b7d-4c2e-9a41-5d3b2f9e7a10";
    const ACTIVE = { importId: IMPORT_ID, status: "COMMITTING", fileName: "legacy.xlsx", totalRows: 250, chunkSize: 100, chunkCount: 3, committedChunks: [0], ownedByYou: true, stale: false, updatedAt: "2026-11-09T04:00:00.000Z" };
    const SOURCE = { [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } } };
    const ROLLBACK = `${BASE}/import/${IMPORT_ID}/rollback`;
    const PREVIEW = {
        importId: IMPORT_ID, status: "ABORTED", canStart: true, blockedReason: null, keyAvailable: true,
        summary: { total: 14, eligible: 12, conflicts: 2, missing: 0, alreadyReverted: 0 },
        willDelete: { candidates: 4, jobs: 1, clients: 1, agents: 1 },
        byType: {}, reasons: { FIELD_CHANGED: 1, PARENT_NOT_REVERTED: 1 },
        conflicts: [
            { entityType: "CANDIDATE", op: "CREATE", rowNumber: 7, reasons: ["FIELD_CHANGED:address"] },
            { entityType: "CANDIDATE_STAGE", op: "CREATE", rowNumber: 7, reasons: ["PARENT_NOT_REVERTED"] },
        ],
        missing: [],
    };
    const report = (over: Record<string, unknown> = {}) => ({
        importId: IMPORT_ID, status: "ROLLED_BACK_WITH_CONFLICTS", previousStatus: "ABORTED", done: true, startedAt: "2026-11-09T05:00:00.000Z", completedAt: "2026-11-09T05:01:00.000Z",
        counts: { total: 14, reverted: 12, conflicts: 2, skipped: 0, remaining: 0 }, byType: {}, reasons: { FIELD_CHANGED: 1, PARENT_NOT_REVERTED: 1 }, conflicts: PREVIEW.conflicts,
        sync: { requested: true, runId: "run-1", alreadyActive: false }, lastError: null, ...over,
    });
    // Your own import in progress -> Abort -> Review rollback…
    async function openReview(routes: FetchRoutes = {}) {
        const backend = asRole("ADMIN", {
            ...SOURCE,
            [`GET ${BASE}/import/active`]: { status: 200, body: { active: ACTIVE } },
            [`POST ${BASE}/import/${IMPORT_ID}/abort`]: { status: 200, body: { importId: IMPORT_ID, status: "ABORTED", totalRows: 250, counts: { created: 100 }, syncRunId: null } },
            [`GET ${ROLLBACK}/preview`]: { status: 200, body: PREVIEW },
            ...routes,
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        await user.click(await within(dialog).findByRole("button", { name: "Abort that import" }));
        await user.click(await within(dialog).findByRole("button", { name: "Review rollback…" }));
        return { ...backend, user, dialog: await screen.findByRole("dialog", { name: "Roll back an import" }) };
    }

    test("the review shows what would be reversed and what stays and why, changes nothing, and asks for confirmation", async () => {
        const { calls, dialog } = await openReview();
        const preview = await within(dialog).findByRole("group", { name: "Rollback preview" }).catch(() => within(dialog).getByLabelText("Rollback preview"));
        expect(within(preview).getByText("Will be reversed").nextSibling).toHaveTextContent("12");
        expect(within(preview).getByText("Cannot be reversed").nextSibling).toHaveTextContent("2");
        expect(within(dialog).getByText(/delete 4 candidates, 1 Job, 1 Client and 1 Agent/)).toBeInTheDocument();
        const reasons = within(dialog).getByLabelText("Why changes are kept");
        expect(within(reasons).getByText(/A value the import wrote was changed afterwards\. \(1 change\)/)).toBeInTheDocument();
        const table = within(dialog).getByLabelText("Changes that stay");
        expect(within(table).getByText("Candidate")).toBeInTheDocument();
        expect(within(table).getAllByText("7", { selector: "td" })).toHaveLength(2);
        expect(within(table).getByText("Stage")).toBeInTheDocument();
        // Nothing but the review request has been sent, and the button waits for the checkbox.
        expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/rollback"))).toEqual([]);
        expect(within(dialog).getByRole("button", { name: "Roll back 12 changes" })).toBeDisabled();
        expect(dialog.textContent).not.toMatch(/N9\d{6}|SYNTH/);
    });

    test("confirm -> the server is called until it reports done (progress), with the number that was confirmed; then the report", async () => {
        const answers = [report({ done: false, status: "ROLLING_BACK", counts: { total: 14, reverted: 5, conflicts: 0, skipped: 0, remaining: 9 } }), report()];
        const { calls, user, dialog } = await openReview({ [`POST ${ROLLBACK}`]: () => ({ status: 200, body: answers.shift() }) });
        await user.click(await within(dialog).findByRole("checkbox"));
        await user.click(within(dialog).getByRole("button", { name: "Roll back 12 changes" }));
        expect(await within(dialog).findByText("The import was rolled back, except for the changes listed below.")).toBeInTheDocument();
        const posts = calls.filter((c) => c.method === "POST" && c.path === `${ROLLBACK}`);
        expect(posts.map((c) => c.body)).toEqual([{ confirm: true, expectedEligible: 12 }, { confirm: true, expectedEligible: null }]);
        const result = within(dialog).getByLabelText("Rollback report");
        expect(within(result).getByText("Reversed").nextSibling).toHaveTextContent("12");
        expect(within(result).getByText("Kept (could not be reversed safely)").nextSibling).toHaveTextContent("2");
        expect(within(dialog).getByText(/A Google Sheet sync was requested/)).toBeInTheDocument();
    });

    test("a double click sends one rollback; the button and the dialog are locked while it runs", async () => {
        let release: (value: { status: number; body: unknown }) => void = () => {};
        const held = new Promise<{ status: number; body: unknown }>((resolve) => { release = resolve; });
        const { calls, user, dialog } = await openReview({ [`POST ${ROLLBACK}`]: () => held });
        await user.click(await within(dialog).findByRole("checkbox"));
        const button = within(dialog).getByRole("button", { name: "Roll back 12 changes" });
        await user.dblClick(button);
        expect(await within(dialog).findByText(/Rolling back…/)).toBeInTheDocument();
        expect(calls.filter((c) => c.method === "POST" && c.path === ROLLBACK)).toHaveLength(1);
        expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog", { name: "Roll back an import" })).toBeInTheDocument();
        release({ status: 200, body: report({ status: "ROLLED_BACK", counts: { total: 14, reverted: 14, conflicts: 0, skipped: 0, remaining: 0 }, reasons: {}, conflicts: [] }) });
        expect(await within(dialog).findByText("The import was rolled back.")).toBeInTheDocument();
    });

    test("an import that changed after the review is refused: nothing was rolled back, the new numbers are shown", async () => {
        const previews = [PREVIEW, { ...PREVIEW, summary: { ...PREVIEW.summary, eligible: 9, conflicts: 5 } }];
        const { user, dialog } = await openReview({
            [`GET ${ROLLBACK}/preview`]: () => ({ status: 200, body: previews.shift() ?? PREVIEW }),
            [`POST ${ROLLBACK}`]: { status: 409, body: { message: "The import changed since you reviewed it. Review it again before rolling back.", code: "ROLLBACK_PREVIEW_CHANGED", details: {} } },
        });
        await user.click(await within(dialog).findByRole("checkbox"));
        await user.click(within(dialog).getByRole("button", { name: "Roll back 12 changes" }));
        expect(await within(dialog).findByText(/changed after you reviewed it, so nothing was rolled back/)).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Roll back 9 changes" })).toBeDisabled();
        expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    });

    test("an interrupted rollback says nothing is half done and offers to continue", async () => {
        const { user, dialog } = await openReview({ [`POST ${ROLLBACK}`]: { status: 409, body: { message: "The rollback was interrupted. Nothing is half done. Continue it to retry.", code: "ROLLBACK_INTERRUPTED", details: {} } } });
        await user.click(await within(dialog).findByRole("checkbox"));
        await user.click(within(dialog).getByRole("button", { name: "Roll back 12 changes" }));
        expect(await within(dialog).findByText(/The rollback was interrupted/)).toBeInTheDocument();
        expect(within(dialog).getByText(/Nothing is left half done/)).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Review and continue" })).toBeEnabled();
    });

    test("a second rollback, one still committing, or another caller's is explained and cannot be confirmed", async () => {
        const { dialog } = await openReview({ [`GET ${ROLLBACK}/preview`]: { status: 200, body: { ...PREVIEW, canStart: false, blockedReason: "ROLLBACK_IN_PROGRESS" } } });
        expect(await within(dialog).findByText(/being rolled back right now/)).toBeInTheDocument();
        expect(within(dialog).queryByRole("checkbox")).toBeNull();
        expect(within(dialog).queryByRole("button", { name: /^Roll back/ })).toBeNull();
    });

    test("without the server's ledger key the review says personal records are kept", async () => {
        const { dialog } = await openReview({ [`GET ${ROLLBACK}/preview`]: { status: 200, body: { ...PREVIEW, keyAvailable: false } } });
        expect(await within(dialog).findByText(/cannot verify personal data right now/)).toBeInTheDocument();
    });

    test("an interrupted rollback of yours is offered when the dialog opens, and continuing it shows how far it got", async () => {
        const interrupted = { ...ACTIVE, status: "ROLLING_BACK" };
        asRole("ADMIN", {
            ...SOURCE,
            [`GET ${BASE}/import/active`]: { status: 200, body: { active: interrupted } },
            [`GET ${ROLLBACK}/preview`]: { status: 200, body: { ...PREVIEW, status: "ROLLING_BACK" } },
            [`GET ${ROLLBACK}`]: { status: 200, body: report({ done: false, status: "ROLLING_BACK" }) },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Upload" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /^Upload: import candidates/ });
        expect(within(dialog).queryByRole("button", { name: "Abort that import" })).toBeNull();
        await user.click(await within(dialog).findByRole("button", { name: "Continue rollback" }));
        const panel = await screen.findByRole("dialog", { name: "Roll back an import" });
        expect(await within(panel).findByText(/12 changes were already reversed before it was interrupted/)).toBeInTheDocument();
        expect(within(panel).getByRole("button", { name: "Continue rollback" })).toBeDisabled();
    });
});
