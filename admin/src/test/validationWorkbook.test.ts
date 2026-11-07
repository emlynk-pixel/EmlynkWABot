import { describe, expect, test } from "vitest";
import ExcelJS from "exceljs";
import { buildValidationWorkbook, validationFileName } from "../components/validationWorkbook";
import type { ImportRowIssues } from "../api/candidateImport";

// The validation sheet: a copy of the uploaded workbook + ERRORS / WARNINGS columns on its first sheet.
// SYNTHETIC rows only. Workbooks are built and read back with the same library.

async function workbookBytes(build: (workbook: ExcelJS.Workbook) => void): Promise<ArrayBuffer> {
    const workbook = new ExcelJS.Workbook();
    build(workbook);
    return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

async function read(bytes: ArrayBuffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    return workbook;
}

function legacySheet(workbook: ExcelJS.Workbook, extraHeaders: string[] = []) {
    const sheet = workbook.addWorksheet("Candidates");
    sheet.addRow(["PASSPORT NUMBER", "NIC NUMBER", "OFFICER", "JOB ROLE", ...extraHeaders]);
    sheet.addRow(["N8000001", "700000001V", "John", "Plaster"]);
    sheet.addRow(["", "700000002V", "John", "Plaster"]);
    sheet.addRow(["N8000003", "", "John", ""]);
    sheet.addRow(["N8000004", "123", "Unknown", "Plaster"]);
    sheet.getCell("F2").value = { formula: "LEN(A2)", result: 8 };
    const notes = workbook.addWorksheet("Notes");
    notes.addRow(["kept as it is"]);
    return sheet;
}

const ISSUES: ImportRowIssues[] = [
    { rowNumber: 3, errors: ["Passport number is missing"], warnings: [] },
    { rowNumber: 4, errors: ["Job role is missing"], warnings: ["NIC number is missing"] },
    { rowNumber: 5, errors: ["Officer does not match a system user"], warnings: ["NIC NUMBER format is invalid", "WhatsApp number is missing"] },
];

const headersOf = (sheet: ExcelJS.Worksheet) => Array.from({ length: sheet.getRow(1).cellCount }, (_, i) => sheet.getRow(1).getCell(i + 1).text);

describe("validation workbook", () => {
    test("15-23. ERRORS and WARNINGS are added at the end; each row gets its own messages; a clean row stays blank; nothing else changes", async () => {
        const source = await workbookBytes((workbook) => legacySheet(workbook));
        const before = new Uint8Array(source.slice(0));
        const out = await read(await buildValidationWorkbook(source, ISSUES));
        const sheet = out.worksheets[0];

        expect(sheet.name).toBe("Candidates");
        expect(headersOf(sheet)).toEqual(["PASSPORT NUMBER", "NIC NUMBER", "OFFICER", "JOB ROLE", "", "", "ERRORS", "WARNINGS"]);
        // Existing values (and the formula) where they were.
        expect(sheet.getCell("A2").value).toBe("N8000001");
        expect(sheet.getCell("B5").value).toBe("123");
        expect(sheet.getCell("C5").value).toBe("Unknown");
        expect(sheet.getCell("F2").formula).toBe("LEN(A2)");
        // Row by row.
        expect(sheet.getCell("G2").value ?? null).toBeNull();
        expect(sheet.getCell("H2").value ?? null).toBeNull();
        expect(sheet.getCell("G3").value).toBe("Passport number is missing");
        expect(sheet.getCell("H3").value ?? null).toBeNull();
        expect(sheet.getCell("G4").value).toBe("Job role is missing");
        expect(sheet.getCell("H4").value).toBe("NIC number is missing");
        expect(sheet.getCell("H5").value).toBe("NIC NUMBER format is invalid\nWhatsApp number is missing");
        expect(sheet.getCell("H5").alignment?.wrapText).toBe(true);
        // The other sheet is kept; the source bytes are untouched (26).
        expect(out.worksheets.map((w) => w.name)).toEqual(["Candidates", "Notes"]);
        expect(out.worksheets[1].getCell("A1").value).toBe("kept as it is");
        expect(new Uint8Array(source)).toEqual(before);
    });

    test("24. existing ERRORS / WARNINGS columns are reused (any case), old messages cleared, never ERRORS_2", async () => {
        const source = await workbookBytes((workbook) => {
            const sheet = legacySheet(workbook, ["", "", "Errors", " warnings "]);
            sheet.getCell("G2").value = "an old error";
            sheet.getCell("H4").value = "an old warning";
        });
        const sheet = (await read(await buildValidationWorkbook(source, ISSUES))).worksheets[0];
        expect(headersOf(sheet)).toEqual(["PASSPORT NUMBER", "NIC NUMBER", "OFFICER", "JOB ROLE", "", "", "ERRORS", "WARNINGS"]);
        expect(sheet.getCell("G2").value ?? null).toBeNull();
        expect(sheet.getCell("H4").value).toBe("NIC number is missing");
        expect(sheet.getCell("I1").value ?? null).toBeNull();
    });

    test("no issues: both columns are added with no messages", async () => {
        const source = await workbookBytes((workbook) => legacySheet(workbook));
        const sheet = (await read(await buildValidationWorkbook(source, []))).worksheets[0];
        expect(headersOf(sheet).slice(-2)).toEqual(["ERRORS", "WARNINGS"]);
        for (const row of [2, 3, 4, 5]) expect(sheet.getRow(row).getCell(7).value ?? null).toBeNull();
    });

    test("the file name says it is the validation copy", () => {
        expect(validationFileName("Legacy Candidates.xlsx")).toBe("Legacy Candidates - validation.xlsx");
        expect(validationFileName("sheet.XLSX")).toBe("sheet - validation.xlsx");
    });
});
