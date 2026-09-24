import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { sha256Hex, isSha256Hex } from "../src/utils/fileChecksum.js";

describe("sha256Hex", () => {
    test("matches the standard SHA-256 of a known input", () => {
        // SHA-256("abc") from FIPS 180-2.
        assert.equal(
            sha256Hex(Buffer.from("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });

    test("same bytes give the same checksum", () => {
        assert.equal(sha256Hex(Buffer.from("same file")), sha256Hex(Buffer.from("same file")));
    });

    test("one changed byte gives a different checksum", () => {
        assert.notEqual(sha256Hex(Buffer.from("file-A")), sha256Hex(Buffer.from("file-B")));
    });

    test("always 64 lowercase hex characters, including for an empty file", () => {
        for (const buffer of [Buffer.alloc(0), Buffer.from([0, 255, 16]), Buffer.alloc(100_000, 7)]) {
            const checksum = sha256Hex(buffer);
            assert.equal(checksum.length, 64);
            assert.ok(isSha256Hex(checksum));
        }
    });

    test("rejects anything that isn't a Buffer", () => {
        assert.throws(() => sha256Hex("text"), TypeError);
        assert.throws(() => sha256Hex(undefined), TypeError);
    });
});

describe("isSha256Hex", () => {
    test("accepts a valid checksum", () => assert.ok(isSha256Hex("a".repeat(64))));
    test("rejects uppercase, wrong length and non-hex", () => {
        assert.equal(isSha256Hex("A".repeat(64)), false);
        assert.equal(isSha256Hex("a".repeat(63)), false);
        assert.equal(isSha256Hex("g".repeat(64)), false);
        assert.equal(isSha256Hex(null), false);
    });
});
