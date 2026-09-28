import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTemporaryDocumentRecord, deleteTemporaryDocument } from "../src/services/temporaryDataService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

describe("createTemporaryDocumentRecord", () => {
    test("stores the file checksum with the new temporary record", async () => {
        const db = createFakePrisma();
        const fileSha256 = sha256Hex(Buffer.from("synthetic document bytes"));

        const record = await createTemporaryDocumentRecord({
            whatsappNumber: "94770000000",
            temporaryStoragePath: "temporary/abc.pdf",
            fileSha256,
        }, { db });

        const { data } = db.calls.find((c) => c.method === "temporaryData.create");
        assert.equal(data.fileSha256, fileSha256);
        assert.equal(data.documentType, "UNCLASSIFIED");
        assert.equal(data.processingStatus, "TEMPORARY_STORED");
        assert.equal(data.whatsappNumber, "94770000000");
        assert.equal(record.fileSha256, fileSha256);
    });

    test("each record gets its own temporary ID", async () => {
        const db = createFakePrisma();
        const input = { whatsappNumber: "94770000000", temporaryStoragePath: "temporary/a.pdf", fileSha256: "a".repeat(64) };

        const first = await createTemporaryDocumentRecord(input, { db });
        const second = await createTemporaryDocumentRecord(input, { db });

        assert.notEqual(first.temporaryId, second.temporaryId);
    });
});

describe("deleteTemporaryDocument", () => {
    test("permanently deletes a temporary document and its files with audit", async () => {
        const temporaryId = "tmp-test-1";
        const admin = { adminId: "a1", name: "Alice" };
        const temporaryData = [
            { temporaryId, processingStatus: "FAILED", documentType: "MEDICAL", temporaryStoragePath: "temporary/f1.pdf", pendingStoragePath: null, fileSha256: "deadbeef" },
        ];
        const db = createFakePrisma([], { temporaryData });
        const bucket = createFakeBucket(["temporary/f1.pdf", "other/keep.pdf"]);

        const result = await deleteTemporaryDocument(temporaryId, admin, { db, bucket });

        assert.equal(result.deleted, true);
        assert.equal(db.tables.temporaryData.length, 0, "Row deleted");
        assert.deepEqual([...bucket.objects.keys()].sort(), ["other/keep.pdf"], "File deleted from storage");

        const audit = db.tables.auditLog[0];
        assert.ok(audit, "Audit entry created");
        assert.equal(audit.action, "DELETE_TEMPORARY_DOCUMENT");
        assert.equal(audit.temporaryId, temporaryId);
        assert.equal(audit.adminId, admin.adminId);
        assert.equal(audit.previousStatus, "FAILED");
        assert.equal(audit.newStatus, "DELETED");
        assert.equal(audit.documentType, "MEDICAL");
        assert.equal(audit.fileSha256, "deadbeef");
    });
});
