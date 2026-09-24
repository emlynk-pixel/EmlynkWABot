import { CONFIDENCE_THRESHOLDS } from "./confidenceService.js";
import { IDENTITY_STATUS } from "./identityVerificationService.js";

// Proposal §14 reconciliation matrix:
//   DB missing  + passport valid/high confidence -> update
//   DB existing + same value                     -> no change
//   DB existing + different value                -> flag conflict
//   DB existing + low confidence                 -> do not overwrite
//   DB missing  + low confidence                 -> do not update automatically

export const RECONCILIATION_OUTCOME = Object.freeze({
    MATCH: "MATCH",
    FILL: "FILL",
    CONFLICT: "CONFLICT",
    LOW_CONFIDENCE: "LOW_CONFIDENCE",
    NOT_EXTRACTED: "NOT_EXTRACTED",
});

// "High confidence" in §14: the HIGH_CONFIDENCE band or better.
export const MIN_FILL_CONFIDENCE = CONFIDENCE_THRESHOLDS.HIGH_CONFIDENCE_FROM;

// Passport field -> users column. Name mapping confirmed by the business:
// legacy FIRST NAME holds the given names, OTHER NAME holds the surname.
const FIELD_MAP = [
    { field: "dateOfBirth", column: "dateOfBirth", type: "date" },
    { field: "placeOfBirth", column: "placeOfBirth", type: "text" },
    { field: "passportExpiryDate", column: "passportExpiryDate", type: "date" },
    { field: "givenNames", column: "firstName", type: "name" },
    { field: "surname", column: "otherName", type: "name" },
];

// Compare dates by calendar day and text case- and spacing-insensitively,
// so "Colombo" on record matches "COLOMBO" from OCR.
function normalizeForCompare(value, type) {
    if (value === null || value === undefined || value === "") return null;

    if (type === "date") {
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }

    return String(value).toUpperCase().replace(/[^A-Z]/g, "") || null;
}

function toColumnValue(value, type) {
    return type === "date" ? new Date(`${value}T00:00:00.000Z`) : value;
}

// Compare extracted passport fields with the matched user's record.
// Pure: nothing is written here. The result holds field names and outcomes.
// `updates` holds the values to write and must not be logged.
export function reconcilePassportFields({ user, passportExtraction, fieldConfidence }) {
    const result = { matchedFields: [], missingFieldsFilled: [], conflicts: [], skipped: [], updates: {} };

    for (const { field, column, type } of FIELD_MAP) {
        const extracted = passportExtraction?.fields?.[field]?.value ?? null;
        const confidence = fieldConfidence?.[field]?.confidence ?? 0;
        const onRecord = normalizeForCompare(user?.[column], type);
        const fromPassport = normalizeForCompare(extracted, type);

        const entry = { field, column, confidence };

        if (!fromPassport) {
            result.skipped.push({ ...entry, outcome: RECONCILIATION_OUTCOME.NOT_EXTRACTED });
        } else if (onRecord && onRecord === fromPassport) {
            result.matchedFields.push({ ...entry, outcome: RECONCILIATION_OUTCOME.MATCH });
        } else if (confidence < MIN_FILL_CONFIDENCE) {
            // A low-confidence read neither fills nor contradicts trusted data.
            result.skipped.push({ ...entry, outcome: RECONCILIATION_OUTCOME.LOW_CONFIDENCE });
        } else if (onRecord) {
            result.conflicts.push({ ...entry, outcome: RECONCILIATION_OUTCOME.CONFLICT });
        } else {
            result.missingFieldsFilled.push({ ...entry, outcome: RECONCILIATION_OUTCOME.FILL });
            result.updates[column] = toColumnValue(extracted, type);
        }
    }

    return result;
}

// Write the proposed fills. Only for a verified identity (§13 A), and each
// column only if it's still empty, so a value added meanwhile by someone
// else is never overwritten. Returns the columns actually written.
export async function applyReconciliationUpdates({ identity, reconciliation, db }) {
    if (identity?.status !== IDENTITY_STATUS.VERIFIED_MATCH || !identity.passportId) {
        return { applied: [], reason: "IDENTITY_NOT_VERIFIED" };
    }

    const client = db ?? (await import("../config/prisma.js")).default;
    const applied = [];

    for (const [column, value] of Object.entries(reconciliation?.updates ?? {})) {
        const { count } = await client.user.updateMany({
            where: { passportId: identity.passportId, [column]: null },
            data: { [column]: value },
        });
        if (count > 0) applied.push(column);
    }

    return { applied, reason: null };
}
