// Column AN (_SYSTEM_CANDIDATE_ID) identity: whitespace around a typed or
// pasted ID must not hide the row (which would plan a duplicate APPEND) nor
// hide a duplicate. Only an in-memory Sheet is used; Google is never reached.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { mapCandidateToSheetRow } from "../src/services/candidateSheetMapper.js";
import { SYNC_ACTION, SheetDuplicateCandidateIdError, buildCandidateRowIndex, createSheetSyncPlanner } from "../src/services/sheetSyncPlanner.js";
import { SYSTEM_CANDIDATE_ID_INDEX } from "../src/services/sheetSchema.js";

const TAB = "Fake Tab";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const aggregate = {
    user: {
        passportId: "SYNPASS03", uniqueId: "0003", firstName: "GIVEN THREE", otherName: "SURNAME THREE",
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"), placeOfBirth: null, passportExpiryDate: null, passportIssueDate: null,
        address: "3 Example Road", job: "Job Three", nic: "000000003V", jobExperience: "Example", whatsappNumber: "94700000003",
        contactNumber: null, nationality: null, sex: null, createdDate: new Date("2026-10-01T10:00:00.000Z"),
    },
    stages: [],
    documents: [],
};

function plannerFor(rows) {
    const sheet = createFakeGoogleSheet({ tabName: TAB, rows });
    const sheets = createGoogleSheetsAdapter({ config: { enabled: false, spreadsheetId: "fake-id", tabName: TAB }, sheetsClient: sheet.client });
    const reader = {
        findByUniqueId: async (id) => (id === "0003" ? structuredClone(aggregate) : null),
        readBatch: async () => ({ aggregates: [structuredClone(aggregate)], nextCursor: null }),
    };
    return { sheet, planner: createSheetSyncPlanner({ reader, sheets, clock: () => NOW }) };
}

const rowWithId = (id) => {
    const cells = mapCandidateToSheetRow(aggregate, { mirroredAt: NOW });
    cells[SYSTEM_CANDIDATE_ID_INDEX] = id;
    return cells;
};

describe("AN identity ignores surrounding whitespace", () => {
    test("whitespace around AN still maps to the clean candidate ID and does not plan an APPEND", async () => {
        const { index, blankRows } = buildCandidateRowIndex([
            { rowNumber: 2, candidateId: "0003 " },
            { rowNumber: 3, candidateId: " 0004 " },
            { rowNumber: 4, candidateId: "   " },
        ]);
        assert.deepEqual([...index], [["0003", 2], ["0004", 3]]);
        assert.equal(blankRows, 1);

        for (const id of ["0003 ", " 0003 ", "\t0003"]) {
            const { planner, sheet } = plannerFor([rowWithId(id)]);
            const single = await planner.planCandidate("0003");
            assert.notEqual(single.action, SYNC_ACTION.APPEND);
            assert.deepEqual([single.candidateId, single.rowNumber], ["0003", 2]);
            const { plans } = await planner.planBatch({ limit: 10 });
            assert.deepEqual(plans.map((p) => [p.action === SYNC_ACTION.APPEND, p.rowNumber]), [[false, 2]]);
            assert.deepEqual(sheet.writes(), []);
        }
    });

    test('"0003" and "0003 " are a duplicate candidate ID: the existing data-integrity error, nothing planned', async () => {
        assert.throws(
            () => buildCandidateRowIndex([{ rowNumber: 2, candidateId: "0003" }, { rowNumber: 5, candidateId: "0003 " }]),
            (error) => error instanceof SheetDuplicateCandidateIdError
                && error.errorClass === "DATA_INTEGRITY"
                && JSON.stringify(error.duplicates) === JSON.stringify([{ candidateId: "0003", rowNumbers: [2, 5] }]),
        );

        const { planner, sheet } = plannerFor([rowWithId("0003"), rowWithId("0003 ")]);
        await assert.rejects(planner.planCandidate("0003"), SheetDuplicateCandidateIdError);
        await assert.rejects(planner.planBatch({ limit: 10 }), SheetDuplicateCandidateIdError);
        assert.deepEqual(sheet.writes(), []);
    });
});
