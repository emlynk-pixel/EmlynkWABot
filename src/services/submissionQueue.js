// Background processing of WhatsApp submissions (M1).
//
// The webhook stores the file in temporary/ and commits its temporary_data
// row (status TEMPORARY_STORED) before it answers Meta; that row is the
// durable job. This worker picks such rows up and runs the existing
// pipeline (processDocument) on them — the single source of processing
// logic. No queue service: PostgreSQL rows only.
//
// Claiming is a compare-and-swap on the row (status, attempts, lease start),
// so two workers (or two app instances) never process the same submission
// at the same time. A claim is a lease: if the process dies, the lease runs
// out and the submission is claimed again. Attempts are bounded; after the
// last one the submission is recorded FAILED (visible in the dashboard, H3).
// Processing a submission again is safe: the pipeline recognises its own
// document from an interrupted attempt (ALREADY_STORED).

import { EventEmitter } from "node:events";

import { processDocument as defaultProcessDocument } from "./documentProcessingService.js";
import { classifyDocument } from "./documentClassificationService.js";
import { mimeTypeForPath } from "./adminReviewService.js";
import { MAX_CONCURRENT_OCR_JOBS } from "./ocrService.js";
import { RECEIVED_STATUS } from "./statusMapping.js";
import { sha256Hex } from "../utils/fileChecksum.js";
import { safeErrorText } from "../utils/safeLog.js";

export const QUEUE_DEFAULTS = Object.freeze({
    pollMs: 5_000,              // fallback poll; new submissions wake the worker at once
    leaseMs: 10 * 60_000,       // longer than the slowest processing (OCR wait + job ≈ 3 min)
    retryDelayMs: 60_000,       // after a temporary failure to load the file
    maxAttempts: 3,
    concurrency: MAX_CONCURRENT_OCR_JOBS,
});

const events = new EventEmitter();

// Called by the webhook after a submission has been committed.
export function notifySubmissionQueued() {
    events.emit("queued");
}

async function resolveDb(db) {
    return db ?? (await import("../config/prisma.js")).default;
}

async function resolveBucket(bucket) {
    if (bucket) return bucket;
    const { default: supabase } = await import("../config/supabase.js");
    return supabase.storage.from(process.env.SUPABASE_BUCKET);
}

const claimSelect = {
    temporaryId: true, whatsappNumber: true, temporaryStoragePath: true, fileSha256: true, originalFilename: true,
    receivedAt: true, createdDate: true, processingAttempts: true, processingStartedAt: true,
};

// The oldest submission that is waiting (never claimed) or whose lease ran
// out, claimed for this worker; null when there is none.
export async function claimNextSubmission({ db, now = new Date(), leaseMs = QUEUE_DEFAULTS.leaseMs }) {
    const cutoff = new Date(now.getTime() - leaseMs);
    for (let tries = 0; tries < 5; tries++) {
        const candidate = await db.temporaryData.findFirst({
            where: { processingStatus: RECEIVED_STATUS, OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: cutoff } }] },
            orderBy: [{ createdDate: "asc" }, { temporaryId: "asc" }],
            select: claimSelect,
        });
        if (!candidate) return null;
        // Only if nobody claimed it in between (same status, attempts and lease).
        const { count } = await db.temporaryData.updateMany({
            where: {
                temporaryId: candidate.temporaryId,
                processingStatus: RECEIVED_STATUS,
                processingAttempts: candidate.processingAttempts,
                processingStartedAt: candidate.processingStartedAt,
            },
            data: { processingAttempts: candidate.processingAttempts + 1, processingStartedAt: now },
        });
        if (count === 1) return { ...candidate, processingAttempts: candidate.processingAttempts + 1, processingStartedAt: now };
    }
    return null;
}

// Records FAILED for a submission the worker can't process (still waiting only).
async function giveUp(db, row, stage, error) {
    await db.temporaryData.updateMany({
        where: { temporaryId: row.temporaryId, processingStatus: RECEIVED_STATUS },
        data: {
            processingStatus: "FAILED",
            reviewReason: "PROCESSING_FAILED",
            processingSummary: { stage, error, processingStatus: "FAILED", recordUpdated: true, attempts: row.processingAttempts },
        },
    });
}

// One claimed submission: load the received file and run the pipeline.
// Returns what happened (for logs and tests); never throws for a bad file.
export async function processClaimedSubmission(row, { db, bucket, maxAttempts = QUEUE_DEFAULTS.maxAttempts, leaseMs = QUEUE_DEFAULTS.leaseMs, retryDelayMs = QUEUE_DEFAULTS.retryDelayMs, now = new Date(), processDocument = defaultProcessDocument, extractText } = {}) {
    if (row.processingAttempts > maxAttempts) {
        await giveUp(db, row, "WORKER", `Processing did not finish after ${maxAttempts} attempts`);
        return { outcome: "GAVE_UP" };
    }

    const { data, error } = await bucket.download(row.temporaryStoragePath);
    if (error || !data) {
        if (row.processingAttempts >= maxAttempts) {
            await giveUp(db, row, "FILE_LOAD", "The received file could not be loaded from storage");
            return { outcome: "GAVE_UP" };
        }
        // Temporary: let the lease run out early so it is tried again in about retryDelayMs.
        await db.temporaryData.updateMany({
            where: { temporaryId: row.temporaryId, processingStatus: RECEIVED_STATUS, processingStartedAt: row.processingStartedAt },
            data: { processingStartedAt: new Date(now.getTime() - leaseMs + retryDelayMs) },
        });
        return { outcome: "RETRY_LATER" };
    }
    const fileBuffer = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
    const mimeType = mimeTypeForPath(row.temporaryStoragePath);
    if (!mimeType || (row.fileSha256 && sha256Hex(fileBuffer) !== row.fileSha256.trim())) {
        await giveUp(db, row, "FILE_LOAD", "The stored file does not match the file that was received");
        return { outcome: "GAVE_UP" };
    }

    const fileName = row.originalFilename ?? null;
    const { summary } = await processDocument({
        temporaryId: row.temporaryId,
        whatsappNumber: row.whatsappNumber,
        fileName,
        mimeType,
        fileBuffer,
        fileSha256: row.fileSha256?.trim(),
        temporaryStoragePath: row.temporaryStoragePath,
        receivedAt: row.receivedAt ?? row.createdDate,
        filenameClassification: classifyDocument({ fileName, mimeType }),
        deps: { db, bucket, ...(extractText ? { extractText } : {}) },
    });
    return { outcome: "PROCESSED", summary };
}

// Claims and processes submissions until none is waiting. For the worker
// loop and for tests. Returns the outcomes in order.
export async function drainSubmissionQueue(options = {}) {
    const db = await resolveDb(options.db);
    const bucket = await resolveBucket(options.bucket);
    const outcomes = [];
    for (;;) {
        const now = options.now?.() ?? new Date();
        const row = await claimNextSubmission({ db, now, leaseMs: options.leaseMs });
        if (!row) return outcomes;
        const result = await processClaimedSubmission(row, { ...options, db, bucket, now });
        outcomes.push({ temporaryId: row.temporaryId, attempt: row.processingAttempts, ...result });
        if (result.outcome === "RETRY_LATER") return outcomes; // don't spin on a storage outage
    }
}

// Starts the background worker (src/app.js). `concurrency` loops share the
// queue; each wakes on a new submission or every pollMs. Returns { stop }.
export function startSubmissionWorker(options = {}) {
    const { pollMs = QUEUE_DEFAULTS.pollMs, concurrency = QUEUE_DEFAULTS.concurrency, log = console } = options;
    let stopped = false;
    const waiters = new Set();
    const wakeAll = () => { for (const wake of waiters) wake(); };
    events.on("queued", wakeAll);

    const sleep = () => new Promise((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done() { clearTimeout(timer); waiters.delete(done); resolve(); }
        waiters.add(done);
    });

    async function loop() {
        while (!stopped) {
            try {
                const outcomes = await drainSubmissionQueue(options);
                for (const o of outcomes) {
                    // IDs and outcomes only: never file names, numbers or document data.
                    log.log("Submission processed in background:", { temporaryId: o.temporaryId, attempt: o.attempt, outcome: o.outcome, processingStatus: o.summary?.processingStatus ?? null });
                }
            } catch (error) {
                log.error("Background processing error:", { errorType: error?.name ?? "Error", error: safeErrorText(error) });
            }
            if (!stopped) await sleep();
        }
    }
    const loops = Array.from({ length: concurrency }, loop);

    return {
        async stop() {
            stopped = true;
            events.off("queued", wakeAll);
            wakeAll();
            await Promise.allSettled(loops);
        },
    };
}
