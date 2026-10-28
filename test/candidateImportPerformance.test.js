// Bulk candidate import: a SAFE performance check on SYNTHETIC data, 100 / 500 / 1,000 rows, on an
// in-process PostgreSQL (PGlite). Never production: nothing here reads DATABASE_URL.
// Measures the server pipeline (validation + preview, chunked commit, per-chunk durations, Prisma
// operation counts, heap) and the existing reconciliation writing the mirror (in-memory Sheet).
// PGlite has no network latency and one connection: absolute times are a lower bound; the
// operation counts are what carries over to Supabase.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTestDatabase } from "./helpers/pgliteDatabase.js";
import { createFakeGoogleSheet } from "./helpers/fakeGoogleSheet.js";
import { chunkRows, commitChunk, finishImport, previewImport } from "../src/services/candidateImportService.js";
import { createCandidateAggregateReader } from "../src/services/candidateAggregateReader.js";
import { createGoogleSheetsAdapter } from "../src/services/googleSheetsAdapter.js";
import { createSheetSyncEngine } from "../src/services/sheetSyncEngine.js";
import { readSheetSyncConfig } from "../src/config/sheetSync.js";
import { authIdFor } from "./helpers/fakeSupabaseAuth.js";

const ADMIN = { adminId: "perf-admin", role: "ADMIN" };
const HEADERS = ["PASSPORT NUMBER", "SURNAME", "OTHER NAME", "FULL NAME", "NIC NUMBER", "WHATSAPP NUMBER", "Job Role", "BIRTH DATE", "PASSPORT EXPIRE DATE",
    "ADDRESS", "Marital Status", "SHIRT SIZE", "HIP SIZE", "SHOE SIZE", "Blood Group", "Father Alive", "Mother Alive", "FATHER DOB", "MOTHER DOB"];
// Every chunk must finish far inside Vercel's 60 s function limit, even with real network latency.
const CHUNK_BUDGET_MS = 10_000;

let database;
let prisma;
let pg;
before(async () => {
    database = await createTestDatabase();
    ({ prisma, pg } = database);
    await prisma.user.create({ data: { adminId: ADMIN.adminId, authUserId: authIdFor(ADMIN.adminId), name: "Perf", email: "perf@example.invalid", role: "ADMIN", status: "ACTIVE" } });
});
after(async () => database?.close());
beforeEach(async () => {
    await pg.exec(`DELETE FROM "candidate_import"; DELETE FROM "candidate_additional_details"; DELETE FROM "candidate"; DELETE FROM "sheet_sync_queue"; DELETE FROM "sheet_sync_runs";`);
});

const pad = (n, w) => String(n).padStart(w, "0");
// A realistic legacy mix (synthetic): ~30 % legacy N+8 passports, some Romanian numbers, bilingual answers.
function rows(count) {
    return Array.from({ length: count }, (_, k) => {
        const i = k + 1;
        return {
            rowNumber: i + 1,
            values: {
                "PASSPORT NUMBER": i % 3 === 0 ? `N9${pad(i, 7)}` : `N8${pad(i, 6)}`, SURNAME: `SYNTHSURNAME${i}`, "OTHER NAME": `SYNTH GIVEN ${i}`,
                "FULL NAME": `SYNTH GIVEN ${i} SYNTHSURNAME${i}`, "NIC NUMBER": i % 4 === 0 ? `${199000000000 + i}` : `${700000000 + i}v`,
                "WHATSAPP NUMBER": i % 2 === 0 ? `0${770000000 + i}` : `40${700000000 + i}`, "Job Role": i % 5 === 0 ? "Welder" : "Plaster",
                "BIRTH DATE": `${pad((i % 28) + 1, 2)}.${pad((i % 12) + 1, 2)}.1990`, "PASSPORT EXPIRE DATE": "01.01.2031", ADDRESS: `${i} Synthetic Road`,
                "Marital Status": "x (Single)", "SHIRT SIZE": "2XL", "HIP SIZE": "W32", "SHOE SIZE": "27.0 cm - size 9", "Blood Group": "O Positive (O+)",
                "Father Alive": "x (Yes)", "Mother Alive": "x (No)", "FATHER DOB": "01.01.1960", "MOTHER DOB": "01.01.1962",
            },
        };
    });
}

function counting() {
    const counter = { operations: 0 };
    return { counter, client: prisma.$extends({ query: { async $allOperations({ args, query }) { counter.operations++; return query(args); } } }) };
}

describe("bulk import performance (synthetic, PGlite)", () => {
    for (const size of [100, 500, 1000]) {
        test(`${size} candidates`, async () => {
            const data = rows(size);
            const { counter, client } = counting();
            const heapBefore = process.memoryUsage().heapUsed;

            let t = performance.now();
            const preview = await previewImport({ db: client, actor: ADMIN, fileName: "synthetic.xlsx", headers: HEADERS, rows: data });
            const previewMs = performance.now() - t;
            const previewOps = counter.operations;
            assert.equal(preview.summary.new, size);
            assert.equal(preview.summary.invalid, 0);

            const chunkMs = [];
            const chunkOps = [];
            t = performance.now();
            for (const [index, chunk] of chunkRows(data, preview.chunkSize).entries()) {
                const ops = counter.operations;
                const started = performance.now();
                const result = await commitChunk({ db: client, actor: ADMIN, importId: preview.importId, chunkIndex: index, rows: chunk });
                chunkMs.push(Math.round(performance.now() - started));
                chunkOps.push(counter.operations - ops);
                assert.equal(result.counts.failed, 0);
            }
            const commitMs = performance.now() - t;
            const finished = await finishImport({ db: client, actor: ADMIN, importId: preview.importId });
            assert.equal(finished.counts.created, size);
            const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

            // The existing reconciliation writes the mirror from the database (batched appends).
            const env = { SHEET_SYNC_ENABLED: "true", SHEET_SPREADSHEET_ID: "fake", SHEET_TAB_NAME: "Mirror" };
            const sheet = createFakeGoogleSheet({ tabName: "Mirror" });
            const engine = createSheetSyncEngine({ reader: createCandidateAggregateReader({ db: prisma }), sheets: createGoogleSheetsAdapter({ config: readSheetSyncConfig(env), sheetsClient: sheet.client }) });
            t = performance.now();
            const summary = await engine.reconcile({ guard: { max: 50, fraction: 0.2 } });
            const mirrorMs = performance.now() - t;
            assert.equal(summary.appended, size);
            assert.equal(sheet.dataRows().length, size);
            const googleWrites = sheet.writes().length;

            const metrics = {
                size, previewMs: Math.round(previewMs), previewOps, chunks: chunkMs.length, commitMs: Math.round(commitMs),
                maxChunkMs: Math.max(...chunkMs), maxChunkOps: Math.max(...chunkOps), totalOps: counter.operations, heapDeltaMb: Number(heapMb.toFixed(1)),
                mirrorMs: Math.round(mirrorMs), googleWriteRequests: googleWrites, failures: finished.counts.failed ?? 0,
            };
            console.log(JSON.stringify({ event: "candidate_import.performance", ...metrics }));

            // No N+1: operations per chunk and for the preview don't grow with the row count.
            assert.ok(previewOps <= 12, `preview operations ${previewOps}`);
            assert.ok(metrics.maxChunkOps <= 15, `operations per chunk ${metrics.maxChunkOps}`);
            assert.ok(metrics.maxChunkMs < CHUNK_BUDGET_MS, `slowest chunk ${metrics.maxChunkMs} ms`);
            // Google: batched (200 rows per append), never one request per candidate.
            assert.ok(googleWrites <= Math.ceil(size / 200), `Google write requests ${googleWrites}`);
        });
    }
});
