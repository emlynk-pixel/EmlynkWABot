// Google Sheet mirror: the Sheets adapter, the safety gate and configuration.
// Every test uses a recording fake client: nothing here can reach Google or
// the real operational Sheet (the live client also refuses to start under
// the test runner, see the last describe block).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SHEET_HEADERS, SYSTEM_CANDIDATE_ID_INDEX, fieldIndex } from "../src/services/sheetSchema.js";
import {
    SHEETS_ERROR_CLASS,
    SheetLayoutChangedError,
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
// Field-ordered cells (canonical order), as the mapper produces them.
const sheetRow = (id = "0042") => Array.from({ length: 41 }, (_, i) => (i === SYSTEM_CANDIDATE_ID_INDEX ? id : ""));
const letterIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

// Shaped like the official client's spreadsheets.values; records every call.
// Row 1 is read as '<tab>'!1:1; a single column below the header as
// '<tab>'!X2:X; anything else returns the data rows. `header` may be a
// function, to change row 1 between calls.
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
                get: (params) => {
                    const column = /!([A-Z]+)2:([A-Z]+)$/.exec(params.range);
                    if (params.range.endsWith("!1:1")) return respond("get", params, { values: [typeof header === "function" ? header() : header] });
                    if (column && column[1] === column[2]) return respond("get", params, { values: rows.map((r) => [r[letterIndex(column[1])] ?? ""]) });
                    return respond("get", params, { values: rows });
                },
                batchGet: (params) => respond("batchGet", params, { valueRanges: (params.ranges || []).map((range) => ({ range, values: rows })) }),
                append: (params) => respond("append", params, { updates: { updatedRange: `'${TAB}'!A9:AO9` } }),
                update: (params) => respond("update", params, {}),
                batchUpdate: (params) => respond("batchUpdate", params, {}),
            },
        },
    };
}

const writes = (client) => client.calls.filter((c) => ["batchUpdate", "update", "append"].includes(c.method));
// Every A1 range a write call targeted (append: its range; batchUpdate: each data range).
const writeRanges = (client) => writes(client).flatMap((c) => (c.method === "batchUpdate" ? c.requestBody.data.map((d) => d.range) : [c.range]));

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

    test("enabled: append writes one RAW row as wide as the header (canonical Sheet: A:AO) after reading row 1", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const result = await adapter.appendRow(sheetRow());
        assert.deepEqual(client.calls.map((c) => c.method), ["get", "append"]);
        const append = client.calls[1];
        assert.equal(append.range, `'${TAB}'!A:AO`);
        assert.equal(append.valueInputOption, "RAW");
        assert.equal(append.insertDataOption, "INSERT_ROWS");
        assert.deepEqual(append.requestBody.values, [sheetRow()]);
        assert.equal(result.updatedRange, `'${TAB}'!A9:AO9`);
    });

    test("enabled: update writes exactly one data row (canonical Sheet: one range A{n}:AO{n}); the header row can't be targeted", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        await adapter.updateRow(7, sheetRow("0007"));
        const update = client.calls.find((c) => c.method === "batchUpdate");
        assert.deepEqual(update.requestBody.data.map((d) => d.range), [`'${TAB}'!A7:AO7`]);
        assert.deepEqual(update.requestBody.data[0].values, [sheetRow("0007")]);
        assert.equal(update.requestBody.valueInputOption, "RAW");
        await assert.rejects(adapter.updateRow(1, sheetRow()), /data row number/);
        assert.equal(writes(client).length, 1);
    });

    test("a header mismatch (a renamed system header) is rejected safely: nothing is written", async () => {
        const header = [...SHEET_HEADERS];
        header[13] = "POLICE REP SRI LANKA (VERIFIED)";
        const client = fakeSheets({ header });
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const error = await adapter.appendRow(sheetRow()).catch((e) => e);
        assert.ok(error instanceof SheetSchemaMismatchError);
        assert.deepEqual(error.mismatches, [{ problem: "MISSING", header: "POLICE REP SRI LANKA", expected: 2, found: 1, columns: ["V"] }]);
        assert.doesNotMatch(error.message, /\(VERIFIED\)/, "the Sheet's own header text is not echoed");
        await assert.rejects(adapter.updateRow(3, sheetRow()), SheetSchemaMismatchError);
        assert.equal(writes(client).length, 0);
    });

    test("a malformed row is refused before any request", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        await assert.rejects(adapter.appendRow(sheetRow().slice(0, 40)), /exactly 41/);
        await assert.rejects(adapter.appendRow(sheetRow("")), /system candidate ID/);
        assert.deepEqual(client.calls, []);
    });

    test("the adapter offers no clear, delete or reset operation", () => {
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: fakeSheets() });
        assert.deepEqual(Object.keys(adapter).sort(), ["appendRow", "readCandidateIds", "readHeader", "readLayout", "readRow", "readRows", "readRowsByNumber", "updateRow", "validateSchema", "writeRows"]);
    });
});

describe("writes by header name: operator columns are never written", () => {
    const UNUSUAL = ["_SYSTEM_CANDIDATE_ID", "Operator Note", "VISA SUBMISSION STATUS", "PASSPORT NUMBER", "Another Note",
        ...SHEET_HEADERS.filter((h) => !["_SYSTEM_CANDIDATE_ID", "VISA SUBMISSION STATUS", "PASSPORT NUMBER"].includes(h))];
    const cells = () => {
        const row = sheetRow("0042");
        row[fieldIndex("visaSubmissionStatus")] = "COMPLETED";
        row[fieldIndex("passportNumber")] = "N1234567";
        row[fieldIndex("visaApprovalStatus")] = "INCOMPLETE";
        return row;
    };

    test("an update writes one range per run of system columns; B and E (operator columns) are in no range", async () => {
        const client = fakeSheets({ header: UNUSUAL });
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const layout = await adapter.readLayout();
        await adapter.writeRows({ updates: [{ rowNumber: 5, cells: cells() }] }, layout);
        const [batch] = writes(client);
        assert.deepEqual(batch.requestBody.data.map((d) => d.range), [`'${TAB}'!A5:A5`, `'${TAB}'!C5:D5`, `'${TAB}'!F5:AQ5`]);
        assert.deepEqual(batch.requestBody.data[0].values, [["0042"]]);
        assert.deepEqual(batch.requestBody.data[1].values, [["COMPLETED", "N1234567"]]);
        assert.equal(batch.requestBody.data[2].values[0].length, 38);
    });

    test("an append is as wide as the header, each value under its own header, \"\" in operator columns", async () => {
        const client = fakeSheets({ header: UNUSUAL });
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const layout = await adapter.readLayout();
        await adapter.writeRows({ appends: [cells()] }, layout);
        const append = writes(client)[0];
        assert.equal(append.range, `'${TAB}'!A:AQ`);
        const [row] = append.requestBody.values;
        assert.equal(row.length, 43);
        assert.deepEqual(row.slice(0, 5), ["0042", "", "COMPLETED", "N1234567", ""]);
        assert.equal(row[UNUSUAL.indexOf("VISA APPROVAL STATUS")], "INCOMPLETE");
    });

    test("row 1 changed after the layout was read (a column moved): nothing is written", async () => {
        let header = [...SHEET_HEADERS];
        const client = fakeSheets({ header: () => header });
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const layout = await adapter.readLayout();
        header = ["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        await assert.rejects(adapter.writeRows({ updates: [{ rowNumber: 2, cells: cells() }], appends: [cells()] }, layout), SheetLayoutChangedError);
        assert.deepEqual(writes(client), []);
        // A new layout (the next run) writes where the columns are now.
        const fresh = await adapter.readLayout();
        await adapter.writeRows({ updates: [{ rowNumber: 2, cells: cells() }] }, fresh);
        assert.equal(writes(client)[0].requestBody.data[0].range, `'${TAB}'!A2:AO2`);
        assert.deepEqual(writes(client)[0].requestBody.data[0].values[0].slice(0, 2), ["0042", ""]);
    });

    test("with a layout, a write re-reads row 1 exactly once to confirm it (no per-row header reads)", async () => {
        const client = fakeSheets();
        const adapter = createGoogleSheetsAdapter({ config: enabledConfig(), sheetsClient: client });
        const layout = await adapter.readLayout();
        const updates = Array.from({ length: 30 }, (_, i) => ({ rowNumber: i + 2, cells: sheetRow(String(i + 1).padStart(4, "0")) }));
        await adapter.writeRows({ updates, appends: [sheetRow("0099")] }, layout);
        assert.equal(client.calls.filter((c) => c.method === "get").length, 2, "the layout read + one confirmation");
        assert.equal(writes(client)[0].requestBody.data.length, 30);
    });
});

describe("reads", () => {
    test("readHeader returns row 1 as the Sheet has it (read whole, 1:1); validateSchema checks it by name", async () => {
        const short = fakeSheets({ header: SHEET_HEADERS.slice(0, 40) });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: short });
        const header = await adapter.readHeader();
        assert.deepEqual(header, SHEET_HEADERS.slice(0, 40));
        const schema = await adapter.validateSchema();
        assert.equal(schema.valid, false);
        assert.deepEqual(schema.mismatches.map((m) => [m.problem, m.header]), [["MISSING", "_SYSTEM_CANDIDATE_ID"]]);
        assert.equal(short.calls[0].range, `'${TAB}'!1:1`);
        assert.equal(short.calls[0].spreadsheetId, SPREADSHEET);
        await assert.rejects(adapter.readLayout(), SheetSchemaMismatchError);
    });

    test("readCandidateIds reads the _SYSTEM_CANDIDATE_ID column wherever it is, with row numbers from row 2", async () => {
        const client = fakeSheets({ rows: [sheetRow("0001"), sheetRow("0002")] });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: client });
        assert.deepEqual(await adapter.readCandidateIds(), [{ rowNumber: 2, candidateId: "0001" }, { rowNumber: 3, candidateId: "0002" }]);
        assert.deepEqual(client.calls.map((c) => c.range), [`'${TAB}'!1:1`, `'${TAB}'!AO2:AO`]);

        // Moved to column A: read from A.
        const idFirst = ["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        const moved = fakeSheets({ header: idFirst, rows: [["0007"], ["0008"]] });
        const adapterA = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: moved });
        assert.deepEqual(await adapterA.readCandidateIds(), [{ rowNumber: 2, candidateId: "0007" }, { rowNumber: 3, candidateId: "0008" }]);
        assert.equal(moved.calls[1].range, `'${TAB}'!A2:A`);
    });

    test("readRows returns field-ordered cells (41), whatever the live order, without operator columns", async () => {
        const client = fakeSheets({ rows: [["A-value"]] });
        const adapter = createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: client });
        const [row] = await adapter.readRows();
        assert.equal(row.rowNumber, 2);
        assert.equal(row.cells.length, 41);
        assert.equal(row.cells[0], "A-value");
        assert.equal(client.calls[1].range, `'${TAB}'!A2:AO`);

        // ID first and an operator column second: the live row is remapped by header.
        const header = ["_SYSTEM_CANDIDATE_ID", "Operator Note", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        const moved = fakeSheets({ header, rows: [["0042", "private note", "T-1", "N1234567"]] });
        const [live] = await createGoogleSheetsAdapter({ config: disabledConfig(), sheetsClient: moved }).readRows();
        assert.equal(live.cells.length, 41);
        assert.equal(live.cells[SYSTEM_CANDIDATE_ID_INDEX], "0042");
        assert.equal(live.cells[fieldIndex("testNumber")], "T-1");
        assert.equal(live.cells[fieldIndex("passportNumber")], "N1234567");
        assert.ok(!live.cells.includes("private note"), "operator columns are not read into the cells");
        assert.equal(moved.calls[1].range, `'${TAB}'!A2:AP`, "as wide as the header");
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
        test(`every read range quotes ${JSON.stringify(tab)}; with one layout, row 1 is read once for all reads`, async () => {
            const client = fakeSheets({ rows: [sheetRow("0042")] });
            const adapter = createGoogleSheetsAdapter({ config: { enabled: false, spreadsheetId: SPREADSHEET, tabName: tab }, sheetsClient: client });
            await adapter.readHeader();
            await adapter.validateSchema();
            const layout = await adapter.readLayout();
            await adapter.readCandidateIds(layout);
            await adapter.readRows(layout);
            await adapter.readRow(7, layout);
            await adapter.readRowsByNumber([7, 8], layout);
            assert.deepEqual(client.calls.filter((c) => c.method === "get").map((c) => c.range), [
                `${quoted}!1:1`, `${quoted}!1:1`, `${quoted}!1:1`, `${quoted}!AO2:AO`, `${quoted}!A2:AO`, `${quoted}!A7:AO7`,
            ]);
            assert.deepEqual(client.calls.filter((c) => c.method === "batchGet").map((c) => c.ranges), [
                [`${quoted}!A7:AO7`, `${quoted}!A8:AO8`],
            ]);
            assert.ok(client.calls.every((c) => ["get", "batchGet"].includes(c.method) && c.spreadsheetId === SPREADSHEET));
            assert.deepEqual(writes(client), []);
        });

        test(`write ranges quote ${JSON.stringify(tab)} too`, async () => {
            const client = fakeSheets({ rows: [sheetRow("0042")] });
            const adapter = createGoogleSheetsAdapter({ config: { enabled: true, spreadsheetId: SPREADSHEET, tabName: tab }, sheetsClient: client });
            await adapter.appendRow(sheetRow("0043"));
            await adapter.updateRow(7, sheetRow("0043"));
            assert.deepEqual(writeRanges(client), [`${quoted}!A:AO`, `${quoted}!A7:AO7`]);
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
