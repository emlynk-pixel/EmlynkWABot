import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    clientFolderPath,
    extensionForMimeType,
    joinStoragePath,
    pendingFolderPath,
    sanitizeFileName,
    standardFileName,
    timestampFileName,
    withNumericSuffix,
} from "../src/utils/storageNaming.js";

// Synthetic IDs only.
const PASSPORT_ID = "N1234567";
const TEMPORARY_ID = "3f2b8c1e-9a4d-4e6f-8b21-0c5d7e9f1a2b";

describe("extensionForMimeType", () => {
    test("PDF, JPEG and PNG", () => {
        assert.equal(extensionForMimeType("application/pdf"), ".pdf");
        assert.equal(extensionForMimeType("image/jpeg"), ".jpeg");
        assert.equal(extensionForMimeType("image/png"), ".png");
    });

    test("anything else is refused", () => {
        assert.throws(() => extensionForMimeType("application/x-msdownload"));
        assert.throws(() => extensionForMimeType(undefined));
    });
});

describe("clientFolderPath", () => {
    test("passport", () => assert.equal(clientFolderPath(PASSPORT_ID, "PASSPORT"), "clients/N1234567/passport"));
    test("police report", () => assert.equal(clientFolderPath(PASSPORT_ID, "POLICE_REPORT"), "clients/N1234567/police-report"));
    test("medical", () => assert.equal(clientFolderPath(PASSPORT_ID, "MEDICAL"), "clients/N1234567/medical"));

    test("UNKNOWN documents have no client folder", () => {
        assert.throws(() => clientFolderPath(PASSPORT_ID, "UNKNOWN"));
    });

    test("a passport ID containing path characters is refused", () => {
        for (const bad of ["../N1234567", "N123/4567", "N123\\4567", "", null]) {
            assert.throws(() => clientFolderPath(bad, "PASSPORT"), undefined, String(bad));
        }
    });
});

describe("pendingFolderPath", () => {
    test("uses unique_id when the client is known", () => {
        assert.equal(pendingFolderPath({ uniqueId: "0001", temporaryId: TEMPORARY_ID }), "pending/0001/undefined/uncleared-docs");
    });

    test("falls back to unidentified/{temporary_id} without a unique_id", () => {
        assert.equal(
            pendingFolderPath({ uniqueId: null, temporaryId: TEMPORARY_ID }),
            `pending/unidentified/${TEMPORARY_ID}/undefined/uncleared-docs`
        );
    });

    test("never contains a WhatsApp number (there is no input for one)", () => {
        const path = pendingFolderPath({ uniqueId: null, temporaryId: TEMPORARY_ID });
        assert.doesNotMatch(path, /94\d{9}/);
    });

    test("unsafe IDs are refused", () => {
        assert.throws(() => pendingFolderPath({ uniqueId: "../0001", temporaryId: TEMPORARY_ID }));
        assert.throws(() => pendingFolderPath({ uniqueId: null, temporaryId: "../../clients" }));
        assert.throws(() => pendingFolderPath({ uniqueId: null, temporaryId: null }));
    });
});

describe("standardFileName", () => {
    test("first version has no suffix", () => {
        assert.equal(standardFileName("PASSPORT", 1, ".pdf"), "passport.pdf");
        assert.equal(standardFileName("POLICE_REPORT", 1, ".jpeg"), "police_report.jpeg");
        assert.equal(standardFileName("MEDICAL", 1, ".png"), "medical.png");
    });

    test("later versions: _v2, _v3", () => {
        assert.equal(standardFileName("PASSPORT", 2, ".pdf"), "passport_v2.pdf");
        assert.equal(standardFileName("PASSPORT", 3, ".pdf"), "passport_v3.pdf");
    });

    test("invalid type or version is refused", () => {
        assert.throws(() => standardFileName("UNKNOWN", 1, ".pdf"));
        assert.throws(() => standardFileName("PASSPORT", 0, ".pdf"));
        assert.throws(() => standardFileName("PASSPORT", 1.5, ".pdf"));
    });
});

describe("timestampFileName", () => {
    const date = new Date("2026-09-24T07:05:03Z");

    test("document_YYYYMMDD_HHMMSS.ext in UTC", () => {
        assert.equal(timestampFileName(date, ".jpeg"), "document_20260924_070503.jpeg");
    });
});

describe("sanitizeFileName", () => {
    const clean = (name, ext = ".pdf") => sanitizeFileName(name, ext);

    test("ordinary name keeps its base, gets the MIME extension", () => {
        assert.equal(clean("police_clearance.pdf"), "police_clearance.pdf");
        assert.equal(clean("Report.PDF"), "Report.pdf");
    });

    test("the sender's extension is never trusted", () => {
        assert.equal(clean("scan.exe"), "scan.pdf");
        assert.equal(clean("photo.png", ".jpeg"), "photo.jpeg");
    });

    test("spaces and unusual characters become underscores", () => {
        assert.equal(clean("My Police Report (final).pdf"), "My_Police_Report_final.pdf");
    });

    test("accents are simplified", () => {
        assert.equal(clean("résumé médical.pdf"), "resume_medical.pdf");
    });

    test("path traversal is removed", () => {
        for (const name of ["../../etc/passwd", "..\\..\\clients\\x.pdf", "a/../../b.pdf", "....//x.pdf"]) {
            const result = clean(name);
            assert.ok(result, name);
            assert.doesNotMatch(result, /\.\.|[\\/]/, `${name} -> ${result}`);
        }
        assert.equal(clean("../../etc/passwd"), "passwd.pdf");
        assert.equal(clean("..\\..\\clients\\x.pdf"), "x.pdf");
    });

    test("control characters are removed", () => {
        assert.equal(clean("scan\u0000\u0007\u001f.pdf"), "scan.pdf");
    });

    test("no hidden files (leading dots)", () => {
        assert.equal(clean(".hidden.pdf"), "hidden.pdf");
    });

    test("nothing usable left -> null (caller uses the fallback name)", () => {
        for (const name of ["", "   ", "...", "@@@.pdf", "ශ්‍රී ලංකා.pdf", null, undefined, 42]) {
            assert.equal(clean(name), null, JSON.stringify(name));
        }
    });

    test("very long names are shortened", () => {
        const result = clean(`${"a".repeat(300)}.pdf`);
        assert.equal(result, `${"a".repeat(100)}.pdf`);
    });
});

describe("withNumericSuffix", () => {
    test("first attempt keeps the name; later attempts add _2, _3", () => {
        assert.equal(withNumericSuffix("scan.pdf", 1), "scan.pdf");
        assert.equal(withNumericSuffix("scan.pdf", 2), "scan_2.pdf");
        assert.equal(withNumericSuffix("scan.pdf", 3), "scan_3.pdf");
        assert.equal(withNumericSuffix("document_20260924_070503.jpeg", 2), "document_20260924_070503_2.jpeg");
    });
});

describe("joinStoragePath", () => {
    test("folder + file name", () => {
        assert.equal(joinStoragePath("clients/N1234567/passport", "passport.pdf"), "clients/N1234567/passport/passport.pdf");
    });
});
