import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { emptyForm, toPayload, type CandidateFormData } from "../form/model";
import { formatKg, parseHeight, parseWeight } from "../form/measurements";
import { BLOOD_GROUPS } from "../form/options";
import { findCity } from "../form/romania";
import { requiredPaths, validateForm } from "../form/validation";
import {
    callsTo, completeToReview, en, field, fillBasic, fillContact, next, ROMANIAN_CITIES, sectionHeading, setField, si, startsWith, switchLanguage, verified,
} from "./helpers";

// The Personal Details answers (City in Romania + approximate distance to Bucharest, Blood
// Group, Height, Weight, Driving Licence, Can Read Drawings, Team Leading Skills, Other
// Languages) and the parents' Mother / Father Alive. The server's own rules are tested in
// test/candidateFormPersonalDetails.test.js; these rules match them. Synthetic data.

const TODAY = "2026-10-20";

function validData(): CandidateFormData {
    const data = emptyForm();
    data.basic = {
        fullName: "SHAMAL", surname: "SATHSARA", otherNames: "N/A", sex: "MALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "COLOMBO",
        bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "ENGLISH, ROMANIAN",
    };
    data.contact = { address: "12 MAIN STREET", city: "COLOMBO", district: "COLOMBO", dsDivision: "KOLONNAWA", gnDivision: "NORTH", alternativePhone: "N/A", email: "a@example.com", cityInRomania: "Cluj-Napoca" };
    data.passport = { issueDate: "2020-01-15", expiryDate: "2030-01-14" };
    data.qualifications = { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "N/A", otherSkills1: "N/A", otherSkills2: "N/A", englishKnowledge: "GOOD" };
    data.measurements = { shirtSize: "M", waistSize: "32", shoeSize: "9" };
    data.family.father = { name: "N/A", surname: "", passportNumber: "", birthDate: "" };
    data.family.mother = { name: "KUMARI", surname: "PERERA", passportNumber: "N/A", birthDate: "1965-02-03" };
    data.family.child1 = "N/A";
    data.family.fatherAlive = "NO";
    data.family.motherAlive = "YES";
    data.guardian = { name: "KAMAL PERERA", relationship: "UNCLE", nic: "901234567V", birthDate: "1960-01-01", phone: "0771234567", address: "45 LAKE ROAD" };
    return data;
}
const errorsWith = (change: (data: CandidateFormData) => void) => {
    const data = validData();
    change(data);
    return Object.fromEntries(Object.entries(validateForm(data, TODAY)).map(([path, message]) => [path, message.key]));
};

describe("rules (the form agrees with the server)", () => {
    test("a complete form with the new answers has no problems", () => {
        expect(validateForm(validData(), TODAY)).toEqual({});
    });

    test("PERSONAL-NEW-001 City in Romania: required; N/A allowed; Romanian letters kept; numbers refused", () => {
        expect(errorsWith((d) => { d.contact.cityInRomania = ""; })).toEqual({ "contact.cityInRomania": "v.required" });
        expect(errorsWith((d) => { d.contact.cityInRomania = "n/a"; })).toEqual({});
        expect(errorsWith((d) => { d.contact.cityInRomania = "Târgu Mureș"; })).toEqual({});
        expect(errorsWith((d) => { d.contact.cityInRomania = "12345"; })).toEqual({ "contact.cityInRomania": "v.cityInvalid" });
        expect(errorsWith((d) => { d.contact.cityInRomania = "a".repeat(101); })).toEqual({ "contact.cityInRomania": "v.tooLong" });
        const sent = toPayload({ ...validData(), contact: { ...validData().contact, cityInRomania: "  Brașov  " } });
        expect(sent.contact.cityInRomania).toBe("Brașov");
        expect(Object.keys(sent.contact)).not.toContain("distanceToBucharestKm");
    });

    test("PERSONAL-NEW-002 Blood Group: only the eight groups; N/A refused", () => {
        for (const group of BLOOD_GROUPS) expect(errorsWith((d) => { d.basic.bloodGroup = group; })).toEqual({});
        expect(errorsWith((d) => { d.basic.bloodGroup = "Z+"; })).toEqual({ "basic.bloodGroup": "v.required" });
        expect(errorsWith((d) => { d.basic.bloodGroup = "N/A"; })).toEqual({ "basic.bloodGroup": "v.notApplicableRefused" });
    });

    test("PERSONAL-NEW-003 Other Languages: N/A allowed; at most 150 characters", () => {
        expect(errorsWith((d) => { d.basic.otherLanguages = "na"; })).toEqual({});
        expect(errorsWith((d) => { d.basic.otherLanguages = "x".repeat(151); })).toEqual({ "basic.otherLanguages": "v.tooLong" });
        expect(toPayload({ ...validData(), basic: { ...validData().basic, otherLanguages: "na" } }).basic.otherLanguages).toBe("N/A");
    });

    test("PERSONAL-NEW-004 / 005 / 006 the Yes / No answers take only YES or NO and are required", () => {
        for (const key of ["drivingLicence", "canReadDrawings", "teamLeadingSkills"] as const) {
            expect(errorsWith((d) => { d.basic[key] = "NO"; })).toEqual({});
            expect(errorsWith((d) => { d.basic[key] = ""; })).toEqual({ [`basic.${key}`]: "v.required" });
            expect(errorsWith((d) => { d.basic[key] = "N/A"; })).toEqual({ [`basic.${key}`]: "v.notApplicableRefused" });
        }
    });

    test("HEIGHT-001..004 cm, m, feet / inches and decimals are accepted (a number alone is cm)", () => {
        for (const height of ["175", "175 cm", "1.75 m", "5'9\"", "5 ft 9 in", "175.5 cm", "1,755m"]) expect(errorsWith((d) => { d.basic.height = height; }), height).toEqual({});
        expect(parseHeight("5'9\"")).toEqual({ text: "5'9\"", cm: 175.3, unit: "ft" });
        expect(parseHeight("1.75 m")?.cm).toBe(175);
    });

    test("HEIGHT-005 / 006 an invalid height is refused; Height is required (no N/A)", () => {
        for (const height of ["abc", "-175", "0 cm", "9999 cm", "1.75"]) expect(errorsWith((d) => { d.basic.height = height; }), height).toEqual({ "basic.height": "v.heightInvalid" });
        expect(errorsWith((d) => { d.basic.height = ""; })).toEqual({ "basic.height": "v.required" });
        expect(errorsWith((d) => { d.basic.height = "N/A"; })).toEqual({ "basic.height": "v.notApplicableRefused" });
    });

    test("WEIGHT-001..004 70 -> 70 kg; 70.5; kg; g normalised to kg", () => {
        expect(formatKg(parseWeight("70")!)).toBe("70 kg");
        expect(parseWeight("70.5")).toBe(70.5);
        expect(parseWeight("70 kg")).toBe(70);
        expect(parseWeight("70000 g")).toBe(70);
        for (const weight of ["70", "70.5", "70 kg", "70000 g"]) expect(errorsWith((d) => { d.basic.weight = weight; }), weight).toEqual({});
    });

    test("WEIGHT-005 / 006 invalid, zero and negative weights are refused; Weight is required", () => {
        for (const weight of ["abc", "-70", "0", "70 bananas", "70 kg kg"]) expect(errorsWith((d) => { d.basic.weight = weight; }), weight).toEqual({ "basic.weight": "v.weightInvalid" });
        expect(errorsWith((d) => { d.basic.weight = " "; })).toEqual({ "basic.weight": "v.required" });
    });

    test("FAMILY-NEW-001 / 002 Mother and Father Alive are required (Yes / No, never N/A), even for a parent named N/A", () => {
        expect(errorsWith((d) => { d.family.motherAlive = ""; })).toEqual({ "family.motherAlive": "v.required" });
        expect(errorsWith((d) => { d.family.fatherAlive = ""; })).toEqual({ "family.fatherAlive": "v.required" });
        expect(errorsWith((d) => { d.family.fatherAlive = "N/A"; })).toEqual({ "family.fatherAlive": "v.notApplicableRefused" });
        expect(requiredPaths(validData())).toEqual(expect.arrayContaining(["family.fatherAlive", "family.motherAlive"]));
    });

    test("FAMILY-NEW-003 Yes / No are sent as their codes", () => {
        const sent = toPayload(validData());
        expect([sent.family.fatherAlive, sent.family.motherAlive, sent.basic.drivingLicence]).toEqual(["NO", "YES", "YES"]);
    });

    test("DISTANCE-001 / 004 a listed city is found in any spelling; an unlisted one has none", () => {
        expect(findCity(ROMANIAN_CITIES, "cluj napoca")?.distanceKm).toBe(323);
        expect(findCity(ROMANIAN_CITIES, "BRASOV")?.name).toBe("Brașov");
        expect(findCity(ROMANIAN_CITIES, "Bucharest")?.name).toBe("București");
        expect(findCity(ROMANIAN_CITIES, "Satu Nou")).toBeNull();
    });

    test("DISTANCE-005 a county-qualified name (two towns share a name) is a valid city entry and is found", () => {
        const cities = [...ROMANIAN_CITIES, { name: "Ștefănești (Argeș)", aliases: [], distanceKm: 100 }, { name: "Ștefănești (Botoșani)", aliases: [], distanceKm: 380 }];
        expect(findCity(cities, "stefanesti (botosani)")?.distanceKm).toBe(380);
        expect(findCity(cities, "Ștefănești")).toBeNull();
        expect(errorsWith((d) => { d.contact.cityInRomania = "Ștefănești (Argeș)"; })).toEqual({});
        expect(errorsWith((d) => { d.contact.cityInRomania = "Ștefănești ((("; })).toEqual({});
        expect(errorsWith((d) => { d.contact.cityInRomania = "<b>"; })).toEqual({ "contact.cityInRomania": "v.cityInvalid" });
    });
});

describe("Personal Details on screen", () => {
    test("PERSONAL-NEW-001 / DISTANCE-001 / 002 City in Romania offers the listed cities and shows the approximate distance in km", async () => {
        await verified();
        expect(sectionHeading("step.contact")).toBeInTheDocument();
        const city = field("f.cityInRomania");
        expect(city).toHaveAttribute("list", "contact-cityInRomania-suggestions");
        const options = [...document.querySelectorAll("#contact-cityInRomania-suggestions option")].map((option) => option.getAttribute("value"));
        expect(options).toEqual(ROMANIAN_CITIES.map((listed) => listed.name));
        const distance = field("f.distanceToBucharest");
        expect(distance).toHaveAttribute("readonly");
        expect(distance).toHaveValue("—");
        setField("f.cityInRomania", "cluj napoca");
        expect(distance).toHaveValue("Approx. 323 km");
        expect(screen.getByText(en("hint.distance"))).toBeInTheDocument();
        setField("f.cityInRomania", "Satu Nou");
        expect(distance).toHaveValue(en("distance.notListed"));
        setField("f.cityInRomania", "N/A");
        expect(distance).toHaveValue(en("distance.notApplicable"));
    });

    test("PERSONAL-NEW-002 Blood Group is a list of the eight groups with a Select blood group placeholder", async () => {
        await verified();
        const select = field("f.bloodGroup");
        const options = within(select).getAllByRole("option").map((option) => option.textContent);
        expect(options).toEqual([en("option.selectBloodGroup"), ...BLOOD_GROUPS]);
    });

    test("PERSONAL-NEW-004 / 005 / 006 Driving Licence, Can Read Drawings and Team Leading Skills are Yes / No lists", async () => {
        await verified();
        for (const key of ["f.drivingLicence", "f.canReadDrawings", "f.teamLeadingSkills"] as const) {
            expect(within(field(key)).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["", "YES", "NO"]);
        }
    });

    test("WEIGHT-001 / 004 a number alone shows kg in the box; grams are shown converted", async () => {
        await verified();
        setField("f.weight", "70");
        const box = field("f.weight").closest(".input-suffix")!;
        expect(box.querySelector(".input-suffix-unit")?.textContent).toBe("kg");
        setField("f.weight", "70000 g");
        expect(box.querySelector(".input-suffix-unit")).toBeNull();
        expect(screen.getByText("= 70 kg")).toBeInTheDocument();
        setField("f.height", "5'9\"");
        expect(screen.getByText("≈ 175.3 cm")).toBeInTheDocument();
    });

    test("HEIGHT-006 / WEIGHT-006 Next is refused while Height and Weight are missing or wrong", async () => {
        const { user, calls } = await verified();
        fillBasic();
        fillContact();
        setField("f.height", "");
        setField("f.weight", "70 bananas");
        await next(user);
        expect(callsTo(calls, "draft")).toHaveLength(0);
        expect(screen.getByText(en("v.weightInvalid"))).toBeInTheDocument();
        expect(field("f.height")).toHaveAttribute("aria-invalid", "true");
        expect(field("f.height")).toHaveFocus();
    });

    test("the new answers are saved with Next, shown on the review (with units) and sent once on Submit", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        const [personal] = callsTo(calls, "draft");
        const saved = (personal.body as { answers: { basic: Record<string, string>; contact: Record<string, string> } }).answers;
        expect(saved.basic).toMatchObject({ bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "ENGLISH, ROMANIAN" });
        expect(saved.contact.cityInRomania).toBe("cluj napoca");
        expect(screen.getByText("70 kg")).toBeInTheDocument();
        expect(screen.getByText("Approx. 323 km")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        await screen.findByRole("heading", { level: 1, name: en("submitted.title") });
        const body = callsTo(calls, "submit")[0].body as { answers: { family: Record<string, unknown> } };
        expect([body.answers.family.fatherAlive, body.answers.family.motherAlive]).toEqual(["NO", "YES"]);
    });

    test("Sinhala labels for the new fields", async () => {
        const { user } = await verified();
        await switchLanguage(user, "සිංහල");
        expect(screen.getByLabelText(startsWith(si("f.bloodGroup")))).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(si("f.cityInRomania")))).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 4, name: si("section.physical") })).toBeInTheDocument();
    });
});
