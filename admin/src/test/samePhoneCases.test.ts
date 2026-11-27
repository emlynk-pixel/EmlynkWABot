import { describe, expect, test } from "vitest";
import { samePhoneNumber } from "../components/candidate/CandidateFields";

// Mirrors test/helpers/samePhoneNumberCases.js, the table the server is tested against.
const SAME: [string, string][] = [
    ["+94771234567", "+94771234567"], ["+94771234567", "+94 77 123 4567"], ["+94771234567", "94771234567"], ["+94771234567", "0094771234567"],
    ["+94771234567", "0771234567"], ["+94771234567", "771234567"], ["+94771234567", "+94 0771234567"], ["+94771234567", "0094 0771234567"],
    ["+94771234567", "077-123-4567"], ["+94771234567", "(077) 123.4567"], ["94771234567", "0771234567"], ["771234567", "+94771234567"],
    ["+94112345678", "0112345678"], ["+919876543210", "00919876543210"], ["+919876543210", "+91 98765 43210"],
];
const DIFFERENT: [string | null, string | null][] = [
    ["+94771234567", "0771234568"], ["+94771234567", "+94 77 123 4568"], ["+94771234567", "+40771234567"], ["+94771234567", "0112345678"],
    ["+94771234567", "9477123456"], ["+919876543210", "9876543210"], ["+94771234567", "N/A"], ["+94771234567", "n/a"], ["+94771234567", ""],
    ["+94771234567", null], ["", ""], [null, null],
];

describe("same-number rule agrees with the server table", () => {
    test("same pairs are the same number, both ways round", () => {
        for (const [a, b] of SAME) {
            expect(samePhoneNumber(a, b), `${a} = ${b}`).toBe(true);
            expect(samePhoneNumber(b, a), `${b} = ${a}`).toBe(true);
        }
    });
    test("different pairs are not", () => {
        for (const [a, b] of DIFFERENT) {
            expect(samePhoneNumber(a, b), `${a} != ${b}`).toBe(false);
            expect(samePhoneNumber(b, a), `${b} != ${a}`).toBe(false);
        }
    });
});
