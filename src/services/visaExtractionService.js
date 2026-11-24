// Visa Submission Phase 2: extraction of the signed VISA_SUBMISSION documents of a Job's candidates into
// VISA SUBMISSION/{YYYY-MM-DD}/Plan B/ ({passportId}.pdf, copied in storage) and into the Client's two
// Excel files (visaExtractionExcel.js). The admin page drives it in batches: the preview lists the
// eligible candidates, then each extract request names up to VISA_EXTRACTION_MAX_BATCH_SIZE of them;
// the server checks every one again, so a request can't extract anyone who is not eligible now.
//
// Eligible for a Job, all of:
//   1. a job_candidate row of that Job with released_at NULL (is_active is NOT read: a COMPLETED job
//      clears it, and its candidates still go to the visa submission);
//   2. the VISA_SUBMISSION stage completed;
//   3. the candidate's current VISA_SUBMISSION document is VERIFIED (currentOf: SUPERSEDED never counts);
//   4. no visa_submission_extraction row for THAT document. Keyed on the document, not the candidate:
//      a re-uploaded signed file is a new document, so the candidate is eligible again.
// Ordered by the signed document's upload time (documents.received_date, which the admin upload sets
// to the upload instant; then created_date, then the passport number). The vacancy count is not read.

import crypto from "node:crypto";

import { VISA_EXTRACTION_MAX_BATCH_SIZE, VISA_EXTRACTION_BATCH_SIZE, VISA_SUBMISSION_DOCUMENT_TYPE } from "../config/visaSubmission.js";
import { businessDateOf } from "../utils/businessDay.js";
import { withStorageTimeout } from "../utils/storageTimeout.js";
import { safeErrorInfo } from "../utils/safeLog.js";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";
import { CandidateError, CURRENT_DOCUMENT_SELECT, currentOf } from "./candidateService.js";
import { JOB_SELECT, jobSummaryView } from "./jobAssignmentReader.js";
import { upsertCandidateDetails, upsertExtraDetails, XLSX_CONTENT_TYPE } from "./visaExtractionExcel.js";
import {
    candidateDetailsFileName, clientFileNameOf, copyReplacing, downloadBuffer, extraDetailsFileName, extractionFolder, extractionPdfPath, fileExists,
} from "./visaSubmissionStorage.js";

export const VISA_EXTRACTION_AUDIT_ACTION = "VISA_SUBMISSION_EXTRACTION";
const STAGE = "VISA_SUBMISSION";

// Why a candidate is left out. INVALID / DUPLICATE are warnings of the preview; the other two are only
// answered to an extract request that named someone who is no longer eligible.
export const EXTRACTION_SKIP = Object.freeze({
    INVALID_PASSPORT_NUMBER: "INVALID_PASSPORT_NUMBER",
    DUPLICATE_PASSPORT_NUMBER: "DUPLICATE_PASSPORT_NUMBER",
    ALREADY_EXTRACTED: "ALREADY_EXTRACTED",
    NOT_ELIGIBLE: "NOT_ELIGIBLE",
});
const SKIP_MESSAGES = Object.freeze({
    INVALID_PASSPORT_NUMBER: "The passport number is missing or can't be used as a file name.",
    DUPLICATE_PASSPORT_NUMBER: "Another candidate on this job has the same passport number (ignoring letter case).",
    ALREADY_EXTRACTED: "This signed document has already been extracted.",
    NOT_ELIGIBLE: "Not eligible for extraction now (removed from the job, stage reopened or document changed).",
});

// The passport number becomes the PDF's file name and the Excel rows' key: letters and digits only,
// like the candidate routes' :passportId (candidateService.js).
const PASSPORT_PATTERN = /^[A-Za-z0-9]{1,20}$/;

// Per storage call during an extraction, and the time after which no new PDF copy is started: one
// request must end inside Vercel's 60 s limit, so candidates not reached are answered as `deferred`
// (the page sends them again) instead of the function being cut off half-way.
const EXTRACTION_STORAGE_TIMEOUT_MS = 15_000;
const COPY_BUDGET_MS = 30_000;
// The lock's lease. Longer than one request can run on Vercel (60 s), so a live batch never loses
// it; a request that died frees it within this time.
export const EXTRACTION_LOCK_TTL_SECONDS = 120;

const ADDITIONAL_DETAILS_SELECT = Object.freeze({
    tshirtSize: true, pantSize: true, shoeSize: true, englishKnowledge: true, canReadDrawings: true, teamLeadingSkills: true, otherLanguages: true,
});

const skip = (passportId, reason) => ({ passportId, reason, message: SKIP_MESSAGES[reason] });

async function loadJob(db, jobId) {
    const job = await db.job.findUnique({ where: { id: jobId }, select: JOB_SELECT });
    if (!job) throw new CandidateError(404, "JOB_NOT_FOUND", "Job not found");
    return job;
}

const jobView = (job) => {
    const summary = jobSummaryView(job);
    return { jobId: summary.jobId, jobCode: summary.jobCode, companyJobId: summary.companyJobId, status: summary.status, client: summary.client, primaryTrade: summary.jobType?.name ?? null };
};

// { eligible: [{ passportId, firstName, otherName, additionalDetails, document: { documentId, storagePath, uploadedAt } }],
//   skipped: [warning], extractedPassportIds: Set (current document already extracted), total: eligible + skipped }.
export async function eligibleCandidates(db, jobId) {
    const rows = await db.jobCandidate.findMany({
        where: { jobId, releasedAt: null },
        select: {
            passportId: true,
            candidate: {
                select: {
                    passportId: true, firstName: true, otherName: true,
                    stages: { where: { stage: STAGE }, select: { completed: true } },
                    documents: {
                        where: { documentType: VISA_SUBMISSION_DOCUMENT_TYPE, verificationStatus: { not: VERIFICATION_STATUS.SUPERSEDED } },
                        select: { ...CURRENT_DOCUMENT_SELECT, storagePath: true },
                    },
                    additionalDetails: { select: ADDITIONAL_DETAILS_SELECT },
                },
            },
        },
    });
    // A "duplicate" passport number: two candidate records on this job whose numbers differ only in
    // letter case (the primary key is case-sensitive, the Excel rows and Windows file names are not).
    const byKey = new Map();
    for (const row of rows) byKey.set(row.passportId.toUpperCase(), (byKey.get(row.passportId.toUpperCase()) ?? 0) + 1);

    const passing = [];
    for (const { candidate } of rows) {
        if (!candidate.stages[0]?.completed) continue;
        const current = currentOf(candidate.documents);
        if (!current || current.verificationStatus !== VERIFICATION_STATUS.VERIFIED) continue;
        const document = candidate.documents.find((d) => d.documentId === current.documentId);
        passing.push({ candidate, document });
    }
    const extracted = passing.length
        ? new Set((await db.visaSubmissionExtraction.findMany({
            where: { documentId: { in: passing.map((p) => p.document.documentId) } },
            select: { documentId: true },
        })).map((row) => row.documentId))
        : new Set();

    const eligible = [];
    const skipped = [];
    const extractedPassportIds = new Set();
    for (const { candidate, document } of passing) {
        if (extracted.has(document.documentId)) {
            extractedPassportIds.add(candidate.passportId);
            continue;
        }
        if (!PASSPORT_PATTERN.test(candidate.passportId)) skipped.push(skip(candidate.passportId, EXTRACTION_SKIP.INVALID_PASSPORT_NUMBER));
        else if (byKey.get(candidate.passportId.toUpperCase()) > 1) skipped.push(skip(candidate.passportId, EXTRACTION_SKIP.DUPLICATE_PASSPORT_NUMBER));
        else {
            eligible.push({
                passportId: candidate.passportId,
                firstName: candidate.firstName,
                otherName: candidate.otherName ?? null,
                additionalDetails: candidate.additionalDetails ?? null,
                document: { documentId: document.documentId, storagePath: document.storagePath, uploadedAt: document.receivedDate, createdDate: document.createdDate },
            });
        }
    }
    eligible.sort((a, b) => a.document.uploadedAt - b.document.uploadedAt
        || a.document.createdDate - b.document.createdDate
        || (a.passportId < b.passportId ? -1 : a.passportId > b.passportId ? 1 : 0));
    return { eligible, skipped, extractedPassportIds };
}

// ---------------------------------------------------------------- jobs list and preview

// Eligible candidates per job, counted in the database (the same four rules and the passport
// checks as eligibleCandidates). The current document is the newest VERIFIED one, as in currentOf.
async function eligibleCounts(db) {
    const rows = await db.$queryRaw`
        SELECT jc."job_id"::text AS "jobId", COUNT(*)::int AS "count"
        FROM "job_candidate" jc
        JOIN "candidate_stages" cs ON cs."passport_id" = jc."passport_id" AND cs."stage" = ${STAGE} AND cs."completed" = TRUE
        JOIN LATERAL (
            SELECT d."document_id" FROM "documents" d
            WHERE d."passport_id" = jc."passport_id" AND d."document_type" = ${VISA_SUBMISSION_DOCUMENT_TYPE} AND d."verification_status" = ${VERIFICATION_STATUS.VERIFIED}
            ORDER BY d."received_date" DESC, d."created_date" DESC
            LIMIT 1
        ) cur ON TRUE
        WHERE jc."released_at" IS NULL
          AND jc."passport_id" ~ '^[A-Za-z0-9]{1,20}$'
          AND NOT EXISTS (SELECT 1 FROM "visa_submission_extraction" x WHERE x."document_id" = cur."document_id")
          AND NOT EXISTS (
              SELECT 1 FROM "job_candidate" o
              WHERE o."job_id" = jc."job_id" AND o."released_at" IS NULL
                AND upper(o."passport_id") = upper(jc."passport_id") AND o."passport_id" <> jc."passport_id"
          )
        GROUP BY jc."job_id"`;
    return new Map(rows.map((row) => [row.jobId, Number(row.count)]));
}

// GET …/visa-submission/extraction/jobs: every PROCESSING job, and any other job (COMPLETED,
// CANCELLED) that still has eligible candidates, newest first, with its eligible count.
export async function listExtractionJobs({ db }) {
    const counts = await eligibleCounts(db);
    const jobs = await db.job.findMany({
        where: { OR: [{ status: "PROCESSING" }, { id: { in: [...counts.keys()] } }] },
        select: JOB_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return { jobs: jobs.map((job) => ({ ...jobView(job), eligibleCount: counts.get(job.id) ?? 0 })) };
}

const candidateView = (c) => ({
    passportId: c.passportId, firstName: c.firstName, otherName: c.otherName,
    documentId: c.document.documentId, uploadedAt: c.document.uploadedAt.toISOString(),
});

// GET …/visa-submission/extraction/jobs/:jobId: the eligible candidates in extraction order, the
// warnings, and where today's extraction goes.
export async function getExtractionPreview({ db, jobId, now = new Date() }) {
    const job = await loadJob(db, jobId);
    const { eligible, skipped } = await eligibleCandidates(db, jobId);
    const date = businessDateOf(now);
    const clientFileName = clientFileNameOf(job.client.name);
    return {
        job: jobView(job),
        date,
        folder: extractionFolder(date),
        files: { candidateDetails: candidateDetailsFileName(clientFileName), extraDetails: extraDetailsFileName(clientFileName) },
        candidates: eligible.map(candidateView),
        skipped,
        batchSize: VISA_EXTRACTION_BATCH_SIZE,
        maxBatchSize: VISA_EXTRACTION_MAX_BATCH_SIZE,
    };
}

// ---------------------------------------------------------------- the lock

// A lease row per (date, Client files), not a PostgreSQL advisory lock: DATABASE_URL goes through
// Supavisor and Prisma's pg.Pool, so a session lock could be taken on one connection and released on
// another, and a transaction lock would keep a pooled connection (and Prisma's interactive transaction)
// open across the storage calls. Taken with one atomic statement; an expired lease is taken over.
export async function acquireExtractionLock(db, lockKey, ttlSeconds = EXTRACTION_LOCK_TTL_SECONDS) {
    const holder = crypto.randomUUID();
    const rows = await db.$queryRaw`
        INSERT INTO "visa_submission_extraction_lock" ("lock_key", "holder", "expires_at")
        VALUES (${lockKey}, ${holder}::uuid, now() + ${ttlSeconds}::integer * interval '1 second')
        ON CONFLICT ("lock_key") DO UPDATE SET "holder" = EXCLUDED."holder", "expires_at" = EXCLUDED."expires_at"
        WHERE "visa_submission_extraction_lock"."expires_at" <= now()
        RETURNING "holder"::text AS "holder"`;
    return rows.length === 1 && rows[0].holder === holder ? holder : null;
}

// Extends the lease, only while it is still ours. false: it expired and may have been taken over.
async function renewExtractionLock(db, lockKey, holder, ttlSeconds = EXTRACTION_LOCK_TTL_SECONDS) {
    const rows = await db.$queryRaw`
        UPDATE "visa_submission_extraction_lock" SET "expires_at" = now() + ${ttlSeconds}::integer * interval '1 second'
        WHERE "lock_key" = ${lockKey} AND "holder" = ${holder}::uuid AND "expires_at" > now()
        RETURNING "lock_key"`;
    return rows.length === 1;
}

async function releaseExtractionLock(db, lockKey, holder) {
    await db.$executeRaw`DELETE FROM "visa_submission_extraction_lock" WHERE "lock_key" = ${lockKey} AND "holder" = ${holder}::uuid`;
}

const lockBusy = () => new CandidateError(409, "EXTRACTION_IN_PROGRESS", "Extraction in progress, try again");

// ---------------------------------------------------------------- extract

// POST body: { passportIds: [1..VISA_EXTRACTION_MAX_BATCH_SIZE distinct passport numbers] }.
export function parseExtractBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const { passportIds } = body;
    const invalid = { errors: [{ field: "passportIds", message: `must be a list of 1 to ${VISA_EXTRACTION_MAX_BATCH_SIZE} distinct passport numbers` }] };
    if (!Array.isArray(passportIds) || passportIds.length === 0 || passportIds.length > VISA_EXTRACTION_MAX_BATCH_SIZE) return invalid;
    if (!passportIds.every((id) => typeof id === "string" && PASSPORT_PATTERN.test(id))) return invalid;
    if (new Set(passportIds).size !== passportIds.length) return invalid;
    return { values: { passportIds } };
}

// Read-modify-write of one Excel file. A stored file that can't be read stops the batch: it is never
// replaced by a new one (that would lose its rows).
async function updateWorkbook(storage, folder, fileName, update) {
    const found = await fileExists(storage, folder, fileName, EXTRACTION_STORAGE_TIMEOUT_MS);
    if (found.error) throw new Error("listing failed");
    let existing = null;
    if (found.exists) {
        const downloaded = await downloadBuffer(storage, `${folder}/${fileName}`, EXTRACTION_STORAGE_TIMEOUT_MS);
        if (downloaded.error) throw new Error("download failed");
        existing = downloaded.buffer;
    }
    const buffer = await update(existing);
    const { error } = await storage.upload(`${folder}/${fileName}`, buffer, { contentType: XLSX_CONTENT_TYPE, upsert: true });
    if (error) throw new Error("upload failed");
}

// One batch: { date, folder, processed, extracted, skipped, failed, deferred, remaining }.
//   extracted: [{ passportId, documentId, file }]   copied, in both Excel files, recorded
//   skipped:   [{ passportId, reason, message }]    named but not eligible now (never retried)
//   failed:    [{ passportId, reason }]             PDF_COPY_FAILED; still eligible, may be sent again
//   deferred:  [passportId]                         not reached in time; send again
//   remaining: eligible candidates of the job after this batch (failed and deferred included)
// The extraction rows are written only after the PDF copies AND both Excel files succeeded, so a retry
// redoes the same work: copies replace, Excel rows are matched by passport number, rows are unique per
// document. A failed Excel update is 502 EXCEL_UPDATE_FAILED and records nothing.
export async function extractBatch({ db, bucket, actor, jobId, passportIds, now = new Date(), clock = () => Date.now() }) {
    const started = clock();
    const job = await loadJob(db, jobId);
    // Asia/Colombo, not UTC: the folder is the business day in Sri Lanka (05:30 ahead of UTC).
    const date = businessDateOf(now);
    const folder = extractionFolder(date);
    const clientName = job.client.name;
    const clientFileName = clientFileNameOf(clientName);
    const primaryTrade = jobSummaryView(job).jobType?.name ?? "";
    const lockKey = `${date}/${clientFileName}`;

    const holder = await acquireExtractionLock(db, lockKey);
    if (!holder) throw lockBusy();
    try {
        const storage = withStorageTimeout(bucket, EXTRACTION_STORAGE_TIMEOUT_MS);
        const { eligible, skipped: warnings, extractedPassportIds } = await eligibleCandidates(db, jobId);
        const requested = new Set(passportIds);
        const batch = eligible.filter((c) => requested.has(c.passportId));
        const inBatch = new Set(batch.map((c) => c.passportId));
        const warningOf = new Map(warnings.map((w) => [w.passportId, w]));
        const skipped = passportIds.filter((id) => !inBatch.has(id)).map((id) => warningOf.get(id)
            ?? skip(id, extractedPassportIds.has(id) ? EXTRACTION_SKIP.ALREADY_EXTRACTED : EXTRACTION_SKIP.NOT_ELIGIBLE));

        const copied = [];
        const failed = [];
        const deferred = [];
        for (const candidate of batch) {
            if (clock() - started > COPY_BUDGET_MS) {
                deferred.push(candidate.passportId);
                continue;
            }
            const target = extractionPdfPath(folder, candidate.passportId);
            const result = await copyReplacing(storage, candidate.document.storagePath, target, EXTRACTION_STORAGE_TIMEOUT_MS);
            if (result.ok) copied.push({ ...candidate, target });
            else {
                console.warn("Visa extraction: PDF copy failed", { documentId: candidate.document.documentId, ...safeErrorInfo(result.error) });
                failed.push({ passportId: candidate.passportId, reason: "PDF_COPY_FAILED" });
            }
        }

        if (copied.length) {
            if (!(await renewExtractionLock(db, lockKey, holder))) throw lockBusy();
            try {
                await updateWorkbook(storage, folder, candidateDetailsFileName(clientFileName), (existing) => upsertCandidateDetails(existing, copied));
                await updateWorkbook(storage, folder, extraDetailsFileName(clientFileName), (existing) => upsertExtraDetails(existing, { clientName, primaryTrade, candidates: copied }));
            } catch (error) {
                console.warn("Visa extraction: Excel update failed", { jobId, ...safeErrorInfo(error) });
                throw new CandidateError(502, "EXCEL_UPDATE_FAILED", "The Excel files could not be updated. Nothing was recorded; try again.");
            }
        }

        const extracted = copied.map((c) => ({ passportId: c.passportId, documentId: c.document.documentId, file: c.target }));
        if (copied.length || failed.length) {
            const writes = [];
            if (copied.length) {
                writes.push(db.visaSubmissionExtraction.createMany({
                    data: copied.map((c) => ({
                        passportId: c.passportId, jobId: job.id, documentId: c.document.documentId, clientName, storagePath: c.target, extractedAt: now, extractedById: actor.adminId,
                    })),
                    skipDuplicates: true,
                }));
            }
            writes.push(db.auditLog.create({
                data: {
                    auditId: crypto.randomUUID(),
                    adminId: actor.adminId,
                    action: VISA_EXTRACTION_AUDIT_ACTION,
                    previousStatus: "NONE",
                    newStatus: "EXTRACTED",
                    newValue: JSON.stringify({
                        jobId: job.id, jobCode: job.jobCode, client: clientName, folder,
                        extractedCount: extracted.length, failedCount: failed.length, skippedCount: skipped.length, deferredCount: deferred.length,
                        extracted: extracted.map(({ passportId, documentId }) => ({ passportId, documentId })),
                        failed,
                    }),
                },
            }));
            await db.$transaction(writes);
        }

        return {
            date,
            folder,
            processed: passportIds.length,
            extracted,
            skipped,
            failed,
            deferred,
            remaining: eligible.length - copied.length,
        };
    } finally {
        await releaseExtractionLock(db, lockKey, holder).catch((error) => console.warn("Visa extraction: lock not released (it expires)", safeErrorInfo(error)));
    }
}
