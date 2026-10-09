// Google Sheet operational mirror: sync PLANNING (Phase 2, read-only).
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 7 and 8.6.)
//
// Works out what a sync would do for a candidate, without doing it:
//   APPEND     the candidate has no row in the Sheet yet
//   UPDATE     the candidate's row differs from what the database says
//   UNCHANGED  the candidate's row already matches
//   NOT_IN_DATABASE  no candidate with that unique ID (nothing planned yet;
//                    inactive marking is a later phase)
//
// It cannot write: the Sheets adapter it is given is reduced to its read
// methods (readOnlySheetsView) before anything else happens, so append/update
// are not reachable from here. A later phase adds a separate executor.
//
// Row identity is the _SYSTEM_CANDIDATE_ID column (= users.unique_id),
// wherever it is in the Sheet, and nothing else: blank ID cells identify no
// one, a duplicate ID stops planning (never a guess which row is "right"),
// and the passport number or NIC is never used as a fallback key.
//
// Row 1 is read once per plan (the live layout); every read uses it.
//
// Plans hold no cell values (no PII): the action, the unique ID, the row
// number and the live letters of the columns that differ.

import { SYSTEM_CANDIDATE_ID_HEADER, SYSTEM_CANDIDATE_ID_INDEX, changedColumnLetters } from "./sheetSchema.js";
import { mapCandidateToSheetRow } from "./candidateSheetMapper.js";
import { readOnlySheetsView } from "./googleSheetsAdapter.js";

export const SYNC_ACTION = Object.freeze({
    APPEND: "APPEND",
    UPDATE: "UPDATE",
    UNCHANGED: "UNCHANGED",
    NOT_IN_DATABASE: "NOT_IN_DATABASE",
});

// Duplicate technical IDs in the Sheet: a data-integrity error, not
// retryable, needs a person to fix the Sheet.
export class SheetDuplicateCandidateIdError extends Error {
    constructor(duplicates) {
        super(`The Sheet has ${duplicates.length} duplicated ${SYSTEM_CANDIDATE_ID_HEADER} candidate ID(s); nothing can be planned until they are resolved`);
        this.name = "SheetDuplicateCandidateIdError";
        this.errorClass = "DATA_INTEGRITY";
        // [{ candidateId, rowNumbers }]: internal IDs and row numbers only.
        this.duplicates = duplicates;
    }
}

// LAST MIRRORED AT changes on every write, so it never makes a row "different".
const IGNORED_FOR_COMPARISON = new Set(["lastMirroredAt"]);

// [{ rowNumber, candidateId }] (the ID column) -> Map(candidateId -> rowNumber).
// Blank cells are skipped (counted); any repeated non-blank ID throws.
// IDs are trimmed of surrounding whitespace (so "0003 " is "0003", and the two
// together are a duplicate), then compared exactly as text: no numeric
// coercion, no other column consulted.
export function buildCandidateRowIndex(candidateIds) {
    const rowsById = new Map();
    let blankRows = 0;
    for (const { rowNumber, candidateId: cell } of candidateIds) {
        const candidateId = typeof cell === "string" ? cell.trim() : "";
        if (candidateId === "") {
            blankRows++;
            continue;
        }
        const rows = rowsById.get(candidateId) ?? [];
        rows.push(rowNumber);
        rowsById.set(candidateId, rows);
    }
    const duplicates = [...rowsById].filter(([, rows]) => rows.length > 1).map(([candidateId, rowNumbers]) => ({ candidateId, rowNumbers }));
    if (duplicates.length) throw new SheetDuplicateCandidateIdError(duplicates);
    return { index: new Map([...rowsById].map(([id, [row]]) => [id, row])), blankRows };
}

// Live column letters where the Sheet row differs from the expected row
// (both field-ordered; layout: the live layout the row was read with).
export function changedColumns(expectedCells, actualCells, layout) {
    if (!layout?.positions) throw new Error("The live Sheet layout is required to name changed columns");
    return changedColumnLetters(expectedCells, actualCells, layout, IGNORED_FOR_COMPARISON);
}

// reader: createCandidateAggregateReader(...); sheets: a Sheets adapter (only
// its read methods are kept); clock: () => Date, the LAST MIRRORED AT time.
export function createSheetSyncPlanner({ reader, sheets, clock = () => new Date() } = {}) {
    if (!reader?.findByUniqueId) throw new Error("A candidate aggregate reader is required");
    const sheet = readOnlySheetsView(sheets);

    // Every system header must be present (in any order) before anything is
    // planned: readLayout throws SheetSchemaMismatchError otherwise.
    function planFor(aggregate, expected, rowIndex, readRowCells, layout) {
        const candidateId = aggregate.user.uniqueId;
        const rowNumber = rowIndex.get(candidateId);
        if (rowNumber === undefined) return { action: SYNC_ACTION.APPEND, candidateId, rowNumber: null, changedColumns: [] };
        const differences = changedColumns(expected, readRowCells(rowNumber), layout);
        return {
            action: differences.length ? SYNC_ACTION.UPDATE : SYNC_ACTION.UNCHANGED,
            candidateId,
            rowNumber,
            changedColumns: differences,
        };
    }

    // The plan for one candidate, by unique ID.
    async function planCandidate(uniqueId) {
        const layout = await sheet.readLayout();
        const aggregate = await reader.findByUniqueId(uniqueId);
        if (!aggregate) return { action: SYNC_ACTION.NOT_IN_DATABASE, candidateId: uniqueId, rowNumber: null, changedColumns: [] };
        const expected = mapCandidateToSheetRow(aggregate, { mirroredAt: clock() });
        const { index } = buildCandidateRowIndex(await sheet.readCandidateIds(layout));
        const rowNumber = index.get(aggregate.user.uniqueId);
        const existing = rowNumber === undefined ? null : (await sheet.readRow(rowNumber, layout)).cells;
        return planFor(aggregate, expected, index, () => existing, layout);
    }

    // Plans for one database batch (readBatch's page), reading the Sheet once.
    async function planBatch({ afterUniqueId = null, limit } = {}) {
        const layout = await sheet.readLayout();
        const { aggregates, nextCursor } = await reader.readBatch({ afterUniqueId, ...(limit === undefined ? {} : { limit }) });
        const rows = await sheet.readRows(layout);
        const { index, blankRows } = buildCandidateRowIndex(rows.map((r) => ({ rowNumber: r.rowNumber, candidateId: r.cells[SYSTEM_CANDIDATE_ID_INDEX] })));
        const cellsByRow = new Map(rows.map((r) => [r.rowNumber, r.cells]));
        const mirroredAt = clock();
        const plans = aggregates.map((aggregate) =>
            planFor(aggregate, mapCandidateToSheetRow(aggregate, { mirroredAt }), index, (n) => cellsByRow.get(n), layout));
        return { plans, nextCursor, blankSheetRows: blankRows };
    }

    return Object.freeze({ planCandidate, planBatch });
}
