import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    reconcilePassportFields,
    applyReconciliationUpdates,
    RECONCILIATION_OUTCOME,
} from "../src/services/fieldReconciliationService.js";

import { IDENTITY_STATUS } from "../src/services/identityVerificationService.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";

const {
    MATCH,
    FILL,
    CONFLICT,
    LOW_CONFIDENCE,
    NOT_EXTRACTED,
    RECORD_MISSING,
} = RECONCILIATION_OUTCOME;

// Build an extraction result where every field has the given value
// and confidence.
function passport(values, confidence = 100) {
    return {
        passportExtraction: {
            fields: Object.fromEntries(
                Object.entries(values).map(([field, value]) => [
                    field,
                    { value },
                ])
            ),
        },

        fieldConfidence: Object.fromEntries(
            Object.keys(values).map((field) => [
                field,
                { confidence },
            ])
        ),
    };
}

const outcomeOf = (result, field) =>
    [
        ...result.matchedFields,
        ...result.missingFieldsFilled,
        ...result.conflicts,
        ...result.skipped,
    ].find((entry) => entry.field === field)?.outcome;

describe("reconcilePassportFields (proposal §14)", () => {
    test("same value -> match, no update", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: "Colombo",
                dateOfBirth: new Date("1990-03-12T00:00:00Z"),
            },

            ...passport({
                placeOfBirth: "COLOMBO",
                dateOfBirth: "1990-03-12",
            }),
        });

        assert.equal(outcomeOf(result, "placeOfBirth"), MATCH);
        assert.equal(outcomeOf(result, "dateOfBirth"), MATCH);
        assert.deepEqual(result.updates, {});
    });

    test("missing DB field + high confidence -> filled", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: null,
                dateOfBirth: null,
                passportExpiryDate: null,
            },

            ...passport(
                {
                    placeOfBirth: "COLOMBO",
                    dateOfBirth: "1990-03-12",
                    passportExpiryDate: "2030-05-11",
                },
                97
            ),
        });

        assert.equal(outcomeOf(result, "placeOfBirth"), FILL);

        assert.equal(
            result.updates.placeOfBirth,
            "COLOMBO"
        );

        assert.equal(
            result.updates.dateOfBirth.toISOString(),
            "1990-03-12T00:00:00.000Z"
        );

        assert.equal(
            result.updates.passportExpiryDate.toISOString(),
            "2030-05-11T00:00:00.000Z"
        );
    });

    test("conflicting DB field -> conflict, never overwritten", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: "KANDY",
            },

            ...passport({
                placeOfBirth: "COLOMBO",
            }),
        });

        assert.equal(
            outcomeOf(result, "placeOfBirth"),
            CONFLICT
        );

        assert.equal(result.conflicts.length, 1);
        assert.deepEqual(result.updates, {});
    });

    test("low-confidence value does not fill a missing field", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: null,
            },

            ...passport(
                {
                    placeOfBirth: "COLOMBO",
                },
                70
            ),
        });

        assert.equal(
            outcomeOf(result, "placeOfBirth"),
            LOW_CONFIDENCE
        );

        assert.deepEqual(result.updates, {});
    });

    test("low-confidence different value neither overwrites nor raises a conflict", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: "KANDY",
            },

            ...passport(
                {
                    placeOfBirth: "COLOMBO",
                },
                45
            ),
        });

        assert.equal(
            outcomeOf(result, "placeOfBirth"),
            LOW_CONFIDENCE
        );

        assert.equal(result.conflicts.length, 0);
        assert.deepEqual(result.updates, {});
    });

    test("low-confidence value that matches the record still counts as a match", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: "COLOMBO",
            },

            ...passport(
                {
                    placeOfBirth: "Colombo",
                },
                40
            ),
        });

        assert.equal(
            outcomeOf(result, "placeOfBirth"),
            MATCH
        );
    });

    test("names: same first name matches, different surname conflicts", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: "Kamal",
                otherName: "Silva",
            },

            ...passport({
                givenNames: "KAMAL",
                surname: "PERERA",
            }),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            MATCH
        );

        assert.equal(
            outcomeOf(result, "surname"),
            CONFLICT
        );

        assert.deepEqual(result.updates, {});
    });

    test("names: first_name is compare-only, surname may fill other_name", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: "KAMAL NIMAL",
                otherName: null,
            },

            ...passport(
                {
                    givenNames: "KAMAL NIMAL",
                    surname: "PERERA",
                },
                97
            ),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            MATCH
        );

        assert.equal(
            outcomeOf(result, "surname"),
            FILL
        );

        assert.deepEqual(result.updates, {
            otherName: "PERERA",
        });
    });

    test("names: different high-confidence first name -> conflict", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: "KAMAL",
                otherName: "PERERA",
            },

            ...passport(
                {
                    givenNames: "NIMAL",
                    surname: "PERERA",
                },
                97
            ),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            CONFLICT
        );

        assert.equal(
            outcomeOf(result, "surname"),
            MATCH
        );

        assert.deepEqual(result.updates, {});
    });

    test("names: low-confidence names are not filled or conflicted", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: "KAMAL",
                otherName: null,
            },

            ...passport(
                {
                    givenNames: "NIMAL",
                    surname: "PERERA",
                },
                85
            ),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            LOW_CONFIDENCE
        );

        assert.equal(
            outcomeOf(result, "surname"),
            LOW_CONFIDENCE
        );

        assert.deepEqual(result.updates, {});
    });

    test("names: first_name missing on record -> RECORD_MISSING, never auto-filled", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: null,
                otherName: null,
            },

            ...passport(
                {
                    givenNames: "KAMAL NIMAL",
                    surname: "PERERA",
                },
                97
            ),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            RECORD_MISSING
        );

        assert.equal(
            outcomeOf(result, "surname"),
            FILL
        );

        assert.deepEqual(result.updates, {
            otherName: "PERERA",
        });

        assert.ok(
            !Object.prototype.hasOwnProperty.call(
                result.updates,
                "firstName"
            )
        );
    });

    test("names: blank first_name -> RECORD_MISSING, never auto-filled", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: "",
                otherName: "PERERA",
            },

            ...passport(
                {
                    givenNames: "KAMAL",
                    surname: "PERERA",
                },
                97
            ),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            RECORD_MISSING
        );

        assert.equal(
            outcomeOf(result, "surname"),
            MATCH
        );

        assert.deepEqual(result.updates, {});
    });

    test("names: a name missing from the passport is not guessed", () => {
        const result = reconcilePassportFields({
            user: {
                firstName: "KAMAL",
                otherName: null,
            },

            ...passport({
                givenNames: null,
                surname: "PERERA",
            }),
        });

        assert.equal(
            outcomeOf(result, "givenNames"),
            NOT_EXTRACTED
        );

        assert.deepEqual(result.updates, {
            otherName: "PERERA",
        });
    });

    test("field not on the passport is skipped", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: null,
            },

            ...passport({
                dateOfBirth: "1990-03-12",
            }),
        });

        assert.equal(
            outcomeOf(result, "placeOfBirth"),
            NOT_EXTRACTED
        );
    });

    test("passport ID and unique_id are never reconciled", () => {
        const result = reconcilePassportFields({
            user: {},

            ...passport({
                passportId: "N1234567",
            }),
        });

        const columns = [
            ...result.matchedFields,
            ...result.missingFieldsFilled,
            ...result.conflicts,
            ...result.skipped,
        ].map((entry) => entry.column);

        assert.ok(!columns.includes("passportId"));
        assert.ok(!columns.includes("uniqueId"));
    });

    test("outcome lists hold field names, not values", () => {
        const result = reconcilePassportFields({
            user: {
                placeOfBirth: "KANDY",
            },

            ...passport({
                placeOfBirth: "COLOMBO",
            }),
        });

        const { updates, ...loggable } = result;

        assert.ok(
            !JSON.stringify(loggable).includes("KANDY")
        );

        assert.ok(
            !JSON.stringify(loggable).includes("COLOMBO")
        );
    });
});

describe("applyReconciliationUpdates", () => {
    const user = {
        passportId: "N1234567",
        firstName: "KAMAL",
        placeOfBirth: null,
        dateOfBirth: null,
    };

    const reconciliation = {
        updates: {
            placeOfBirth: "COLOMBO",
        },
    };

    test("writes missing fillable fields for a verified identity", async () => {
        const db = createFakePrisma([user]);

        const result = await applyReconciliationUpdates({
            identity: {
                status: IDENTITY_STATUS.VERIFIED_MATCH,
                passportId: "N1234567",
            },

            reconciliation,
            db,
        });

        assert.deepEqual(
            result.applied,
            ["placeOfBirth"]
        );

        assert.equal(
            db.rows[0].placeOfBirth,
            "COLOMBO"
        );

        assert.deepEqual(
            db.calls[0].where,
            {
                passportId: "N1234567",
                placeOfBirth: null,
            }
        );
    });

    test("firstName is ignored even if it accidentally appears in updates", async () => {
        const db = createFakePrisma([user]);

        const result = await applyReconciliationUpdates({
            identity: {
                status: IDENTITY_STATUS.VERIFIED_MATCH,
                passportId: "N1234567",
            },

            reconciliation: {
                updates: {
                    firstName: "NIMAL",
                },
            },

            db,
        });

        assert.deepEqual(
            result.applied,
            []
        );

        assert.equal(
            db.rows[0].firstName,
            "KAMAL"
        );

        assert.equal(
            db.calls.length,
            0
        );
    });

    for (
        const status of Object.values(IDENTITY_STATUS)
            .filter(
                (s) =>
                    s !== IDENTITY_STATUS.VERIFIED_MATCH
            )
    ) {
        test(`writes nothing for ${status}`, async () => {
            const db = createFakePrisma([user]);

            const result =
                await applyReconciliationUpdates({
                    identity: {
                        status,
                        passportId: "N1234567",
                    },

                    reconciliation,
                    db,
                });

            assert.deepEqual(
                result.applied,
                []
            );

            assert.equal(
                db.calls.length,
                0
            );
        });
    }

    test("a value filled in meanwhile is not overwritten", async () => {
        const db = createFakePrisma([
            {
                ...user,
                placeOfBirth: "KANDY",
            },
        ]);

        const result =
            await applyReconciliationUpdates({
                identity: {
                    status:
                        IDENTITY_STATUS.VERIFIED_MATCH,
                    passportId: "N1234567",
                },

                reconciliation,
                db,
            });

        assert.deepEqual(
            result.applied,
            []
        );

        assert.equal(
            db.rows[0].placeOfBirth,
            "KANDY"
        );
    });
});