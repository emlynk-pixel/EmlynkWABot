// Comprehensive regression tests for dynamic header-based column mapping
// in Google Sheet Sync (Tasks 1 & 2).
// Verifies that operators can safely reorder any system column, move
// _SYSTEM_CANDIDATE_ID (col A, middle, last), move VISA SUBMISSION STATUS,
// move VISA APPROVAL STATUS, and insert custom/operator columns without breaking sync.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    SHEET_COLUMN_COUNT,
    SHEET_HEADERS,
    SHEET_COLUMNS,
    SYSTEM_CANDIDATE_ID_INDEX,
    fieldIndex,
    columnOf,
    readSheetLayout,
    validateHeaderRow,
    toFieldCells,
    toLiveRow,
    writeRangesFor,
} from "../src/services/sheetSchema.js";
import {
    createGoogleSheetsAdapter,
    SheetSchemaMismatchError,
    SheetLayoutChangedError,
} from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncPlanner, SYNC_ACTION } from "../src/services/sheetSyncPlanner.js";
import { createSheetSyncEngine, ENGINE_ACTION } from "../src/services/sheetSyncEngine.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { RECORD_STATUS, mapCandidateToSheetRow } from "../src/services/candidateSheetMapper.js";

const TAB = "Operational Mirror";
const NOW = new Date("2026-10-09T12:00:00.000Z");

function mockCandidate(n, overrides = {}) {
    return {
        passportId: `N100000${n}`,
        uniqueId: `000${n}`,
        firstName: `First${n}`,
        otherName: `Last${n}`,
        dateOfBirth: new Date("1992-05-10T00:00:00.000Z"),
        placeOfBirth: "Colombo",
        passportExpiryDate: new Date("2032-05-09T00:00:00.000Z"),
        passportIssueDate: new Date("2022-05-10T00:00:00.000Z"),
        address: `${n} Main Street`,
        job: "Driver",
        nic: `19920000000${n}`,
        jobExperience: "5 years",
        whatsappNumber: `+9477000000${n}`,
        contactNumber: `+9411000000${n}`,
        nationality: "Sri Lankan",
        sex: "MALE",
        createdDate: new Date("2026-10-01T10:00:00.000Z"),
        stages: [
            { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
            { stage: "VISA_SUBMISSION", completed: n % 2 === 0, notes: null },
            { stage: "VISA_APPROVAL", completed: false, notes: null },
        ],
        documents: [
            {
                documentId: `doc-${n}-pass`,
                documentType: "PASSPORT",
                documentVariant: null,
                verificationStatus: "VERIFIED",
                receivedDate: new Date("2026-10-02T00:00:00.000Z"),
                createdDate: new Date("2026-10-02T00:00:00.000Z"),
                policeSubmittedDate: null,
            },
        ],
        ...overrides,
    };
}

function mockAggregate(candidate) {
    const { stages, documents, ...user } = candidate;
    return { user: { ...user }, stages: [...stages], documents: [...documents] };
}

function makeReader(candidates) {
    return {
        findByUniqueId: async (id) => {
            const c = candidates.find((x) => x.uniqueId === id);
            return c ? mockAggregate(c) : null;
        },
        findByUniqueIds: async (ids) => {
            const map = new Map();
            for (const id of ids) {
                const c = candidates.find((x) => x.uniqueId === id);
                if (c) map.set(id, mockAggregate(c));
            }
            return map;
        },
        readSnapshot: async () => ({
            aggregates: candidates.map(mockAggregate),
            count: candidates.length,
        }),
    };
}

function makeAdapter(sheet, enabled = true) {
    return createGoogleSheetsAdapter({
        config: { enabled, spreadsheetId: "fake-spreadsheet-id", tabName: sheet.tabName },
        sheetsClient: sheet.client,
    });
}

describe("Dynamic Column Mapping & Reordering Regression Suite", () => {
    // 1. Canonical 41-column order still works
    test("1. canonical 41-column order works exactly as expected", async () => {
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: [...SHEET_HEADERS] });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        const syncResult = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(syncResult.get("0001").action, ENGINE_ACTION.APPENDED);

        const rows = sheet.dataRows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0][40], "0001", "ID is in canonical column AO (index 40)");
        assert.equal(rows[0][1], "N1000001", "Passport is in canonical column B");
    });

    // 2. Fully reversed known-column order works
    test("2. fully reversed known-column order works", async () => {
        const reversedHeaders = [...SHEET_HEADERS].reverse();
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: reversedHeaders });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        const syncResult = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(syncResult.get("0001").action, ENGINE_ACTION.APPENDED);

        const layout = await adapter.readLayout();
        const readRows = await adapter.readRows(layout);
        assert.equal(readRows.length, 1);
        assert.equal(readRows[0].cells[SYSTEM_CANDIDATE_ID_INDEX], "0001");
        assert.equal(readRows[0].cells[fieldIndex("passportNumber")], "N1000001");

        // Physical sheet verification: reversed means _SYSTEM_CANDIDATE_ID is at physical index 0 (Column A)
        assert.equal(sheet.dataRows()[0][0], "0001");
    });

    // 3. _SYSTEM_CANDIDATE_ID in column A works
    test("3. _SYSTEM_CANDIDATE_ID in column A works for reads, updates, and appends", async () => {
        const headersA = ["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        const c1 = mockCandidate(1);
        const c2 = mockCandidate(2);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headersA });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1, c2]), sheets: adapter, clock: () => NOW });

        // Append c1
        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][0], "0001", "_SYSTEM_CANDIDATE_ID is in Column A");

        // Append c2
        await engine.syncCandidates([{ uniqueId: "0002", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[1][0], "0002", "Second candidate appended with ID in Column A");

        // Update c1: change address
        c1.address = "Updated Address In Col A Layout";
        const updateResult = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(updateResult.get("0001").action, ENGINE_ACTION.UPDATED);
        assert.equal(sheet.dataRows()[0][0], "0001", "ID untouched");

        const layout = await adapter.readLayout();
        const row1Cells = (await adapter.readRow(2, layout)).cells;
        assert.equal(row1Cells[fieldIndex("address")], "Updated Address In Col A Layout");
    });

    // 4. _SYSTEM_CANDIDATE_ID in the middle works
    test("4. _SYSTEM_CANDIDATE_ID in the middle works", async () => {
        const others = SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID");
        const headersMiddle = [...others.slice(0, 15), "_SYSTEM_CANDIDATE_ID", ...others.slice(15)];
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headersMiddle });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][15], "0001", "ID is in middle at index 15");

        const layout = await adapter.readLayout();
        const ids = await adapter.readCandidateIds(layout);
        assert.deepEqual(ids, [{ rowNumber: 2, candidateId: "0001" }]);
    });

    // 5. _SYSTEM_CANDIDATE_ID last still works
    test("5. _SYSTEM_CANDIDATE_ID last still works", async () => {
        const headersLast = [...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID"), "_SYSTEM_CANDIDATE_ID"];
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headersLast });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][40], "0001");
    });

    // 6. VISA SUBMISSION STATUS moved elsewhere works
    test("6. VISA SUBMISSION STATUS moved to column B works", async () => {
        const headers = ["TEST NUMBER", "VISA SUBMISSION STATUS", ...SHEET_HEADERS.filter((h) => !["TEST NUMBER", "VISA SUBMISSION STATUS"].includes(h))];
        const c1 = mockCandidate(1, {
            stages: [
                { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
                { stage: "VISA_SUBMISSION", completed: true, notes: null },
            ],
        });
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][1], "COMPLETED", "VISA SUBMISSION STATUS is written to physical index 1 (Column B)");
    });

    // 7. VISA APPROVAL STATUS moved elsewhere works
    test("7. VISA APPROVAL STATUS moved to column A works", async () => {
        const headers = ["VISA APPROVAL STATUS", ...SHEET_HEADERS.filter((h) => h !== "VISA APPROVAL STATUS")];
        const c1 = mockCandidate(1, {
            stages: [
                { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
                { stage: "VISA_APPROVAL", completed: true, notes: null },
            ],
        });
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][0], "COMPLETED", "VISA APPROVAL STATUS is written to physical index 0 (Column A)");
    });

    // 8. Multiple known columns reordered simultaneously
    test("8. multiple known columns reordered simultaneously", async () => {
        // Swap pairs: (0, 1), (5, 6), (34, 35)
        const headers = [...SHEET_HEADERS];
        [headers[0], headers[1]] = [headers[1], headers[0]];
        [headers[5], headers[6]] = [headers[6], headers[5]];
        [headers[34], headers[35]] = [headers[35], headers[34]];

        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        const layout = await adapter.readLayout();
        const row = (await adapter.readRow(2, layout)).cells;

        assert.equal(row[SYSTEM_CANDIDATE_ID_INDEX], "0001");
        assert.equal(row[fieldIndex("passportNumber")], "N1000001");
    });

    // 9. One unknown custom column is allowed
    test("9. one unknown custom column is allowed and ignored", async () => {
        const headers = ["Internal Notes", ...SHEET_HEADERS];
        const { valid, problems, layout } = readSheetLayout(headers);
        assert.equal(valid, true);
        assert.equal(problems.length, 0);
        assert.equal(layout.extraColumns, 1);
    });

    // 10. Several unknown columns are allowed
    test("10. several unknown columns are allowed and ignored", async () => {
        const headers = ["Custom1", ...SHEET_HEADERS.slice(0, 10), "Custom2", ...SHEET_HEADERS.slice(10), "Custom3"];
        const { valid, problems, layout } = readSheetLayout(headers);
        assert.equal(valid, true);
        assert.equal(problems.length, 0);
        assert.equal(layout.extraColumns, 3);
    });

    // 11. Custom values survive DB -> Sheet updates
    test("11. custom values survive DB -> Sheet updates without being touched or overwritten", async () => {
        const headers = ["_SYSTEM_CANDIDATE_ID", "Operator Note", "PASSPORT NUMBER", ...SHEET_HEADERS.filter((h) => !["_SYSTEM_CANDIDATE_ID", "PASSPORT NUMBER"].includes(h))];
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        // Initial append
        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);

        // Operator enters manual note in row 2, column B (index 1)
        sheet.setCell(2, 1, "DO NOT OVERWRITE THIS VALUABLE NOTE");
        assert.equal(sheet.dataRows()[0][1], "DO NOT OVERWRITE THIS VALUABLE NOTE");

        // Database updates candidate details
        c1.job = "Senior Specialist";
        const updateResult = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(updateResult.get("0001").action, ENGINE_ACTION.UPDATED);

        // Verify operator note is still 100% intact!
        assert.equal(sheet.dataRows()[0][1], "DO NOT OVERWRITE THIS VALUABLE NOTE", "Custom note was completely preserved");

        // Verify write call ranges never included Column B
        const batchUpdateCalls = sheet.calls.filter((c) => c.method === "batchUpdate");
        assert.ok(batchUpdateCalls.length > 0);
        for (const call of batchUpdateCalls) {
            for (const range of call.ranges) {
                // Column B must NOT be written to! (Ranges should be A2:A2 and C2:AP2)
                assert.ok(!range.includes("!B2:B2"), "Range must not write to column B");
            }
        }
    });

    // 12. Missing required header => SCHEMA_INVALID
    test("12. missing required header => SCHEMA_INVALID", () => {
        const missing = SHEET_HEADERS.filter((h) => h !== "BIRTHDAY");
        const { valid, problems } = readSheetLayout(missing);
        assert.equal(valid, false);
        assert.equal(problems[0].problem, "MISSING");
        assert.equal(problems[0].header, "BIRTHDAY");
    });

    // 13. Duplicate required header => SCHEMA_INVALID
    test("13. duplicate required header => SCHEMA_INVALID", () => {
        const dup = [...SHEET_HEADERS, "VISA SUBMISSION STATUS"];
        const { valid, problems } = readSheetLayout(dup);
        assert.equal(valid, false);
        assert.equal(problems[0].problem, "DUPLICATE");
        assert.equal(problems[0].header, "VISA SUBMISSION STATUS");
    });

    // 14. Renamed required header => SCHEMA_INVALID
    test("14. renamed required header => SCHEMA_INVALID", () => {
        const renamed = [...SHEET_HEADERS];
        renamed[1] = "PASSPORT NO"; // Should be PASSPORT NUMBER
        const { valid, problems } = readSheetLayout(renamed);
        assert.equal(valid, false);
        assert.equal(problems[0].problem, "MISSING");
        assert.equal(problems[0].header, "PASSPORT NUMBER");
    });

    // 15. No system data is written to a wrong physical column
    test("15. no system data is written to a wrong physical column", async () => {
        const customHeader = [
            "_SYSTEM_CANDIDATE_ID", // Col A
            "Operator Note",        // Col B
            "VISA SUBMISSION STATUS", // Col C
            "PASSPORT NUMBER",      // Col D
            ...SHEET_HEADERS.filter((h) => !["_SYSTEM_CANDIDATE_ID", "VISA SUBMISSION STATUS", "PASSPORT NUMBER"].includes(h)),
        ];
        const c1 = mockCandidate(1, {
            stages: [
                { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
                { stage: "VISA_SUBMISSION", completed: true, notes: null },
            ],
        });
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: customHeader });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        const row = sheet.dataRows()[0];

        assert.equal(row[0], "0001", "System ID is in Column A");
        assert.equal(row[1], "", "Operator note column is empty string upon append");
        assert.equal(row[2], "COMPLETED", "VISA SUBMISSION STATUS is in Column C");
        assert.equal(row[3], "N1000001", "PASSPORT NUMBER is in Column D");
    });

    // 16. Identity matching still uses _SYSTEM_CANDIDATE_ID
    test("16. identity matching strictly uses _SYSTEM_CANDIDATE_ID regardless of position", async () => {
        const headers = ["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const planner = createSheetSyncPlanner({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        // Empty sheet -> plans APPEND
        const plan = await planner.planCandidate("0001");
        assert.equal(plan.action, SYNC_ACTION.APPEND);

        // Prepopulate sheet row with different passport number but same uniqueId
        const layout = await adapter.readLayout();
        const cells = mapCandidateToSheetRow(mockAggregate(c1), { mirroredAt: NOW });
        cells[fieldIndex("passportNumber")] = "DIFFERENT_PASSPORT";
        await adapter.appendRow(cells, layout);

        // Planner must find the candidate by unique ID in Col A and plan UPDATE, never APPEND
        const plan2 = await planner.planCandidate("0001");
        assert.equal(plan2.action, SYNC_ACTION.UPDATE);
        assert.equal(plan2.rowNumber, 2);
    });

    // 17. Reconciliation works with arbitrary order
    test("17. reconciliation works with arbitrary order and repairs drift", async () => {
        const headersReordered = [
            "_SYSTEM_CANDIDATE_ID",
            "Custom Col 1",
            "VISA APPROVAL STATUS",
            "Custom Col 2",
            ...SHEET_HEADERS.filter((h) => !["_SYSTEM_CANDIDATE_ID", "VISA APPROVAL STATUS"].includes(h)),
        ];
        const c1 = mockCandidate(1);
        const c2 = mockCandidate(2);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headersReordered });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1, c2]), sheets: adapter, clock: () => NOW });

        // Run full reconciliation
        const summary = await engine.reconcile({ guard: { max: 10, fraction: 0.5 } });
        assert.equal(summary.appended, 2);
        assert.equal(sheet.dataRows().length, 2);

        // Set custom columns
        sheet.setCell(2, 1, "Custom Val 1");
        sheet.setCell(2, 3, "Custom Val 2");

        // Introduce drift in candidate 1
        c1.job = "Updated Title";
        const summary2 = await engine.reconcile({ guard: { max: 10, fraction: 0.5 } });
        assert.equal(summary2.updated, 1);
        assert.equal(summary2.unchanged, 1);

        // Custom columns preserved
        assert.equal(sheet.dataRows()[0][1], "Custom Val 1");
        assert.equal(sheet.dataRows()[0][3], "Custom Val 2");
    });

    // 18. DB -> Sheet writes work with arbitrary order
    test("18. DB -> Sheet writes work with arbitrary order", async () => {
        const shuffled = [...SHEET_HEADERS].reverse();
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: shuffled });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        const res = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(res.get("0001").action, ENGINE_ACTION.APPENDED);

        const layout = await adapter.readLayout();
        const readRow = await adapter.readRow(2, layout);
        assert.equal(readRow.cells[SYSTEM_CANDIDATE_ID_INDEX], "0001");
        assert.equal(readRow.cells[fieldIndex("passportNumber")], "N1000001");
    });

    // 19. Later sync reloads the changed header layout
    test("19. later sync reloads the changed header layout after an operator moves columns", async () => {
        // Run 1: Canonical order
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: [...SHEET_HEADERS] });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][40], "0001", "Col AO initially");

        // Operator moves _SYSTEM_CANDIDATE_ID to Column A and shifts others
        const newHeader = ["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        sheet.setHeader(newHeader);
        // Also move row 2's cells to match the operator's reordering
        const oldRow = sheet.dataRows()[0];
        const newRow = [oldRow[40], ...oldRow.slice(0, 40)];
        newRow.forEach((val, i) => sheet.setCell(2, i, val));

        // Run 2: modifying candidate triggers another sync
        c1.job = "Updated Role";
        const res2 = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(res2.get("0001").action, ENGINE_ACTION.UPDATED);
        assert.equal(sheet.dataRows()[0][0], "0001", "ID is now in Col A and recognized dynamically");
    });

    // 20. Mid-run layout change is detected before writing
    test("20. mid-run layout change throws SheetLayoutChangedError without writing", async () => {
        const headers = [...SHEET_HEADERS];
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const layout = await adapter.readLayout();

        // Operator mutates header mid-run
        sheet.setHeader(["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")]);

        const cells = mapCandidateToSheetRow(mockAggregate(mockCandidate(1)), { mirroredAt: NOW });
        await assert.rejects(
            adapter.writeRows({ updates: [{ rowNumber: 2, cells }] }, layout),
            SheetLayoutChangedError
        );
        assert.equal(sheet.writes().length, 0, "No data was written");
    });

    // 21. VISA Submission status remains correct
    test("21. VISA Submission status remains correct across transitions", async () => {
        const headers = ["VISA SUBMISSION STATUS", ...SHEET_HEADERS.filter((h) => h !== "VISA SUBMISSION STATUS")];
        const c1 = mockCandidate(1, {
            stages: [
                { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
                { stage: "VISA_SUBMISSION", completed: false, notes: null },
            ],
        });
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        // Append initial state (INCOMPLETE)
        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][0], "INCOMPLETE");

        // Complete the stage
        c1.stages = [
            { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
            { stage: "VISA_SUBMISSION", completed: true, notes: null },
        ];
        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(sheet.dataRows()[0][0], "COMPLETED");
    });

    // 22. Crash recovery/idempotency tests still pass
    test("22. worker recovery and idempotency: repeated sync of same state writes nothing", async () => {
        const headers = ["_SYSTEM_CANDIDATE_ID", ...SHEET_HEADERS.filter((h) => h !== "_SYSTEM_CANDIDATE_ID")];
        const c1 = mockCandidate(1);
        const sheet = createFakeGoogleSheet({ tabName: TAB, header: headers });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        // First sync
        await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        const writesCount = sheet.writes().length;

        // Second sync with identical state
        const res2 = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(res2.get("0001").action, ENGINE_ACTION.UNCHANGED);
        assert.equal(sheet.writes().length, writesCount, "Zero additional writes made");
    });

    // 23. Intentionally unusual layout test
    test("23. Intentionally unusual layout: Column A identity, custom columns, reordered statuses", async () => {
        /*
          Layout:
          A: _SYSTEM_CANDIDATE_ID
          B: Operator Note
          C: VISA SUBMISSION STATUS
          D: PASSPORT NUMBER
          E: Internal Audit
          ... rest of system headers ...
          near end: VISA APPROVAL STATUS
          end: Supervisor Signoff
        */
        const otherHeaders = SHEET_HEADERS.filter((h) =>
            !["_SYSTEM_CANDIDATE_ID", "VISA SUBMISSION STATUS", "PASSPORT NUMBER", "VISA APPROVAL STATUS"].includes(h)
        );

        const unusualHeader = [
            "_SYSTEM_CANDIDATE_ID",       // Col A (0)
            "Operator Note",              // Col B (1) - Custom
            "VISA SUBMISSION STATUS",     // Col C (2)
            "PASSPORT NUMBER",            // Col D (3)
            "Internal Audit",             // Col E (4) - Custom
            ...otherHeaders,              // Cols 5..41
            "VISA APPROVAL STATUS",       // Col 42
            "Supervisor Signoff",         // Col 43 - Custom
        ];

        const c1 = mockCandidate(1, {
            stages: [
                { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
                { stage: "VISA_SUBMISSION", completed: true, notes: null },
                { stage: "VISA_APPROVAL", completed: false, notes: null },
            ],
        });

        const sheet = createFakeGoogleSheet({ tabName: TAB, header: unusualHeader });
        const adapter = makeAdapter(sheet);
        const engine = createSheetSyncEngine({ reader: makeReader([c1]), sheets: adapter, clock: () => NOW });

        // 1. Initial append
        const appendRes = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(appendRes.get("0001").action, ENGINE_ACTION.APPENDED);

        const rowAfterAppend = sheet.dataRows()[0];
        assert.equal(rowAfterAppend[0], "0001", "ID in Col A");
        assert.equal(rowAfterAppend[1], "", "Operator Note initially blank");
        assert.equal(rowAfterAppend[2], "COMPLETED", "VISA SUBMISSION STATUS in Col C");
        assert.equal(rowAfterAppend[3], "N1000001", "PASSPORT NUMBER in Col D");
        assert.equal(rowAfterAppend[4], "", "Internal Audit initially blank");
        assert.equal(rowAfterAppend[42], "INCOMPLETE", "VISA APPROVAL STATUS near end");
        assert.equal(rowAfterAppend[43], "", "Supervisor Signoff initially blank");

        // 2. Operator populates all custom columns
        sheet.setCell(2, 1, "OPERATOR_NOTE_PRESERVED");
        sheet.setCell(2, 4, "AUDIT_PASSED_2026");
        sheet.setCell(2, 43, "SIGNOFF_BY_MANAGER_BOB");

        // 3. Database updates candidate details and Visa Approval status
        c1.job = "Updated Job Title";
        c1.stages = [
            { stage: "TEST_DETAILS", completed: true, notes: null, testDate: new Date("2026-10-02T00:00:00.000Z") },
            { stage: "VISA_SUBMISSION", completed: true, notes: null },
            { stage: "VISA_APPROVAL", completed: true, notes: null },
        ];

        const updateRes = await engine.syncCandidates([{ uniqueId: "0001", candidateDeleted: false }]);
        assert.equal(updateRes.get("0001").action, ENGINE_ACTION.UPDATED);

        const rowAfterUpdate = sheet.dataRows()[0];

        // Verify all known fields updated correctly
        assert.equal(rowAfterUpdate[0], "0001", "Identity intact in Col A");
        assert.equal(rowAfterUpdate[2], "COMPLETED", "VISA SUBMISSION STATUS intact in Col C");
        assert.equal(rowAfterUpdate[3], "N1000001", "PASSPORT NUMBER intact in Col D");
        assert.equal(rowAfterUpdate[42], "COMPLETED", "VISA APPROVAL STATUS updated to COMPLETED");

        // Verify ALL custom fields are completely untouched!
        assert.equal(rowAfterUpdate[1], "OPERATOR_NOTE_PRESERVED", "Col B custom field untouched");
        assert.equal(rowAfterUpdate[4], "AUDIT_PASSED_2026", "Col E custom field untouched");
        assert.equal(rowAfterUpdate[43], "SIGNOFF_BY_MANAGER_BOB", "Trailing custom field untouched");
    });
});
