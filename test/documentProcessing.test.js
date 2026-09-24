import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    processDocument,
    determineProcessingStatus,
    PROCESSING_STATUS,
} from "../src/services/documentProcessingService.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { loadDocumentText } from "./helpers/fixtures.js";

const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));

// Synthetic users. text-passport.pdf belongs to N1234567.
const makeUsers = () => [
    { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: null, otherName: null, dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333" },
];

const textExtractor = (text) => async () => ({ success: true, method: "PDF_TEXT", text });

async function run({ file = "text-passport.pdf", mimeType = "application/pdf", fileName = "scan.pdf", sender = "94771234567", users = makeUsers(), extractText, db }) {
    const fakeDb = db ?? createFakePrisma(users);
    const result = await processDocument({
        temporaryId: "tmp-1",
        whatsappNumber: sender,
        fileName,
        mimeType,
        fileBuffer: file ? loadFile(file) : Buffer.alloc(0),
        deps: { db: fakeDb, ...(extractText ? { extractText } : {}) },
    });
    const recordUpdate = fakeDb.calls.filter((c) => c.method === "temporaryData.update").at(-1);
    return { ...result, db: fakeDb, recordUpdate };
}

describe("processDocument", () => {
    test("verified passport: classified, identified, missing fields filled, record linked", async () => {
        const { summary, details, db, recordUpdate } = await run({});
        assert.equal(details.policeDate, null);

        assert.equal(summary.stage, "COMPLETED");
        assert.equal(summary.documentType, "PASSPORT");
        assert.equal(summary.extractionMethod, "PDF_TEXT");
        assert.equal(summary.identity.status, "VERIFIED_MATCH");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.VERIFIED);

        assert.deepEqual(recordUpdate.where, { temporaryId: "tmp-1" });
        assert.deepEqual(recordUpdate.data, {
            documentType: "PASSPORT",
            processingStatus: "VERIFIED",
            passportId: "N1234567",
            uniqueId: "0001",
        });

        // Printed-only fields reach confidence 90, enough to fill (§14).
        assert.deepEqual(summary.reconciliation.filled.sort(), [
            "dateOfBirth", "firstName", "otherName", "passportExpiryDate", "placeOfBirth",
        ]);
        assert.equal(db.rows[0].placeOfBirth, "COLOMBO");
        assert.equal(db.rows[0].firstName, "KAMAL NIMAL");
        assert.equal(db.rows[0].otherName, "PERERA");
    });

    test("passport sent from another client's WhatsApp: conflict, nothing linked or written", async () => {
        const { summary, db, recordUpdate } = await run({ sender: "94772223333" });

        assert.equal(summary.identity.status, "IDENTITY_CONFLICT");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.CONFLICT);
        assert.equal(recordUpdate.data.passportId, undefined);
        assert.ok(!db.calls.some((c) => c.method === "user.updateMany"));
        assert.equal(db.rows[0].placeOfBirth, null);
    });

    test("existing value that differs from the passport is a conflict and is kept", async () => {
        const users = makeUsers();
        users[0].placeOfBirth = "KANDY";
        const { summary, db } = await run({ users });

        assert.deepEqual(summary.reconciliation.conflicts, ["placeOfBirth"]);
        assert.equal(summary.processingStatus, PROCESSING_STATUS.CONFLICT);
        assert.equal(db.rows[0].placeOfBirth, "KANDY");
    });

    test("corrupt PDF named passport.pdf: UNDEFINED, not linked", async () => {
        const { summary, recordUpdate } = await run({ file: "corrupt.pdf", fileName: "passport.pdf" });

        assert.equal(summary.extractionMethod, "PDF_PARSE_FAILED");
        assert.equal(summary.typeSource, "FILENAME");
        assert.ok(summary.confidence.flags.includes("CORRUPT_FILE"));
        assert.equal(summary.identity.status, "PASSPORT_ID_UNRESOLVED");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.UNDEFINED);
        assert.equal(recordUpdate.data.passportId, undefined);
    });

    test("police slip from a known WhatsApp: linked, date resolved", async () => {
        const { summary, details, recordUpdate } = await run({ extractText: textExtractor(loadDocumentText("police-slip")) });

        // The date is kept in the result (no column until Phase 7/9), never in the log summary.
        assert.deepEqual(details.policeDate, { status: "RESOLVED", date: "2026-09-01", kind: "SUBMITTED", confidence: 95 });
        assert.ok(!JSON.stringify(summary).includes("2026-09-01"));
        assert.ok(!("policeDate" in recordUpdate.data));

        assert.equal(summary.documentType, "POLICE_REPORT");
        assert.deepEqual(summary.policeDate, { status: "RESOLVED", kind: "SUBMITTED" });
        assert.equal(summary.identity.status, "WHATSAPP_MATCH_ONLY");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.SLIGHTLY_UNCLEAR);
        assert.equal(recordUpdate.data.passportId, "N1234567");
        assert.equal(summary.reconciliation, null);
    });

    test("police report without a readable date needs manual review", async () => {
        const text = "SRI LANKA POLICE\nPolice Clearance Certificate\nNo criminal records found.";
        const { summary } = await run({ extractText: textExtractor(text) });

        assert.equal(summary.policeDate.status, "NOT_FOUND");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.MANUAL_REVIEW);
    });

    test("medical report from an unknown number: NO_MATCH, review, not linked", async () => {
        const { summary, recordUpdate } = await run({
            sender: "94770000000",
            extractText: textExtractor(loadDocumentText("medical-gamca")),
        });

        assert.equal(summary.documentType, "MEDICAL");
        assert.equal(summary.identity.status, "NO_MATCH");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.MANUAL_REVIEW);
        assert.equal(recordUpdate.data.passportId, undefined);
    });

    test("wrong document (named medical.pdf, content is a passport) needs review", async () => {
        const { summary } = await run({ fileName: "medical.pdf" });

        assert.ok(summary.confidence.flags.includes("WRONG_DOCUMENT_SUSPECTED"));
        assert.equal(summary.processingStatus, PROCESSING_STATUS.MANUAL_REVIEW);
    });

    test("unknown document", async () => {
        const { summary, recordUpdate } = await run({ extractText: textExtractor(loadDocumentText("random-invoice")) });

        assert.equal(summary.documentType, "UNKNOWN");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.UNDEFINED);
        assert.equal(recordUpdate.data.documentType, "UNKNOWN");
    });

    test("OCR failure is recorded as FAILED with its stage, and does not throw", async () => {
        const { summary, recordUpdate } = await run({
            extractText: async () => { throw new Error("worker crashed"); },
        });

        assert.equal(summary.stage, "TEXT_EXTRACTION");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.FAILED);
        assert.equal(summary.error, "worker crashed");
        assert.deepEqual(recordUpdate.data, { processingStatus: "FAILED" });
    });

    test("database failure during lookup is recorded as FAILED at the IDENTITY stage", async () => {
        const db = createFakePrisma(makeUsers());
        db.user.findMany = async () => {
            throw new Error("Invalid `prisma.user.findMany()` invocation:\n  where: { passportId: \"N1234567\" }");
        };
        const { summary } = await run({ db });

        assert.equal(summary.stage, "IDENTITY");
        assert.equal(summary.processingStatus, PROCESSING_STATUS.FAILED);
        assert.ok(!summary.error.includes("N1234567"), "error message must not carry query arguments");
    });

    test("failure to even record FAILED is reported, not thrown", async () => {
        const db = createFakePrisma(makeUsers());
        db.temporaryData.update = async () => { throw new Error("db down"); };
        const { summary } = await run({ db });

        assert.equal(summary.processingStatus, PROCESSING_STATUS.FAILED);
        assert.equal(summary.recordUpdated, false);
        assert.match(summary.error, /status update failed: db down/);
    });

    test("the loggable summary contains no personal data", async () => {
        const { summary } = await run({});
        const serialized = JSON.stringify(summary);

        for (const value of ["N1234567", "PERERA", "KAMAL", "COLOMBO", "1990", "2030", "771234567", "0001"]) {
            assert.ok(!serialized.includes(value), `summary leaks ${value}`);
        }
    });
});

describe("determineProcessingStatus", () => {
    const confidence = (band, reviewRequired = false) => ({ band, reviewRequired });

    test("conflict beats everything except failure", () => {
        assert.equal(
            determineProcessingStatus({ confidence: confidence("UNDEFINED", true), identity: { status: "IDENTITY_CONFLICT" } }),
            "CONFLICT"
        );
    });
    test("UNDEFINED band beats manual review", () => {
        assert.equal(determineProcessingStatus({ confidence: confidence("UNDEFINED", true), identity: { reviewRequired: true } }), "UNDEFINED");
    });
    test("UNCLEAR band stays UNCLEAR even with review notes", () => {
        assert.equal(determineProcessingStatus({ confidence: confidence("UNCLEAR", true), identity: { reviewRequired: true } }), "UNCLEAR");
    });
    test("identity review in a good band becomes MANUAL_REVIEW", () => {
        assert.equal(determineProcessingStatus({ confidence: confidence("VERIFIED"), identity: { reviewRequired: true } }), "MANUAL_REVIEW");
    });
    test("nothing to review: the band is the status", () => {
        assert.equal(determineProcessingStatus({ confidence: confidence("HIGH_CONFIDENCE"), identity: { reviewRequired: false } }), "HIGH_CONFIDENCE");
    });
});
