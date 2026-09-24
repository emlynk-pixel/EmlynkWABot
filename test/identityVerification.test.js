import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    decideIdentity,
    IDENTITY_STATUS,
    IDENTITY_NOTES,
} from "../src/services/identityVerificationService.js";
import { findUsersByPassportId, findUsersByWhatsappNumber } from "../src/services/userLookupService.js";
import { createFakePrisma } from "./helpers/fakePrisma.js";

const {
    VERIFIED_MATCH, PASSPORT_MATCH_ONLY, WHATSAPP_MATCH_ONLY, IDENTITY_CONFLICT,
    NO_MATCH, PASSPORT_ID_UNRESOLVED, AMBIGUOUS_MATCH,
} = IDENTITY_STATUS;

// Synthetic users.
const users = [
    { passportId: "N1234567", uniqueId: "0001", whatsappNumber: "0771234567", firstName: "KAMAL" },
    { passportId: "N7654321", uniqueId: "0002", whatsappNumber: "0772223333", firstName: "NIMAL" },
    { passportId: "N3333333", uniqueId: "0003", whatsappNumber: null },
    { passportId: "N4444444", uniqueId: "0004", whatsappNumber: "0775556666" },
    { passportId: "N5555555", uniqueId: "0005", whatsappNumber: "0775556666" },
];

async function identify({ passportId, sender, isPassportDocument = true, passportIdConfidence = 100 }) {
    const db = createFakePrisma(users);
    const passportLookup = isPassportDocument ? await findUsersByPassportId(passportId, { db }) : null;
    const whatsappLookup = await findUsersByWhatsappNumber(sender, { db });
    return decideIdentity({ isPassportDocument, passportIdConfidence, passportLookup, whatsappLookup });
}

describe("decideIdentity: passport documents (proposal §13)", () => {
    test("A: passport and WhatsApp identify the same user", async () => {
        const result = await identify({ passportId: "N1234567", sender: "94771234567" });

        assert.equal(result.status, VERIFIED_MATCH);
        assert.equal(result.passportId, "N1234567");
        assert.equal(result.uniqueId, "0001");
        assert.equal(result.reviewRequired, false);
        assert.equal(result.provisional, false);
    });

    test("B: WhatsApp belongs to another user (passport of another client) -> conflict, never merged", async () => {
        const result = await identify({ passportId: "N1234567", sender: "94772223333" });

        assert.equal(result.status, IDENTITY_CONFLICT);
        assert.equal(result.passportId, null);
        assert.equal(result.reviewRequired, true);
        assert.deepEqual(result.candidates.byPassport, [{ passportId: "N1234567", uniqueId: "0001" }]);
        assert.deepEqual(result.candidates.byWhatsapp, [{ passportId: "N7654321", uniqueId: "0002" }]);
    });

    test("C: passport matches, sender is not the WhatsApp on record -> flagged, number not changed", async () => {
        const result = await identify({ passportId: "N1234567", sender: "94770000000" });

        assert.equal(result.status, PASSPORT_MATCH_ONLY);
        assert.equal(result.passportId, "N1234567");
        assert.equal(result.reviewRequired, true);
        assert.deepEqual(result.notes, [IDENTITY_NOTES.WHATSAPP_DIFFERS]);
    });

    test("E: passport matches, no WhatsApp on record -> associated by passport", async () => {
        const result = await identify({ passportId: "N3333333", sender: "94770000000" });

        assert.equal(result.status, PASSPORT_MATCH_ONLY);
        assert.equal(result.passportId, "N3333333");
        assert.equal(result.reviewRequired, false);
        assert.deepEqual(result.notes, [IDENTITY_NOTES.WHATSAPP_NOT_ON_RECORD]);
    });

    test("D: known WhatsApp, new passport -> provisional, needs review", async () => {
        const result = await identify({ passportId: "X9999999", sender: "94771234567" });

        assert.equal(result.status, WHATSAPP_MATCH_ONLY);
        assert.equal(result.passportId, "N1234567");
        assert.equal(result.provisional, true);
        assert.equal(result.reviewRequired, true);
        assert.deepEqual(result.notes, [IDENTITY_NOTES.PASSPORT_NOT_IN_DATABASE]);
    });

    test("F: no passport match and no WhatsApp match", async () => {
        const result = await identify({ passportId: "X9999999", sender: "94770000000" });

        assert.equal(result.status, NO_MATCH);
        assert.equal(result.passportId, null);
        assert.equal(result.reviewRequired, true);
    });

    test("G: passport ID missing/unreadable", async () => {
        const result = await identify({ passportId: null, sender: "94770000000" });

        assert.equal(result.status, PASSPORT_ID_UNRESOLVED);
        assert.equal(result.reviewRequired, true);
        assert.equal(result.provisional, false);
    });

    test("G: unreadable passport from a known WhatsApp keeps that user as a provisional candidate only", async () => {
        const result = await identify({ passportId: null, sender: "94771234567" });

        assert.equal(result.status, PASSPORT_ID_UNRESOLVED);
        assert.equal(result.passportId, "N1234567");
        assert.equal(result.provisional, true);
        assert.equal(result.reviewRequired, true);
    });

    test("G: low-confidence passport number is not trusted even if it matches", async () => {
        const result = await identify({ passportId: "N1234567", sender: "94771234567", passportIdConfidence: 30 });

        assert.equal(result.status, PASSPORT_ID_UNRESOLVED);
        assert.deepEqual(result.notes, [IDENTITY_NOTES.PASSPORT_ID_LOW_CONFIDENCE]);
    });

    test("H: WhatsApp number shared by several users -> ambiguous, nobody picked", async () => {
        const result = await identify({ passportId: "N4444444", sender: "94775556666" });

        assert.equal(result.status, AMBIGUOUS_MATCH);
        assert.equal(result.passportId, null);
        assert.equal(result.candidates.byWhatsapp.length, 2);
    });

    test("result contains IDs only, never names", async () => {
        const result = await identify({ passportId: "N1234567", sender: "94772223333" });
        const serialized = JSON.stringify(result);

        assert.ok(!serialized.includes("KAMAL"));
        assert.ok(!serialized.includes("NIMAL"));
    });
});

describe("decideIdentity: police/medical documents (no passport on the document)", () => {
    test("known WhatsApp identifies the client", async () => {
        const result = await identify({ isPassportDocument: false, sender: "94771234567" });

        assert.equal(result.status, WHATSAPP_MATCH_ONLY);
        assert.equal(result.passportId, "N1234567");
        assert.equal(result.provisional, false);
        assert.equal(result.reviewRequired, false);
    });

    test("unknown WhatsApp", async () => {
        const result = await identify({ isPassportDocument: false, sender: "94770000000" });

        assert.equal(result.status, NO_MATCH);
        assert.equal(result.reviewRequired, true);
    });

    test("shared WhatsApp number", async () => {
        const result = await identify({ isPassportDocument: false, sender: "94775556666" });
        assert.equal(result.status, AMBIGUOUS_MATCH);
    });
});
