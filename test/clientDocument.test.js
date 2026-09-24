import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    storeClientDocument,
    verificationStatusForBand,
    VERIFICATION_STATUS,
    CLIENT_STORE_OUTCOME,
} from "../src/services/clientDocumentService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

// Synthetic values only.
const TEMP = "temporary/5d1e.pdf";
const NOW = new Date("2026-09-24T07:05:03Z");
const SHA = sha256Hex(Buffer.from("synthetic passport bytes"));

const input = (overrides = {}) => ({
    temporaryStoragePath: TEMP,
    passportId: "N1234567",
    documentType: "PASSPORT",
    band: "VERIFIED",
    mimeType: "application/pdf",
    originalFileName: "my passport.pdf",
    fileSize: 1234,
    fileSha256: SHA,
    documentConfidence: 97.456,
    receivedAt: NOW,
    ...overrides,
});

async function store(overrides, { documents = [], objects = [TEMP], bucketOptions, db } = {}) {
    const fakeDb = db ?? createFakePrisma([], { documents });
    const bucket = createFakeBucket(objects, bucketOptions);
    const result = await storeClientDocument(input(overrides), { db: fakeDb, bucket, now: NOW });
    return { result, db: fakeDb, bucket };
}

describe("verificationStatusForBand (decision D6)", () => {
    test("VERIFIED / HIGH_CONFIDENCE / SLIGHTLY_UNCLEAR -> VERIFIED", () => {
        for (const band of ["VERIFIED", "HIGH_CONFIDENCE", "SLIGHTLY_UNCLEAR"]) {
            assert.equal(verificationStatusForBand(band), VERIFICATION_STATUS.VERIFIED);
        }
    });
    test("UNCLEAR -> REVIEW_REQUIRED", () => {
        assert.equal(verificationStatusForBand("UNCLEAR"), VERIFICATION_STATUS.REVIEW_REQUIRED);
    });
    test("UNDEFINED is never stored under a client", () => {
        assert.throws(() => verificationStatusForBand("UNDEFINED"));
    });
});

describe("storeClientDocument", () => {
    test("verified passport: standard name, documents row, temporary object kept", async () => {
        const { result, db, bucket } = await store();

        assert.equal(result.outcome, CLIENT_STORE_OUTCOME.STORED);
        assert.equal(result.storagePath, "clients/N1234567/passport/passport.pdf");
        assert.ok(bucket.has(TEMP));

        const [row] = db.documentRows;
        assert.equal(row.passportId, "N1234567");
        assert.equal(row.documentType, "PASSPORT");
        assert.equal(row.storedFilename, "passport.pdf");
        assert.equal(row.storagePath, "clients/N1234567/passport/passport.pdf");
        assert.equal(row.originalFilename, "my passport.pdf");
        assert.equal(row.verificationStatus, "VERIFIED");
        assert.equal(row.processingStatus, "STORED");
        assert.equal(row.fileSha256, SHA);
        assert.equal(row.fileSize, 1234n);
        assert.equal(row.mimeType, "application/pdf");
        assert.equal(row.ocrConfidence, 97.46);
        assert.equal(row.receivedDate, NOW);
    });

    test("police report and medical use their own folders and names", async () => {
        const police = await store({ documentType: "POLICE_REPORT", mimeType: "image/jpeg" });
        assert.equal(police.result.storagePath, "clients/N1234567/police-report/police_report.jpeg");

        const medical = await store({ documentType: "MEDICAL", mimeType: "image/png" });
        assert.equal(medical.result.storagePath, "clients/N1234567/medical/medical.png");
    });

    test("second and third different files become _v2 and _v3", async () => {
        const db = createFakePrisma();
        const bucket = createFakeBucket([TEMP]);

        const first = await storeClientDocument(input({ fileSha256: sha256Hex(Buffer.from("v1")) }), { db, bucket, now: NOW });
        const second = await storeClientDocument(input({ fileSha256: sha256Hex(Buffer.from("v2")) }), { db, bucket, now: NOW });
        const third = await storeClientDocument(input({ fileSha256: sha256Hex(Buffer.from("v3")) }), { db, bucket, now: NOW });

        assert.deepEqual(
            [first, second, third].map((r) => r.storedFilename),
            ["passport.pdf", "passport_v2.pdf", "passport_v3.pdf"]
        );
    });

    test("an object left in the folder without a row is not overwritten", async () => {
        const { result } = await store({}, { objects: [TEMP, "clients/N1234567/passport/passport.pdf"] });
        assert.equal(result.storedFilename, "passport_v2.pdf");
    });

    test("UNCLEAR keeps the sanitized original name and is REVIEW_REQUIRED", async () => {
        const { result, db } = await store({ band: "UNCLEAR", originalFileName: "../My Scan (1).pdf" });

        assert.equal(result.storagePath, "clients/N1234567/passport/My_Scan_1.pdf");
        assert.equal(result.verificationStatus, "REVIEW_REQUIRED");
        assert.equal(db.documentRows[0].verificationStatus, "REVIEW_REQUIRED");
        assert.equal(db.documentRows[0].originalFilename, "../My Scan (1).pdf");
    });

    test("UNCLEAR photo with no file name gets a timestamp name", async () => {
        const { result, db } = await store({ band: "UNCLEAR", originalFileName: null, mimeType: "image/jpeg" });

        assert.equal(result.storedFilename, "document_20260924_070503.jpeg");
        assert.equal(db.documentRows[0].originalFilename, "document_20260924_070503.jpeg");
    });

    test("UNCLEAR name collision adds a numeric suffix", async () => {
        const { result } = await store(
            { band: "UNCLEAR", originalFileName: "scan.pdf" },
            { objects: [TEMP, "clients/N1234567/passport/scan.pdf"] }
        );
        assert.equal(result.storedFilename, "scan_2.pdf");
    });

    test("UNDEFINED is refused before anything is copied", async () => {
        const bucket = createFakeBucket([TEMP]);
        await assert.rejects(storeClientDocument(input({ band: "UNDEFINED" }), { db: createFakePrisma(), bucket, now: NOW }));
        assert.ok(!bucket.calls.some((c) => c.method === "copy"));
    });

    test("database failure after the copy: copy removed, temporary kept, error raised", async () => {
        const db = createFakePrisma();
        db.document.create = async () => { throw new Error("connection lost"); };

        const bucket = createFakeBucket([TEMP]);
        await assert.rejects(
            storeClientDocument(input(), { db, bucket, now: NOW }),
            /documents insert failed \(connection lost\); copy removed/
        );

        assert.ok(!bucket.has("clients/N1234567/passport/passport.pdf"));
        assert.ok(bucket.has(TEMP));
    });

    test("if even the clean-up fails, the error says so (without the path)", async () => {
        const db = createFakePrisma();
        db.document.create = async () => { throw new Error("connection lost"); };

        const bucket = createFakeBucket([TEMP], { failRemove: true });
        await assert.rejects(storeClientDocument(input(), { db, bucket, now: NOW }), (error) => {
            assert.match(error.message, /copy NOT removed/);
            assert.ok(!error.message.includes("N1234567"));
            return true;
        });
    });

    test("parallel duplicate (P2002 on insert): copy removed and DUPLICATE returned", async () => {
        const documents = [{ documentId: "doc-1", passportId: "N1234567", documentType: "PASSPORT", fileSha256: SHA }];
        const { result, bucket, db } = await store({}, { documents });

        assert.equal(result.outcome, CLIENT_STORE_OUTCOME.DUPLICATE);
        assert.equal(db.documentRows.length, 1);
        assert.deepEqual([...bucket.objects.keys()], [TEMP]);
    });

    test("storage failure: error raised and no documents row", async () => {
        const db = createFakePrisma();
        const bucket = createFakeBucket([TEMP], { failCopy: true });

        await assert.rejects(storeClientDocument(input(), { db, bucket, now: NOW }), /Storage copy failed/);
        assert.equal(db.documentRows.length, 0);
        assert.ok(!db.calls.some((c) => c.method === "document.create"));
    });

    test("the returned result holds no document text", async () => {
        const { result } = await store();
        assert.deepEqual(Object.keys(result).sort(), ["documentId", "outcome", "storagePath", "storedFilename", "verificationStatus"]);
    });
});
