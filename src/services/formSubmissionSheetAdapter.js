// Google Sheets adapter for the "Candidate Form Submissions" tab. The counterpart of
// googleSheetsAdapter.js for the other tab: it uses the same live client (Application Default
// Credentials, no key file), the same error classes and the same write gate, and knows only this
// tab's columns (formSubmissionSheetSchema.js). The operational mirror's adapter and schema are
// untouched, and nothing here can reach the mirror's tab (the sync refuses a destination whose
// mirror tab is this tab, formSubmissionSync.js).
//
//   readHeader()                row 1
//   readLayout({ initialize })  row 1 -> the live layout; an EMPTY row 1 (a new tab) gets our
//                               headers when initialize is set and the gate is enabled; any
//                               other row 1 is validated by header text and never modified
//   readSubmissionIds(layout)   Map(_SUBMISSION_ID -> first data row number carrying it)
//   writeRows({ updates, appends }, layout)  rewrites rows (by row number) and appends new ones
// Writes: the gate first (a disabled sync never reaches Google), then the row checks, then a
// re-read of row 1 (a header that moved or changed since the layout was read stops the write:
// SheetLayoutChangedError), RAW values (nothing is parsed as a formula), existing rows only in
// our columns' ranges. There is no clear, delete or reset operation of any kind.
// Errors carry an HTTP status, a Google reason code and a class, never Google's message text.

import {
    SheetLayoutChangedError,
    SheetSchemaMismatchError,
    SheetSyncDisabledError,
    SheetsAdapterError,
    classifySheetsError,
    createLiveSheetsClient,
} from "./googleSheetsAdapter.js";
import {
    FORM_SUBMISSION_FIRST_DATA_ROW,
    FORM_SUBMISSION_HEADERS,
    assertSubmissionRow,
    formAppendRange,
    formHeaderRange,
    formHeaderWriteRange,
    formWriteRangesFor,
    readFormSubmissionLayout,
    submissionIdRange,
    toLiveRow,
} from "./formSubmissionSheetSchema.js";

// config: { enabled, spreadsheetId, tabName }. sheetsClient: an object shaped like the official
// client, or a factory returning one (default: the live client, created on first use).
export function createFormSubmissionSheetsAdapter({ config, sheetsClient = createLiveSheetsClient } = {}) {
    if (!config || typeof config !== "object") throw new Error("Candidate Form Submissions sheet configuration is required");
    const { spreadsheetId, tabName } = config;

    let client = null;
    const getClient = async () => {
        if (!client) client = typeof sheetsClient === "function" ? await sheetsClient() : sheetsClient;
        return client;
    };
    const requireTarget = () => {
        if (!spreadsheetId || !tabName) throw new Error("A spreadsheet ID and the Candidate Form Submissions tab name are required");
    };
    const call = async (run) => {
        requireTarget();
        const values = (await getClient()).spreadsheets.values;
        try {
            return await run(values);
        } catch (error) {
            throw new SheetsAdapterError(classifySheetsError(error));
        }
    };
    const readRange = (range) => call(async (values) => {
        const response = await values.get({ spreadsheetId, range, majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
        return response?.data?.values ?? [];
    });
    const requireGate = () => {
        if (config.enabled !== true) throw new SheetSyncDisabledError();
    };

    const readHeader = async () => ((await readRange(formHeaderRange(tabName)))[0] ?? []).map((cell) => (cell === undefined || cell === null ? "" : String(cell)));

    // The live layout. A tab with no header at all gets ours (initialize + enabled); a header with
    // missing or repeated columns is SheetSchemaMismatchError and is never "repaired".
    const readLayout = async ({ initialize = false } = {}) => {
        let read = readFormSubmissionLayout(await readHeader());
        if (read.empty && initialize) {
            requireGate();
            await call((values) => values.update({
                spreadsheetId,
                range: formHeaderWriteRange(tabName),
                valueInputOption: "RAW",
                requestBody: { majorDimension: "ROWS", values: [[...FORM_SUBMISSION_HEADERS]] },
            }));
            read = readFormSubmissionLayout(await readHeader());
        }
        if (read.empty) {
            // A tab with no header (and no permission or reason to create one): every column is missing.
            throw new SheetSchemaMismatchError(FORM_SUBMISSION_HEADERS.map((header) => ({ problem: "MISSING", header, expected: 1, found: 0, columns: [] })));
        }
        if (!read.valid) throw new SheetSchemaMismatchError(read.problems);
        return read.layout;
    };

    const confirmLayout = async (layout) => {
        const current = readFormSubmissionLayout(await readHeader());
        if (!current.valid) throw new SheetSchemaMismatchError(current.problems);
        const same = current.layout.width === layout.width && current.layout.header.every((h, i) => h === layout.header[i]);
        if (!same) throw new SheetLayoutChangedError();
    };

    return Object.freeze({
        readHeader,
        readLayout,

        // Map(submissionId -> row number of its first occurrence) and how many extra copies exist.
        async readSubmissionIds(layout) {
            const rows = await readRange(submissionIdRange(tabName, layout));
            const ids = new Map();
            let duplicates = 0;
            rows.forEach((row, offset) => {
                const id = row?.[0] === undefined ? "" : String(row[0]);
                if (id === "") return;
                if (ids.has(id)) duplicates += 1;
                else ids.set(id, FORM_SUBMISSION_FIRST_DATA_ROW + offset);
            });
            return { ids, duplicates };
        },

        async writeRows({ updates = [], appends = [] } = {}, layout) {
            requireGate();
            requireTarget();
            for (const update of updates) {
                if (!Number.isSafeInteger(update.rowNumber) || update.rowNumber < FORM_SUBMISSION_FIRST_DATA_ROW) {
                    throw new Error(`A data row number must be a whole number from ${FORM_SUBMISSION_FIRST_DATA_ROW}`);
                }
            }
            [...updates.map((u) => u.cells), ...appends].forEach(assertSubmissionRow);
            if (!updates.length && !appends.length) return { updated: 0, appended: 0 };
            await confirmLayout(layout);
            await call(async (values) => {
                if (updates.length) {
                    await values.batchUpdate({
                        spreadsheetId,
                        requestBody: {
                            valueInputOption: "RAW",
                            data: updates.flatMap((u) => formWriteRangesFor(tabName, u.rowNumber, layout, u.cells).map((w) => ({ range: w.range, majorDimension: "ROWS", values: w.values }))),
                        },
                    });
                }
                if (appends.length) {
                    await values.append({
                        spreadsheetId,
                        range: formAppendRange(tabName, layout),
                        valueInputOption: "RAW",
                        insertDataOption: "INSERT_ROWS",
                        requestBody: { majorDimension: "ROWS", values: appends.map((cells) => toLiveRow(cells, layout)) },
                    });
                }
            });
            return { updated: updates.length, appended: appends.length };
        },
    });
}

