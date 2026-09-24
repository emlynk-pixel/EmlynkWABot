import { CONFIDENCE_THRESHOLDS } from "./confidenceService.js";
import { IDENTITY_STATUS } from "./identityVerificationService.js";

// Proposal §14 reconciliation matrix:
//   DB missing  + passport valid/high confidence -> update
//   DB existing + same value                     -> no change
//   DB existing + different value                -> flag conflict
//   DB existing + low confidence                 -> do not overwrite
//   DB missing  + low confidence                 -> do not update automatically
//
// Business exception:
//   users.first_name is required (NOT NULL).
//   Passport givenNames are compared with firstName, but firstName is never
//   automatically filled from passport OCR.
export const RECONCILIATION_OUTCOME = Object.freeze({
    MATCH: "MATCH",
    FILL: "FILL",
    CONFLICT: "CONFLICT",
    LOW_CONFIDENCE: "LOW_CONFIDENCE",
    NOT_EXTRACTED: "NOT_EXTRACTED",
    RECORD_MISSING: "RECORD_MISSING",
});

// "High confidence" in §14: the HIGH_CONFIDENCE band or better.
export const MIN_FILL_CONFIDENCE =
    CONFIDENCE_THRESHOLDS.HIGH_CONFIDENCE_FROM;

// Passport field -> users column.
// legacy FIRST NAME holds the given names, OTHER NAME holds the surname.
//
// fillable:
// true  -> missing DB value may be filled automatically
// false -> compare-only; never auto-fill
const FIELD_MAP = [
    {
        field: "dateOfBirth",
        column: "dateOfBirth",
        type: "date",
        fillable: true,
    },
    {
        field: "placeOfBirth",
        column: "placeOfBirth",
        type: "text",
        fillable: true,
    },
    {
        field: "passportExpiryDate",
        column: "passportExpiryDate",
        type: "date",
        fillable: true,
    },
    {
        field: "givenNames",
        column: "firstName",
        type: "name",
        fillable: false,
    },
    {
        field: "surname",
        column: "otherName",
        type: "name",
        fillable: true,
    },
];

// Extra safety:
// only these columns are ever allowed to be auto-filled in the database.
const FILLABLE_COLUMNS = new Set(
    FIELD_MAP
        .filter(({ fillable }) => fillable)
        .map(({ column }) => column)
);

// Compare dates by calendar day and text case- and spacing-insensitively,
// so "Colombo" on record matches "COLOMBO" from OCR.
function normalizeForCompare(value, type) {
    if (value === null || value === undefined || value === "") return null;

    if (type === "date") {
        const date = value instanceof Date ? value : new Date(value);

        return Number.isNaN(date.getTime())
            ? null
            : date.toISOString().slice(0, 10);
    }

    return String(value)
        .toUpperCase()
        .replace(/[^A-Z]/g, "") || null;
}

function toColumnValue(value, type) {
    return type === "date"
        ? new Date(`${value}T00:00:00.000Z`)
        : value;
}

// Compare extracted passport fields with the matched user's record.
// Pure: nothing is written here.
// `updates` holds values proposed for database writes and must not be logged.
export function reconcilePassportFields({
    user,
    passportExtraction,
    fieldConfidence,
}) {
    const result = {
        matchedFields: [],
        missingFieldsFilled: [],
        conflicts: [],
        skipped: [],
        updates: {},
    };

    for (const { field, column, type, fillable } of FIELD_MAP) {
        const extracted =
            passportExtraction?.fields?.[field]?.value ?? null;

        const confidence =
            fieldConfidence?.[field]?.confidence ?? 0;

        const onRecord =
            normalizeForCompare(user?.[column], type);

        const fromPassport =
            normalizeForCompare(extracted, type);

        const entry = {
            field,
            column,
            confidence,
        };

        // Passport field could not be extracted.
        if (!fromPassport) {
            result.skipped.push({
                ...entry,
                outcome: RECONCILIATION_OUTCOME.NOT_EXTRACTED,
            });
        }

        // Existing DB value matches the passport.
        else if (onRecord === fromPassport) {
            result.matchedFields.push({
                ...entry,
                outcome: RECONCILIATION_OUTCOME.MATCH,
            });
        }

        // OCR/extracted value is not confident enough to modify or conflict
        // with trusted database data.
        else if (confidence < MIN_FILL_CONFIDENCE) {
            result.skipped.push({
                ...entry,
                outcome: RECONCILIATION_OUTCOME.LOW_CONFIDENCE,
            });
        }

        // DB already has a different trusted value.
        else if (onRecord) {
            result.conflicts.push({
                ...entry,
                outcome: RECONCILIATION_OUTCOME.CONFLICT,
            });
        }

        // firstName is required and compare-only.
        // If it is unexpectedly missing/blank, do not auto-fill it.
        else if (!fillable) {
            result.skipped.push({
                ...entry,
                outcome: RECONCILIATION_OUTCOME.RECORD_MISSING,
            });
        }

        // Nullable field is missing and passport value is high-confidence.
        else {
            result.missingFieldsFilled.push({
                ...entry,
                outcome: RECONCILIATION_OUTCOME.FILL,
            });

            result.updates[column] =
                toColumnValue(extracted, type);
        }
    }

    return result;
}

// Write proposed fills only for a verified identity.
// Only explicitly fillable columns may be updated.
// Each column is updated only while it is still NULL, preventing an
// overwrite if another process/user filled it meanwhile.
export async function applyReconciliationUpdates({
    identity,
    reconciliation,
    db,
}) {
    if (
        identity?.status !== IDENTITY_STATUS.VERIFIED_MATCH ||
        !identity.passportId
    ) {
        return {
            applied: [],
            reason: "IDENTITY_NOT_VERIFIED",
        };
    }

    const client =
        db ?? (await import("../config/prisma.js")).default;

    const applied = [];

    for (
        const [column, value]
        of Object.entries(reconciliation?.updates ?? {})
    ) {
        // Safety net: firstName and any future non-fillable fields
        // can never be written automatically.
        if (!FILLABLE_COLUMNS.has(column)) {
            continue;
        }

        const { count } = await client.user.updateMany({
            where: {
                passportId: identity.passportId,
                [column]: null,
            },
            data: {
                [column]: value,
            },
        });

        if (count > 0) {
            applied.push(column);
        }
    }

    return {
        applied,
        reason: null,
    };
}