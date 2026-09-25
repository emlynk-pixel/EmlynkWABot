import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decidePlacement, PLACEMENT } from "../src/services/storagePlacementService.js";
import { processDocument } from "../src/services/documentProcessingService.js";
import { CHECKSUM_OUTCOME } from "../src/services/documentChecksumService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";
import { loadDocumentText } from "./helpers/fixtures.js";

// All IDs, numbers and documents are synthetic.
const TEMP_PATH = "temporary/tmp-1.pdf";
const NOW = new Date("2026-09-24T07:05:03Z");
const TEMP_ID = "tmp-1";
const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const PASSPORT_PDF = loadFile("text-passport.pdf");
const PASSPORT_SHA = sha256Hex(PASSPORT_PDF);

// text-passport.pdf belongs to N1234567, whose WhatsApp is 0771234567.
const makeUsers = () => [
    { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL NIMAL", otherName: null, dateOfBirth: null, placeOfBirth: null, passportExpiryDate: null },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333", firstName: "NIMAL" },
];

const ocrText = (text, confidence) => async () => ({ success: true, method: "OCR", text, confidence });
const pdfText = (text) => async () => ({ success: true, method: "PDF_TEXT", text });

async function run({
    sender = "94771234567",
    fileName = "scan.pdf",
    mimeType = "application/pdf",
    fileBuffer = PASSPORT_PDF,
    extractText,
    users = makeUsers(),
    documents = [],
    temporaryData = [],
    bucket = createFakeBucket([TEMP_PATH]),
    db,
    receivedAt,
} = {}) {
    const fakeDb = db ?? createFakePrisma(users, { documents, temporaryData });
    const result = await processDocument({
        temporaryId: TEMP_ID,
        whatsappNumber: sender,
        fileName,
        mimeType,
        fileBuffer,
        temporaryStoragePath: TEMP_PATH,
        receivedAt,
        deps: { db: fakeDb, bucket, now: NOW, ...(extractText ? { extractText } : {}) },
    });
    const recordUpdate = fakeDb.calls.filter((c) => c.method === "temporaryData.update").at(-1);
    const objects = [...bucket.objects.keys()];
    return { ...result, db: fakeDb, bucket, recordUpdate, objects };
}

const PENDING_UNIDENTIFIED = `pending/unidentified/${TEMP_ID}/undefined/uncleared-docs`;
const PENDING_0001 = "pending/0001/undefined/uncleared-docs";

describe("decidePlacement (placement rules)", () => {
    const base = { band: "VERIFIED", documentType: "PASSPORT", clientIdentified: true, uniqueId: "0001", checksumOutcome: CHECKSUM_OUTCOME.NEW };
    const decide = (overrides) => decidePlacement({ processingStatus: "VERIFIED", ...base, ...overrides });

    for (const band of ["VERIFIED", "HIGH_CONFIDENCE", "SLIGHTLY_UNCLEAR", "UNCLEAR"]) {
        test(`${band} + identified client -> client folder`, () => {
            assert.equal(decide({ band, processingStatus: band }).placement, PLACEMENT.CLIENT);
        });
    }

    test("DUPLICATE checksum -> nothing stored", () => {
        assert.deepEqual(decide({ checksumOutcome: CHECKSUM_OUTCOME.DUPLICATE }), { placement: PLACEMENT.NONE, processingStatus: "DUPLICATE", pendingOwner: null });
    });

    test("cross-client checksum -> pending, CONFLICT, no client named in the path", () => {
        assert.deepEqual(decide({ checksumOutcome: CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT }), { placement: PLACEMENT.PENDING, processingStatus: "CONFLICT", pendingOwner: null });
    });

    for (const status of ["CONFLICT", "UNDEFINED", "MANUAL_REVIEW"]) {
        test(`${status} never enters the client folder`, () => {
            const result = decide({ processingStatus: status });
            assert.equal(result.placement, PLACEMENT.PENDING);
            assert.equal(result.processingStatus, status);
        });
    }

    test("known client needing review -> pending/{unique_id}", () => {
        assert.equal(decide({ processingStatus: "MANUAL_REVIEW" }).pendingOwner, "0001");
    });

    test("no identified client -> pending/unidentified even for a clear document", () => {
        const result = decide({ clientIdentified: false, uniqueId: "0001" });
        assert.equal(result.placement, PLACEMENT.PENDING);
        assert.equal(result.pendingOwner, null);
    });

    test("UNKNOWN type has no client folder -> pending", () => {
        assert.equal(decide({ documentType: "UNKNOWN" }).placement, PLACEMENT.PENDING);
    });

    test("UNDEFINED band never goes to a client folder, whatever the status", () => {
        assert.equal(decide({ band: "UNDEFINED", processingStatus: "VERIFIED" }).placement, PLACEMENT.PENDING);
    });
});

describe("processDocument: permanent client storage", () => {
    test("verified passport -> clients/{id}/passport/passport.pdf, documents row VERIFIED, temporary kept", async () => {
        const { summary, db, objects, recordUpdate } = await run();

        assert.equal(summary.processingStatus, "VERIFIED");
        assert.deepEqual(summary.storage, { checksum: "NEW", placement: "CLIENT", verificationStatus: "VERIFIED", documentStored: true, pendingCopy: false });
        assert.ok(objects.includes("clients/N1234567/passport/passport.pdf"));
        assert.ok(objects.includes(TEMP_PATH), "temporary object must remain for Phase 8");

        const [row] = db.documentRows;
        assert.equal(row.verificationStatus, "VERIFIED");
        assert.equal(row.fileSha256, PASSPORT_SHA);
        assert.equal(row.storagePath, "clients/N1234567/passport/passport.pdf");
        assert.equal(recordUpdate.data.pendingStoragePath, undefined);
        assert.equal(recordUpdate.data.passportId, "N1234567");
    });

    test("a different file of the same type becomes passport_v2", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: "PASSPORT", fileSha256: sha256Hex(Buffer.from("older scan")) }];
        const { db } = await run({ documents, bucket: createFakeBucket([TEMP_PATH, "clients/N1234567/passport/passport.pdf"]) });

        assert.equal(db.documentRows.at(-1).storedFilename, "passport_v2.pdf");
    });

    test("police slip, police report and medical go to their own folders", async () => {
        const slip = await run({ extractText: pdfText(loadDocumentText("police-slip")), mimeType: "image/jpeg" });
        assert.ok(slip.objects.includes("clients/N1234567/police-slip/police_slip.jpeg"));

        const police = await run({ extractText: pdfText(loadDocumentText("police-clearance")), mimeType: "image/jpeg" });
        assert.ok(police.objects.includes("clients/N1234567/police-report/police_report.jpeg"));

        const medical = await run({ extractText: pdfText(loadDocumentText("medical-gamca")), mimeType: "image/png" });
        assert.ok(medical.objects.includes("clients/N1234567/medical/medical.png"));
    });

    test("UNCLEAR from an identified client keeps the sanitized original name, REVIEW_REQUIRED", async () => {
        const { summary, db, objects } = await run({
            extractText: ocrText(loadDocumentText("medical-gamca"), 50),
            fileName: "My Medical (copy).pdf",
        });

        assert.equal(summary.processingStatus, "UNCLEAR");
        assert.ok(objects.includes("clients/N1234567/medical/My_Medical_copy.pdf"));
        assert.equal(db.documentRows[0].verificationStatus, "REVIEW_REQUIRED");
        assert.equal(db.documentRows[0].originalFilename, "My Medical (copy).pdf");
    });

    test("UNCLEAR photo without a file name gets a timestamp name", async () => {
        const { objects } = await run({
            extractText: ocrText(loadDocumentText("medical-gamca"), 50),
            fileName: null,
            mimeType: "image/jpeg",
        });

        assert.ok(objects.includes("clients/N1234567/medical/document_20260924_070503.jpeg"));
    });
});

describe("processDocument: duplicates and checksum conflicts", () => {
    test("same client, same file -> DUPLICATE: no copy, no row, no client writes, temporary kept", async () => {
        const documents = [{ documentId: "d1", passportId: "N1234567", documentType: "PASSPORT", fileSha256: PASSPORT_SHA }];
        const { summary, db, objects, recordUpdate } = await run({ documents });

        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.equal(summary.storage.placement, "NONE");
        assert.deepEqual(objects, [TEMP_PATH]);
        assert.equal(db.documentRows.length, 1);
        assert.ok(!db.calls.some((c) => c.method === "user.updateMany"), "duplicate must not fill client fields again");
        assert.equal(recordUpdate.data.processingStatus, "DUPLICATE");
    });

    test("same file stored for another client -> CONFLICT in pending/unidentified, no row, not linked, no writes", async () => {
        const documents = [{ documentId: "d9", passportId: "N7654321", documentType: "PASSPORT", fileSha256: PASSPORT_SHA }];
        const { summary, db, objects, recordUpdate } = await run({ documents });

        assert.equal(summary.processingStatus, "CONFLICT");
        assert.equal(summary.storage.checksum, "CROSS_CLIENT_CONFLICT");
        assert.ok(!objects.some((p) => p.startsWith("clients/")));
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`${PENDING_UNIDENTIFIED}/`));
        assert.ok(objects.includes(recordUpdate.data.pendingStoragePath));
        assert.equal(db.documentRows.length, 1, "no documents row for the wrong client");
        assert.equal(recordUpdate.data.passportId, undefined);
        assert.ok(!db.calls.some((c) => c.method === "user.updateMany"));
    });

    test("same sender re-sends a file already waiting in pending/ -> DUPLICATE, no second copy", async () => {
        const temporaryData = [{ temporaryId: "tmp-0", whatsappNumber: "94770000000", fileSha256: PASSPORT_SHA, pendingStoragePath: `pending/unidentified/tmp-0/undefined/uncleared-docs/document_20260923_101010.pdf` }];
        const { summary, objects, recordUpdate } = await run({ sender: "94770000000", temporaryData });

        assert.equal(summary.processingStatus, "DUPLICATE");
        assert.deepEqual(objects, [TEMP_PATH]);
        assert.equal(recordUpdate.data.pendingStoragePath, undefined);
    });
});

describe("processDocument: pending storage", () => {
    test("identity conflict -> pending/unidentified/{temporary_id}", async () => {
        const { summary, recordUpdate, objects } = await run({ sender: "94772223333" });

        assert.equal(summary.processingStatus, "CONFLICT");
        assert.equal(recordUpdate.data.pendingStoragePath, `${PENDING_UNIDENTIFIED}/document_20260924_070503.pdf`);
        assert.ok(objects.includes(TEMP_PATH));
        assert.ok(!objects.some((p) => p.startsWith("clients/")));
    });

    test("UNDEFINED from an unknown sender -> pending/unidentified", async () => {
        const { summary, recordUpdate } = await run({ sender: "94770000000", extractText: pdfText(loadDocumentText("random-invoice")) });

        assert.equal(summary.processingStatus, "UNDEFINED");
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`${PENDING_UNIDENTIFIED}/`));
    });

    test("UNDEFINED from a known client -> pending/{unique_id}", async () => {
        const { summary, recordUpdate } = await run({ extractText: pdfText(loadDocumentText("random-invoice")) });

        assert.equal(summary.processingStatus, "UNDEFINED");
        assert.equal(recordUpdate.data.pendingStoragePath, `${PENDING_0001}/document_20260924_070503.pdf`);
    });

    test("MANUAL_REVIEW (police slip without a date) -> pending/{unique_id}", async () => {
        const text = "SRI LANKA POLICE\nReceipt of application for Police Clearance\nApplication No: PCC/2026/12345";
        const { summary, recordUpdate, db } = await run({ extractText: pdfText(text) });

        assert.equal(summary.processingStatus, "MANUAL_REVIEW");
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`${PENDING_0001}/`));
        assert.equal(db.documentRows.length, 0);
    });

    test("passport of a client with no WhatsApp on record -> MANUAL_REVIEW in pending/{unique_id}, not the client folder (SEC-008)", async () => {
        const users = makeUsers();
        users[0].whatsappNumber = null;
        const { summary, recordUpdate, db, objects } = await run({ sender: "94779999999", users });

        assert.equal(summary.processingStatus, "MANUAL_REVIEW");
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`${PENDING_0001}/`));
        assert.equal(recordUpdate.data.passportId, "N1234567", "still associated with the passport");
        assert.equal(db.documentRows.length, 0);
        assert.ok(!objects.some((path) => path.startsWith("clients/")));
        assert.ok(!db.calls.some((c) => c.method === "user.updateMany"), "client record (incl. WhatsApp) is not changed");
    });

    test("pending file name uses the WhatsApp message time when given", async () => {
        const { recordUpdate } = await run({ sender: "94772223333", receivedAt: new Date("2026-09-20T14:35:22Z") });
        assert.equal(recordUpdate.data.pendingStoragePath, `${PENDING_UNIDENTIFIED}/document_20260920_143522.pdf`);
    });

    test("pending paths never contain a WhatsApp number", async () => {
        const { recordUpdate } = await run({ sender: "94770000000", extractText: pdfText(loadDocumentText("random-invoice")) });
        assert.doesNotMatch(recordUpdate.data.pendingStoragePath, /94770000000|0770000000/);
    });
});

describe("processDocument: failures", () => {
    test("storage failure -> FAILED at STORAGE, no documents row, temporary kept", async () => {
        const bucket = createFakeBucket([TEMP_PATH], { failCopy: true });
        const { summary, db, objects, recordUpdate } = await run({ bucket });

        assert.equal(summary.processingStatus, "FAILED");
        assert.equal(summary.stage, "STORAGE");
        assert.equal(db.documentRows.length, 0);
        assert.deepEqual(objects, [TEMP_PATH]);
        assert.equal(recordUpdate.data.processingStatus, "FAILED");
    });

    test("database failure after the copy -> copy removed, FAILED, temporary kept", async () => {
        const db = createFakePrisma(makeUsers());
        db.document.create = async () => { throw new Error("connection lost"); };
        const { summary, objects } = await run({ db });

        assert.equal(summary.processingStatus, "FAILED");
        assert.equal(summary.stage, "STORAGE");
        assert.deepEqual(objects, [TEMP_PATH]);
    });

    test("pending copy is still recorded if the final record update fails and FAILED is written", async () => {
        const db = createFakePrisma(makeUsers());
        let updates = 0;
        const realUpdate = db.temporaryData.update;
        db.temporaryData.update = async (args) => {
            updates += 1;
            if (updates === 1) throw new Error("timeout");
            return realUpdate(args);
        };
        const { summary, recordUpdate } = await run({ db, sender: "94772223333" });

        assert.equal(summary.processingStatus, "FAILED");
        assert.ok(recordUpdate.data.pendingStoragePath.startsWith(`${PENDING_UNIDENTIFIED}/`));
    });
});

describe("processDocument: privacy", () => {
    test("the loggable summary has no paths, passport numbers, client references or phone numbers", async () => {
        for (const scenario of [{}, { sender: "94772223333" }, { extractText: pdfText(loadDocumentText("random-invoice")) }]) {
            const { summary } = await run(scenario);
            const serialized = JSON.stringify(summary);
            for (const value of ["N1234567", "N7654321", "clients/", "pending/", "0001", "771234567", "772223333", PASSPORT_SHA]) {
                assert.ok(!serialized.includes(value), `summary leaks ${value}`);
            }
        }
    });
});
