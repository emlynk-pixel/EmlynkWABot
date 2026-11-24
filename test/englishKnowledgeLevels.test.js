// English Knowledge on the ENGLISH 6..10 scale: the one translation of the older six levels
// (englishKnowledgeLevels.js) and its use by the Candidate Form's Confirm / automatic fill, the
// bulk import and the Sheet mirror. Pure: no database.
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

import { ENGLISH_KNOWLEDGE_LEVELS, ENGLISH_KNOWLEDGE_VALUES, mapEnglishKnowledge, resolveEnglishKnowledge } from "../src/services/englishKnowledgeLevels.js";
import { additionalDetailsComplete } from "../src/services/additionalDetailsCompletion.js";
import { completeAdditionalDetailsData } from "./helpers/completeAdditionalDetails.js";
import { autoFillChanges, pendingChange } from "../src/services/candidateFormFieldConfirmService.js";
import { normalizeEnglishKnowledge } from "../src/services/candidateImportNormalizers.js";

const FIELD = "qualifications.englishKnowledge";

let warn;
beforeEach(() => { warn = mock.method(console, "warn", () => {}); });
afterEach(() => mock.restoreAll());

describe("mapEnglishKnowledge", () => {
    test("the older five levels become ENGLISH 6 (Basic) to ENGLISH 10 (Fluent)", () => {
        assert.deepEqual(["BASIC", "FAIR", "GOOD", "VERY GOOD", "FLUENT"].map(mapEnglishKnowledge), ["ENGLISH 6", "ENGLISH 7", "ENGLISH 8", "ENGLISH 9", "ENGLISH 10"]);
        assert.deepEqual(ENGLISH_KNOWLEDGE_LEVELS, ["ENGLISH 6", "ENGLISH 7", "ENGLISH 8", "ENGLISH 9", "ENGLISH 10"]);
    });

    test("case and extra spaces are ignored", () => {
        assert.equal(mapEnglishKnowledge("good"), "ENGLISH 8");
        assert.equal(mapEnglishKnowledge("  Very   Good "), "ENGLISH 9");
        assert.equal(mapEnglishKnowledge("\tfluent\n"), "ENGLISH 10");
    });

    test("NO KNOWLEDGE and ENGLISH 6..10 pass through, in any case or spacing", () => {
        assert.deepEqual(ENGLISH_KNOWLEDGE_VALUES, ["NO KNOWLEDGE", ...ENGLISH_KNOWLEDGE_LEVELS]);
        for (const value of ENGLISH_KNOWLEDGE_VALUES) assert.equal(mapEnglishKnowledge(value), value);
        assert.equal(mapEnglishKnowledge(" english   7 "), "ENGLISH 7");
        assert.equal(mapEnglishKnowledge(" no  Knowledge "), "NO KNOWLEDGE");
        assert.equal(warn.mock.callCount(), 0);
    });

    test("Not recorded, empty and null are no value, without a warning", () => {
        for (const raw of ["Not recorded", " not   RECORDED ", "", "   ", null, undefined]) {
            assert.equal(mapEnglishKnowledge(raw), null, String(raw));
            assert.equal(resolveEnglishKnowledge(raw).recognised, true);
        }
        assert.equal(warn.mock.callCount(), 0);
    });

    test("an unknown value is null and warns without the value; nothing throws", () => {
        for (const raw of ["PERFECT", "ENGLISH 5", "ENGLISH 11", "N1234567", 8, {}, [], true]) {
            assert.doesNotThrow(() => mapEnglishKnowledge(raw));
            assert.equal(mapEnglishKnowledge(raw), null);
        }
        assert.ok(warn.mock.callCount() > 0);
        for (const call of warn.mock.calls) {
            assert.doesNotMatch(JSON.stringify(call.arguments), /PERFECT|N1234567|ENGLISH 5|ENGLISH 11/);
        }
        assert.equal(resolveEnglishKnowledge("PERFECT").recognised, false);
    });
});

describe("Candidate Form Confirm and automatic fill", () => {
    const response = (englishKnowledge) => ({ englishKnowledge });

    test("a submitted older level is offered as its ENGLISH n against an empty record", () => {
        assert.deepEqual(pendingChange(FIELD, { details: null, submitted: { [FIELD]: "GOOD" } }), { field: FIELD, current: null, submitted: "ENGLISH 8" });
    });

    test("a stored older level reads as its ENGLISH n: the same submitted level is no pending change", () => {
        assert.equal(pendingChange(FIELD, { details: { englishKnowledge: "GOOD" }, submitted: { [FIELD]: "GOOD" } }), null);
        assert.equal(pendingChange(FIELD, { details: { englishKnowledge: "ENGLISH 8" }, submitted: { [FIELD]: "GOOD" } }), null);
        assert.deepEqual(pendingChange(FIELD, { details: { englishKnowledge: "GOOD" }, submitted: { [FIELD]: "FLUENT" } }), { field: FIELD, current: "ENGLISH 8", submitted: "ENGLISH 10" });
    });

    test("a submitted NO KNOWLEDGE is offered as NO KNOWLEDGE; a stored NO KNOWLEDGE is the same value", () => {
        assert.deepEqual(pendingChange(FIELD, { details: null, submitted: { [FIELD]: "NO KNOWLEDGE" } }), { field: FIELD, current: null, submitted: "NO KNOWLEDGE" });
        assert.equal(pendingChange(FIELD, { details: { englishKnowledge: "NO KNOWLEDGE" }, submitted: { [FIELD]: "NO KNOWLEDGE" } }), null);
    });

    test("the automatic fill writes the ENGLISH n into an empty record only", () => {
        assert.deepEqual(autoFillChanges({ details: null, response: response("VERY GOOD") }).data.englishKnowledge, "ENGLISH 9");
        assert.deepEqual(autoFillChanges({ details: { englishKnowledge: "  " }, response: response("BASIC") }).data.englishKnowledge, "ENGLISH 6");
        for (const stored of ["ENGLISH 7", "FAIR", "NO KNOWLEDGE"]) {
            const { data, fields } = autoFillChanges({ details: { englishKnowledge: stored }, response: response("FLUENT") });
            assert.equal(Object.hasOwn(data, "englishKnowledge"), false, stored);
            assert.equal(fields.includes(FIELD), false, stored);
        }
        assert.equal(autoFillChanges({ details: null, response: response("NO KNOWLEDGE") }).data.englishKnowledge, "NO KNOWLEDGE");
        assert.equal(Object.hasOwn(autoFillChanges({ details: { englishKnowledge: "ENGLISH 8" }, response: response("NO KNOWLEDGE") }).data, "englishKnowledge"), false);
    });
});

describe("bulk import", () => {
    test("older answers become their ENGLISH n; NO KNOWLEDGE is kept; anything else is an issue", () => {
        assert.deepEqual(normalizeEnglishKnowledge("Good"), { value: "ENGLISH 8" });
        assert.deepEqual(normalizeEnglishKnowledge("ඉතා හොඳයි (Very Good)"), { value: "ENGLISH 9" });
        assert.deepEqual(normalizeEnglishKnowledge("english 10"), { value: "ENGLISH 10" });
        assert.deepEqual(normalizeEnglishKnowledge("No Knowledge"), { value: "NO KNOWLEDGE" });
        assert.deepEqual(normalizeEnglishKnowledge("N/A"), { value: null });
        assert.deepEqual(normalizeEnglishKnowledge("Perfect"), { value: null, warning: "INVALID_ENGLISH_LEVEL" });
        assert.equal(warn.mock.callCount(), 0, "the import's normalizers never log");
    });
});

describe("Additional details completion", () => {
    test("NO KNOWLEDGE is an answer: it counts as filled, like any level; empty does not", () => {
        for (const englishKnowledge of ["NO KNOWLEDGE", "ENGLISH 6", "ENGLISH 10", "GOOD"]) assert.equal(additionalDetailsComplete(completeAdditionalDetailsData({ englishKnowledge })), true, englishKnowledge);
        assert.equal(additionalDetailsComplete(completeAdditionalDetailsData({ englishKnowledge: null })), false);
    });
});
