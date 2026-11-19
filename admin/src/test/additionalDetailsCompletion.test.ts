import { describe, expect, test } from "vitest";
import type { AdditionalDetails } from "../api/candidates";
import { additionalDetailsComplete } from "../components/candidate/additionalDetailsCompletion";

// The Additional details step is completed only when every field the form shows is filled.
const EMPTY = {
    nameAsInPassport: null, permanentAddress: null, birthday: null, tshirtSize: null, pantSize: null, shoeSize: null,
    fatherAlive: null, fatherFullName: null, fatherBirthday: null, motherAlive: null, motherFullName: null, motherBirthday: null,
    maritalStatus: null, wifeFullName: null, wifeBirthday: null, child1Name: null, child2Name: null, child3Name: null, otherJobSkills: null,
    bloodGroup: null, height: null, weightKg: null, drivingLicence: null, canReadDrawings: null, teamLeadingSkills: null, otherLanguages: null,
    email: null, city: null, district: null, dsDivision: null, gnDivision: null, cityInRomania: null, englishKnowledge: null, otherJobCategory: null, otherJobSkills2: null,
    fatherPassportNumber: null, motherPassportNumber: null, spousePassportNumber: null,
    guardianName: null, guardianRelationship: null, guardianNic: null, guardianBirthday: null, guardianPhone: null, guardianAddress: null,
} satisfies AdditionalDetails;

const COMPLETE: AdditionalDetails = {
    ...EMPTY, nameAsInPassport: "SAMAN K SILVA", permanentAddress: "1 Main Street", birthday: "1990-03-12",
    bloodGroup: "O+", height: "175 cm", weightKg: "70.5", drivingLicence: true, canReadDrawings: false, teamLeadingSkills: false, otherLanguages: "Tamil", englishKnowledge: "GOOD",
    email: "saman@example.invalid", city: "Kandy", district: "Kandy", dsDivision: "Gangawata Korale", gnDivision: "Mahaiyawa", cityInRomania: "Bucharest",
    tshirtSize: "L", pantSize: "31", shoeSize: "42",
    fatherAlive: false, motherAlive: false,
    maritalStatus: "SINGLE", otherJobSkills: "Welding", otherJobSkills2: "Forklift", otherJobCategory: "Mason",
    guardianName: "Sunil Silva", guardianRelationship: "Uncle", guardianNic: "600011111V", guardianBirthday: "1960-01-01", guardianPhone: "+94771234567", guardianAddress: "1 Main Street",
};

describe("additionalDetailsComplete", () => {
    test("no details row: incomplete", () => {
        expect(additionalDetailsComplete(null)).toBe(false);
        expect(additionalDetailsComplete(undefined)).toBe(false);
    });

    test("a row with only some fields (as a sheet import creates it): incomplete", () => {
        expect(additionalDetailsComplete({ ...EMPTY, city: "Kandy", district: "Kandy", bloodGroup: "O+", email: "a@example.invalid" })).toBe(false);
    });

    test("every shown field filled: completed; No answers (false) count as answered; child names are never required", () => {
        expect(additionalDetailsComplete(COMPLETE)).toBe(true);
    });

    test("one blank or whitespace-only field: incomplete", () => {
        expect(additionalDetailsComplete({ ...COMPLETE, guardianPhone: null })).toBe(false);
        expect(additionalDetailsComplete({ ...COMPLETE, city: "   " })).toBe(false);
        expect(additionalDetailsComplete({ ...COMPLETE, drivingLicence: null })).toBe(false);
    });

    test("a parent who is alive needs their name, birthday and passport number", () => {
        const father = { ...COMPLETE, fatherAlive: true };
        expect(additionalDetailsComplete(father)).toBe(false);
        expect(additionalDetailsComplete({ ...father, fatherFullName: "Sunil Silva", fatherBirthday: "1960-01-01", fatherPassportNumber: "N1111111" })).toBe(true);
        const mother = { ...COMPLETE, motherAlive: true, motherFullName: "Kamala Silva", motherBirthday: "1962-01-01" };
        expect(additionalDetailsComplete(mother)).toBe(false);
        expect(additionalDetailsComplete({ ...mother, motherPassportNumber: "N2222222" })).toBe(true);
    });

    test("married needs the spouse's name, birthday and passport number", () => {
        const married = { ...COMPLETE, maritalStatus: "MARRIED" };
        expect(additionalDetailsComplete(married)).toBe(false);
        expect(additionalDetailsComplete({ ...married, wifeFullName: "Nadeesha Silva", wifeBirthday: "1992-05-01", spousePassportNumber: "N3333333" })).toBe(true);
    });

    test("every field in Physical details, Clothing & sizes and Employment / skills is needed too", () => {
        const fields = [
            "bloodGroup", "height", "weightKg", "drivingLicence", "canReadDrawings", "teamLeadingSkills", "otherLanguages", "englishKnowledge",
            "tshirtSize", "pantSize", "shoeSize", "otherJobSkills", "otherJobSkills2", "otherJobCategory",
        ] as const;
        for (const key of fields) expect(additionalDetailsComplete({ ...COMPLETE, [key]: null }), key).toBe(false);
    });
});
