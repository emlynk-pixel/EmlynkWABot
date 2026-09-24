import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    findUsersByPassportId,
    findUsersByWhatsappNumber,
    LOOKUP_STATUS,
} from "../src/services/userLookupService.js";
import { normalizePhoneNumber } from "../src/utils/phoneNumber.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";

const { FOUND, NOT_FOUND, MULTIPLE, INVALID_INPUT } = LOOKUP_STATUS;

// Synthetic users. Numbers are stored in the mixed formats legacy data uses.
const users = [
    { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "+94 77 123 4567" },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333" },
    { passportId: "N1111111", uniqueId: "0003", whatsappNumber: "774445555" },
    { passportId: "N2222222", uniqueId: "0004", whatsappNumber: "94774445555" },
    { passportId: "n9999999", uniqueId: "0005", whatsappNumber: null },
];

describe("normalizePhoneNumber", () => {
    const cases = [
        ["94771234567", "94771234567"],
        ["+94 77 123 4567", "94771234567"],
        ["0771234567", "94771234567"],
        ["771234567", "94771234567"],
        ["0094771234567", "94771234567"],
        ["077-123-4567", "94771234567"],
        ["447911123456", "447911123456"],
        ["+94771234567", "94771234567"],
        ["+447911123456", "447911123456"],
        // Country code already present: nothing is prepended.
        ["94712345678", "94712345678"],
        // Sri Lankan landline in local format: not a mobile, left as digits.
        ["0112345678", "0112345678"],
        // 10 digits starting with 7 is not a local mobile number.
        ["7123456789", "7123456789"],
        ["123", null],
        [null, null],
        ["", null],
    ];

    for (const [input, expected] of cases) {
        test(`${JSON.stringify(input)} -> ${expected}`, () => assert.equal(normalizePhoneNumber(input), expected));
    }
});

describe("findUsersByPassportId", () => {
    test("exact passport ID match", async () => {
        const result = await findUsersByPassportId("N1234567", { db: createFakePrisma(users) });

        assert.equal(result.status, FOUND);
        assert.equal(result.users[0].passportId, "N1234567");
        assert.equal(result.users[0].uniqueId, "0001");
    });

    test("normalizes before looking up (spaces, lowercase)", async () => {
        const result = await findUsersByPassportId(" n 1234567 ", { db: createFakePrisma(users) });
        assert.equal(result.status, FOUND);
    });

    test("finds a legacy row stored in lowercase", async () => {
        const result = await findUsersByPassportId("N9999999", { db: createFakePrisma(users) });
        assert.equal(result.status, FOUND);
    });

    test("no match", async () => {
        const result = await findUsersByPassportId("X0000000", { db: createFakePrisma(users) });
        assert.equal(result.status, NOT_FOUND);
    });

    test("unique_id is never used as a passport ID", async () => {
        const db = createFakePrisma(users);
        const result = await findUsersByPassportId("0001", { db });

        assert.equal(result.status, INVALID_INPUT);
        assert.equal(db.calls.length, 0);
    });

    test("queries passportId only", async () => {
        const db = createFakePrisma(users);
        await findUsersByPassportId("N1234567", { db });

        assert.deepEqual(Object.keys(db.calls[0].where), ["passportId"]);
    });

    test("invalid passport ID does not query the database", async () => {
        const db = createFakePrisma(users);
        const result = await findUsersByPassportId("PASSPORT", { db });

        assert.equal(result.status, INVALID_INPUT);
        assert.equal(db.calls.length, 0);
    });
});

describe("findUsersByWhatsappNumber", () => {
    test("Meta format matches a number stored with + and spaces", async () => {
        const result = await findUsersByWhatsappNumber("94771234567", { db: createFakePrisma(users) });

        assert.equal(result.status, FOUND);
        assert.equal(result.users[0].passportId, "N1234567");
    });

    test("matches a number stored in local 07X format", async () => {
        const result = await findUsersByWhatsappNumber("94772223333", { db: createFakePrisma(users) });
        assert.equal(result.users[0].passportId, "N7654321");
    });

    test("two users share a WhatsApp number (stored in different formats)", async () => {
        const result = await findUsersByWhatsappNumber("94774445555", { db: createFakePrisma(users) });

        assert.equal(result.status, MULTIPLE);
        assert.deepEqual(result.users.map((u) => u.passportId).sort(), ["N1111111", "N2222222"]);
    });

    test("same last four digits but a different number is not a match", async () => {
        const result = await findUsersByWhatsappNumber("94710004567", { db: createFakePrisma(users) });
        assert.equal(result.status, NOT_FOUND);
    });

    test("unknown number", async () => {
        const result = await findUsersByWhatsappNumber("94700000000", { db: createFakePrisma(users) });
        assert.equal(result.status, NOT_FOUND);
    });

    test("invalid number does not query the database", async () => {
        const db = createFakePrisma(users);
        const result = await findUsersByWhatsappNumber("abc", { db });

        assert.equal(result.status, INVALID_INPUT);
        assert.equal(db.calls.length, 0);
    });

    test("stored numbers are never modified", async () => {
        const db = createFakePrisma(users);
        await findUsersByWhatsappNumber("94771234567", { db });

        assert.equal(db.rows[0].whatsappNumber, "+94 77 123 4567");
        assert.ok(db.calls.every((call) => call.method === "user.findMany"));
    });
});
