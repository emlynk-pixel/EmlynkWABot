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
// document from an interrupted attempt (ALREADY_STORED), and a copy an
// interrupted attempt already made is reused (placementRecovery.js).
//
// Stale attempts: an attempt may outlive its lease (e.g. a slow call) while
// another attempt has taken the submission over. Every write of an attempt
// is therefore conditional on its claim (status, attempt number, lease
// start). Database writes are fenced atomically: the client record update
// and the documents insert commit in one transaction with a renewal of the
// claim, and the final temporary_data update is itself conditional. A
// storage copy can't join a transaction: the claim is renewed right before
// it, and a retry reuses a copy that landed late (placementRecovery.js).
// An attempt that lost its claim writes nothing more and its result is
// discarded (logged).
// Timing: a renewal starts a fresh lease, and what follows it before the
// next check is one storage call (bounded by STORAGE_TIMEOUT_MS), far
// shorter than the lease.

import { EventEmitter } from "node:events";

import { processDocument as defaultProcessDocument } from "./documentProcessingService.js";
import { classifyDocument } from "./documentClassificationService.js";
import { mimeTypeForPath } from "./adminReviewService.js";
import { MAX_CONCURRENT_OCR_JOBS } from "./ocrService.js";
import { RECEIVED_STATUS } from "./statusMapping.js";
import { ClaimLostError } from "./temporaryDataService.js";
import { sha256Hex } from "../utils/fileChecksum.js";
import { safeErrorText } from "../utils/safeLog.js";
import { STORAGE_TIMEOUT_MS, withStorageTimeout } from "../utils/storageTimeout.js";

export const QUEUE_DEFAULTS = Object.freeze({
    pollMs: 5_000,              // fallback poll; new submissions wake the worker at once
    leaseMs: 10 * 60_000,       // longer than the slowest processing (OCR wait + job ≈ 3 min)
    retryDelayMs: 60_000,       // after a temporary failure to load the file
    maxAttempts: 3,
    concurrency: MAX_CONCURRENT_OCR_JOBS,
    storageTimeoutMs: STORAGE_TIMEOUT_MS, // 1 min, a tenth of the lease
});

// One storage call must always end well inside a lease (see above).
if (QUEUE_DEFAULTS.storageTimeoutMs * 2 >= QUEUE_DEFAULTS.leaseMs) {
    throw new Error("The storage timeout must be well below the worker lease");
}

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
    receivedAt: true, createdDate: true, processingAttempts: true, processingStartedAt: true, placementPath: true,
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

// One attempt's claim on a submission. where() matches the row only while
// this attempt still owns it; renew() checks that and starts a fresh lease
// (optionally recording the storage path about to be created), inside a
// transaction when given its client (the row lock then keeps a competing
// claim waiting until that transaction ends); release() hands it back
// early. `clock` is the worker's time source.
export function createClaim(row, { db, clock = () => new Date(), leaseMs = QUEUE_DEFAULTS.leaseMs, retryDelayMs = QUEUE_DEFAULTS.retryDelayMs }) {
    let startedAt = row.processingStartedAt;
    const where = () => ({
        temporaryId: row.temporaryId,
        processingStatus: RECEIVED_STATUS,
        processingAttempts: row.processingAttempts,
        processingStartedAt: startedAt,
    });
    return {
        temporaryId: row.temporaryId,
        attempt: row.processingAttempts,
        // Path recorded by an earlier, interrupted attempt (placementRecovery.js).
        earlierPlacementPath: row.placementPath ?? null,
        where,
        async renew({ placementPath, tx = db } = {}) {
            const at = clock();
            const { count } = await tx.temporaryData.updateMany({
                where: where(),
                data: { processingStartedAt: at, ...(placementPath ? { placementPath } : {}) },
            });
            if (count !== 1) throw new ClaimLostError();
            startedAt = at;
        },
        // Shutdown: claimable again in about retryDelayMs, and this attempt
        // is not counted. This attempt owns nothing afterwards (its own
        // later writes no longer match). Returns whether it was released.
        async release() {
            const { count } = await db.temporaryData.updateMany({
                where: where(),
                data: {
                    processingAttempts: row.processingAttempts - 1,
                    processingStartedAt: new Date(clock().getTime() - leaseMs + retryDelayMs),
                },
            });
            return count === 1;
        },
    };
}

// Records FAILED for a submission the worker can't process (only while this
// attempt still owns it).
async function giveUp(db, claim, stage, error) {
    const { count } = await db.temporaryData.updateMany({
        where: claim.where(),
        data: {
            processingStatus: "FAILED",
            reviewReason: "PROCESSING_FAILED",
            processingSummary: { stage, error, processingStatus: "FAILED", recordUpdated: true, attempts: claim.attempt },
        },
    });
    return { outcome: count === 1 ? "GAVE_UP" : "STALE_DISCARDED" };
}

// One claimed submission: load the received file and run the pipeline.
// Returns what happened (for logs and tests); never throws for a bad file.
// Storage calls are bounded by storageTimeoutMs: a hung call fails like
// any storage error (download -> tried again later; copy -> FAILED).
// `activeClaims` (the worker's) holds the claim while it runs.
export async function processClaimedSubmission(row, {
    db, bucket, maxAttempts = QUEUE_DEFAULTS.maxAttempts, leaseMs = QUEUE_DEFAULTS.leaseMs,
    retryDelayMs = QUEUE_DEFAULTS.retryDelayMs, storageTimeoutMs = QUEUE_DEFAULTS.storageTimeoutMs,
    now = new Date(), clock = () => new Date(), activeClaims = null, processDocument = defaultProcessDocument, extractText,
} = {}) {
    const claim = createClaim(row, { db, clock, leaseMs, retryDelayMs });
    const storage = withStorageTimeout(bucket, storageTimeoutMs);
    activeClaims?.add(claim);
    try {
        if (row.processingAttempts > maxAttempts) {
            return await giveUp(db, claim, "WORKER", `Processing did not finish after ${maxAttempts} attempts`);
        }

        const { data, error } = await storage.download(row.temporaryStoragePath);
        if (error || !data) {
            if (row.processingAttempts >= maxAttempts) {
                return await giveUp(db, claim, "FILE_LOAD", "The received file could not be loaded from storage");
            }
            // Temporary: let the lease run out early so it is tried again in about retryDelayMs.
            const { count } = await db.temporaryData.updateMany({
                where: claim.where(),
                data: { processingStartedAt: new Date(now.getTime() - leaseMs + retryDelayMs) },
            });
            return { outcome: count === 1 ? "RETRY_LATER" : "STALE_DISCARDED" };
        }
        const fileBuffer = Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer());
        const mimeType = mimeTypeForPath(row.temporaryStoragePath);
        if (!mimeType || (row.fileSha256 && sha256Hex(fileBuffer) !== row.fileSha256.trim())) {
            return await giveUp(db, claim, "FILE_LOAD", "The stored file does not match the file that was received");
        }

        const fileName = row.originalFilename ?? null;
        const { summary, stale } = await processDocument({
            temporaryId: row.temporaryId,
            whatsappNumber: row.whatsappNumber,
            fileName,
            mimeType,
            fileBuffer,
            fileSha256: row.fileSha256?.trim(),
            temporaryStoragePath: row.temporaryStoragePath,
            receivedAt: row.receivedAt ?? row.createdDate,
            filenameClassification: classifyDocument({ fileName, mimeType }),
            deps: { db, bucket: storage, claim, ...(extractText ? { extractText } : {}) },
        });
        return stale ? { outcome: "STALE_DISCARDED" } : { outcome: "PROCESSED", summary };
    } finally {
        activeClaims?.delete(claim);
    }
}

// Claims and processes submissions until none is waiting (or shouldStop()
// says to stop: no new job is started then). For the worker loop and for
// tests. `now`, if given, is the clock (a function). Returns the outcomes in order.
export async function drainSubmissionQueue(options = {}) {
    const db = await resolveDb(options.db);
    const bucket = await resolveBucket(options.bucket);
    const clock = options.now ?? (() => new Date());
    const outcomes = [];
    for (;;) {
        if (options.shouldStop?.()) return outcomes;
        const now = clock();
        const row = await claimNextSubmission({ db, now, leaseMs: options.leaseMs });
        if (!row) return outcomes;
        const result = await processClaimedSubmission(row, { ...options, db, bucket, now, clock });
        outcomes.push({ temporaryId: row.temporaryId, attempt: row.processingAttempts, ...result });
        if (result.outcome === "RETRY_LATER") return outcomes; // don't spin on a storage outage
    }
}

// Starts the background worker (src/app.js). `concurrency` loops share the
// queue; each wakes on a new submission or every pollMs. Returns { stop }.
export function startSubmissionWorker(options = {}) {
    const { pollMs = QUEUE_DEFAULTS.pollMs, concurrency = QUEUE_DEFAULTS.concurrency, log = console } = options;
    const warn = (...args) => (log.warn ?? log.log).apply(log, args);
    let stopped = false;
    const activeClaims = new Set();
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
                const outcomes = await drainSubmissionQueue({ ...options, activeClaims, shouldStop: () => stopped });
                for (const o of outcomes) {
                    // IDs and outcomes only: never file names, numbers or document data.
                    if (o.outcome === "STALE_DISCARDED") {
                        warn("Stale background attempt discarded (the submission was taken over or finished meanwhile):", { temporaryId: o.temporaryId, attempt: o.attempt });
                        continue;
                    }
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
        // No new job is started after stop(). Running jobs may finish within
        // timeoutMs; any still running then are released (claimable again in
        // about retryDelayMs, attempt not counted) and whatever they do
        // afterwards is discarded. Returns { finished, released }.
        async stop({ timeoutMs = Infinity } = {}) {
            stopped = true;
            events.off("queued", wakeAll);
            wakeAll();
            const settled = Promise.allSettled(loops).then(() => true);
            let timer;
            const finished = Number.isFinite(timeoutMs)
                ? await Promise.race([settled, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs), false); })])
                : await settled;
            clearTimeout(timer);
            if (finished) return { finished: true, released: 0 };

            let released = 0;
            for (const claim of [...activeClaims]) {
                try {
                    if (await claim.release()) released += 1;
                } catch (error) {
                    log.error("Background job not released at shutdown (its lease runs out instead):", { temporaryId: claim.temporaryId, errorType: error?.name ?? "Error" });
                }
            }
            warn("Background worker stopped before its running jobs finished; they are resumed by the next run:", { released });
            return { finished: false, released };
        },
    };
}
