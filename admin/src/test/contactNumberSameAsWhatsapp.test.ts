import { describe, expect, test } from "vitest";
import { ApiError } from "../api/client";
import { emptyDetails, isSameAsContactError, phoneKey, SAME_AS_CONTACT, validateDetails } from "../components/candidate/CandidateFields";

const details = (contactNumber: string, whatsappNumber = "94771234567") => ({
    ...emptyDetails(), surname: "PERERA", otherNames: "KAMAL", nic: "901234567V", jobTypes: ["Welder"],
    jobExperience: "5 years", passportIssueDate: "2020-01-01", passportExpiryDate: "2030-01-01", whatsappNumber, contactNumber,
});

describe("contact number vs WhatsApp number", () => {
    test("the same number in any format is refused with the message", () => {
        expect(SAME_AS_CONTACT).toBe("Contact number must be different from the WhatsApp number.");
        for (const same of ["+94 77 123 4567", "0094771234567", "0771234567", "077-123-4567", "(077) 123 4567", "94771234567"]) {
            expect(validateDetails(details(same), "details").contactNumber, same).toBe(SAME_AS_CONTACT);
        }
        expect(validateDetails(details("0771234567"), "details", { whatsappLocked: true }).contactNumber).toBe(SAME_AS_CONTACT);
        expect(validateDetails(details("+40 712 345 678", "40712345678"), "details").contactNumber).toBe(SAME_AS_CONTACT);
    });

    test("a different number, an empty one, or no WhatsApp number passes; other rules are unchanged", () => {
        expect(validateDetails(details("0712345678"), "details")).toEqual({});
        expect(validateDetails(details(""), "details")).toEqual({});
        expect(validateDetails(details("0771234567", ""), "details").contactNumber).toBeUndefined();
        expect(validateDetails(details("12"), "details").contactNumber).toBe("Enter a phone number, e.g. 0771234567.");
    });

    test("like the server, an existing record already holding both equal can be saved until this save makes them equal", () => {
        const original = { contactNumber: "0771234567", whatsappNumber: "94771234567" };
        expect(validateDetails(details("0771234567"), "details", { whatsappLocked: true, original }).contactNumber).toBeUndefined();
        expect(validateDetails(details("077 123 4567"), "details", { whatsappLocked: true, original }).contactNumber).toBeUndefined(); // same number, reformatted
        expect(validateDetails(details("0771234567"), "details", { whatsappLocked: true, original: { contactNumber: "0712345678", whatsappNumber: "94771234567" } }).contactNumber).toBe(SAME_AS_CONTACT);
        // Adding the WhatsApp number now, equal to the contact number on record.
        expect(validateDetails(details("0771234567"), "details", { original: { contactNumber: "0771234567", whatsappNumber: "" } }).contactNumber).toBe(SAME_AS_CONTACT);
    });

    test("normalization", () => {
        expect(phoneKey("+94 77 123 4567")).toBe("771234567");
        expect(phoneKey("0094771234567")).toBe("771234567");
        expect(phoneKey("0771234567")).toBe("771234567");
        expect(phoneKey("+91 98765 43210")).toBe("919876543210");
    });

    test("the server's same_as_contact refusal is recognised", () => {
        expect(isSameAsContactError(new ApiError(400, "Bad", undefined, [{ field: "contactNumber", message: "same_as_contact" }]))).toBe(true);
        expect(isSameAsContactError(new ApiError(400, "Bad", undefined, [{ field: "contact.alternativePhone", message: "same_as_contact" }]))).toBe(true);
        expect(isSameAsContactError(new ApiError(400, "Bad", undefined, [], "SAME_AS_CONTACT"))).toBe(true);
        // The shape candidateService.js sends: { code, errors: [{ field, code, message: <sentence> }] }.
        const sent = [{ field: "contactNumber", code: "same_as_contact", message: "Contact number must be different from the WhatsApp number." }];
        expect(isSameAsContactError(new ApiError(400, "Bad", undefined, sent, "CONTACT_SAME_AS_WHATSAPP"))).toBe(true);
        expect(isSameAsContactError(new ApiError(400, "Bad", undefined, sent))).toBe(true);
        expect(isSameAsContactError(new ApiError(400, "Bad", undefined, [{ field: "contactNumber", message: "invalid" }]))).toBe(false);
        expect(isSameAsContactError(new Error("x"))).toBe(false);
    });
});
