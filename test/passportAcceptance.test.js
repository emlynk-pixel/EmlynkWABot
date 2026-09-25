import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    evaluatePassportAcceptance,
    applyPassportAcceptance,
    PASSPORT_ACCEPTANCE_FLAG,
} from "../src/services/passportAcceptanceService.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";

// All people, numbers and documents are synthetic. passport-mrz.txt holds
// N1234567, born 1990-03-12, expiring 2030-05-11, with a valid MRZ.
const TEMP_ID = "tmp-1";
const TEMP_PATH = "temporary/tmp-1.pdf";
const NOW = new Date("2026-09-24T07:05:03Z");
const LOW_OCR = 34; // a typical company passport scan
const SENDER = "94771234567"; // WhatsApp on record for N1234567
const FILE = Buffer.from("%PDF-1.4 synthetic low-quality passport scan");
const FILE_SHA = sha256Hex(FILE);

const PASSPORT_TEXT = loadDocumentText("passport-mrz");
const MRZ_LINE_1 = "P<LKAPERERA<<KAMAL<NIMAL<<<<<<<<<<<<<<<<<<<<";
const MRZ_LINE_2 = "N1234567<7LKA9003129M3005110<<<<<<<<<<<<<<02";

// Replace one character of MRZ line 2 (e.g. a check digit).
const withMrzLine2Char = (index, char) =>
    PASSPORT_TEXT.replace(MRZ_LINE_2, MRZ_LINE_2.slice(0, index) + char + MRZ_LINE_2.slice(index + 1));

const makeUsers = (overrides = {}) => [
    {
        passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567",
        firstName: "KAMAL NIMAL", otherName: "PERERA",
        dateOfBirth: new Date("1990-03-12T00:00:00Z"),
        passportExpiryDate: new Date("2030-05-11T00:00:00Z"),
        placeOfBirth: null,
        ...overrides,
    },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333", firstName: "NIMAL" },
];

const ocrText = (text, confidence) => async () => ({ success: true, method: "OCR", text, confidence });

async function run({ text = PASSPORT_TEXT, confidence = LOW_OCR, sender = SENDER, fileName = "scan.pdf", users = makeUsers(), documents = [] } = {}) {
    const db = createFakePrisma(users, { documents });
    const bucket = createFakeBucket([TEMP_PATH]);
    const { summary } = await processDocument({
        temporaryId: TEMP_ID,
        whatsappNumber: sender,
        fileName,
        mimeType: "application/pdf",
        fileBuffer: FILE,
        temporaryStoragePath: TEMP_PATH,
        deps: { db, bucket, now: NOW, extractText: ocrText(text, confidence) },
    });
    const objects = [...bucket.objects.keys()];
    const recordUpdate = db.calls.filter((c) => c.method === "temporaryData.update").at(-1);
    return { summary, db, objects, recordUpdate };
}

// The rule did not apply: the flag is absent and nothing is in a client folder.
function assertNotAccepted({ summary, objects, db }) {
    assert.ok(!summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
    assert.ok(!objects.some((path) => path.startsWith("clients/")), "must not reach a client folder");
    assert.equal(db.documentRows.length, 0);
    assert.equal(summary.confidence.document, LOW_OCR, "measured confidence unchanged");
}

describe("low-quality passport accepted by MRZ + identity", () => {
    test("positive: OCR 34, verified MRZ fields, VERIFIED_MATCH, DOB + expiry matched -> client folder for review", async () => {
        const { summary, db, objects, recordUpdate } = await run();

        // The measured values are reported as they are.
        assert.equal(summary.confidence.extraction, LOW_OCR);
        assert.ok(summary.confidence.classification >= 90);
        assert.equal(summary.confidence.document, LOW_OCR);
        assert.equal(summary.confidence.measuredBand, "UNDEFINED");
        assert.equal(summary.passport.mrzLinesFound, 2);
        assert.equal(summary.passport.passportIdBand, "VERIFIED");
        assert.equal(summary.identity.status, "VERIFIED_MATCH");

        // Stored for review, never as VERIFIED.
        assert.equal(summary.confidence.band, "UNCLEAR");
        assert.ok(summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
        assert.deepEqual(summary.passportAcceptance, { accepted: true, failedConditions: [] });
        assert.equal(summary.processingStatus, "UNCLEAR");
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");

        assert.ok(objects.includes("clients/N1234567/passport/scan.pdf"));
        const [row] = db.documentRows;
        assert.equal(row.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(Number(row.ocrConfidence), LOW_OCR, "stored confidence is the real one");
        assert.equal(recordUpdate.data.passportId, "N1234567");
        assert.equal(recordUpdate.data.pendingStoragePath, undefined);
    });

    test("positive: placeOfBirth (printed zone at 34%) is not filled into the client record", async () => {
        const { db } = await run();
        const writes = db.calls.filter((c) => c.method === "user.updateMany");
        assert.ok(writes.every((c) => !("placeOfBirth" in c.data)));
        assert.equal(db.rows.find((u) => u.passportId === "N1234567").placeOfBirth, null);
    });

    test("composite MRZ check is logged but not required", async () => {
        const { summary } = await run({ text: withMrzLine2Char(43, "9") }); // break only the composite digit
        assert.equal(summary.passport.mrzCompositeCheckValid, false);
        assert.equal(summary.storage.placement, "CLIENT");
        assert.ok(summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
    });

    const negativeCases = [
        ["passport ID check digit fails", { text: withMrzLine2Char(9, "8") }, "PASSPORT_ID_VERIFIED"],
        ["DOB check digit fails", { text: withMrzLine2Char(19, "8") }, "DATE_OF_BIRTH_VERIFIED"],
        ["expiry check digit fails", { text: withMrzLine2Char(27, "1") }, "EXPIRY_DATE_VERIFIED"],
        ["only one MRZ line", { text: PASSPORT_TEXT.replace(MRZ_LINE_1, "") }, "TWO_MRZ_LINES"],
        ["wrong-document suspicion (file named as a police report)", { fileName: "police_report.pdf" }, "NO_WRONG_DOCUMENT_SUSPICION"],
        ["DOB not explicitly matched (none on record)", { users: makeUsers({ dateOfBirth: null }) }, "DATE_OF_BIRTH_MATCHED"],
        ["expiry not explicitly matched (none on record)", { users: makeUsers({ passportExpiryDate: null }) }, "EXPIRY_DATE_MATCHED"],
    ];
    for (const [name, options, failedCondition] of negativeCases) {
        test(`negative: ${name} -> stays UNDEFINED in pending`, async () => {
            const result = await run(options);

            assertNotAccepted(result);
            assert.equal(result.summary.processingStatus, "UNDEFINED");
            assert.equal(result.summary.confidence.band, "UNDEFINED");
            assert.equal(result.summary.passportAcceptance.accepted, false);
            assert.ok(result.summary.passportAcceptance.failedConditions.includes(failedCondition));
            assert.ok(result.recordUpdate.data.pendingStoragePath.startsWith("pending/0001/"));
        });
    }

    test("negative: identity not VERIFIED_MATCH (sender's number differs from the record) -> pending", async () => {
        const result = await run({ sender: "94779999999" });
        assertNotAccepted(result);
        assert.equal(result.summary.identity.status, "PASSPORT_MATCH_ONLY");
        assert.ok(result.summary.passportAcceptance.failedConditions.includes("IDENTITY_VERIFIED_MATCH"));
        assert.ok(result.recordUpdate.data.pendingStoragePath.startsWith("pending/"));
    });

    test("negative: SEC-008 case (no WhatsApp on record) keeps its manual-review routing", async () => {
        const result = await run({ sender: "94779999999", users: makeUsers({ whatsappNumber: null }) });
        assertNotAccepted(result);
        assert.ok(result.recordUpdate.data.pendingStoragePath.startsWith("pending/0001/"));
    });

    test("negative: identity conflict (sender is another client) stays CONFLICT", async () => {
        const result = await run({ sender: "94772223333" });
        assertNotAccepted(result);
        assert.equal(result.summary.processingStatus, "CONFLICT");
    });

    test("negative: DOB conflict with the record stays CONFLICT", async () => {
        const result = await run({ users: makeUsers({ dateOfBirth: new Date("1991-01-01T00:00:00Z") }) });
        assertNotAccepted(result);
        assert.equal(result.summary.processingStatus, "CONFLICT");
        assert.ok(result.summary.passportAcceptance.failedConditions.includes("NO_RECONCILIATION_CONFLICTS"));
    });

    test("negative: duplicate checksum for the same client -> DUPLICATE, nothing stored", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: "PASSPORT", fileSha256: FILE_SHA }];
        const { summary, objects } = await run({ documents });
        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.deepEqual(objects, [TEMP_PATH]);
    });

    test("negative: same file already stored for another client -> CONFLICT in pending/unidentified", async () => {
        const documents = [{ documentId: "d9", passportId: "N7654321", documentType: "PASSPORT", fileSha256: FILE_SHA }];
        const { summary, objects, recordUpdate } = await run({ documents });
        assert.equal(summary.processingStatus, "CONFLICT");
        assert.ok(!objects.some((path) => path.startsWith("clients/")));
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`pending/unidentified/${TEMP_ID}/`));
    });

    for (const fixture of ["police-clearance", "medical-gamca"]) {
        test(`negative: ${fixture} at OCR 34 stays UNDEFINED in pending (rule is passport-only)`, async () => {
            const result = await run({ text: loadDocumentText(fixture) });
            assertNotAccepted(result);
            assert.equal(result.summary.processingStatus, "UNDEFINED");
            assert.equal(result.summary.passportAcceptance, null);
        });
    }

    test("a passport read well enough for a normal band is unaffected", async () => {
        const { summary } = await run({ confidence: 97 });
        assert.equal(summary.passportAcceptance, null);
        assert.ok(!summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
        assert.equal(summary.storage.verificationStatus, "VERIFIED");
    });
});

describe("evaluatePassportAcceptance (each condition)", () => {
    const accepted = () => ({
        resolvedType: { documentType: "PASSPORT", source: "CONTENT", filenameMismatch: false },
        confidence: { band: "UNDEFINED", flags: [], documentConfidence: 34 },
        passport: { mrz: { linesFound: 2, compositeCheckValid: null } },
        fieldConfidence: {
            passportId: { band: "VERIFIED" },
            dateOfBirth: { band: "VERIFIED" },
            passportExpiryDate: { band: "VERIFIED" },
        },
        identity: { status: "VERIFIED_MATCH", provisional: false },
        reconciliation: { conflicts: [], matchedFields: [{ field: "dateOfBirth" }, { field: "passportExpiryDate" }] },
    });

    test("all conditions met -> accepted", () => {
        assert.deepEqual(evaluatePassportAcceptance(accepted()), { accepted: true, failedConditions: [] });
    });

    test("also evaluated for the UNCLEAR band; not for better bands", () => {
        const state = accepted();
        state.confidence.band = "UNCLEAR";
        assert.equal(evaluatePassportAcceptance(state).accepted, true);
        for (const band of ["SLIGHTLY_UNCLEAR", "HIGH_CONFIDENCE", "VERIFIED"]) {
            state.confidence.band = band;
            assert.equal(evaluatePassportAcceptance(state), null);
        }
    });

    const breaks = [
        ["not a passport", (s) => { s.resolvedType.documentType = "POLICE_REPORT"; }, "PASSPORT_DOCUMENT"],
        ["filename-only classification", (s) => { s.resolvedType.source = "FILENAME"; }, "TYPE_FROM_CONTENT"],
        ["filename-only flag", (s) => { s.confidence.flags = ["CLASSIFIED_FROM_FILENAME_ONLY"]; }, "TYPE_FROM_CONTENT"],
        ["wrong-document flag", (s) => { s.confidence.flags = ["WRONG_DOCUMENT_SUSPECTED"]; }, "NO_WRONG_DOCUMENT_SUSPICION"],
        ["filename mismatch", (s) => { s.resolvedType.filenameMismatch = true; }, "NO_WRONG_DOCUMENT_SUSPICION"],
        ["one MRZ line", (s) => { s.passport.mrz.linesFound = 1; }, "TWO_MRZ_LINES"],
        ["passport ID not VERIFIED", (s) => { s.fieldConfidence.passportId.band = "HIGH_CONFIDENCE"; }, "PASSPORT_ID_VERIFIED"],
        ["DOB not VERIFIED", (s) => { s.fieldConfidence.dateOfBirth.band = "UNDEFINED"; }, "DATE_OF_BIRTH_VERIFIED"],
        ["expiry not VERIFIED", (s) => { delete s.fieldConfidence.passportExpiryDate; }, "EXPIRY_DATE_VERIFIED"],
        ["identity not VERIFIED_MATCH", (s) => { s.identity.status = "WHATSAPP_MATCH_ONLY"; }, "IDENTITY_VERIFIED_MATCH"],
        ["provisional identity", (s) => { s.identity.provisional = true; }, "IDENTITY_NOT_PROVISIONAL"],
        ["provisional unknown", (s) => { delete s.identity.provisional; }, "IDENTITY_NOT_PROVISIONAL"],
        ["reconciliation conflict", (s) => { s.reconciliation.conflicts = [{ field: "dateOfBirth" }]; }, "NO_RECONCILIATION_CONFLICTS"],
        ["no reconciliation at all", (s) => { s.reconciliation = undefined; }, "NO_RECONCILIATION_CONFLICTS"],
        ["DOB not matched", (s) => { s.reconciliation.matchedFields = [{ field: "passportExpiryDate" }]; }, "DATE_OF_BIRTH_MATCHED"],
        ["expiry not matched", (s) => { s.reconciliation.matchedFields = [{ field: "dateOfBirth" }]; }, "EXPIRY_DATE_MATCHED"],
    ];
    for (const [name, mutate, condition] of breaks) {
        test(`${name} -> not accepted (${condition})`, () => {
            const state = accepted();
            mutate(state);
            const result = evaluatePassportAcceptance(state);
            assert.equal(result.accepted, false);
            assert.ok(result.failedConditions.includes(condition), JSON.stringify(result.failedConditions));
        });
    }

    test("applyPassportAcceptance changes only band, review flag and flags; never the confidence", () => {
        const confidence = { extractionConfidence: 34, classificationConfidence: 90, documentConfidence: 34, band: "UNDEFINED", bandFlag: "CRITICAL_REVIEW", reviewRequired: true, flags: [] };
        const result = applyPassportAcceptance(confidence, { accepted: true, failedConditions: [] });

        assert.equal(result.band, "UNCLEAR");
        assert.equal(result.measuredBand, "UNDEFINED");
        assert.equal(result.reviewRequired, true);
        assert.equal(result.documentConfidence, 34);
        assert.equal(result.extractionConfidence, 34);
        assert.deepEqual(result.flags, [PASSPORT_ACCEPTANCE_FLAG]);
        assert.equal(confidence.band, "UNDEFINED", "input not mutated");

        assert.equal(applyPassportAcceptance(confidence, { accepted: false, failedConditions: ["TWO_MRZ_LINES"] }), confidence);
        assert.equal(applyPassportAcceptance(confidence, null), confidence);
    });
});
