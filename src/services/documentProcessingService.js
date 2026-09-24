import { extractDocumentText } from "./ocrService.js";
import {
    classifyDocument,
    classifyDocumentContent,
    resolveDocumentType,
    DOCUMENT_TYPES,
} from "./documentClassificationService.js";
import { assessDocumentConfidence, assessPassportFieldConfidence } from "./confidenceService.js";
import { extractPassportFields } from "./passportExtractionService.js";
import { extractPoliceReportDate, POLICE_DATE_STATUS } from "./policeReportDateService.js";
import { findUsersByPassportId, findUsersByWhatsappNumber } from "./userLookupService.js";
import { decideIdentity, IDENTITY_STATUS } from "./identityVerificationService.js";
import { reconcilePassportFields, applyReconciliationUpdates } from "./fieldReconciliationService.js";
import { updateTemporaryDocumentRecord } from "./temporaryDataService.js";

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

// Prisma puts query arguments (e.g. a passport number) on later lines of
// its messages, so only the first line is kept for logs.
function safeErrorMessage(error) {
    return String(error?.message ?? error).split("\n")[0].slice(0, 200);
}

// Build the parts of the result that are safe to log: statuses, scores,
// flags and field names. No document text, names, dates or passport numbers.
function summarize(state) {
    const { stage, error, textExtraction, resolvedType, confidence, passport, fieldConfidence,
        policeDate, identity, reconciliation, applied, processingStatus, recordUpdated } = state;

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
        confidence: confidence
            ? {
                extraction: confidence.extractionConfidence,
                classification: confidence.classificationConfidence,
                document: confidence.documentConfidence,
                band: confidence.band,
                flags: confidence.flags,
            }
            : null,
        passport: passport
            ? {
                status: passport.status,
                missingFields: passport.missingFields,
                mrzLinesFound: passport.mrz.linesFound,
                passportIdBand: fieldConfidence?.passportId?.band ?? null,
            }
            : null,
        policeDate: policeDate ? { status: policeDate.status, kind: policeDate.kind } : null,
        identity: identity
            ? {
                status: identity.status,
                reviewRequired: identity.reviewRequired,
                provisional: identity.provisional,
                notes: identity.notes,
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
// date) and Phase 6 (identity, reconciliation) for one stored document,
// then update its temporary_data row. Never throws: a failure is recorded
// as FAILED with the stage it happened in, so the webhook keeps working.
// Returns { summary } (safe to log) and { details } (extracted values, not logged).
export async function processDocument({
    temporaryId,
    whatsappNumber,
    fileName,
    mimeType,
    fileBuffer,
    filenameClassification,
    deps = {},
}) {
    const { db, extractText = extractDocumentText } = deps;
    const state = { stage: "TEXT_EXTRACTION", recordUpdated: false };

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
        if (documentType === DOCUMENT_TYPES.POLICE_REPORT) {
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

        state.stage = "RECONCILIATION";
        const passportUser = passportLookup?.users.length === 1 ? passportLookup.users[0] : null;
        if (isPassportDocument && passportUser && state.identity.status !== IDENTITY_STATUS.PASSPORT_ID_UNRESOLVED) {
            state.reconciliation = reconcilePassportFields({
                user: passportUser,
                passportExtraction: state.passport,
                fieldConfidence: state.fieldConfidence,
            });
            ({ applied: state.applied } = await applyReconciliationUpdates({
                identity: state.identity,
                reconciliation: state.reconciliation,
                db,
            }));
        }

        state.stage = "RECORD_UPDATE";
        state.processingStatus = determineProcessingStatus(state);

        const linkUser = LINKABLE_IDENTITIES.has(state.identity.status) && !state.identity.provisional;
        await updateTemporaryDocumentRecord(temporaryId, {
            documentType,
            processingStatus: state.processingStatus,
            ...(linkUser ? { passportId: state.identity.passportId, uniqueId: state.identity.uniqueId } : {}),
        }, { db });
        state.recordUpdated = true;
        state.stage = "COMPLETED";
    } catch (error) {
        state.error = safeErrorMessage(error);
        state.processingStatus = PROCESSING_STATUS.FAILED;

        try {
            await updateTemporaryDocumentRecord(temporaryId, { processingStatus: PROCESSING_STATUS.FAILED }, { db });
            state.recordUpdated = true;
        } catch (updateError) {
            state.error = `${safeErrorMessage(error)}; status update failed: ${safeErrorMessage(updateError)}`;
        }
    }

    return {
        summary: summarize(state),
        // Not for logging. The police date has no column until Phase 7/9,
        // so it's kept here in the result rather than stored.
        details: {
            policeDate: state.policeDate
                ? { status: state.policeDate.status, date: state.policeDate.date, kind: state.policeDate.kind, confidence: state.policeDate.confidence }
                : null,
        },
    };
}
