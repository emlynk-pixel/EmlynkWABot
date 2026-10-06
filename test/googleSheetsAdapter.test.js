// Google Sheet mirror: the Sheets adapter, the safety gate and configuration.
// Every test uses a recording fake client: nothing here can reach Google or
// the real operational Sheet (the live client also refuses to start under
// the test runner, see the last describe block).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SHEET_HEADERS } from "../src/services/sheetSchema.js";
import {
    SHEETS_ERROR_CLASS,
    SheetSchemaMismatchError,
    SheetSyncDisabledError,
    SheetsAdapterError,
    classifySheetsError,
    createGoogleSheetsAdapter,
    createLiveSheetsClient,
} from "../src/services/googleSheetsAdapter.js";
import { SHEET_SYNC_GATE, SHEET_SYNC_GATE_REASON, isSheetSyncEnabled, readSheetSyncConfig } from "../src/config/sheetSync.js";

const TAB = "Fake Tab";
const SPREADSHEET = "fake-spreadsheet-id";
const enabledConfig = () => ({ enabled: true, spreadsheetId: SPREADSHEET, tabName: TAB });
const disabledConfig = () => ({ enabled: false, spreadsheetId: SPREADSHEET, tabName: TAB });
const sheetRow = (id = "0042") => Array.from({ length: 40 }, (_, i) => (i === 39 ? id : ""));

// Shaped like the official client's spreadsheets.values; records every call.
function fakeSheets({ header = [...SHEET_HEADERS], rows = [], fail = null } = {}) {
    const calls = [];
    const respond = (method, params, data) => {
        calls.push({ method, ...params });
        if (fail && fail.method === method) return Promise.reject(fail.error);
        return Promise.resolve({ data });
    };
    return {
        calls,
        spreadsheets: {
            values: {
                get: (params) => respond("get", params, params.range.endsWith("A1:AN1") ? { values: [header] } : params.range.includes("!AN2") ? { values: rows.map((r) => [r[39]]) } : { values: rows }),
                append: (params) => respond("append", params, { updates: { updatedRange: `'${TAB}'!A9:AN9` } }),
                update: (params) => respond("update", params, {}),
            },
        },
    };
}

const writes = (client) => client.calls.filter((c) => c.method !== "get");

describe("write safety gate", () => {
    test("disabled: appendRow and updateRow refuse before any Google call", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: client });
        await assert.rejects(adapter.appendRow(sheetRow()), SheetSyncDisabledError);
        await assert.rejects(adapter.updateRow(5, sheetRow()), SheetSyncDisabledError);
        assert.deepEqual(client.calls, [], "no request of any kind");
    });

    test("disabled: the Google client is never even created for a write", async () => {
        let created = 0;
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: async () => { created++; return fakeSheets(); } });
        await assert.rejects(adapter.appendRow(sheetRow()), SheetSyncDisabledError);
        assert.equal(created, 0);
    });

    test("a config with no explicit enabled flag is treated as disabled", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: { spreadsheetId: SPREADSHEET, tabName: TAB, enabled: "true" }, sheetsClient: client });
        await assert.rejects(adapter.appendRow(sheetRow()), SheetSyncDisabledError);
        assert.equal(writes(client).length, 0);
    });

    test("enabled: append writes one RAW row to A:AN after validating the header", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const result = await adapter.appendRow(sheetRow());
        assert.deepEqual(client.calls.map((c) => c.method), ["get", "append"]);
        const append = client.calls[1];
        assert.equal(append.range, `'${TAB}'!A:AN`);
        assert.equal(append.valueInputOption, "RAW");
        assert.equal(append.insertDataOption, "INSERT_ROWS");
        assert.deepEqual(append.requestBody.values, [sheetRow()]);
        assert.equal(result.updatedRange, `'${TAB}'!A9:AN9`);
    });

    test("enabled: update writes exactly one data row A{n}:AN{n}; the header row can't be targeted", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        await adapter.updateRow(7, sheetRow("0007"));
        const update = client.calls.find((c) => c.method === "update");
        assert.equal(update.range, `'${TAB}'!A7:AN7`);
        assert.equal(update.valueInputOption, "RAW");
        await assert.rejects(adapter.updateRow(1, sheetRow()), /data row number/);
        assert.equal(writes(client).length, 1);
    });

    test("a header mismatch is rejected safely: nothing is written", async () => {
        const header = [...SHEET_HEADERS];
        [header[13], header[21]] = ["POLICE REP SRI LANKA (VERIFIED)", "POLICE REP SRI LANKA"];
        const client = fakeSheets({ header });
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const error = await adapter.appendRow(sheetRow()).catch((e) => e);
        assert.ok(error instanceof SheetSchemaMismatchError);
        assert.deepEqual(error.mismatches.map((m) => m.column), ["N"]);
        await assert.rejects(adapter.updateRow(3, sheetRow()), SheetSchemaMismatchError);
        assert.equal(writes(client).length, 0);
    });

    test("a malformed row is refused before any request", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        await assert.rejects(adapter.appendRow(sheetRow().slice(0, 39)), /exactly 40/);
        await assert.rejects(adapter.appendRow(sheetRow("")), /system candidate ID/);
        assert.deepEqual(client.calls, []);
    });

    test("the adapter offers no clear, delete or reset operation", () => {
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: fakeSheets() });
        assert.deepEqual(Object.keys(adapter).sort(), ["appendRow", "readCandidateIds", "readHeader", "readRow", "readRows", "readRowsByNumber", "updateRow", "validateSchema", "writeRows"]);
    });
});

describe("reads", () => {
    test("readHeader pads to 40 cells; validateSchema checks positions", async () => {
        const short = fakeSheets({ header: SHEET_HEADERS.slice(0, 39) });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: short });
        const header = await adapter.readHeader();
        assert.equal(header.length, 40);
        assert.equal(header[39], "");
        const schema = await adapter.validateSchema();
        assert.equal(schema.valid, false);
        assert.deepEqual(schema.mismatches.map((m) => m.column), ["AN"]);
        assert.equal(short.calls[0].range, `'${TAB}'!A1:AN1`);
        assert.equal(short.calls[0].spreadsheetId, SPREADSHEET);
    });

    test("readCandidateIds returns AN with row numbers from row 2", async () => {
        const client = fakeSheets({ rows: [sheetRow("0001"), sheetRow("0002")] });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: client });
        assert.deepEqual(await adapter.readCandidateIds(), [{ rowNumber: 2, candidateId: "0001" }, { rowNumber: 3, candidateId: "0002" }]);
        assert.equal(client.calls[0].range, `'${TAB}'!AN2:AN`);
    });

    test("readRows returns 40 cells per row, padded", async () => {
        const client = fakeSheets({ rows: [["A-value"]] });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: client });
        const [row] = await adapter.readRows();
        assert.equal(row.rowNumber, 2);
        assert.equal(row.cells.length, 40);
        assert.equal(row.cells[0], "A-value");
        assert.equal(client.calls[0].range, `'${TAB}'!A2:AN`);
    });

    test("no target configured: nothing is requested", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: { enabled: false, spreadsheetId: null, tabName: null }, sheetsClient: client });
        await assert.rejects(adapter.readCandidateIds(), /SHEET_SPREADSHEET_ID and SHEET_TAB_NAME/);
        assert.deepEqual(client.calls, []);
    });
});

describe("Google errors", () => {
    test("are classified and never carry Google's message text", async () => {
        const googleError = Object.assign(new Error(`Requested entity was not found: spreadsheets/${SPREADSHEET} 'Fake Tab'!A1`), { response: { status: 404 } });
        const client = fakeSheets({ fail: { method: "get", error: googleError } });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: client });
        const error = await adapter.readHeader().catch((e) => e);
        assert.ok(error instanceof SheetsAdapterError);
        assert.equal(error.errorClass, SHEETS_ERROR_CLASS.CONFIG);
        assert.equal(error.status, 404);
        assert.doesNotMatch(error.message, /fake-spreadsheet-id|Fake Tab|not found/);
    });

    test("classification: retryable, configuration, permanent", () => {
        const cases = [
            [{ response: { status: 429 } }, "RETRYABLE"],
            [{ response: { status: 503 } }, "RETRYABLE"],
            [{ code: "ECONNRESET" }, "RETRYABLE"],
            [{ response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } }, "RETRYABLE"],
            [{ response: { status: 403 } }, "CONFIG"],
            [{ response: { status: 401 } }, "CONFIG"],
            [{ response: { status: 404 } }, "CONFIG"],
            [{ response: { status: 400 } }, "CONFIG"],
            [{ response: { status: 409 } }, "PERMANENT"],
            [new Error("boom"), "PERMANENT"],
        ];
        for (const [error, expected] of cases) assert.equal(classifySheetsError(error).errorClass, expected, JSON.stringify(error));
    });
});

describe("the real Sheet can't be reached from tests", () => {
    test("the live client refuses to start under the Node test runner", async () => {
        assert.ok(process.env.NODE_TEST_CONTEXT, "running under node --test");
        await assert.rejects(createLiveSheetsClient(), /not available under the test runner/);
    });

    test("an adapter built with the default live client fails before any request, even when enabled", async () => {
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig() });
        await assert.rejects(adapter.readHeader(), /not available under the test runner/);
        await assert.rejects(adapter.appendRow(sheetRow()), /not available under the test runner/);
    });
});

describe("SHEET_SYNC_ENABLED configuration", () => {
    const base = { SHEET_SPREADSHEET_ID: SPREADSHEET, SHEET_TAB_NAME: TAB };

    test("defaults to disabled when missing", () => {
        const config = readSheetSyncConfig({ ...base });
        assert.equal(config.enabled, false);
        assert.equal(config.gate, SHEET_SYNC_GATE.DISABLED);
        assert.equal(config.gateReason, SHEET_SYNC_GATE_REASON.MISSING);
        assert.equal(isSheetSyncEnabled({}), false);
        assert.equal(readSheetSyncConfig({ ...base, SHEET_SYNC_ENABLED: "" }).enabled, false);
    });

    test("false is disabled; anything other than true is disabled and reported", () => {
        assert.equal(readSheetSyncConfig({ ...base, SHEET_SYNC_ENABLED: "false" }).gateReason, SHEET_SYNC_GATE_REASON.FALSE);
        for (const value of ["1", "yes", "on", "enabled", "truee"]) {
            const config = readSheetSyncConfig({ ...base, SHEET_SYNC_ENABLED: value });
            assert.equal(config.enabled, false, value);
            assert.equal(config.gateReason, SHEET_SYNC_GATE_REASON.INVALID, value);
            assert.match(config.problems.join(), /SHEET_SYNC_ENABLED must be true or false/);
        }
    });

    test("only an explicit true enables it", () => {
        for (const value of ["true", "TRUE", " true "]) {
            const config = readSheetSyncConfig({ ...base, SHEET_SYNC_ENABLED: value });
            assert.equal(config.enabled, true, value);
            assert.equal(config.gate, SHEET_SYNC_GATE.ENABLED);
            assert.deepEqual(config.problems, []);
        }
    });

    test("enabled without a target reports the missing variables by name only", () => {
        const config = readSheetSyncConfig({ SHEET_SYNC_ENABLED: "true" });
        assert.deepEqual([...config.problems], ["SHEET_SPREADSHEET_ID is missing", "SHEET_TAB_NAME is missing"]);
    });

    test("a key-file credential is refused (runtime identity only), without echoing it", () => {
        const config = readSheetSyncConfig({ ...base, SHEET_SYNC_ENABLED: "true", GOOGLE_APPLICATION_CREDENTIALS: "/secret/key.json" });
        assert.match(config.problems.join(), /GOOGLE_APPLICATION_CREDENTIALS must not be set/);
        assert.doesNotMatch(config.problems.join(), /secret\/key\.json/);
    });

    test("the tab name is kept exactly; values are read from the environment given", () => {
        const config = readSheetSyncConfig({ ...base, SHEET_TAB_NAME: "Emlynk Candidate Operational Mirror" });
        assert.equal(config.tabName, "Emlynk Candidate Operational Mirror");
        assert.equal(config.spreadsheetId, SPREADSHEET);
    });

    test("the test process itself has sync disabled", () => {
        assert.equal(isSheetSyncEnabled(), false, "SHEET_SYNC_ENABLED must not be true when tests run");
    });
});

describe("A1 ranges for real-world tab names (regression: Cloud Run HTTP 400)", () => {
    const realTab = "Emlynk Candidate Operational Mirror";
    const cases = [[realTab, `'${realTab}'`], ["Bob's tab", "'Bob''s tab'"], ["It''s", "'It''''s'"]];

    for (const [tab, quoted] of cases) {
        test(`every read range quotes ${JSON.stringify(tab)} and keeps the A:AN schema`, async () => {
            const client = fakeSheets({ rows: [sheetRow("0042")] });
            const adapter = createGoogleSheetsAdapter({ config: { enabled: false, spreadsheetId: SPREADSHEET, tabName: tab }, sheetsClient: client });
            await adapter.readHeader();
            await adapter.validateSchema();
            await adapter.readCandidateIds();
            await adapter.readRows();
            await adapter.readRow(7);
            assert.deepEqual(client.calls.map((c) => c.range), [
                `${quoted}!A1:AN1`, `${quoted}!A1:AN1`, `${quoted}!AN2:AN`, `${quoted}!A2:AN`, `${quoted}!A7:AN7`,
            ]);
            assert.ok(client.calls.every((c) => c.method === "get" && c.spreadsheetId === SPREADSHEET));
            assert.deepEqual(writes(client), []);
        });

        test(`write ranges quote ${JSON.stringify(tab)} too`, async () => {
            const client = fakeSheets({ rows: [sheetRow("0042")] });
            const adapter = createGoogleSheetsAdapter({ config: { enabled: true, spreadsheetId: SPREADSHEET, tabName: tab }, sheetsClient: client });
            await adapter.appendRow(sheetRow("0043"));
            await adapter.updateRow(7, sheetRow("0043"));
            assert.deepEqual(writes(client).map((c) => c.range), [`${quoted}!A:AN`, `${quoted}!A7:AN7`]);
        });
    }

    test("a Google 400 keeps its status enum and is a CONFIG class, without message text", () => {
        const error = Object.assign(new Error("Unable to parse range: 'Secret Tab'!A1"), {
            response: { status: 400, data: { error: { status: "INVALID_ARGUMENT", message: "Unable to parse range: 'Secret Tab'!A1", errors: [{ reason: "badRequest" }] } } },
        });
        const info = classifySheetsError(error);
        assert.deepEqual(info, { errorClass: "CONFIG", status: 400, reason: "badRequest", googleStatus: "INVALID_ARGUMENT" });
        assert.doesNotMatch(new SheetsAdapterError(info).message, /Secret Tab|parse range/);
    });

    test("the write gate stays off by default", () => {
        assert.equal(isSheetSyncEnabled({}), false);
    });
});
