import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ImportPreview } from "../api/candidateImport";
import { UPDATE_SHEET_HINT } from "../pages/SettingsPage";
import { RENDER_STEP, renderApp, signedInBackend, userWithRole, type FetchRoutes } from "./helpers";

// Settings -> Google Sheet Sync -> Update Sheet. SYNTHETIC rows only; the backend is stubbed.
// The binary .xlsx read (read-excel-file) is replaced in the dialog flow; the column extraction
// and file checks it feeds are tested for real below.

const readWorkbookMock = vi.hoisted(() => vi.fn());
vi.mock("../components/importWorkbook", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../components/importWorkbook")>()),
    readWorkbook: readWorkbookMock,
}));
const { checkWorkbookFile, extractRows, WorkbookError } = await import("../components/importWorkbook");

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

beforeEach(() => readWorkbookMock.mockReset());

describe("Update Sheet button and roles", () => {
    test("1. ADMIN sees Update Sheet (with its hint) next to Test Connection and Sync Now", async () => {
        asRole("ADMIN");
        renderApp("/settings/sheet-sync");
        const button = await screen.findByRole("button", { name: "Update Sheet" }, RENDER_STEP);
        expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sync Now" })).toBeInTheDocument();
        expect(button).toHaveAccessibleDescription(UPDATE_SHEET_HINT);
        expect(UPDATE_SHEET_HINT).toBe("Upload an existing candidate sheet to validate and import candidate records into Emlynk, then sync them to the Candidate Operational Mirror.");
        await userEvent.setup().hover(button);
        expect(screen.getByRole("tooltip")).toHaveTextContent(UPDATE_SHEET_HINT);
        expect(screen.getByRole("tooltip")).toBeVisible();
    });

    test("2/3. MANAGER opens Google Sheet Sync and gets Update Sheet; Test Connection, Sync Now and the destination switch stay ADMIN only", async () => {
        asRole("MANAGER");
        renderApp("/settings/sheet-sync");
        expect(await screen.findByRole("button", { name: "Update Sheet" }, RENDER_STEP)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Test Connection" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Sync Now" })).toBeNull();
        expect(await screen.findByText("Main Mirror")).toBeInTheDocument();
        expect(screen.queryByRole("combobox", { name: "Google Sheet" })).toBeNull();
    });

    for (const role of ["ANALYST", "REGISTRATION_DESK"]) {
        test(`4/5. ${role}: no Update Sheet, no Settings data`, async () => {
            const { calls } = asRole(role);
            renderApp("/settings/sheet-sync");
            expect(await screen.findByRole("heading", { name: "Access Restricted" }, RENDER_STEP)).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Update Sheet" })).toBeNull();
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
        const { calls } = asRole("MANAGER", {
            [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } },
            [`POST ${BASE}/import/preview`]: { status: 200, body: PREVIEW },
            [`POST ${BASE}/import/${PREVIEW.importId}/chunks/0`]: chunk(2),
            [`POST ${BASE}/import/${PREVIEW.importId}/chunks/1`]: chunk(0, 1),
            [`POST ${BASE}/import/${PREVIEW.importId}/finish`]: { status: 200, body: { importId: PREVIEW.importId, status: "COMPLETED", totalRows: 3, counts: { created: 2, invalid: 1, warnings: 1 }, syncRunId: "run-1", sync: { requested: true, runId: "run-1", alreadyActive: false } } },
        });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Update Sheet" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Update Sheet/ });
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

    test("6/7. a sheet without a required heading is refused in the browser: the problem is shown and nothing is sent", async () => {
        readWorkbookMock.mockResolvedValue({ headers: ["PASSPORT NUMBER", "OTHER NAME"], rows: [{ rowNumber: 2, values: { "PASSPORT NUMBER": "N9000001", "OTHER NAME": "SYNTH" } }], missingRequired: ["SURNAME"] });
        const { calls } = asRole("ADMIN", { [`GET ${BASE}/import/source-columns`]: { status: 200, body: { allowed: ALLOWED, required: REQUIRED } } });
        renderApp("/settings/sheet-sync");
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Update Sheet" }, RENDER_STEP));
        const dialog = await screen.findByRole("dialog", { name: /Update Sheet/ });
        await user.upload(within(dialog).getByLabelText("Candidate sheet (.xlsx)"), new File(["x"], "legacy.xlsx"));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("The sheet is missing required headings: SURNAME.");
        expect(calls.some((c) => c.path.endsWith("/import/preview"))).toBe(false);
    });
});
