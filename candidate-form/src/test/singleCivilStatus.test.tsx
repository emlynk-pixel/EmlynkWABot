import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { App } from "../App";
import { emptyForm, toPayload, type CandidateFormData } from "../form/model";
import { requiredPaths, validateForm, visiblePaths } from "../form/validation";
import type { CandidateFormPayload, FormLoadResponse } from "../types/api";
import {
    backend, callsTo, completeToReview, CONTINUE, en, field, fillBasic, fillContact, fillVerify, fillWork, next, prefill, queryField, setField, stepHeading, verified,
    type Call, type User,
} from "./helpers";

// Civil Status Single: no spouse and no children are asked, checked, saved or sent. Every other
// Civil Status is as before (the spouse only with Married, the children with all of them).
// Synthetic data; the backend is a stub.

const NOBODY = { name: null, surname: null, passportNumber: null, birthDate: null };
// What Single sends for the children: nothing (a Single candidate has no children).
const NO_CHILDREN = { child1: null, child2: null, child3: null };
const CHILD_FIELDS = ["f.child1", "f.child2", "f.child3"] as const;
const SPOUSE_FIELDS = ["f.spouseName", "f.spouseSurname", "f.spousePassport", "f.spouseBirthDate"] as const;

type Body = { step?: string; answers: CandidateFormPayload };
const bodies = (calls: Call[], endpoint: "draft" | "submit") => callsTo(calls, endpoint).map((call) => call.body as Body);

async function submit(user: User) {
    await user.click(screen.getByRole("button", { name: en("review.save") }));
    await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
    await screen.findByRole("heading", { level: 1, name: en("submitted.title") });
}

// A Married candidate's whole form with a spouse and three children.
function marriedData(): CandidateFormData {
    const data = emptyForm();
    data.basic = { fullName: "SHAMAL", surname: "SATHSARA", otherNames: "N/A", sex: "MALE", civilStatus: "MARRIED", birthDate: "1990-05-01", birthPlace: "COLOMBO", bloodGroup: "O+", height: "175 cm", weight: "70", drivingLicence: "YES", canReadDrawings: "NO", teamLeadingSkills: "YES", otherLanguages: "N/A" };
    data.contact = { address: "12 MAIN STREET", city: "COLOMBO", district: "COLOMBO", dsDivision: "KOLONNAWA", gnDivision: "KOLONNAWA NORTH", alternativePhone: "N/A", email: "shamal@example.com", cityInRomania: "N/A" };
    data.passport = { issueDate: "2020-01-15", expiryDate: "2030-01-14" };
    data.qualifications = { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 YEARS", otherSkills1: "N/A", otherSkills2: "N/A", englishKnowledge: "GOOD" };
    data.measurements = { shirtSize: "M", waistSize: "32", shoeSize: "42" };
    data.family.father.name = "N/A";
    data.family.mother = { name: "KUMARI", surname: "PERERA", passportNumber: "N/A", birthDate: "1965-02-03" };
    data.family.spouse = { name: "NADEESHA", surname: "SILVA", passportNumber: "N1111111", birthDate: "1992-07-08" };
    data.family.child1 = "NIMAL";
    data.family.child2 = "KASUN";
    data.family.child3 = "N/A";
    data.family.fatherAlive = "NO";
    data.family.motherAlive = "YES";
    data.guardian = { name: "KAMAL PERERA", relationship: "UNCLE", nic: "901234567V", birthDate: "1960-01-01", phone: "0771234567", address: "45 LAKE ROAD" };
    return data;
}

// POST /form for a candidate whose answers say Single but still hold spouse and child values
// (a draft saved before, or the record's prefill). `savedSteps` [] = a first visit (prefill only).
function singleWithLeftovers(savedSteps: ("personal" | "work")[]): FormLoadResponse {
    const answers = toPayload(marriedData());
    answers.basic.civilStatus = "SINGLE";
    const base = prefill();
    return { ...base, answers, prefilled: savedSteps.length ? [] : ["basic.civilStatus", "family.spouse.name", "family.child1", "family.child2"], savedSteps, draftSavedAt: savedSteps.length ? new Date().toISOString() : null };
}

async function open(form: FormLoadResponse, first: "step.personal" | "step.work" | "step.review") {
    const calls = backend({ form: { status: 200, body: form } });
    render(<App />);
    const user = userEvent.setup();
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: en("verify.submit") }));
    await user.click(await screen.findByRole("button", { name: CONTINUE }));
    await screen.findByRole("heading", { level: 2, name: en(first) });
    return { user, calls };
}

const expectNoSpouseOrChildFields = () => {
    for (const key of [...SPOUSE_FIELDS, ...CHILD_FIELDS]) expect(queryField(key), key).toBeNull();
    expect(screen.queryByText(en("family.children"))).toBeNull();
};
const familyCard = () => within(screen.getByRole("region", { name: en("step.family") }));

describe("Civil Status Single", () => {
    test("hides every spouse and child field, and the form is completed, saved and submitted without them", async () => {
        const { user, calls } = await verified();
        fillBasic("SINGLE");
        fillContact();
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        expectNoSpouseOrChildFields();
        // Father and mother are still asked.
        expect(field("f.fatherName")).toBeInTheDocument();
        expect(field("f.motherName")).toBeInTheDocument();

        await fillWork(user);
        await next(user);
        expect(stepHeading("step.review")).toBeInTheDocument();
        for (const key of [...SPOUSE_FIELDS, ...CHILD_FIELDS]) expect(familyCard().queryByText(en(key)), key).toBeNull();
        expect(familyCard().getByText(en("f.motherName"))).toBeInTheDocument();

        await submit(user);
        const [work] = bodies(calls, "draft").filter((body) => body.step === "work");
        expect(work.answers.family).toMatchObject({ spouse: NOBODY, ...NO_CHILDREN });
        const [sent] = bodies(calls, "submit");
        expect(sent.answers.family).toMatchObject({ spouse: NOBODY, ...NO_CHILDREN });
    });

    test("spouse and child answers are neither required nor checked", () => {
        const data = marriedData();
        data.basic.civilStatus = "SINGLE";
        // Leftovers that would be refused if they were shown.
        data.family.spouse = { name: "", surname: "", passportNumber: "!!", birthDate: "2999-01-01" };
        data.family.child1 = "";
        data.family.child2 = "X".repeat(500);
        expect(validateForm(data, "2026-10-20")).toEqual({});
        const hidden = (path: string) => path.startsWith("family.spouse.") || /^family\.child\d$/.test(path);
        expect(visiblePaths(data).filter(hidden)).toEqual([]);
        expect(requiredPaths(data).filter(hidden)).toEqual([]);
    });
});

describe("other Civil Status answers are as before", () => {
    test("Married shows the spouse and the children, they are required, and they are saved and sent as typed", async () => {
        const { user, calls } = await verified();
        fillBasic("MARRIED");
        fillContact();
        await next(user);
        for (const key of [...SPOUSE_FIELDS, "f.child1"] as const) expect(field(key), key).toBeRequired();
        // Empty, they block Next.
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        for (const key of [...SPOUSE_FIELDS, "f.child1"] as const) expect(field(key), key).toHaveAttribute("aria-invalid", "true");

        await fillWork(user, { spouse: true });
        setField("f.child1", "nimal");
        setField("f.child2", "kasun");
        setField("f.child3", "N/A");
        await next(user);
        expect(stepHeading("step.review")).toBeInTheDocument();
        for (const key of [...SPOUSE_FIELDS, ...CHILD_FIELDS]) expect(familyCard().getByText(en(key)), key).toBeInTheDocument();

        await submit(user);
        const expected = { spouse: { name: "NADEESHA", surname: "SILVA", passportNumber: "N/A", birthDate: "1992-07-08" }, child1: "NIMAL", child2: "KASUN", child3: "N/A" };
        const [work] = bodies(calls, "draft").filter((body) => body.step === "work");
        expect(work.answers.family).toMatchObject(expected);
        expect(bodies(calls, "submit")[0].answers.family).toMatchObject(expected);
    });

    test("Divorced and Widowed (and an unanswered Civil Status) keep the children and no spouse, as before", async () => {
        for (const status of ["DIVORCED", "WIDOWED", ""]) {
            const data = marriedData();
            data.basic.civilStatus = status;
            const sent = toPayload(data).family;
            expect(sent.spouse, status).toEqual(NOBODY);
            expect([sent.child1, sent.child2, sent.child3], status).toEqual(["NIMAL", "KASUN", "N/A"]);
            expect(requiredPaths(data), status).toContain("family.child1");
        }
        const { user } = await verified();
        await completeToReview(user, { civilStatus: "DIVORCED" });
        expect(familyCard().getByText(en("f.child1"))).toBeInTheDocument();
        expect(familyCard().queryByText(en("f.spouseName"))).toBeNull();
    });
});

describe("switching to Single", () => {
    test("Married -> Single: the typed spouse and children are hidden, not saved and not sent; Married again shows them", async () => {
        const { user, calls } = await verified();
        await completeToReview(user, { civilStatus: "MARRIED" });
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.family")}` }));
        setField("f.child1", "nimal");
        setField("f.child2", "kasun");
        setField("f.child3", "ruwan");

        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "SINGLE");
        await next(user); // saves Personal Details
        expectNoSpouseOrChildFields();
        await next(user); // saves Work & Family Details
        expect(stepHeading("step.review")).toBeInTheDocument();
        for (const key of [...SPOUSE_FIELDS, ...CHILD_FIELDS]) expect(familyCard().queryByText(en(key)), key).toBeNull();

        const lastWork = bodies(calls, "draft").filter((body) => body.step === "work").at(-1)!;
        expect(lastWork.answers.family).toMatchObject({ spouse: NOBODY, ...NO_CHILDREN });
        for (const body of bodies(calls, "draft").filter((b) => b.step === "personal").slice(-1)) expect(body.answers.basic.civilStatus).toBe("SINGLE");

        // Still in the form: switching back before submitting shows them again.
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.basic")}` }));
        await user.selectOptions(field("f.civilStatus"), "MARRIED");
        await user.click(screen.getByRole("button", { name: en("step.work") }));
        expect(field("f.spouseName")).toHaveValue("NADEESHA");
        expect(field("f.child3")).toHaveValue("RUWAN");

        // Single once more, then submit: nothing of them is sent.
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "SINGLE");
        await user.click(screen.getByRole("button", { name: en("step.review") }));
        await submit(user);
        const [sent] = bodies(calls, "submit");
        expect(sent.answers.family).toMatchObject({ spouse: NOBODY, ...NO_CHILDREN });
        expect(JSON.stringify(sent)).not.toMatch(/NADEESHA|SILVA|NIMAL|KASUN|RUWAN/);
    });
});

describe("loading Single with leftover spouse and child values", () => {
    test("a resumed draft shows them nowhere and submits without them", async () => {
        const { user, calls } = await open(singleWithLeftovers(["personal", "work"]), "step.review");
        for (const key of [...SPOUSE_FIELDS, ...CHILD_FIELDS]) expect(familyCard().queryByText(en(key)), key).toBeNull();
        expect(screen.queryByText("NADEESHA")).toBeNull();
        expect(screen.queryByText("NIMAL")).toBeNull();
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.family")}` }));
        expectNoSpouseOrChildFields();
        await user.click(screen.getByRole("button", { name: en("step.review") }));
        await submit(user);
        const [sent] = bodies(calls, "submit");
        expect(sent.answers.family).toMatchObject({ spouse: NOBODY, ...NO_CHILDREN });
        expect(JSON.stringify(sent)).not.toMatch(/NADEESHA|SILVA|N1111111|NIMAL|KASUN/);
    });

    test("a prefill (first visit) hides them, and saving the step does not send them", async () => {
        const { user, calls } = await open(singleWithLeftovers([]), "step.personal");
        expect(field("f.civilStatus")).toHaveValue("SINGLE");
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        expectNoSpouseOrChildFields();
        await next(user);
        expect(stepHeading("step.review")).toBeInTheDocument();
        const [work] = bodies(calls, "draft").filter((body) => body.step === "work");
        expect(work.answers.family).toMatchObject({ spouse: NOBODY, ...NO_CHILDREN });
        expect(JSON.stringify(work)).not.toMatch(/NADEESHA|NIMAL|KASUN/);
    });
});
