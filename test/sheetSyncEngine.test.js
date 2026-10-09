// Google Sheet mirror, Phase 3/4 units: adapter batch read/write and its
// gate, deletion guard, backoff, error classification, worker tuning.
// In-memory only (fake Sheet); nothing can reach Google.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createFakeGoogleSheet, googleError } from "./helpers/fakeGoogleSheet.js";
import { createGoogleSheetsAdapter, SheetSchemaMismatchError, SheetSyncDisabledError, SheetsAdapterError, readOnlySheetsView } from "../src/services/googleSheetsAdapter.js";
import { deletionGuardAllows } from "../src/services/sheetSyncEngine.js";
import { BACKOFF, backoffDelayMs } from "../src/services/sheetSyncStore.js";
import { classifySyncError } from "../src/services/sheetSyncWorker.js";
import { SheetDuplicateCandidateIdError } from "../src/services/sheetSyncPlanner.js";
import { readSheetSyncConfig, readSheetSyncTuning, sheetTargetHint, SHEET_SYNC_TUNING_DEFAULTS } from "../src/config/sheetSync.js";
import { SHEET_HEADERS } from "../src/services/sheetSchema.js";

const TAB = "Bob's Candidate Mirror";
const row = (id) => Array.from({ length: 41 }, (_, i) => (i === 40 ? id : `v${i}`));
const adapterFor = (sheet, enabled = true) => createGoogleSheetsAdapter({ config: { enabled, spreadsheetId: "fake-id", tabName: TAB }, sheetsClient: sheet.client });

describe("adapter: batch reads and writes", () => {
    test("writeRows refuses while the gate is off, before any Google call", async () => {
        const sheet = createFakeGoogleSheet({ tabName: TAB });
        await assert.rejects(adapterFor(sheet, false).writeRows({ appends: [row("0001")] }), SheetSyncDisabledError);
        assert.deepEqual(sheet.calls, []);
    });

    test("writeRows validates the header once, then one batchUpdate (RAW) and one append (INSERT_ROWS), quoted ranges", async () => {
        const sheet = createFakeGoogleSheet({ tabName: TAB, rows: [row("0001"), row("0002")] });
        const result = await adapterFor(sheet).writeRows({ updates: [{ rowNumber: 2, cells: row("0001") }, { rowNumber: 3, cells: row("0002") }], appends: [row("0003")] });
        assert.deepEqual(result, { updated: 2, appended: 1 });
        assert.deepEqual(sheet.calls.map((c) => c.method), ["get", "batchUpdate", "append"]);
        assert.equal(sheet.calls[0].range, "'Bob''s Candidate Mirror'!1:1");
        assert.deepEqual(sheet.calls[1].ranges, ["'Bob''s Candidate Mirror'!A2:AO2", "'Bob''s Candidate Mirror'!A3:AO3"]);
        assert.equal(sheet.calls[1].valueInputOption, "RAW");
        assert.deepEqual([sheet.calls[2].range, sheet.calls[2].insertDataOption], ["'Bob''s Candidate Mirror'!A:AO", "INSERT_ROWS"]);
    });

    test("writeRows writes nothing when the header does not match, and rejects rows that are not 41 cells", async () => {
        const header = [...SHEET_HEADERS];
        header[40] = "ID";
        const bad = createFakeGoogleSheet({ tabName: TAB, header });
        await assert.rejects(adapterFor(bad).writeRows({ appends: [row("0001")] }), SheetSchemaMismatchError);
        assert.deepEqual(bad.writes(), []);
        const good = createFakeGoogleSheet({ tabName: TAB });
        await assert.rejects(adapterFor(good).writeRows({ appends: [row("0001").slice(0, 40)] }));
        await assert.rejects(adapterFor(good).writeRows({ updates: [{ rowNumber: 1, cells: row("0001") }] }), /data row number/);
        assert.deepEqual(good.calls, []);
    });

    test("readRowsByNumber reads several rows in one batchGet per 100 rows, padded to 41 cells", async () => {
        const rows = Array.from({ length: 150 }, (_, i) => row(String(i + 1).padStart(4, "0")));
        const sheet = createFakeGoogleSheet({ tabName: TAB, rows });
        const cells = await readOnlySheetsView(adapterFor(sheet, false)).readRowsByNumber(Array.from({ length: 150 }, (_, i) => i + 2));
        assert.equal(sheet.calls.filter((c) => c.method === "batchGet").length, 2);
        assert.equal(cells.get(151)[40], "0150");
        assert.equal(cells.get(2).length, 41);
    });

    test("a Google failure surfaces as a classified SheetsAdapterError without Google's message", async () => {
        const sheet = createFakeGoogleSheet({ tabName: TAB });
        sheet.failNext("batchGet", googleError(429, { reason: "rateLimitExceeded" }));
        const error = await adapterFor(sheet).readRowsByNumber([2]).catch((e) => e);
        assert.ok(error instanceof SheetsAdapterError);
        assert.equal(error.errorClass, "RETRYABLE");
        assert.doesNotMatch(error.message, /ya29|Fake Tab|fake Google/);
    });
});

describe("deletion guard", () => {
    const guard = { max: 10, fraction: 0.05 };
    test("allows a few rows within both limits", () => {
        assert.equal(deletionGuardAllows({ count: 1, identifiedRows: 20, snapshotCount: 19, ...guard }), true);
        assert.equal(deletionGuardAllows({ count: 0, identifiedRows: 0, snapshotCount: 0, ...guard }), true);
    });
    test("blocks above the absolute cap, above the fraction, and whenever the snapshot is empty", () => {
        assert.equal(deletionGuardAllows({ count: 11, identifiedRows: 10_000, snapshotCount: 9_000, ...guard }), false);
        assert.equal(deletionGuardAllows({ count: 2, identifiedRows: 20, snapshotCount: 18, ...guard }), false);
        assert.equal(deletionGuardAllows({ count: 1, identifiedRows: 1, snapshotCount: 0, max: 100, fraction: 1 }), false);
    });
});

describe("backoff", () => {
    test("grows exponentially, is capped, and jitter stays within +/- 20 %", () => {
        const mid = (attempt) => backoffDelayMs(attempt, { random: () => 0.5 });
        assert.deepEqual([1, 2, 3, 4, 5, 9].map(mid), [15_000, 60_000, 240_000, 900_000, 900_000, 900_000]);
        assert.equal(backoffDelayMs(1, { random: () => 0 }), Math.round(BACKOFF.baseMs * 0.8));
        assert.equal(backoffDelayMs(1, { random: () => 0.999999 }), Math.round(BACKOFF.baseMs * 1.199999 * 1));
    });
});

describe("error classification", () => {
    const adapterError = (status, extra = {}) => new SheetsAdapterError({ errorClass: status === 429 || status >= 500 ? "RETRYABLE" : status ? "CONFIG" : "PERMANENT", status, ...extra });
    test("transient vs configuration vs data integrity", () => {
        assert.deepEqual(classifySyncError(adapterError(429, { reason: "rateLimitExceeded" })), { kind: "RETRYABLE", errorClass: "GOOGLE_UNAVAILABLE", errorCode: "429/rateLimitExceeded" });
        assert.equal(classifySyncError(adapterError(503)).kind, "RETRYABLE");
        assert.deepEqual(classifySyncError(adapterError(403, { googleStatus: "PERMISSION_DENIED" })), { kind: "CONFIG", errorClass: "ACCESS_DENIED", errorCode: "403/PERMISSION_DENIED" });
        assert.equal(classifySyncError(adapterError(404)).errorClass, "NOT_FOUND");
        assert.equal(classifySyncError(adapterError(400)).errorClass, "BAD_REQUEST");
        assert.equal(classifySyncError(adapterError(null)).kind, "CONFIG");
        assert.equal(classifySyncError(new SheetSchemaMismatchError([{ column: "F" }])).errorClass, "SCHEMA_INVALID");
        assert.deepEqual(classifySyncError(new SheetDuplicateCandidateIdError([{ candidateId: "0001", rowNumbers: [2, 3] }])), { kind: "DATA_INTEGRITY", errorClass: "DUPLICATE_CANDIDATE_ID", errorCode: "1" });
        assert.equal(classifySyncError(new Error("boom 'N1234567'")).kind, "INTERNAL");
        assert.equal(classifySyncError(new Error("boom 'N1234567'")).errorCode, null);
    });
});

describe("worker configuration", () => {
    test("defaults; SHEET_SYNC_ENABLED stays false by default whatever the tunables say", () => {
        const tuning = readSheetSyncTuning({});
        assert.deepEqual({ ...tuning, problems: [...tuning.problems] }, { ...SHEET_SYNC_TUNING_DEFAULTS, maxAttempts: 6, pilotCandidateIds: null, problems: [] });
        assert.equal(readSheetSyncConfig({ SHEET_SYNC_BATCH_SIZE: "50" }).enabled, false);
        assert.equal(readSheetSyncConfig({}).gate, "DISABLED");
    });
    test("invalid tunables fall back to the default and are reported by name only", () => {
        const tuning = readSheetSyncTuning({ SHEET_SYNC_BATCH_SIZE: "0", SHEET_SYNC_DELETION_GUARD_FRACTION: "2", SHEET_SYNC_MAX_RETRIES: "x" });
        assert.equal(tuning.batchSize, 25);
        assert.equal(tuning.deletionGuardFraction, 0.05);
        assert.equal(tuning.problems.length, 3);
        assert.ok(tuning.problems.every((p) => p.startsWith("SHEET_SYNC_")));
    });
    test("the first-write pilot list: parsed, bounded, and fail-closed when unusable", () => {
        assert.deepEqual(readSheetSyncTuning({ SHEET_SYNC_PILOT_CANDIDATE_IDS: " 0042, 0042,0007 " }).pilotCandidateIds, ["0042", "0007"]);
        for (const bad of [",", "0042;DROP", Array.from({ length: 21 }, (_, i) => String(i)).join(",")]) {
            const tuning = readSheetSyncTuning({ SHEET_SYNC_PILOT_CANDIDATE_IDS: bad });
            assert.equal(tuning.pilotCandidateIds, null);
            assert.match(tuning.problems.join(), /SHEET_SYNC_PILOT_CANDIDATE_IDS/);
        }
    });

    test("the target hint never contains the full spreadsheet ID", () => {
        const id = "1-11g-0tQruJbgVslH0nzCzG_JRr-4LahSCU8ZJirMpE";
        const hint = sheetTargetHint({ spreadsheetId: id, tabName: "Emlynk Candidate Operational Mirror" });
        assert.equal(hint, "…JirMpE / Emlynk Candidate Operational Mirror");
        assert.ok(!hint.includes(id));
        assert.equal(sheetTargetHint({ spreadsheetId: null, tabName: "x" }), null);
    });
});
