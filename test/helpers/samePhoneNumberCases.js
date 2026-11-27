// The shared table of the "alternative/contact number must differ from the WhatsApp number" rule:
// [whatsappNumber, otherNumber]. SAME pairs are one phone number (refused), DIFFERENT pairs are not
// (accepted). The server (src/utils/phoneNumber.js isSamePhoneNumber) and the clients
// (candidate-form/src/form/phone.ts samePhone, admin CandidateFields.tsx samePhoneNumber) must agree
// on every row. Comparison: non-digits dropped, a leading "00" removed, then a Sri Lankan number is
// its 9 national digits (94 + 9, 940 + 9, 0 + 9 or the bare 9 digits); any other number its digits.
// Synthetic numbers only.
export const SAME_PHONE_NUMBER_CASES = Object.freeze([
    ["+94771234567", "+94771234567"],
    ["+94771234567", "+94 77 123 4567"],
    ["+94771234567", "94771234567"],
    ["+94771234567", "0094771234567"],
    ["+94771234567", "0771234567"],
    ["+94771234567", "771234567"],
    ["+94771234567", "+94 0771234567"],
    ["+94771234567", "0094 0771234567"],
    ["+94771234567", "077-123-4567"],
    ["+94771234567", "(077) 123.4567"],
    ["94771234567", "0771234567"],
    ["771234567", "+94771234567"],
    ["+94112345678", "0112345678"],
    ["+919876543210", "00919876543210"],
    ["+919876543210", "+91 98765 43210"],
]);

export const DIFFERENT_PHONE_NUMBER_CASES = Object.freeze([
    ["+94771234567", "0771234568"],
    ["+94771234567", "+94 77 123 4568"],
    ["+94771234567", "+40771234567"],
    ["+94771234567", "0112345678"],
    ["+94771234567", "9477123456"],
    ["+919876543210", "9876543210"],
    // Not a number is never the same.
    ["+94771234567", "N/A"],
    ["+94771234567", "n/a"],
    ["+94771234567", ""],
    ["+94771234567", null],
    ["", ""],
    [null, null],
]);
