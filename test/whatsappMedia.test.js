import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractDocumentMetadata, SUPPORTED_MEDIA_MESSAGE_TYPES } from "../src/utils/whatsappMedia.js";
import { validateDocumentFile } from "../src/utils/fileValidation.js";

// Message shapes as sent by the WhatsApp Cloud API webhook (synthetic IDs).
const documentMessage = {
    from: "94770000000",
    id: "wamid.DOC1",
    type: "document",
    document: { id: "media-doc-1", filename: "passport.pdf", mime_type: "application/pdf", sha256: "abc" },
};

const imageMessage = {
    from: "94770000000",
    id: "wamid.IMG1",
    type: "image",
    image: { id: "media-img-1", mime_type: "image/jpeg", sha256: "def" },
};

describe("extractDocumentMetadata: documents (unchanged behaviour)", () => {
    test("PDF document", () => {
        assert.deepEqual(extractDocumentMetadata(documentMessage), {
            valid: true,
            mediaId: "media-doc-1",
            fileName: "passport.pdf",
            mimeType: "application/pdf",
        });
    });

    test("document without a filename", () => {
        const message = { ...documentMessage, document: { id: "media-doc-2", mime_type: "application/pdf" } };
        assert.deepEqual(extractDocumentMetadata(message), {
            valid: true,
            mediaId: "media-doc-2",
            fileName: undefined,
            mimeType: "application/pdf",
        });
    });

    test("document without a media ID", () => {
        const message = { ...documentMessage, document: { filename: "x.pdf" } };
        assert.deepEqual(extractDocumentMetadata(message), { valid: false, reason: "NO_MEDIA_ID" });
    });
});

describe("extractDocumentMetadata: images", () => {
    test("JPEG photo", () => {
        assert.deepEqual(extractDocumentMetadata(imageMessage), {
            valid: true,
            mediaId: "media-img-1",
            fileName: null,
            mimeType: "image/jpeg",
        });
    });

    test("PNG image", () => {
        const message = { ...imageMessage, image: { id: "media-img-2", mime_type: "image/png" } };
        const result = extractDocumentMetadata(message);

        assert.equal(result.valid, true);
        assert.equal(result.mediaId, "media-img-2");
        assert.equal(result.mimeType, "image/png");
    });

    test("caption is ignored and never used as a filename", () => {
        const message = { ...imageMessage, image: { ...imageMessage.image, caption: "my passport" } };
        assert.equal(extractDocumentMetadata(message).fileName, null);
    });

    test("image without a media ID", () => {
        const message = { ...imageMessage, image: { mime_type: "image/jpeg" } };
        assert.deepEqual(extractDocumentMetadata(message), { valid: false, reason: "NO_MEDIA_ID" });
    });

    test("image type but the image object is missing", () => {
        const message = { ...imageMessage };
        delete message.image;
        assert.deepEqual(extractDocumentMetadata(message), { valid: false, reason: "NO_MEDIA_ID" });
    });

    test("an image message's media is read from message.image, not message.document", () => {
        const message = { ...imageMessage, document: { id: "wrong", filename: "wrong.pdf" } };
        const result = extractDocumentMetadata(message);

        assert.equal(result.mediaId, "media-img-1");
        assert.equal(result.fileName, null);
    });
});

describe("extractDocumentMetadata: unsupported messages", () => {
    for (const type of ["text", "audio", "video", "sticker", "location", "reaction"]) {
        test(`${type} message is not processed`, () => {
            const message = { from: "94770000000", id: `wamid.${type}`, type, [type]: { id: "media-x" } };
            assert.deepEqual(extractDocumentMetadata(message), { valid: false, reason: "NOT_A_DOCUMENT" });
        });
    }

    test("missing message", () => {
        assert.deepEqual(extractDocumentMetadata(undefined), { valid: false, reason: "NOT_A_DOCUMENT" });
    });

    test("only document and image are supported", () => {
        assert.deepEqual([...SUPPORTED_MEDIA_MESSAGE_TYPES], ["document", "image"]);
    });
});

describe("image messages use the existing validation rules", () => {
    const validate = (mimeType, fileSize = 50_000) => validateDocumentFile({ mimeType, fileSize });

    test("JPEG and PNG pass", () => {
        assert.deepEqual(validate("image/jpeg"), { valid: true });
        assert.deepEqual(validate("image/png"), { valid: true });
    });

    test("WebP (not in the allowed list) is rejected", () => {
        assert.equal(validate("image/webp").reason, "UNSUPPORTED_FILE_TYPE");
    });

    test("image without a MIME type is rejected", () => {
        assert.equal(validate(undefined).reason, "MISSING_MIME_TYPE");
    });

    test("image over 10 MB is rejected", () => {
        assert.equal(validate("image/jpeg", 10 * 1024 * 1024 + 1).reason, "FILE_TOO_LARGE");
    });
});
