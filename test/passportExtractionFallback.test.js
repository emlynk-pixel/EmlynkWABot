import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractPassportFields, PASSPORT_EXTRACTION_STATUS } from "../src/services/passportExtractionService.js";

describe("extractPassportFields (fallback)", () => {
    test("fallback passport ID extraction without labels or valid MRZ", () => {
        const text = `
        Some random header
        N9606058
        SURNAME
        JAYASINGHE
        GIVEN NAMES
        KASUN CHAMARA
        `;
        const result = extractPassportFields(text);
        assert.equal(result.fields.passportId.value, "N9606058");
        assert.equal(result.fields.surname.value, "JAYASINGHE");
        assert.equal(result.fields.givenNames.value, "KASUN CHAMARA");
    });
});
