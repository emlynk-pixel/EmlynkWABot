// Google Sheet operational mirror: the sync ENGINE (Phase 3/4).
// (Docs/GOOGLE_SHEET_CANDIDATE_SYNC_ARCHITECTURE.md, Sections 7, 8.6 and 9.)
//
// Two operations, one mapper, one comparison:
//   syncCandidates(entries)  incremental: the candidates named by queue rows
//   reconcile()              every candidate in a complete database snapshot
//                            against every row of the Sheet
//
// Direction is strictly database -> Sheet. Nothing read from the Sheet is ever
// written to the database; the Sheet is only read to find rows (the
// _SYSTEM_CANDIDATE_ID column) and to compare cells.
//
// Columns are found by header name: each operation reads row 1 ONCE (the live
// layout) and uses it for every read and write; the next operation reads it
// again, so columns moved in between are found where they now are. Operator
// columns are never written (googleSheetsAdapter.js).
//
// Row identity is the _SYSTEM_CANDIDATE_ID column (= users.unique_id),
// wherever it is. Blank ID cells identify nobody. A unique ID present in more than one row is a hard
// data-integrity error (SheetDuplicateCandidateIdError): the whole operation
// stops before any write, and none of those rows is touched; nothing guesses
// which row is "right".
//
// Writes:
//   - only rows whose mirrored cells differ are rewritten (LAST MIRRORED AT
//     is ignored in the comparison and set on every write);
//   - missing candidates are appended (INSERT_ROWS);
//   - rows are NEVER cleared or deleted. A candidate deleted from the
//     database keeps its row; only RECORD STATUS and LAST MIRRORED AT
//     change, to "DELETED / INACTIVE":
//       incremental: only when the queue row says the users row was deleted
//         (trigger delete hint) AND a fresh read confirms it is gone;
//       reconciliation: only from a complete, count-verified snapshot, and
//         only while the number of rows to mark stays under the deletion
//         guard. Otherwise the row is left unchanged and reported
//         NOT_IN_DATABASE.
//   - dryRun: everything is read and compared, nothing is written (the write
//     gate SHEET_SYNC_ENABLED is off). The adapter refuses writes on its own
//     too while the gate is off.
//
// Results hold actions, unique IDs, row numbers, column letters and counts,
// never cell values (the cells are PII). Nothing here logs.

import { SYSTEM_CANDIDATE_ID_INDEX, columnOf, fieldIndex } from "./sheetSchema.js";
import { RECORD_STATUS, SheetMappingError, mapCandidateToSheetRow } from "./candidateSheetMapper.js";
import { buildCandidateRowIndex, changedColumns } from "./sheetSyncPlanner.js";

export const ENGINE_ACTION = Object.freeze({
    APPENDED: "APPENDED",
    UPDATED: "UPDATED",
    UNCHANGED: "UNCHANGED",
    MARKED_INACTIVE: "MARKED_INACTIVE",
    NOT_IN_DATABASE: "NOT_IN_DATABASE",
    MAPPING_FAILED: "MAPPING_FAILED",
});

// Field-ordered (canonical) indexes: the cells here are field-ordered, never live positions.
const RECORD_STATUS_INDEX = fieldIndex("recordStatus");
const LAST_MIRRORED_AT_INDEX = fieldIndex("lastMirroredAt");

// Rows per values.batchUpdate / values.append request in a reconciliation.
export const DEFAULT_WRITE_CHUNK = 200;

// YYYY-MM-DDTHH:mm:ssZ, like the mapper's LAST MIRRORED AT.
const utcTimestamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

// The existing row with RECORD STATUS = DELETED / INACTIVE and LAST MIRRORED
// AT = now; every other cell kept as it is (historical data is retained).
function inactiveRow(existingCells, mirroredAt) {
    const cells = [...existingCells];
    cells[RECORD_STATUS_INDEX] = RECORD_STATUS.DELETED_INACTIVE;
    cells[LAST_MIRRORED_AT_INDEX] = utcTimestamp(mirroredAt);
    return cells;
}

const isInactive = (cells) => cells?.[RECORD_STATUS_INDEX] === RECORD_STATUS.DELETED_INACTIVE;

// Whether marking `count` rows inactive is within the deletion guard: at most
// `max` rows AND at most `fraction` of the identified Sheet rows. An empty
// database snapshot never marks anything.
export function deletionGuardAllows({ count, identifiedRows, snapshotCount, max, fraction }) {
    if (count === 0) return true;
    if (snapshotCount === 0) return false;
    if (count > max) return false;
    return count <= Math.floor(fraction * identifiedRows);
}

// reader: candidateAggregateReader (findByUniqueIds, readSnapshot).
// sheets: the full Sheets adapter (writes go through its own gate).
// clock: () => Date for LAST MIRRORED AT.
export function createSheetSyncEngine({ reader, sheets, clock = () => new Date() } = {}) {
    if (!reader?.findByUniqueIds || !reader?.readSnapshot) throw new Error("A candidate aggregate reader is required");
    if (!sheets?.readLayout || !sheets?.writeRows) throw new Error("A Sheets adapter is required");

    // layout: the live layout this operation read (every system header present, in any order).
    async function write({ updates, appends, dryRun, chunkSize = DEFAULT_WRITE_CHUNK, beforeWrite, layout }) {
        if (dryRun) return;
        for (let i = 0; i < Math.max(updates.length, appends.length); i += chunkSize) {
            const chunk = { updates: updates.slice(i, i + chunkSize), appends: appends.slice(i, i + chunkSize) };
            if (!chunk.updates.length && !chunk.appends.length) continue;
            await beforeWrite?.();
            await sheets.writeRows(chunk, layout);
        }
    }

    // Incremental sync of the candidates named by queue rows.
    // entries: [{ uniqueId, candidateDeleted }] (one per candidate).
    // Returns Map(uniqueId -> { action, rowNumber, changedColumns }).
    // A Google, schema or duplicate-ID failure throws for the whole batch
    // (nothing is reported done); a candidate that can't be mapped is
    // reported MAPPING_FAILED and the others continue.
    async function syncCandidates(entries, { dryRun = false, beforeWrite } = {}) {
        const results = new Map();
        if (!entries.length) return results;
        const layout = await sheets.readLayout();
        const { index } = buildCandidateRowIndex(await sheets.readCandidateIds(layout));
        const aggregates = await reader.findByUniqueIds(entries.map((e) => e.uniqueId));
        const knownRows = entries.map((e) => index.get(e.uniqueId)).filter((n) => n !== undefined);
        const existing = knownRows.length ? await sheets.readRowsByNumber(knownRows, layout) : new Map();
        const mirroredAt = clock();
        const updates = [];
        const appends = [];

        for (const { uniqueId, candidateDeleted } of entries) {
            const rowNumber = index.get(uniqueId) ?? null;
            const current = rowNumber === null ? null : existing.get(rowNumber);
            const aggregate = aggregates.get(uniqueId);
            if (!aggregate) {
                // Only a confirmed deletion marks a row; an unknown ID changes nothing.
                if (candidateDeleted && current && !isInactive(current)) {
                    updates.push({ rowNumber, cells: inactiveRow(current, mirroredAt) });
                    results.set(uniqueId, { action: ENGINE_ACTION.MARKED_INACTIVE, rowNumber, changedColumns: [columnOf(layout, "recordStatus")] });
                } else {
                    results.set(uniqueId, { action: candidateDeleted && current ? ENGINE_ACTION.UNCHANGED : ENGINE_ACTION.NOT_IN_DATABASE, rowNumber, changedColumns: [] });
                }
                continue;
            }
            let expected;
            try {
                expected = mapCandidateToSheetRow(aggregate, { mirroredAt });
            } catch (error) {
                if (!(error instanceof SheetMappingError)) throw error;
                results.set(uniqueId, { action: ENGINE_ACTION.MAPPING_FAILED, rowNumber, changedColumns: [] });
                continue;
            }
            if (rowNumber === null) {
                appends.push(expected);
                results.set(uniqueId, { action: ENGINE_ACTION.APPENDED, rowNumber: null, changedColumns: [] });
                continue;
            }
            const differences = changedColumns(expected, current, layout);
            if (differences.length) updates.push({ rowNumber, cells: expected });
            results.set(uniqueId, { action: differences.length ? ENGINE_ACTION.UPDATED : ENGINE_ACTION.UNCHANGED, rowNumber, changedColumns: differences });
        }

        await write({ updates, appends, dryRun, beforeWrite, layout });
        return results;
    }

    // Full reconciliation. guard: { max, fraction } (deletion guard).
    // beforeWrite: called before each write chunk (lease renewal); throwing
    // stops the run. Returns a summary of counts (no candidate data).
    async function reconcile({ dryRun = false, guard, chunkSize = DEFAULT_WRITE_CHUNK, beforeWrite } = {}) {
        if (!guard || !Number.isFinite(guard.max) || !Number.isFinite(guard.fraction)) throw new Error("A deletion guard is required");
        const layout = await sheets.readLayout();

        // The Sheet first: a duplicate ID stops everything before the
        // database is read and before any write.
        const rows = await sheets.readRows(layout);
        const { index, blankRows } = buildCandidateRowIndex(rows.map((r) => ({ rowNumber: r.rowNumber, candidateId: r.cells[SYSTEM_CANDIDATE_ID_INDEX] })));
        const cellsByRow = new Map(rows.map((r) => [r.rowNumber, r.cells]));

        // Complete, count-verified snapshot, or the run stops here.
        const { aggregates, count: snapshotCount } = await reader.readSnapshot();
        const mirroredAt = clock();
        const updates = [];
        const appends = [];
        const summary = {
            dryRun, sheetRows: rows.length, identifiedSheetRows: index.size, blankIdRows: blankRows, databaseCandidates: snapshotCount,
            appended: 0, updated: 0, unchanged: 0, mappingFailed: 0, markedInactive: 0, alreadyInactive: 0, notInDatabase: 0,
            deletionGuardTriggered: false,
        };

        for (const aggregate of aggregates) {
            const uniqueId = aggregate.user.uniqueId;
            let expected;
            try {
                expected = mapCandidateToSheetRow(aggregate, { mirroredAt });
            } catch (error) {
                if (!(error instanceof SheetMappingError)) throw error;
                summary.mappingFailed += 1;
                continue;
            }
            const rowNumber = index.get(uniqueId);
            if (rowNumber === undefined) {
                appends.push(expected);
                summary.appended += 1;
            } else if (changedColumns(expected, cellsByRow.get(rowNumber), layout).length) {
                updates.push({ rowNumber, cells: expected });
                summary.updated += 1;
            } else {
                summary.unchanged += 1;
            }
        }

        // Identified Sheet rows with no candidate in the (complete) snapshot.
        const inDatabase = new Set(aggregates.map((a) => a.user.uniqueId));
        const toMark = [];
        for (const [uniqueId, rowNumber] of index) {
            if (inDatabase.has(uniqueId)) continue;
            const cells = cellsByRow.get(rowNumber);
            if (isInactive(cells)) summary.alreadyInactive += 1;
            else toMark.push({ rowNumber, cells });
        }
        if (deletionGuardAllows({ count: toMark.length, identifiedRows: index.size, snapshotCount, ...guard })) {
            for (const { rowNumber, cells } of toMark) updates.push({ rowNumber, cells: inactiveRow(cells, mirroredAt) });
            summary.markedInactive = toMark.length;
        } else {
            summary.deletionGuardTriggered = true;
            summary.notInDatabase = toMark.length;
        }

        await write({ updates, appends, dryRun, chunkSize, beforeWrite, layout });
        return summary;
    }

    // Read-only: the header is valid and no candidate ID is duplicated.
    // Throws the same errors a sync would. Used to leave a halted state.
    async function checkTarget() {
        const layout = await sheets.readLayout();
        const { index, blankRows } = buildCandidateRowIndex(await sheets.readCandidateIds(layout));
        return { identifiedSheetRows: index.size, blankIdRows: blankRows };
    }

    return Object.freeze({ syncCandidates, reconcile, checkTarget });
}
