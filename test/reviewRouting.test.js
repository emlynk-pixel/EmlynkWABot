import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { processDocument, hasReviewBlocker, determineProcessingStatus } from "../src/services/documentProcessingService.js";
import { decidePlacement, PLACEMENT } from "../src/services/storagePlacementService.js";
import { CHECKSUM_OUTCOME } from "../src/services/documentChecksumService.js";
import { CONFIDENCE_THRESHOLDS, DOCUMENT_FLAGS } from "../src/services/confidenceService.js";
import { PASSPORT_ACCEPTANCE_FLAG } from "../src/services/passportAcceptanceService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";

// All people, numbers and documents are synthetic.
const TEMP_ID = "tmp-r";
const TEMP_PATH = "temporary/tmp-r.pdf";
const FILE = Buffer.from("%PDF-1.4 synthetic document for review routing");
const FILE_SHA = sha256Hex(FILE);
const UNCLEAR_OCR = 50; // inside the UNCLEAR band (40-59)

const MEDICAL_TEXT = loadDocumentText("medical-gamca");
const PASSPORT_TEXT = loadDocumentText("passport-mrz"); // N1234567, valid MRZ
const SLIP_WITHOUT_DATE = "SRI LANKA POLICE - Receipt of application for Police Clearance\nApplication No: PCC/2026/12345";
const REPORT_TEXT = loadDocumentText("police-clearance");

// N1234567: WhatsApp 0771234567, DOB and expiry match passport-mrz.txt.
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

async function run({ text, confidence, sender = "94771234567", users = makeUsers(), documents = [], fileName = "scan.pdf" }) {
    const db = createFakePrisma(users, { documents });
    const bucket = createFakeBucket([TEMP_PATH]);
    const extractText = async () => (confidence === undefined
        ? { success: true, method: "PDF_TEXT", text }
        : { success: true, method: "OCR", text, confidence });
    const { summary } = await processDocument({
        temporaryId: TEMP_ID,
        whatsappNumber: sender,
        fileName,
        mimeType: "application/pdf",
        fileBuffer: FILE,
        temporaryStoragePath: TEMP_PATH,
        deps: { db, bucket, now: new Date("2026-09-24T07:05:03Z"), extractText },
    });
    const recordUpdate = db.calls.filter((c) => c.method === "temporaryData.update").at(-1);
    const objects = [...bucket.objects.keys()];
    return { summary, db, objects, clientObjects: objects.filter((p) => p.startsWith("clients/")), recordUpdate };
}

function assertPending(result, prefix = "pending/0001/", { existingRows = 0 } = {}) {
    assert.equal(result.summary.storage.placement, "PENDING");
    assert.deepEqual(result.clientObjects, [], "nothing in a client folder");
    assert.equal(result.db.documentRows.length, existingRows, "no new documents row");
    assert.ok(result.recordUpdate.data.pendingStoragePath.startsWith(prefix), result.recordUpdate.data.pendingStoragePath);
}

describe("UNCLEAR band: review reasons keep documents out of the client folder", () => {
    test("plain MEDICAL (no review reason) -> CLIENT + REVIEW_REQUIRED (approved Phase 7 behaviour)", async () => {
        const { summary, clientObjects, db } = await run({ text: MEDICAL_TEXT, confidence: UNCLEAR_OCR });
        assert.equal(summary.confidence.band, "UNCLEAR");
        assert.equal(summary.processingStatus, "UNCLEAR");
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
        assert.deepEqual(clientObjects, ["clients/N1234567/medical/scan.pdf"]);
        assert.equal(db.documentRows[0].verificationStatus, "REVIEW_REQUIRED");
    });

    test("MEDICAL + wrong-document suspicion -> PENDING", async () => {
        const result = await run({ text: MEDICAL_TEXT, confidence: UNCLEAR_OCR, fileName: "passport.pdf" });
        assert.ok(result.summary.confidence.flags.includes(DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED));
        assert.equal(result.summary.processingStatus, "UNCLEAR", "status semantics unchanged");
        assertPending(result);
    });

    test("SEC-008 passport (client has no WhatsApp on record) -> PENDING", async () => {
        const result = await run({ text: PASSPORT_TEXT, confidence: UNCLEAR_OCR, sender: "94779999999", users: makeUsers({ whatsappNumber: null }) });
        assert.equal(result.summary.identity.status, "PASSPORT_MATCH_ONLY");
        assert.deepEqual(result.summary.identity.notes, ["WHATSAPP_NOT_ON_RECORD"]);
        assertPending(result);
        assert.equal(result.recordUpdate.data.passportId, "N1234567", "still linked to the passport");
    });

    test("passport whose record has another WhatsApp (identity review) -> PENDING", async () => {
        const result = await run({ text: PASSPORT_TEXT, confidence: UNCLEAR_OCR, sender: "94779999999" });
        assert.deepEqual(result.summary.identity.notes, ["WHATSAPP_DIFFERS"]);
        assertPending(result);
    });

    test("POLICE_SLIP without a resolved date -> PENDING", async () => {
        const result = await run({ text: SLIP_WITHOUT_DATE, confidence: UNCLEAR_OCR });
        assert.equal(result.summary.documentType, "POLICE_SLIP");
        assert.equal(result.summary.policeDate.status, "NOT_FOUND");
        assertPending(result);
        assert.equal(result.summary.policeWorkflowEvent, null);
    });

    for (const [status, dateLine] of [["AMBIGUOUS", "Submitted date: 01/09/2026  Received date: 03/09/2026"], ["INVALID", "Submitted date: 01/12/2099"]]) {
        test(`POLICE_SLIP with ${status} date -> PENDING`, async () => {
            const result = await run({ text: `${SLIP_WITHOUT_DATE}\n${dateLine}`, confidence: UNCLEAR_OCR });
            assert.equal(result.summary.policeDate.status, status);
            assertPending(result);
        });
    }

    test("accepted low-quality passport -> CLIENT + REVIEW_REQUIRED (unchanged)", async () => {
        const { summary, clientObjects } = await run({ text: PASSPORT_TEXT, confidence: UNCLEAR_OCR });
        assert.equal(summary.identity.status, "VERIFIED_MATCH");
        assert.ok(summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(clientObjects.length, 1);
        assert.ok(clientObjects[0].startsWith("clients/N1234567/passport/"));
    });

    test("accepted low-quality passport from the UNDEFINED band (OCR 34) -> CLIENT + REVIEW_REQUIRED (unchanged)", async () => {
        const { summary } = await run({ text: PASSPORT_TEXT, confidence: 34 });
        assert.equal(summary.confidence.measuredBand, "UNDEFINED");
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
    });

    test("POLICE_REPORT at UNCLEAR (no review reason) -> CLIENT + REVIEW_REQUIRED (unchanged)", async () => {
        const { summary, clientObjects } = await run({ text: REPORT_TEXT, confidence: UNCLEAR_OCR });
        assert.equal(summary.storage.placement, "CLIENT");
        assert.equal(summary.storage.verificationStatus, "REVIEW_REQUIRED");
        assert.ok(clientObjects[0].startsWith("clients/N1234567/police-report/"));
    });
});

describe("review routing in the higher bands is unchanged", () => {
    for (const confidence of [97, 92, 75]) {
        test(`OCR ${confidence}: the same review reasons still go to pending as MANUAL_REVIEW`, async () => {
            for (const options of [
                { text: MEDICAL_TEXT, fileName: "passport.pdf" },
                { text: PASSPORT_TEXT, sender: "94779999999", users: makeUsers({ whatsappNumber: null }) },
                { text: SLIP_WITHOUT_DATE },
            ]) {
                const result = await run({ ...options, confidence });
                assert.equal(result.summary.processingStatus, "MANUAL_REVIEW");
                assertPending(result);
            }
        });
    }
});

describe("MEDICAL regression matrix", () => {
    const cases = [
        { name: "VERIFIED (text layer)", confidence: undefined, status: "VERIFIED", band: "VERIFIED", verification: "VERIFIED", path: "clients/N1234567/medical/medical.pdf" },
        { name: "HIGH_CONFIDENCE (92)", confidence: 92, status: "HIGH_CONFIDENCE", band: "HIGH_CONFIDENCE", verification: "VERIFIED", path: "clients/N1234567/medical/medical.pdf" },
        { name: "SLIGHTLY_UNCLEAR (75)", confidence: 75, status: "SLIGHTLY_UNCLEAR", band: "SLIGHTLY_UNCLEAR", verification: "VERIFIED", path: "clients/N1234567/medical/medical.pdf" },
        { name: "UNCLEAR (50)", confidence: 50, status: "UNCLEAR", band: "UNCLEAR", verification: "REVIEW_REQUIRED", path: "clients/N1234567/medical/scan.pdf" },
    ];
    for (const { name, confidence, status, band, verification, path } of cases) {
        test(`${name} -> client folder, ${verification}`, async () => {
            const { summary, clientObjects, db } = await run({ text: MEDICAL_TEXT, confidence });
            assert.equal(summary.documentType, "MEDICAL");
            assert.equal(summary.identity.status, "WHATSAPP_MATCH_ONLY");
            assert.equal(summary.confidence.band, band);
            assert.equal(summary.processingStatus, status);
            assert.equal(summary.storage.placement, "CLIENT");
            assert.equal(summary.storage.verificationStatus, verification);
            assert.deepEqual(clientObjects, [path]);
            assert.equal(db.documentRows[0].documentType, "MEDICAL");
        });
    }

    test("UNDEFINED (30) -> pending/{unique_id}", async () => {
        const result = await run({ text: MEDICAL_TEXT, confidence: 30 });
        assert.equal(result.summary.processingStatus, "UNDEFINED");
        assertPending(result);
    });

    test("AMBIGUOUS_MATCH (number shared by two clients) -> pending/unidentified, not linked", async () => {
        const users = makeUsers();
        users[1].whatsappNumber = "0771234567";
        const result = await run({ text: MEDICAL_TEXT, users });
        assert.equal(result.summary.identity.status, "AMBIGUOUS_MATCH");
        assertPending(result, `pending/unidentified/${TEMP_ID}/`);
        assert.equal(result.recordUpdate.data.passportId, undefined);
    });

    test("NO_MATCH (unknown number) -> pending/unidentified, not linked", async () => {
        const result = await run({ text: MEDICAL_TEXT, sender: "94779999999" });
        assert.equal(result.summary.identity.status, "NO_MATCH");
        assertPending(result, `pending/unidentified/${TEMP_ID}/`);
    });

    test("wrong-document suspicion (good confidence) -> MANUAL_REVIEW, pending", async () => {
        const result = await run({ text: MEDICAL_TEXT, fileName: "passport.pdf" });
        assert.equal(result.summary.processingStatus, "MANUAL_REVIEW");
        assertPending(result);
    });

    test("duplicate (same client, same file) -> DUPLICATE, nothing stored", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: "MEDICAL", fileSha256: FILE_SHA }];
        const { summary, objects } = await run({ text: MEDICAL_TEXT, documents });
        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.equal(summary.storage.placement, "NONE");
        assert.deepEqual(objects, [TEMP_PATH]);
    });

    test("same file stored for another client -> CONFLICT in pending/unidentified, not linked", async () => {
        const documents = [{ documentId: "d9", passportId: "N7654321", documentType: "MEDICAL", fileSha256: FILE_SHA }];
        const result = await run({ text: MEDICAL_TEXT, documents });
        assert.equal(result.summary.processingStatus, "CONFLICT");
        assertPending(result, `pending/unidentified/${TEMP_ID}/`, { existingRows: 1 });
        assert.equal(result.recordUpdate.data.passportId, undefined);
    });

    test("a second, different medical file -> medical_v2, existing file kept", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: "MEDICAL", fileSha256: "0".repeat(64) }];
        const { clientObjects } = await run({ text: MEDICAL_TEXT, documents });
        assert.deepEqual(clientObjects, ["clients/N1234567/medical/medical_v2.pdf"]);
    });

    test("no passport- or police-specific results in a medical summary", async () => {
        const { summary } = await run({ text: MEDICAL_TEXT });
        assert.equal(summary.passport, null);
        assert.equal(summary.reconciliation, null);
        assert.equal(summary.passportAcceptance, null);
        assert.equal(summary.policeDate, null);
        assert.equal(summary.policeWorkflowEvent, null);
        assert.ok(!summary.confidence.flags.includes(PASSPORT_ACCEPTANCE_FLAG));
    });
});

describe("hasReviewBlocker / decidePlacement (units)", () => {
    const confidence = (flags = []) => ({ band: "UNCLEAR", reviewRequired: true, flags });

    test("low confidence alone is not a blocker", () => {
        assert.equal(hasReviewBlocker({ confidence: confidence(), identity: { reviewRequired: false }, policeDate: null }), false);
        assert.equal(hasReviewBlocker({ confidence: confidence([PASSPORT_ACCEPTANCE_FLAG]), identity: { reviewRequired: false } }), false);
    });

    test("each explicit reason is a blocker", () => {
        const none = { confidence: confidence(), identity: { reviewRequired: false }, policeDate: null };
        assert.equal(hasReviewBlocker({ ...none, identity: { reviewRequired: true } }), true);
        assert.equal(hasReviewBlocker({ ...none, confidence: confidence([DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED]) }), true);
        assert.equal(hasReviewBlocker({ ...none, confidence: confidence([DOCUMENT_FLAGS.CLASSIFIED_FROM_FILENAME_ONLY]) }), true);
        assert.equal(hasReviewBlocker({ ...none, confidence: confidence([DOCUMENT_FLAGS.POLICE_TYPE_UNCLEAR]) }), true);
        for (const status of ["AMBIGUOUS", "INVALID", "NOT_FOUND"]) {
            assert.equal(hasReviewBlocker({ ...none, policeDate: { status } }), true, status);
        }
        assert.equal(hasReviewBlocker({ ...none, policeDate: { status: "RESOLVED" } }), false);
    });

    const base = { band: "UNCLEAR", processingStatus: "UNCLEAR", documentType: "MEDICAL", clientIdentified: true, uniqueId: "0001", checksumOutcome: CHECKSUM_OUTCOME.NEW };

    test("UNCLEAR: client folder without a blocker, pending with one", () => {
        assert.equal(decidePlacement(base).placement, PLACEMENT.CLIENT);
        assert.equal(decidePlacement({ ...base, reviewBlocked: false }).placement, PLACEMENT.CLIENT);
        const blocked = decidePlacement({ ...base, reviewBlocked: true });
        assert.equal(blocked.placement, PLACEMENT.PENDING);
        assert.equal(blocked.processingStatus, "UNCLEAR", "status unchanged");
        assert.equal(blocked.pendingOwner, "0001");
    });

    test("checksum rules still come first", () => {
        assert.equal(decidePlacement({ ...base, reviewBlocked: true, checksumOutcome: CHECKSUM_OUTCOME.DUPLICATE }).processingStatus, "DUPLICATE");
        assert.equal(decidePlacement({ ...base, reviewBlocked: true, checksumOutcome: CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT }).processingStatus, "CONFLICT");
    });

    test("processing-status semantics unchanged", () => {
        assert.equal(determineProcessingStatus({ confidence: { band: "UNCLEAR", reviewRequired: true }, identity: { reviewRequired: true } }), "UNCLEAR");
        assert.equal(determineProcessingStatus({ confidence: { band: "VERIFIED", reviewRequired: false }, identity: { reviewRequired: true } }), "MANUAL_REVIEW");
    });

    test("global confidence thresholds unchanged", () => {
        assert.deepEqual(CONFIDENCE_THRESHOLDS, { VERIFIED_ABOVE: 95, HIGH_CONFIDENCE_FROM: 90, SLIGHTLY_UNCLEAR_FROM: 60, UNCLEAR_FROM: 40 });
    });
});
