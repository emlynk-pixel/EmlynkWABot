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
// Row identity is column AN (_SYSTEM_CANDIDATE_ID) = users.unique_id, and
// nothing else: blank AN cells identify no one, a duplicate AN value stops
// planning (never a guess which row is "right"), and the passport number or
// NIC is never used as a fallback key.
//
// Plans hold no cell values (no PII): the action, the unique ID, the row
// number and the letters of the columns that differ.

import { SHEET_COLUMNS, SYSTEM_CANDIDATE_ID_COLUMN, SYSTEM_CANDIDATE_ID_INDEX } from "./sheetSchema.js";
import { mapCandidateToSheetRow } from "./candidateSheetMapper.js";
import { SheetSchemaMismatchError, readOnlySheetsView } from "./googleSheetsAdapter.js";

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
        super(`The Sheet has ${duplicates.length} duplicated ${SYSTEM_CANDIDATE_ID_COLUMN} candidate ID(s); nothing can be planned until they are resolved`);
        this.name = "SheetDuplicateCandidateIdError";
        this.errorClass = "DATA_INTEGRITY";
        // [{ candidateId, rowNumbers }]: internal IDs and row numbers only.
        this.duplicates = duplicates;
    }
}

// LAST MIRRORED AT changes on every write, so it never makes a row "different".
const IGNORED_FOR_COMPARISON = new Set(["lastMirroredAt"]);

// [{ rowNumber, candidateId }] (column AN) -> Map(candidateId -> rowNumber).
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

// Column letters where the Sheet row differs from the expected row.
export function changedColumns(expectedCells, actualCells) {
    return SHEET_COLUMNS
        .filter((c) => !IGNORED_FOR_COMPARISON.has(c.field) && expectedCells[c.index] !== (actualCells?.[c.index] ?? ""))
        .map((c) => c.column);
}

// reader: createCandidateAggregateReader(...); sheets: a Sheets adapter (only
// its read methods are kept); clock: () => Date, the LAST MIRRORED AT time.
export function createSheetSyncPlanner({ reader, sheets, clock = () => new Date() } = {}) {
    if (!reader?.findByUniqueId) throw new Error("A candidate aggregate reader is required");
    const sheet = readOnlySheetsView(sheets);

    // The Sheet must have the exact 40-column header before anything is planned.
    async function requireValidSchema() {
        const schema = await sheet.validateSchema();
        if (!schema.valid) throw new SheetSchemaMismatchError(schema.mismatches);
    }

    async function loadRowIndex() {
        return buildCandidateRowIndex(await sheet.readCandidateIds());
    }

    function planFor(aggregate, expected, rowIndex, readRowCells) {
        const candidateId = aggregate.user.uniqueId;
        const rowNumber = rowIndex.get(candidateId);
        if (rowNumber === undefined) return { action: SYNC_ACTION.APPEND, candidateId, rowNumber: null, changedColumns: [] };
        const differences = changedColumns(expected, readRowCells(rowNumber));
        return {
            action: differences.length ? SYNC_ACTION.UPDATE : SYNC_ACTION.UNCHANGED,
            candidateId,
            rowNumber,
            changedColumns: differences,
        };
    }

    // The plan for one candidate, by unique ID.
    async function planCandidate(uniqueId) {
        await requireValidSchema();
        const aggregate = await reader.findByUniqueId(uniqueId);
        if (!aggregate) return { action: SYNC_ACTION.NOT_IN_DATABASE, candidateId: uniqueId, rowNumber: null, changedColumns: [] };
        const expected = mapCandidateToSheetRow(aggregate, { mirroredAt: clock() });
        const { index } = await loadRowIndex();
        const rowNumber = index.get(aggregate.user.uniqueId);
        const existing = rowNumber === undefined ? null : (await sheet.readRow(rowNumber)).cells;
        return planFor(aggregate, expected, index, () => existing);
    }

    // Plans for one database batch (readBatch's page), reading the Sheet once.
    async function planBatch({ afterUniqueId = null, limit } = {}) {
        await requireValidSchema();
        const { aggregates, nextCursor } = await reader.readBatch({ afterUniqueId, ...(limit === undefined ? {} : { limit }) });
        const rows = await sheet.readRows();
        const { index, blankRows } = buildCandidateRowIndex(rows.map((r) => ({ rowNumber: r.rowNumber, candidateId: r.cells[SYSTEM_CANDIDATE_ID_INDEX] })));
        const cellsByRow = new Map(rows.map((r) => [r.rowNumber, r.cells]));
        const mirroredAt = clock();
        const plans = aggregates.map((aggregate) =>
            planFor(aggregate, mapCandidateToSheetRow(aggregate, { mirroredAt }), index, (n) => cellsByRow.get(n)));
        return { plans, nextCursor, blankSheetRows: blankRows };
    }

    return Object.freeze({ planCandidate, planBatch });
}
