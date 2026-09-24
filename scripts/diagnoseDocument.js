// Sanitized OCR/classification diagnostics for one document.
//
//   npm run diagnose:document -- path/to/file.jpg
//   npm run diagnose:document -- --storage-path temporary/<uuid>.jpeg
//
// Prints counts, confidence, indicator IDs and which known vocabulary words
// OCR recognized. It never prints document text, and a file downloaded from
// Supabase stays in memory only.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWorker } from "tesseract.js";

import { extractDocumentText, OCR_THRESHOLDING, recognizeImage } from "../src/services/ocrService.js";
import { describeTextForDiagnostics } from "../src/utils/ocrDiagnostics.js";

const MIME_BY_EXTENSION = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

async function loadInput(args) {
    const storageIndex = args.indexOf("--storage-path");

    if (storageIndex !== -1) {
        const storagePath = args[storageIndex + 1];
        const { default: supabase } = await import("../src/config/supabase.js");
        const { data, error } = await supabase.storage.from(process.env.SUPABASE_BUCKET).download(storagePath);
        if (error) throw new Error(`Download failed: ${error.message}`);
        return { buffer: Buffer.from(await data.arrayBuffer()), name: storagePath };
    }

    if (!args[0]) {
        throw new Error("Usage: diagnoseDocument.js <file> | --storage-path temporary/<uuid>.<ext>");
    }
    return { buffer: await readFile(args[0]), name: args[0] };
}

// Compare OCR settings on an image: the old default, each setting on its
// own, and the production behaviour (default read, then alternatives if weak).
async function compareImageSettings(buffer) {
    const worker = await createWorker("eng");
    const rows = [];

    try {
        const variants = [
            { label: "otsu (old default)", thresholding: OCR_THRESHOLDING.OTSU, rotateAuto: false },
            { label: "otsu + rotateAuto", thresholding: OCR_THRESHOLDING.OTSU, rotateAuto: true },
            { label: "sauvola", thresholding: OCR_THRESHOLDING.SAUVOLA, rotateAuto: false },
            { label: "sauvola + rotateAuto", thresholding: OCR_THRESHOLDING.SAUVOLA, rotateAuto: true },
        ];

        for (const { label, thresholding, rotateAuto } of variants) {
            await worker.setParameters({ thresholding_method: thresholding.tesseractValue });
            const result = await worker.recognize(buffer, { rotateAuto });
            rows.push({ label, confidence: Math.round(result.data.confidence), ...describeTextForDiagnostics(result.data.text) });
        }

        const production = await recognizeImage(worker, buffer);
        rows.push({
            label: `production (${production.thresholding}${production.rotateAuto ? " + rotateAuto" : ""})`,
            confidence: Math.round(production.confidence),
            ...describeTextForDiagnostics(production.text),
        });
    } finally {
        await worker.terminate();
    }

    return rows;
}

function printRow(row) {
    const { classification, vocabulary } = row;

    console.log(`\n--- ${row.label ?? row.method}`);
    console.log(`confidence ${row.confidence ?? "-"} | chars ${row.textLength} | lines ${row.lineCount} | words ${row.wordCount} | letterRatio ${row.letterRatio} | avgWordLength ${row.averageWordLength} | mrzLines ${row.mrzLinesFound}`);
    console.log(`classification ${classification.documentType}${classification.reason ? ` (${classification.reason})` : ""} scores ${JSON.stringify(classification.scores)}`);
    console.log(`indicators [${classification.indicators.join(", ")}]`);

    for (const [documentType, { exact, near }] of Object.entries(vocabulary)) {
        console.log(`vocabulary ${documentType}: exact [${exact.join(", ")}] near-miss [${near.join(", ")}]`);
    }
}

async function main() {
    const { buffer, name } = await loadInput(process.argv.slice(2));
    const mimeType = MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported file extension. Use .pdf, .jpg, .jpeg or .png.");

    console.log(`Diagnostics for a ${mimeType} file (${buffer.length} bytes). No document text is printed.`);

    if (mimeType === "application/pdf") {
        const result = await extractDocumentText({ fileBuffer: buffer, mimeType });
        printRow({ method: result.method, confidence: result.confidence, ...describeTextForDiagnostics(result.text) });
        return;
    }

    for (const row of await compareImageSettings(buffer)) {
        printRow(row);
    }
}

main().catch((error) => {
    console.error("Diagnostics failed:", error.message);
    process.exitCode = 1;
});
