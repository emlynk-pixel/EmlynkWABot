import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateDocumentFile, fileSignatureMatches } from "../src/utils/fileValidation.js";
import { saveTemporaryFile } from "../src/services/temporaryStorageService.js";
import { createFakeBucket } from "./helpers/fakeStorage.js";

// Synthetic fixtures only.
const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const PDF = loadFile("text-passport.pdf");
const JPEG = loadFile("passport-photo.jpg");
const PNG = loadFile("image-medical.png");

const validate = (mimeType, fileBuffer) => validateDocumentFile({ mimeType, fileSize: fileBuffer.length, fileBuffer });

describe("file signature validation (SEC-009)", () => {
    test("real PDF, JPEG and PNG files pass with their own MIME type", () => {
        assert.deepEqual(validate("application/pdf", PDF), { valid: true });
        assert.deepEqual(validate("image/jpeg", JPEG), { valid: true });
        assert.deepEqual(validate("image/png", PNG), { valid: true });
    });

    test("a file whose bytes don't match the declared type is rejected", () => {
        const cases = [
            ["application/pdf", JPEG],
            ["application/pdf", PNG],
            ["image/jpeg", PDF],
            ["image/jpeg", PNG],
            ["image/png", PDF],
            ["image/png", JPEG],
        ];
        for (const [mimeType, buffer] of cases) {
            assert.equal(validate(mimeType, buffer).reason, "FILE_SIGNATURE_MISMATCH", mimeType);
        }
    });

    test("executables, HTML and scripts disguised as allowed types are rejected", () => {
        const disguised = [
            Buffer.from("MZ\x90\x00\x03\x00\x00\x00 synthetic windows executable header"),
            Buffer.from("\x7fELF\x02\x01\x01 synthetic linux executable header"),
            Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>"),
            Buffer.from("#!/bin/sh\necho synthetic\n"),
            Buffer.from("PK\x03\x04 synthetic zip"),
        ];
        for (const buffer of disguised) {
            for (const mimeType of ["application/pdf", "image/jpeg", "image/png"]) {
                assert.equal(validate(mimeType, buffer).reason, "FILE_SIGNATURE_MISMATCH");
            }
        }
    });

    test("PDF header may follow a little leading junk, but not more than 1024 bytes", () => {
        const withJunk = Buffer.concat([Buffer.alloc(100, 0x20), PDF]);
        assert.equal(fileSignatureMatches(withJunk, "application/pdf"), true);

        const tooFar = Buffer.concat([Buffer.alloc(1024, 0x20), PDF]);
        assert.equal(fileSignatureMatches(tooFar, "application/pdf"), false);
    });

    test("too-short files and non-buffers never match", () => {
        assert.equal(fileSignatureMatches(Buffer.from([0xff, 0xd8]), "image/jpeg"), false);
        assert.equal(fileSignatureMatches(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"), false);
        assert.equal(fileSignatureMatches("%PDF-1.4", "application/pdf"), false);
        assert.equal(fileSignatureMatches(PDF, "image/webp"), false);
    });

    test("the existing type and size checks still come first", () => {
        assert.equal(validateDocumentFile({ mimeType: "image/webp", fileSize: 10, fileBuffer: PNG }).reason, "UNSUPPORTED_FILE_TYPE");
        assert.equal(validateDocumentFile({ mimeType: "image/png", fileSize: 10 * 1024 * 1024 + 1, fileBuffer: PNG }).reason, "FILE_TOO_LARGE");
        assert.equal(validateDocumentFile({ mimeType: "image/png", fileSize: 0, fileBuffer: Buffer.alloc(0) }).reason, "INVALID_FILE_SIZE");
    });
});

describe("temporary storage naming (SEC-010)", () => {
    const save = async (mimeType, fileBuffer) => {
        const bucket = createFakeBucket();
        const result = await saveTemporaryFile({ fileBuffer, mimeType, bucket });
        return { ...result, bucket };
    };
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    test("extension comes from the MIME type: .pdf, .jpeg, .png", async () => {
        assert.match((await save("application/pdf", PDF)).storagePath, new RegExp(`^temporary/${UUID}\\.pdf$`));
        assert.match((await save("image/jpeg", JPEG)).storagePath, new RegExp(`^temporary/${UUID}\\.jpeg$`));
        assert.match((await save("image/png", PNG)).storagePath, new RegExp(`^temporary/${UUID}\\.png$`));
    });

    test("the sender's file name is ignored: passport.exe sent as a PDF is stored as .pdf", async () => {
        const bucket = createFakeBucket();
        const result = await saveTemporaryFile({ fileBuffer: PDF, mimeType: "application/pdf", originalFileName: "passport.exe", bucket });

        assert.match(result.storagePath, /\.pdf$/);
        assert.ok(!result.storagePath.includes("exe"));
        assert.ok(!result.storagePath.includes("passport"));
    });

    test("uploads with the validated content type and never overwrites", async () => {
        const { bucket, storagePath } = await save("image/png", PNG);
        const [upload] = bucket.calls.filter((c) => c.method === "upload");

        assert.equal(upload.path, storagePath);
        assert.equal(upload.contentType, "image/png");
        assert.equal(upload.upsert, false);
    });

    test("a MIME type outside the allowed list is refused before upload", async () => {
        const bucket = createFakeBucket();
        await assert.rejects(saveTemporaryFile({ fileBuffer: PDF, mimeType: "application/x-msdownload", bucket }));
        assert.equal(bucket.calls.length, 0);
    });

    test("upload errors don't include the storage path", async () => {
        const bucket = { upload: async () => ({ error: { message: "The resource already exists" } }) };
        await assert.rejects(
            saveTemporaryFile({ fileBuffer: PDF, mimeType: "application/pdf", bucket }),
            (error) => !error.message.includes("temporary/")
        );
    });
});
