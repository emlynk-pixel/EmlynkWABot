import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    checkClientChecksum,
    findPendingDuplicate,
    CHECKSUM_OUTCOME,
} from "../src/services/documentChecksumService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";

const { NEW, DUPLICATE, CROSS_CLIENT_CONFLICT } = CHECKSUM_OUTCOME;

// Synthetic checksums and IDs.
const PASSPORT_FILE = sha256Hex(Buffer.from("synthetic passport scan"));
const OTHER_FILE = sha256Hex(Buffer.from("a different photo of the passport"));
const documents = [
    { documentId: "doc-1", passportId: "N1234567", documentType: "PASSPORT", fileSha256: PASSPORT_FILE },
];

describe("checkClientChecksum", () => {
    test("A: same client, same checksum -> DUPLICATE with the existing document", async () => {
        const db = createFakePrisma([], { documents });
        const result = await checkClientChecksum({ passportId: "N1234567", fileSha256: PASSPORT_FILE }, { db });

        assert.deepEqual(result, { outcome: DUPLICATE, existingDocumentId: "doc-1", existingVerified: false });
    });

    test("M4: says whether the same-client match is VERIFIED", async () => {
        const db = createFakePrisma([], { documents: [{ ...documents[0], verificationStatus: "VERIFIED" }] });
        const result = await checkClientChecksum({ passportId: "N1234567", fileSha256: PASSPORT_FILE }, { db });
        assert.deepEqual(result, { outcome: DUPLICATE, existingDocumentId: "doc-1", existingVerified: true });
        const pending = createFakePrisma([], { documents: [{ ...documents[0], verificationStatus: "REVIEW_REQUIRED" }] });
        assert.equal((await checkClientChecksum({ passportId: "N1234567", fileSha256: PASSPORT_FILE }, { db: pending })).existingVerified, false);
    });

    test("B: same checksum stored for a different client -> CROSS_CLIENT_CONFLICT", async () => {
        const db = createFakePrisma([], { documents });
        const result = await checkClientChecksum({ passportId: "N7654321", fileSha256: PASSPORT_FILE }, { db });

        assert.equal(result.outcome, CROSS_CLIENT_CONFLICT);
    });

    test("B: the other client's identity is never returned", async () => {
        const db = createFakePrisma([], { documents });
        const result = await checkClientChecksum({ passportId: "N7654321", fileSha256: PASSPORT_FILE }, { db });

        assert.ok(!JSON.stringify(result).includes("N1234567"));
        assert.equal(result.existingDocumentId, null);
    });

    test("C: different bytes (new photo of the same document) -> NEW", async () => {
        const db = createFakePrisma([], { documents });
        const result = await checkClientChecksum({ passportId: "N1234567", fileSha256: OTHER_FILE }, { db });

        assert.equal(result.outcome, NEW);
    });

    test("no documents at all -> NEW", async () => {
        const result = await checkClientChecksum(
            { passportId: "N1234567", fileSha256: PASSPORT_FILE },
            { db: createFakePrisma() }
        );
        assert.equal(result.outcome, NEW);
    });

    test("same-client duplicate wins over a cross-client match", async () => {
        const db = createFakePrisma([], {
            documents: [...documents, { documentId: "doc-2", passportId: "N7654321", fileSha256: PASSPORT_FILE }],
        });
        const result = await checkClientChecksum({ passportId: "N7654321", fileSha256: PASSPORT_FILE }, { db });

        assert.deepEqual(result, { outcome: DUPLICATE, existingDocumentId: "doc-2", existingVerified: false });
    });

    test("lookups are scoped: exact passport + checksum, then checksum excluding this client", async () => {
        const db = createFakePrisma([], { documents });
        await checkClientChecksum({ passportId: "N7654321", fileSha256: PASSPORT_FILE }, { db });

        const wheres = db.calls.filter((c) => c.method === "document.findFirst").map((c) => c.where);
        assert.deepEqual(wheres, [
            { passportId: "N7654321", fileSha256: PASSPORT_FILE },
            { fileSha256: PASSPORT_FILE, passportId: { not: "N7654321" } },
        ]);
    });

    test("refuses to run without a passport ID or checksum", async () => {
        await assert.rejects(checkClientChecksum({ passportId: null, fileSha256: PASSPORT_FILE }, { db: createFakePrisma() }));
        await assert.rejects(checkClientChecksum({ passportId: "N1234567", fileSha256: null }, { db: createFakePrisma() }));
    });
});

describe("findPendingDuplicate", () => {
    const temporaryData = [
        { temporaryId: "tmp-old", whatsappNumber: "94770000000", fileSha256: PASSPORT_FILE, pendingStoragePath: "pending/unidentified/tmp-old/undefined/uncleared-docs/document_20260924_101500.jpeg" },
        { temporaryId: "tmp-failed", whatsappNumber: "94770000000", fileSha256: OTHER_FILE, pendingStoragePath: null },
    ];

    test("same sender already has this exact file waiting in pending/ -> found", async () => {
        const db = createFakePrisma([], { temporaryData });
        const found = await findPendingDuplicate({ whatsappNumber: "94770000000", fileSha256: PASSPORT_FILE, temporaryId: "tmp-new" }, { db });

        assert.deepEqual(found, { temporaryId: "tmp-old" });
    });

    test("an earlier attempt that never reached pending/ is not a duplicate", async () => {
        const db = createFakePrisma([], { temporaryData });
        const found = await findPendingDuplicate({ whatsappNumber: "94770000000", fileSha256: OTHER_FILE, temporaryId: "tmp-new" }, { db });

        assert.equal(found, null);
    });

    test("the current record never matches itself", async () => {
        const db = createFakePrisma([], { temporaryData });
        const found = await findPendingDuplicate({ whatsappNumber: "94770000000", fileSha256: PASSPORT_FILE, temporaryId: "tmp-old" }, { db });

        assert.equal(found, null);
    });

    test("a different sender with the same file is not a pending duplicate", async () => {
        const db = createFakePrisma([], { temporaryData });
        const found = await findPendingDuplicate({ whatsappNumber: "94771111111", fileSha256: PASSPORT_FILE, temporaryId: "tmp-new" }, { db });

        assert.equal(found, null);
    });
});

describe("fake database enforces client-scoped checksum uniqueness", () => {
    test("same client + same checksum twice is rejected with P2002; another client is allowed", async () => {
        const db = createFakePrisma([], { documents });

        await assert.rejects(
            db.document.create({ data: { documentId: "doc-x", passportId: "N1234567", fileSha256: PASSPORT_FILE } }),
            (error) => error.code === "P2002"
        );
        await db.document.create({ data: { documentId: "doc-y", passportId: "N7654321", fileSha256: PASSPORT_FILE } });
    });
});
