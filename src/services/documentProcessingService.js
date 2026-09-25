import { extractDocumentText } from "./ocrService.js";
import {
    classifyDocument,
    classifyDocumentContent,
    resolveDocumentType,
    DOCUMENT_TYPES,
} from "./documentClassificationService.js";
import { assessDocumentConfidence, assessPassportFieldConfidence, DOCUMENT_FLAGS } from "./confidenceService.js";
import { extractPassportFields } from "./passportExtractionService.js";
import { extractPoliceReportDate, POLICE_DATE_STATUS } from "./policeReportDateService.js";
import { findUsersByPassportId, findUsersByWhatsappNumber } from "./userLookupService.js";
import { decideIdentity, IDENTITY_STATUS } from "./identityVerificationService.js";
import { reconcilePassportFields, applyReconciliationUpdates } from "./fieldReconciliationService.js";
import { updateTemporaryDocumentRecord } from "./temporaryDataService.js";
import { sha256Hex } from "../utils/fileChecksum.js";
import { checkClientChecksum, CHECKSUM_OUTCOME } from "./documentChecksumService.js";
import { decidePlacement, placeDocument } from "./storagePlacementService.js";
import { safeErrorText } from "../utils/safeLog.js";
import { evaluatePassportAcceptance, applyPassportAcceptance } from "./passportAcceptanceService.js";
import { policeWorkflowEvent } from "./policeWorkflowService.js";
import { deriveReviewReason } from "./reviewReason.js";

// temporary_data.processing_status values after processing, taken from
// the proposal (§24 state machine, §32 error table). The confidence-band
// names double as statuses when nothing else needs attention.
export const PROCESSING_STATUS = Object.freeze({
    VERIFIED: "VERIFIED",
    HIGH_CONFIDENCE: "HIGH_CONFIDENCE",
    SLIGHTLY_UNCLEAR: "SLIGHTLY_UNCLEAR",
    UNCLEAR: "UNCLEAR",
    UNDEFINED: "UNDEFINED",
    CONFLICT: "CONFLICT",
    MANUAL_REVIEW: "MANUAL_REVIEW",
    DUPLICATE: "DUPLICATE",
    FAILED: "FAILED",
});

// Identity results that point at one existing user and can be stored on
// temporary_data. Provisional matches are left for review instead.
const LINKABLE_IDENTITIES = new Set([
    IDENTITY_STATUS.VERIFIED_MATCH,
    IDENTITY_STATUS.PASSPORT_MATCH_ONLY,
    IDENTITY_STATUS.WHATSAPP_MATCH_ONLY,
]);

const POLICE_DATE_NEEDS_REVIEW = new Set([
    POLICE_DATE_STATUS.AMBIGUOUS,
    POLICE_DATE_STATUS.INVALID,
    POLICE_DATE_STATUS.NOT_FOUND,
]);

// Explicit reasons a person must look at the document before it may enter
// a client folder. Low confidence alone is not one: a plain UNCLEAR document
// (and an accepted low-quality passport) is stored under the client for
// review. Used for placement only; processing statuses are unchanged.
const REVIEW_BLOCKING_FLAGS = [
    DOCUMENT_FLAGS.WRONG_DOCUMENT_SUSPECTED,
    DOCUMENT_FLAGS.CLASSIFIED_FROM_FILENAME_ONLY,
    DOCUMENT_FLAGS.POLICE_TYPE_UNCLEAR,
];

export function hasReviewBlocker({ confidence, identity, policeDate }) {
    return Boolean(identity?.reviewRequired)
        || REVIEW_BLOCKING_FLAGS.some((flag) => confidence?.flags?.includes(flag))
        || POLICE_DATE_NEEDS_REVIEW.has(policeDate?.status);
}

// Most serious problem first: failure, conflict, unusable document, then
// anything a person has to look at. Otherwise the confidence band.
export function determineProcessingStatus({ confidence, identity, reconciliation, policeDate }) {
    if (identity?.status === IDENTITY_STATUS.IDENTITY_CONFLICT || reconciliation?.conflicts.length > 0) {
        return PROCESSING_STATUS.CONFLICT;
    }
    if (confidence.band === PROCESSING_STATUS.UNDEFINED) {
        return PROCESSING_STATUS.UNDEFINED;
    }
    if (identity?.reviewRequired || confidence.reviewRequired || POLICE_DATE_NEEDS_REVIEW.has(policeDate?.status)) {
        return confidence.band === PROCESSING_STATUS.UNCLEAR ? PROCESSING_STATUS.UNCLEAR : PROCESSING_STATUS.MANUAL_REVIEW;
    }
    return confidence.band;
}

// Build the parts of the result that are safe to log: statuses, scores,
// flags and field names. No document text, names, dates or passport numbers.
function summarize(state) {
    const { stage, error, textExtraction, resolvedType, confidence, passport, fieldConfidence,
        policeDate, identity, reconciliation, applied, processingStatus, recordUpdated,
        checksum, placement, passportAcceptance, policeWorkflow } = state;

    return {
        stage,
        error: error ?? null,
        processingStatus,
        recordUpdated,
        documentType: resolvedType?.documentType ?? null,
        typeSource: resolvedType?.source ?? null,
        extractionMethod: textExtraction?.method ?? null,
        ocrThresholding: textExtraction?.thresholding ?? null,
        ocrRotateAuto: textExtraction?.rotateAuto ?? null,
        ocrUpscaled: textExtraction?.upscaled ?? null,
        confidence: confidence
            ? {
                extraction: confidence.extractionConfidence,
                classification: confidence.classificationConfidence,
                document: confidence.documentConfidence,
                band: confidence.band,
                measuredBand: confidence.measuredBand ?? confidence.band,
                flags: confidence.flags,
            }
            : null,
        passport: passport
            ? {
                status: passport.status,
                missingFields: passport.missingFields,
                mrzLinesFound: passport.mrz.linesFound,
                // Not used in any decision yet; logged to evaluate on real scans.
                mrzCompositeCheckValid: passport.mrz.compositeCheckValid,
                passportIdBand: fieldConfidence?.passportId?.band ?? null,
            }
            : null,
        policeDate: policeDate ? { status: policeDate.status, kind: policeDate.kind } : null,
        // Condition names only, e.g. ["DATE_OF_BIRTH_VERIFIED"].
        passportAcceptance: passportAcceptance ?? null,
        // Event name only; the dates stay in details.
        policeWorkflowEvent: policeWorkflow?.event ?? null,
        identity: identity
            ? {
                status: identity.status,
                reviewRequired: identity.reviewRequired,
                provisional: identity.provisional,
                notes: identity.notes,
            }
            : null,
        // No storage paths: they contain passport numbers or client references.
        storage: placement
            ? {
                checksum: checksum?.outcome ?? null,
                placement: placement.placement,
                verificationStatus: placement.stored?.verificationStatus ?? null,
                documentStored: Boolean(placement.stored?.documentId),
                pendingCopy: Boolean(placement.pendingStoragePath),
            }
            : null,
        reconciliation: reconciliation
            ? {
                matched: reconciliation.matchedFields.map((f) => f.field),
                filled: applied ?? [],
                conflicts: reconciliation.conflicts.map((f) => f.field),
                skipped: reconciliation.skipped.map((f) => `${f.field}:${f.outcome}`),
            }
            : null,
    };
}

// Run Phase 5 (classification, OCR, confidence, passport fields, police
// date), Phase 6 (identity, reconciliation) and Phase 7 (checksum checks,
// permanent or pending copy) for one stored document, then update its
// temporary_data row. The temporary object is never deleted (Phase 8).
// Never throws: a failure is recorded as FAILED with the stage it happened
// in, so the webhook keeps working.
// Returns { summary } (safe to log) and { details } (extracted values, not logged).
export async function processDocument({
    temporaryId,
    whatsappNumber,
    fileName,
    mimeType,
    fileBuffer,
    fileSha256,
    temporaryStoragePath,
    receivedAt,
    filenameClassification,
    deps = {},
}) {
    const { db, bucket, now = new Date(), extractText = extractDocumentText } = deps;
    const state = { stage: "TEXT_EXTRACTION", recordUpdated: false };
    // The route passes the checksum it already calculated; fall back for other callers.
    state.fileSha256 = fileSha256 ?? sha256Hex(fileBuffer);

    try {
        state.textExtraction = await extractText({ fileBuffer, mimeType });

        state.stage = "CLASSIFICATION";
        const contentClassification = classifyDocumentContent(state.textExtraction.text);
        state.resolvedType = resolveDocumentType({
            filenameClassification: filenameClassification ?? classifyDocument({ fileName }),
            contentClassification,
        });
        state.confidence = assessDocumentConfidence({
            textExtraction: state.textExtraction,
            contentClassification,
            resolvedType: state.resolvedType,
        });

        const { documentType } = state.resolvedType;
        const isPassportDocument = documentType === DOCUMENT_TYPES.PASSPORT;

        state.stage = "FIELD_EXTRACTION";
        if (isPassportDocument) {
            state.passport = extractPassportFields(state.textExtraction.text);
            state.fieldConfidence = assessPassportFieldConfidence(state.passport, state.confidence.extractionConfidence);
        }
        // Only a slip needs its submitted date (the 21-day wait starts from
        // it). A final police report is stored without any date.
        if (documentType === DOCUMENT_TYPES.POLICE_SLIP) {
            state.policeDate = extractPoliceReportDate(state.textExtraction.text);
        }

        state.stage = "IDENTITY";
        const passportLookup = isPassportDocument
            ? await findUsersByPassportId(state.passport.fields.passportId.value, { db })
            : null;
        const whatsappLookup = await findUsersByWhatsappNumber(whatsappNumber, { db });
        state.identity = decideIdentity({
            isPassportDocument,
            passportIdConfidence: state.fieldConfidence?.passportId?.confidence ?? 0,
            passportLookup,
            whatsappLookup,
        });

        // One existing, non-provisional client: the only case where a
        // document may be linked to or stored under a client.
        const clientIdentified = LINKABLE_IDENTITIES.has(state.identity.status)
            && !state.identity.provisional
            && Boolean(state.identity.passportId);

        // Before reconciliation, so a file that is a duplicate or belongs to
        // another client never writes to this client's record.
        state.stage = "DUPLICATE_CHECK";
        if (clientIdentified) {
            state.checksum = await checkClientChecksum(
                { passportId: state.identity.passportId, fileSha256: state.fileSha256 },
                { db }
            );
        }
        const checksumAllowsWrites = !state.checksum || state.checksum.outcome === CHECKSUM_OUTCOME.NEW;

        state.stage = "RECONCILIATION";
        const passportUser = passportLookup?.users.length === 1 ? passportLookup.users[0] : null;
        if (isPassportDocument && passportUser && state.identity.status !== IDENTITY_STATUS.PASSPORT_ID_UNRESOLVED) {
            state.reconciliation = reconcilePassportFields({
                user: passportUser,
                passportExtraction: state.passport,
                fieldConfidence: state.fieldConfidence,
            });
            if (checksumAllowsWrites) {
                ({ applied: state.applied } = await applyReconciliationUpdates({
                    identity: state.identity,
                    reconciliation: state.reconciliation,
                    db,
                }));
            }
        }

        // Low-quality passport with MRZ + identity proof: stored for review
        // under the client instead of pending. Band only; the measured
        // confidence stays as it is.
        state.passportAcceptance = isPassportDocument ? evaluatePassportAcceptance(state) : null;
        state.confidence = applyPassportAcceptance(state.confidence, state.passportAcceptance);

        state.stage = "STORAGE";
        const decision = decidePlacement({
            processingStatus: determineProcessingStatus(state),
            band: state.confidence.band,
            documentType,
            clientIdentified,
            uniqueId: state.identity.uniqueId,
            checksumOutcome: state.checksum?.outcome,
            reviewBlocked: hasReviewBlocker(state),
        });
        state.placement = await placeDocument(decision, {
            temporaryId,
            temporaryStoragePath,
            whatsappNumber,
            passportId: state.identity.passportId,
            documentType,
            band: state.confidence.band,
            mimeType,
            originalFileName: fileName,
            fileSize: fileBuffer.length,
            fileSha256: state.fileSha256,
            documentConfidence: state.confidence.documentConfidence,
            receivedAt,
            // Only a police slip's resolved date is kept (Police Workflow countdown).
            policeSubmittedDate: documentType === DOCUMENT_TYPES.POLICE_SLIP && state.policeDate?.status === POLICE_DATE_STATUS.RESOLVED
                ? state.policeDate.date
                : null,
        }, { db, bucket, now });
        state.processingStatus = state.placement.processingStatus;
        // Phase 9 event (not stored itself; the slip's date is, see placeDocument above).
        state.policeWorkflow = policeWorkflowEvent({
            documentType,
            policeDate: state.policeDate,
            placement: state.placement.placement,
        });

        state.stage = "RECORD_UPDATE";
        // A file that belongs to another client is never linked to this one.
        const linkUser = clientIdentified && state.checksum?.outcome !== CHECKSUM_OUTCOME.CROSS_CLIENT_CONFLICT;
        await updateTemporaryDocumentRecord(temporaryId, {
            documentType,
            processingStatus: state.processingStatus,
            ...(linkUser ? { passportId: state.identity.passportId, uniqueId: state.identity.uniqueId } : {}),
            ...(state.placement.pendingStoragePath ? { pendingStoragePath: state.placement.pendingStoragePath } : {}),
            // Review data for the admin dashboard: the same PII-free summary
            // that is logged, as it stands once processing has completed.
            processingSummary: summarize({ ...state, stage: "COMPLETED", recordUpdated: true }),
            reviewReason: deriveReviewReason(state),
        }, { db });
        state.recordUpdated = true;
        state.stage = "COMPLETED";
    } catch (error) {
        state.error = safeErrorText(error);
        state.processingStatus = PROCESSING_STATUS.FAILED;

        try {
            // Keep a pending copy traceable even if a later step failed.
            await updateTemporaryDocumentRecord(temporaryId, {
                processingStatus: PROCESSING_STATUS.FAILED,
                ...(state.placement?.pendingStoragePath ? { pendingStoragePath: state.placement.pendingStoragePath } : {}),
                processingSummary: summarize(state),
                reviewReason: deriveReviewReason(state),
            }, { db });
            state.recordUpdated = true;
        } catch (updateError) {
            state.error = `${safeErrorText(error)}; status update failed: ${safeErrorText(updateError)}`;
        }
    }

    return {
        summary: summarize(state),
        // Not for logging. A police slip's resolved date is also stored on
        // its documents row (police_submitted_date) when filed under the client.
        details: {
            policeDate: state.policeDate
                ? { status: state.policeDate.status, date: state.policeDate.date, kind: state.policeDate.kind, confidence: state.policeDate.confidence }
                : null,
            policeWorkflow: state.policeWorkflow ?? null,
        },
    };
}
