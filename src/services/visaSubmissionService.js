// Visa Submission (Phase 1): the documents merged into the candidate's one
// submission file. The merge itself happens in the browser: these routes only
// say which documents there are (the manifest), stream each VERIFIED one from
// private storage, and audit the confirmed download. The slots and the roles
// are config/visaSubmission.js.

import crypto from "node:crypto";
import { Readable } from "node:stream";

import { VISA_SUBMISSION_SLOTS, VISA_SUBMISSION_SLOT_KEYS } from "../config/visaSubmission.js";
import { STORAGE_TIMEOUT_MS, settleWithin } from "../utils/storageTimeout.js";
import { VERIFICATION_STATUS } from "./clientDocumentService.js";
import { CandidateError, CURRENT_DOCUMENT_SELECT, currentOf } from "./candidateService.js";

export const SLOT_STATUS = Object.freeze({ VERIFIED: "VERIFIED", UNVERIFIED: "UNVERIFIED", MISSING: "MISSING" });
export const VISA_SUBMISSION_AUDIT_ACTION = "VISA_SUBMISSION_MERGED_DOWNLOAD";

const SLOT_DOCUMENT_TYPES = [...new Set(VISA_SUBMISSION_SLOTS.map((slot) => slot.documentType))];

const slotDocuments = (rows, slot) => rows.filter((d) => d.documentType === slot.documentType && (slot.variant === null || d.documentVariant === slot.variant));

export const visaSubmissionFileUrl = (passportId, documentId) => `/api/admin/candidates/${encodeURIComponent(passportId)}/visa-submission/files/${documentId}`;

// passportId: the stored ID (routes/admin.js storedCandidateId, which applies the user's scope).
// Each slot's current document (currentOf: the newest VERIFIED, otherwise the newest waiting for
// review; SUPERSEDED never counts). A police report slot takes its own variant only.
export async function getVisaSubmissionManifest({ db, passportId }) {
    const rows = await db.document.findMany({
        where: { passportId, documentType: { in: SLOT_DOCUMENT_TYPES } },
        select: { ...CURRENT_DOCUMENT_SELECT, mimeType: true, fileSize: true },
    });
    const byId = new Map(rows.map((row) => [row.documentId, row]));
    return {
        passportId,
        slots: VISA_SUBMISSION_SLOTS.map((slot) => {
            const current = currentOf(slotDocuments(rows, slot));
            const base = { order: slot.order, key: slot.key, label: slot.label, documentType: slot.documentType, variant: slot.variant };
            if (!current) return { ...base, status: SLOT_STATUS.MISSING, document: null };
            if (current.verificationStatus !== VERIFICATION_STATUS.VERIFIED) return { ...base, status: SLOT_STATUS.UNVERIFIED, document: null };
            const row = byId.get(current.documentId);
            return {
                ...base,
                status: SLOT_STATUS.VERIFIED,
                document: {
                    documentId: row.documentId,
                    mimeType: row.mimeType ?? null,
                    size: row.fileSize === null || row.fileSize === undefined ? null : Number(row.fileSize),
                    fileUrl: visaSubmissionFileUrl(passportId, row.documentId),
                },
            };
        }),
    };
}

// The file of one slot's current VERIFIED document of this candidate, or null (any other document:
// another candidate's, an earlier version, one waiting for review, or a type outside the slots).
// The storage path comes from the database record, never the request.
// { stream } (the storage response body, not read into memory) or { buffer }; { unavailable } when
// storage failed or did not answer within STORAGE_TIMEOUT_MS.
export async function getVisaSubmissionFile({ db, bucket, passportId, documentId, timeoutMs = STORAGE_TIMEOUT_MS }) {
    const manifest = await getVisaSubmissionManifest({ db, passportId });
    const slot = manifest.slots.find((s) => s.status === SLOT_STATUS.VERIFIED && s.document.documentId === documentId);
    if (!slot) return null;
    const record = await db.document.findFirst({
        where: { documentId, passportId, verificationStatus: VERIFICATION_STATUS.VERIFIED },
        select: { storagePath: true, storedFilename: true, mimeType: true, fileSize: true },
    });
    if (!record?.storagePath) return null;

    // Supabase's download() reads the whole body into a Blob unless asked for the stream.
    const download = bucket.download(record.storagePath);
    const { data, error } = await settleWithin(typeof download?.asStream === "function" ? download.asStream() : download, timeoutMs, "download");
    if (error || !data) return { unavailable: true };

    const file = {
        mimeType: record.mimeType || "application/octet-stream",
        size: record.fileSize === null || record.fileSize === undefined ? null : Number(record.fileSize),
        fileName: record.storedFilename,
        slotKey: slot.key,
    };
    if (Buffer.isBuffer(data)) return { ...file, buffer: data, size: data.length };
    if (data instanceof Readable) return { ...file, stream: data };
    if (typeof data.getReader === "function") return { ...file, stream: Readable.fromWeb(data) };
    const buffer = Buffer.from(await data.arrayBuffer());
    return { ...file, buffer, size: buffer.length };
}

// POST …/visa-submission/merged-download: { includedSlots: [slot key, …] } (at least one, each once).
// Every other slot is recorded as excluded; nothing else from the body is read.
export function parseMergedDownloadBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: [{ field: "body", message: "must be a JSON object" }] };
    const { includedSlots } = body;
    const invalid = { errors: [{ field: "includedSlots", message: `must be a non-empty list of distinct slot keys: ${VISA_SUBMISSION_SLOT_KEYS.join(", ")}` }] };
    if (!Array.isArray(includedSlots) || includedSlots.length === 0 || includedSlots.length > VISA_SUBMISSION_SLOT_KEYS.length) return invalid;
    if (!includedSlots.every((key) => typeof key === "string" && VISA_SUBMISSION_SLOT_KEYS.includes(key))) return invalid;
    if (new Set(includedSlots).size !== includedSlots.length) return invalid;
    // Always in the merge order, whatever order the body used.
    const included = VISA_SUBMISSION_SLOT_KEYS.filter((key) => includedSlots.includes(key));
    return { values: { includedSlots: included, excludedSlots: VISA_SUBMISSION_SLOT_KEYS.filter((key) => !included.includes(key)) } };
}

// One audit entry for a merged file the user downloaded. Each included slot must be VERIFIED now
// (the only documents the file route serves); its document ID is recorded from the database.
export async function recordMergedDownload({ db, actor, passportId, includedSlots, excludedSlots }) {
    const manifest = await getVisaSubmissionManifest({ db, passportId });
    const bySlot = new Map(manifest.slots.map((slot) => [slot.key, slot]));
    const notVerified = includedSlots.filter((key) => bySlot.get(key).status !== SLOT_STATUS.VERIFIED);
    if (notVerified.length) {
        throw new CandidateError(409, "SLOT_NOT_VERIFIED", "A document included in the download is no longer verified. Refresh the page.");
    }
    const auditId = crypto.randomUUID();
    await db.auditLog.create({
        data: {
            auditId,
            adminId: actor.adminId,
            action: VISA_SUBMISSION_AUDIT_ACTION,
            passportId,
            previousStatus: "NONE",
            newStatus: "DOWNLOADED",
            newValue: JSON.stringify({
                includedSlots,
                excludedSlots,
                documents: Object.fromEntries(includedSlots.map((key) => [key, bySlot.get(key).document.documentId])),
            }),
        },
    });
    return { auditId, passportId, includedSlots, excludedSlots };
}
