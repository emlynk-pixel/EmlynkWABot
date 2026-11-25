// English Knowledge display mapping (englishKnowledgeLevels.js): the stored codes stay
// NO KNOWLEDGE / BASIC..FLUENT; ENGLISH 6..10 is a label only. Pure: no database.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ENGLISH_KNOWLEDGE_LABELS, codeOf, labelOf } from "../src/services/englishKnowledgeLevels.js";
import { ENGLISH_LEVELS } from "../src/services/candidateFormDataService.js";
import { pendingChange } from "../src/services/candidateFormFieldConfirmService.js";
import { normalizeEnglishKnowledge } from "../src/services/candidateImportNormalizers.js";

const FIELD = "qualifications.englishKnowledge";
const PAIRS = [["NO KNOWLEDGE", "NO KNOWLEDGE"], ["BASIC", "ENGLISH 6"], ["FAIR", "ENGLISH 7"], ["GOOD", "ENGLISH 8"], ["VERY GOOD", "ENGLISH 9"], ["FLUENT", "ENGLISH 10"]];

describe("labelOf / codeOf", () => {
    test("every stored code has its label, and the map is frozen", () => {
        assert.deepEqual(Object.keys(ENGLISH_KNOWLEDGE_LABELS), [...ENGLISH_LEVELS]);
        assert.ok(Object.isFrozen(ENGLISH_KNOWLEDGE_LABELS));
        for (const [code, label] of PAIRS) assert.equal(labelOf(code), label, code);
    });

    test("codeOf: a label or a code gives the stored code", () => {
        for (const [code, label] of PAIRS) {
            assert.equal(codeOf(label), code, label);
            assert.equal(codeOf(code), code, code);
        }
    });

    test("NO KNOWLEDGE is the same on both sides", () => {
        assert.equal(labelOf("NO KNOWLEDGE"), "NO KNOWLEDGE");
        assert.equal(codeOf("NO KNOWLEDGE"), "NO KNOWLEDGE");
    });

    test("case and extra spacing are ignored", () => {
        assert.equal(codeOf(" english   8 "), "GOOD");
        assert.equal(codeOf("\tvery  good\n"), "VERY GOOD");
        assert.equal(codeOf("no Knowledge"), "NO KNOWLEDGE");
        assert.equal(labelOf(" fluent "), "ENGLISH 10");
    });

    test("null, blank and unknown give null", () => {
        for (const raw of [null, undefined, "", "   ", "PERFECT", "ENGLISH 5", "ENGLISH 11", "ENGLISH8", 8, {}]) {
            assert.equal(codeOf(raw), null, String(raw));
            assert.equal(labelOf(raw), null, String(raw));
        }
        assert.equal(labelOf("ENGLISH 8"), null, "a label is not a stored code");
    });
});

describe("bulk import", () => {
    test("both an old answer and an ENGLISH n label are stored as the code", () => {
        assert.deepEqual(normalizeEnglishKnowledge("Good"), { value: "GOOD" });
        assert.deepEqual(normalizeEnglishKnowledge("ENGLISH 8"), { value: "GOOD" });
        assert.deepEqual(normalizeEnglishKnowledge("ඉතා හොඳයි (Very Good)"), { value: "VERY GOOD" });
        assert.deepEqual(normalizeEnglishKnowledge("No Knowledge"), { value: "NO KNOWLEDGE" });
        assert.deepEqual(normalizeEnglishKnowledge(""), { value: null });
        assert.deepEqual(normalizeEnglishKnowledge("N/A"), { value: null });
        assert.deepEqual(normalizeEnglishKnowledge("Perfect"), { value: null, warning: "INVALID_ENGLISH_LEVEL" });
    });
});

describe("Candidate Form Confirm (codes in, codes out)", () => {
    test("a submitted GOOD against a stored GOOD is no pending change", () => {
        assert.equal(pendingChange(FIELD, { details: { englishKnowledge: "GOOD" }, submitted: { [FIELD]: "GOOD" } }), null);
    });

    test("a submitted GOOD against a stored FAIR is offered as codes", () => {
        assert.deepEqual(pendingChange(FIELD, { details: { englishKnowledge: "FAIR" }, submitted: { [FIELD]: "GOOD" } }), { field: FIELD, current: "FAIR", submitted: "GOOD" });
    });
});
