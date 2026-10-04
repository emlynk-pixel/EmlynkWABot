import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

import {
    extractTextFromImage,
    recognizeImageWithUpscale,
    rotateImage,
    mrzEvidence,
    OcrResourceError,
    ORIENTATION_CANDIDATES,
} from "../src/ocrService.js";
import { readImageDimensions } from "../src/utils/imageDimensions.js";

// Photos taken sideways or upside down (0°, 90°, 180°, 270°). Synthetic data only.
// Classification of turned real photos, and the pipeline storing the
// received file unchanged, are tested by the backend: test/ocrPipeline.test.js.
const loadFile = (name) => readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url));
const ocrTest = process.env.RUN_OCR_TESTS === "1" ? test : test.skip;

// Rotates an image clockwise pixel by pixel (pngjs / jpeg-js only), independent
// of the code under test, and returns a PNG.
function turnImage(buffer, degrees) {
    const src = buffer[0] === 0x89 ? PNG.sync.read(buffer) : jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    const { width: w, height: h, data } = src;
    const sideways = degrees % 180 !== 0;
    const out = new PNG({ width: sideways ? h : w, height: sideways ? w : h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [nx, ny] = {
                0: [x, y],
                90: [h - 1 - y, x],
                180: [w - 1 - x, h - 1 - y],
                270: [y, w - 1 - x],
            }[degrees];
            const s = (y * w + x) * 4;
            const d = (ny * out.width + nx) * 4;
            out.data[d] = data[s]; out.data[d + 1] = data[s + 1]; out.data[d + 2] = data[s + 2]; out.data[d + 3] = 255;
        }
    }
    return PNG.sync.write(out);
}

// A small "document": landscape, white, with a dark block in the top-left
// corner only. Upright means: wider than high and darkest in the top-left.
function markerDocument() {
    const png = new PNG({ width: 60, height: 40 });
    for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 60; x++) {
            const i = (y * 60 + x) * 4;
            const dark = x < 20 && y < 12;
            png.data[i] = png.data[i + 1] = png.data[i + 2] = dark ? 0 : 255;
            png.data[i + 3] = 255;
        }
    }
    return PNG.sync.write(png);
}
function isUpright(buffer) {
    const { width, height, data } = PNG.sync.read(buffer);
    if (width <= height) return false;
    const darkness = (x0, y0) => {
        let sum = 0;
        for (let y = y0; y < y0 + height / 2; y++) for (let x = x0; x < x0 + width / 2; x++) sum += 255 - data[(y * width + x) * 4];
        return sum;
    };
    const quadrants = [darkness(0, 0), darkness(width / 2, 0), darkness(0, height / 2), darkness(width / 2, height / 2)];
    return quadrants[0] === Math.max(...quadrants) && quadrants[0] > 0;
}

const MEDICAL_TEXT = "GAMCA MEDICAL EXAMINATION REPORT\nMedical fitness certificate\nThe candidate is FIT for employment.";
const GARBAGE = { text: "~ ,. ;' |i l1 -_ ;: ,. ~~ ;", confidence: 31 };

// A stand-in Tesseract worker: reads the document well only when it is upright.
function orientationWorker({ upright = { text: MEDICAL_TEXT, confidence: 95 }, sideways = GARBAGE } = {}) {
    const reads = [];
    return {
        reads,
        async setParameters() {},
        async recognize(image, options) {
            const ok = image[0] === 0x89 && isUpright(image);
            reads.push({ upright: ok, rotateAuto: options.rotateAuto });
            return { data: ok ? upright : sideways };
        },
        async terminate() {},
    };
}
const noUpscale = async () => null;

describe("OCR orientation: the OCR input is turned upright, the received file never changes", () => {
    const upright = markerDocument();

    test("0°: an upright image that reads well is read once, never turned", async () => {
        const worker = orientationWorker();
        let turns = 0;
        const read = await recognizeImageWithUpscale(worker, upright, readImageDimensions(upright), { upscale: noUpscale, rotate: async (...a) => { turns += 1; return rotateImage(...a); } });
        assert.equal(read.text, MEDICAL_TEXT);
        assert.equal(read.rotation, 0);
        assert.equal(worker.reads.length, 1);
        assert.equal(turns, 0);
    });

    for (const received of [90, 180, 270]) {
        const correction = (360 - received) % 360;
        test(`${received}°: turned ${correction}° for OCR and read like the upright document`, async () => {
            const image = turnImage(upright, received);
            const worker = orientationWorker();
            const read = await recognizeImageWithUpscale(worker, image, readImageDimensions(image), { upscale: noUpscale });
            assert.equal(read.rotation, correction);
            assert.equal(read.text, MEDICAL_TEXT);
            assert.equal(read.confidence, 95);
            assert.ok(worker.reads.length <= 1 + 3 + ORIENTATION_CANDIDATES.length, "bounded number of reads");
        });
    }

    test("fallback: the image can't be decoded for turning -> the read as received is kept (no error)", async () => {
        const image = turnImage(upright, 90);
        const worker = orientationWorker();
        const read = await recognizeImageWithUpscale(worker, image, readImageDimensions(image), { upscale: noUpscale, rotate: async () => null });
        assert.deepEqual([read.rotation, read.text], [0, GARBAGE.text]);
    });

    test("fallback: turning fails unexpectedly -> the read as received is kept (no error)", async () => {
        const image = turnImage(upright, 90);
        const worker = orientationWorker();
        const read = await recognizeImageWithUpscale(worker, image, readImageDimensions(image), { upscale: noUpscale, rotate: async () => { throw new Error("canvas failed"); } });
        assert.deepEqual([read.rotation, read.text], [0, GARBAGE.text]);
    });

    test("fallback: no orientation reads clearly better (e.g. a blank or unreadable photo) -> stays as received", async () => {
        const worker = orientationWorker({ upright: { text: "~ ,. ;' |i l1 -_ ;: ,. ~~ ; x", confidence: 34 } });
        const image = turnImage(upright, 90);
        const read = await recognizeImageWithUpscale(worker, image, readImageDimensions(image), { upscale: noUpscale });
        assert.equal(read.rotation, 0, "a difference within the similar-confidence margin never turns the image");
    });

    test("a read with a complete passport MRZ is never turned, even at low confidence", async () => {
        const mrz = readFileSync(new URL("./fixtures/documents/passport-mrz.txt", import.meta.url), "utf8").trim();
        assert.equal(mrzEvidence(mrz), 4);
        const worker = orientationWorker({ sideways: { text: mrz, confidence: 40 } });
        const image = turnImage(upright, 90);
        const read = await recognizeImageWithUpscale(worker, image, readImageDimensions(image), { upscale: noUpscale });
        assert.equal(read.rotation, 0);
        assert.equal(worker.reads.length, 4, "the usual retries only; no orientation reads");
    });

    test("rotateImage turns the pixels exactly (checked against an independent rotation)", async () => {
        for (const degrees of [90, 180, 270]) {
            const turned = await rotateImage(upright, readImageDimensions(upright), degrees);
            assert.deepEqual(turned.dimensions, { format: "png", width: degrees === 180 ? 60 : 40, height: degrees === 180 ? 40 : 60 });
            assert.deepEqual(PNG.sync.read(turned.image).data, PNG.sync.read(turnImage(upright, degrees)).data, `${degrees}°`);
        }
    });

    test("rotateImage: a corrupt image -> null; a decoded size that differs from the header -> IMAGE_UNREADABLE", async () => {
        const corrupt = Buffer.concat([upright.subarray(0, 40), Buffer.alloc(40)]);
        assert.equal(await rotateImage(corrupt, { format: "png", width: 60, height: 40 }, 90), null);
        await assert.rejects(rotateImage(upright, { format: "png", width: 61, height: 40 }, 90), (e) => e instanceof OcrResourceError && e.reason === "IMAGE_UNREADABLE");
    });

    test("the received buffer is not modified; only the OCR input is turned", async () => {
        const image = turnImage(upright, 270);
        const before = Buffer.from(image);
        const worker = orientationWorker();
        const result = await extractTextFromImage(image, { createOcrWorker: async () => worker, upscale: noUpscale });
        assert.deepEqual([result.rotation, result.text], [90, MEDICAL_TEXT]);
        assert.ok(image.equals(before), "byte for byte unchanged");
    });
});

describe("OCR orientation with real Tesseract (RUN_OCR_TESTS=1)", () => {
    for (const file of ["passport-photo.jpg", "image-medical.png", "police-photo-hard.jpg"]) {
        for (const received of [90, 180, 270]) {
            ocrTest(`${file} received at ${received}° is turned back upright for OCR`, async () => {
                const result = await extractTextFromImage(turnImage(loadFile(file), received));
                assert.equal(result.rotation, (360 - received) % 360);
                assert.ok(result.confidence >= 80, `confidence ${result.confidence}`);
                if (file.startsWith("passport")) assert.equal(mrzEvidence(result.text), 4);
            });
        }
    }

    ocrTest("small low-quality passport (380 x 520) received at 90° -> both MRZ lines valid (2x read of the turned image)", async () => {
        const result = await extractTextFromImage(turnImage(loadFile("passport-photo-small.jpg"), 90));
        assert.equal(result.rotation, 270);
        assert.equal(mrzEvidence(result.text), 4);
    });

    ocrTest("a blank image is never turned", async () => {
        const result = await extractTextFromImage(turnImage(loadFile("blank.png"), 90));
        assert.equal(result.rotation, 0);
    });
});
