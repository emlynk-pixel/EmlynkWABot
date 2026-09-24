import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTemporaryDocumentRecord } from "../src/services/temporaryDataService.js";
import { sha256Hex } from "../src/utils/fileChecksum.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";

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
