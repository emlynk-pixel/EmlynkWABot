import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { emptyForm, toPayload } from "../form/model";
import { JOB_CATEGORIES, ENGLISH_LEVELS } from "../form/options";
import { toUpperEnglish } from "../form/uppercase";
import { validateForm } from "../form/validation";
import styles from "../styles.css?raw";
import {
    completeToReview, en, field, fillBasic, fillContact, fillGuardian, fillPassport, next, PASSPORT, queryField, setField, si, startsWith,
    stepHeading, switchLanguage, verified, WHATSAPP, type User,
} from "./helpers";

// The Candidate Form: sections, fields, rules, review. Saving is Task 3, so
// nothing here is ever sent after the verification.

const goToStep = async (user: User, step: "contact" | "passport" | "family" | "guardian") => {
    fillBasic(step === "family" ? "MARRIED" : "SINGLE");
    await next(user);
    if (step === "contact") return;
    fillContact();
    await next(user);
    if (step === "passport") return;
    await fillPassport(user);
    await next(user);
    await next(user);
    if (step === "family") return;
    await next(user);
};

describe("sections and fields", () => {
    test("FORM-NEW-001 every section and its fields are there, one section at a time", async () => {
        const { user } = await verified();
        const labels = (keys: Parameters<typeof en>[0][]) => keys.forEach((key) => expect(field(key), key).toBeInTheDocument());
        labels(["f.fullName", "f.surname", "f.otherNames", "f.nic", "f.sex", "f.civilStatus", "f.birthDate", "f.birthPlace"]);
        expect(queryField("f.address")).toBeNull(); // the next section is not on screen yet
        fillBasic("MARRIED");
        await next(user);
        expect(stepHeading("step.contact")).toBeInTheDocument();
        labels(["f.address", "f.city", "f.district", "f.dsDivision", "f.gnDivision", "f.whatsapp", "f.alternativePhone", "f.email"]);
        fillContact();
        await next(user);
        labels(["f.passportNumber", "f.passportIssueDate", "f.passportExpiryDate", "f.jobCategory", "f.experience", "f.otherSkills1", "f.otherSkills2"]);
        expect(screen.getByRole("group", { name: startsWith(en("f.englishKnowledge")) })).toBeInTheDocument();
        await fillPassport(user);
        await next(user);
        labels(["f.shirtSize", "f.waistSize", "f.shoeSize"]);
        await next(user);
        labels(["f.fatherName", "f.fatherSurname", "f.fatherPassport", "f.fatherBirthDate", "f.motherName", "f.motherSurname", "f.motherPassport", "f.motherBirthDate",
            "f.spouseName", "f.spouseSurname", "f.spousePassport", "f.spouseBirthDate", "f.child1", "f.child2", "f.child3"]);
        await next(user);
        labels(["f.guardianName", "f.guardianRelationship", "f.guardianNic", "f.guardianBirthDate", "f.guardianPhone", "f.guardianAddress"]);
    });

    test("FORM-NEW-002 there is no register number, and nothing staff-only, anywhere in the form or the data", async () => {
        const { user } = await verified();
        await completeToReview(user);
        const text = document.body.textContent ?? "";
        for (const word of [/register/i, /allocat/i, /analyst/i, /\bstage/i, /document/i, /internal/i]) expect(text, String(word)).not.toMatch(word);
        expect(JSON.stringify(emptyForm())).not.toMatch(/register|uniqueId|passportId|whatsapp/i);
        expect(JSON.stringify(toPayload(emptyForm()))).not.toMatch(/register|uniqueId|passportId|whatsapp|token/i);
    });

    test("FORM-NEW-003 / FORM-NEW-004 the verified Passport and WhatsApp numbers are shown read-only and can't be changed", async () => {
        const { user } = await verified();
        fillBasic();
        await next(user);
        const whatsapp = field("f.whatsapp");
        expect(whatsapp).toHaveValue(WHATSAPP);
        expect(whatsapp).toHaveAttribute("readonly");
        await user.type(whatsapp, "999");
        expect(whatsapp).toHaveValue(WHATSAPP);
        expect(whatsapp).toHaveAccessibleDescription(startsWith(en("form.verifiedHint")));
        fillContact();
        await next(user);
        const passport = field("f.passportNumber");
        expect(passport).toHaveValue(PASSPORT);
        expect(passport).toHaveAttribute("readonly");
        await user.type(passport, "X");
        expect(passport).toHaveValue(PASSPORT);
    });

    test("FORM-NEW-005 the job categories are exactly the required list, with OTHER last", async () => {
        const { user } = await verified();
        await goToStep(user, "passport");
        const options = within(field("f.jobCategory")).getAllByRole("option").map((option) => (option as HTMLOptionElement).value).filter(Boolean);
        expect(options).toEqual([
            "PLASTER", "BLOCK MASON", "TILER", "SHUTTERING CARPENTER", "BARBENDER", "GYPSUM WORKER", "ALUMINIUM WORKER", "WELDER TIG", "WELDER MIG", "WELDER ARC",
            "PLUMBER", "ELECTRICIAN", "JCB OPERATOR", "EXCAVATOR OPERATOR", "MOTOR GRADER OPERATOR", "BOBCAT OPERATOR", "WHEEL LOADER OPERATOR", "OTHER",
        ]);
        expect(options).toEqual([...JOB_CATEGORIES]);
    });

    test("FORM-NEW-006 / UPPER-005 OTHER opens a required Other Job Category, typed in capitals, sent only with OTHER", async () => {
        const { user } = await verified();
        await goToStep(user, "passport");
        expect(queryField("f.jobCategoryOther")).toBeNull();
        await user.selectOptions(field("f.jobCategory"), "OTHER");
        const other = field("f.jobCategoryOther");
        expect(other).toBeRequired();
        await user.type(other, "scaffolder");
        expect(other).toHaveValue("SCAFFOLDER");
        const data = { ...emptyForm(), qualifications: { ...emptyForm().qualifications, jobCategory: "OTHER", jobCategoryOther: "SCAFFOLDER" } };
        expect(toPayload(data).qualifications.jobCategoryOther).toBe("SCAFFOLDER");
        expect(toPayload({ ...data, qualifications: { ...data.qualifications, jobCategory: "TILER" } }).qualifications.jobCategoryOther).toBeNull();
        expect(validateForm({ ...data, qualifications: { ...data.qualifications, jobCategoryOther: "" } })["qualifications.jobCategoryOther"]?.key).toBe("v.required");
    });

    test("English Knowledge is one choice of six, stored as an English code, labelled in the current language", async () => {
        const { user } = await verified();
        await goToStep(user, "passport");
        const group = screen.getByRole("group", { name: startsWith(en("f.englishKnowledge")) });
        expect(within(group).getAllByRole("radio")).toHaveLength(ENGLISH_LEVELS.length);
        await user.click(within(group).getByRole("radio", { name: en("english.VERY GOOD") }));
        expect(within(group).getByRole("radio", { name: en("english.VERY GOOD") })).toHaveAttribute("value", "VERY GOOD");
        await switchLanguage(user, "සිංහල");
        expect(screen.getByRole("radio", { name: si("english.VERY GOOD") })).toBeChecked();
    });
});

describe("family", () => {
    test("FORM-NEW-007 / 008 / 009 spouse details only for Married; hidden values are kept, and never sent", async () => {
        const { user } = await verified();
        await goToStep(user, "family");
        expect(field("f.spouseName")).toBeInTheDocument();
        await user.type(field("f.spouseName"), "kumari");
        await user.type(field("f.child1"), "nimal");

        // Back to Basic, change to Single: the spouse is hidden, the children stay.
        for (let i = 0; i < 4; i++) await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "SINGLE");
        await user.click(screen.getByRole("button", { name: en("step.family") }));
        expect(stepHeading("step.family")).toBeInTheDocument();
        expect(queryField("f.spouseName")).toBeNull();
        expect(field("f.child1")).toHaveValue("NIMAL");

        // Married again: what was typed is still there.
        for (let i = 0; i < 4; i++) await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "MARRIED");
        await user.click(screen.getByRole("button", { name: en("step.family") }));
        expect(field("f.spouseName")).toHaveValue("KUMARI");

        const single = emptyForm();
        single.basic.civilStatus = "DIVORCED";
        single.family.spouse.name = "KUMARI";
        expect(toPayload(single).family.spouse).toEqual({ name: null, surname: null, passportNumber: null, birthDate: null });
        single.basic.civilStatus = "MARRIED";
        expect(toPayload(single).family.spouse.name).toBe("KUMARI");
    });

    test("the family section is marked important; children are optional", async () => {
        const { user } = await verified();
        await goToStep(user, "family");
        expect(stepHeading("step.family")).toHaveTextContent(en("form.important"));
        expect(screen.getByText(en("family.childrenNote"))).toBeInTheDocument();
        expect(field("f.child1")).not.toBeRequired();
        await next(user);
        expect(stepHeading("step.guardian")).toBeInTheDocument();
    });
});

describe("validation", () => {
    test("Next checks the section: required answers, with the first problem focused; corrections clear the messages", async () => {
        const { user } = await verified();
        await next(user);
        expect(stepHeading("step.basic")).toBeInTheDocument();
        expect(screen.getByText(en("form.fixErrors"))).toBeInTheDocument();
        expect(screen.getAllByText(en("v.required"))).toHaveLength(6);
        expect(field("f.fullName")).toHaveAttribute("aria-invalid", "true");
        fillBasic();
        expect(screen.queryByText(en("v.required"))).toBeNull();
        await next(user);
        expect(stepHeading("step.contact")).toBeInTheDocument();
    });

    test("formats: NIC, email, phone, dates, passport expiry after issue", async () => {
        const { user } = await verified();
        setField("f.nic", "12345");
        setField("f.birthDate", "2999-01-01");
        await next(user);
        expect(screen.getByText(en("v.nicInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("v.dateFuture"))).toBeInTheDocument();
        fillBasic();
        await next(user);
        fillContact();
        setField("f.email", "not-an-email");
        setField("f.alternativePhone", "12");
        await next(user);
        expect(screen.getByText(en("v.emailInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("v.phoneInvalid"))).toBeInTheDocument();
        setField("f.email", "a@b.lk");
        setField("f.alternativePhone", "");
        await next(user);
        await fillPassport(user);
        setField("f.passportExpiryDate", "2019-01-01");
        await next(user);
        expect(screen.getByText(en("v.expiryBeforeIssue"))).toBeInTheDocument();
    });

    test("FORM-NEW-010 guardian name, NIC, phone and address are required and checked", async () => {
        const { user } = await verified();
        await goToStep(user, "guardian");
        expect(stepHeading("step.guardian")).toBeInTheDocument();
        await next(user);
        for (const key of ["f.guardianName", "f.guardianNic", "f.guardianPhone", "f.guardianAddress"] as const) {
            expect(field(key), key).toHaveAttribute("aria-invalid", "true");
            expect(field(key)).toHaveAccessibleDescription(new RegExp(en("v.required")));
        }
        expect(field("f.guardianRelationship")).not.toHaveAttribute("aria-invalid");
        setField("f.guardianNic", "abc");
        setField("f.guardianPhone", "phone");
        expect(screen.getByText(en("v.nicInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("v.phoneInvalid"))).toBeInTheDocument();
        fillGuardian();
        await next(user);
        expect(stepHeading("step.review")).toBeInTheDocument();
    });

    test("LANG validation messages and step text follow the language without losing answers", async () => {
        const { user } = await verified();
        setField("f.fullName", "shamal");
        await next(user);
        expect(screen.getAllByText(en("v.required")).length).toBeGreaterThan(0);
        await switchLanguage(user, "සිංහල");
        expect(screen.getByRole("heading", { level: 2, name: startsWith(si("step.basic")) })).toBeInTheDocument();
        expect(screen.getAllByText(si("v.required")).length).toBeGreaterThan(0);
        expect(screen.queryByText(en("v.required"))).toBeNull();
        expect(screen.getByLabelText(startsWith(si("f.fullName")))).toHaveValue("SHAMAL");
        expect(screen.getByRole("button", { name: si("form.next") })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: si("civil.MARRIED") })).toHaveAttribute("value", "MARRIED");
    });
});

describe("review and save", () => {
    test("FORM-NEW-011 the review shows the candidate's answers by section, with codes as words, and Edit goes back", async () => {
        const { user } = await verified();
        await completeToReview(user, { civilStatus: "SINGLE" });
        const card = (key: Parameters<typeof en>[0]) => screen.getByRole("region", { name: en(key) });
        expect(within(card("review.verifiedIdentity")).getByText(PASSPORT)).toBeInTheDocument();
        expect(within(card("review.verifiedIdentity")).getByText(WHATSAPP)).toBeInTheDocument();
        expect(within(card("step.basic")).getByText("SHAMAL")).toBeInTheDocument();
        expect(within(card("step.basic")).getByText(en("sex.MALE"))).toBeInTheDocument();
        expect(within(card("step.basic")).getByText(en("civil.SINGLE"))).toBeInTheDocument();
        expect(within(card("step.contact")).getByText("shamal@example.com")).toBeInTheDocument();
        expect(within(card("step.passport")).getByText(en("job.WELDER TIG"))).toBeInTheDocument();
        expect(within(card("step.passport")).getByText(en("english.GOOD"))).toBeInTheDocument();
        expect(within(card("step.guardian")).getByText("0771234567")).toBeInTheDocument();
        expect(within(card("step.family")).queryByText(en("f.spouseName"))).toBeNull();
        expect(within(card("step.family")).getAllByText(en("review.empty")).length).toBeGreaterThan(0);
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.contact")}` }));
        expect(stepHeading("step.contact")).toBeInTheDocument();
        expect(field("f.email")).toHaveValue("shamal@example.com");
    });

    test("FORM-NEW-012 Save Details sends nothing and says saving is not connected yet", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        expect(screen.getByText(en("review.devNotice"))).toBeInTheDocument();
        expect(screen.getByText(en("review.notSaved"))).toBeInTheDocument();
        expect(calls).toHaveLength(1); // only the verification
        await switchLanguage(user, "සිංහල");
        expect(screen.getByText(si("review.devNotice"))).toBeInTheDocument();
    });

    test("Save with missing answers lists the sections to fix, with links back", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.guardian")}` }));
        setField("f.guardianAddress", "");
        await user.click(screen.getByRole("button", { name: en("step.review") }));
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        expect(screen.getByText(en("review.problems"))).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: en("review.goTo").replace("{section}", en("step.guardian")) }));
        expect(field("f.guardianAddress")).toHaveAttribute("aria-invalid", "true");
        expect(calls).toHaveLength(1);
    });
});

describe("uppercase", () => {
    test("UPPER-001 lowercase English becomes capitals in the value itself, as it is typed", async () => {
        const { user } = await verified();
        await user.type(field("f.fullName"), "shamal sathsara");
        expect(field("f.fullName")).toHaveValue("SHAMAL SATHSARA");
        expect(toUpperEnglish("shamal sathsara")).toBe("SHAMAL SATHSARA");
    });

    test("typing in the middle keeps the cursor where it was", async () => {
        const { user } = await verified();
        const input = field("f.fullName") as HTMLInputElement;
        await user.type(input, "ac");
        await user.type(input, "b", { initialSelectionStart: 1, initialSelectionEnd: 1 });
        expect(input).toHaveValue("ABC");
        expect(input.selectionStart).toBe(2);
    });

    test("UPPER-002 Sinhala (and digits, punctuation) are left exactly as typed", async () => {
        const { user } = await verified();
        await user.type(field("f.birthPlace"), "කොළඹ 07, colombo");
        expect(field("f.birthPlace")).toHaveValue("කොළඹ 07, COLOMBO");
        expect(toUpperEnglish("ශාමල් sathsara ñ")).toBe("ශාමල් SATHSARA ñ");
    });

    test("UPPER-003 / UPPER-004 email and phone numbers are not changed", async () => {
        const { user } = await verified();
        fillBasic();
        await next(user);
        await user.type(field("f.email"), "Shamal.Sathsara@example.com");
        expect(field("f.email")).toHaveValue("Shamal.Sathsara@example.com");
        await user.type(field("f.alternativePhone"), "+94 77 123 4567");
        expect(field("f.alternativePhone")).toHaveValue("+94 77 123 4567");
    });

    test("identifiers and names elsewhere are capitalised too: NIC, guardian, family", async () => {
        const { user } = await verified();
        await user.type(field("f.nic"), "901234567v");
        expect(field("f.nic")).toHaveValue("901234567V");
        await goToStep(user, "family");
        await user.type(field("f.fatherPassport"), "n7654321");
        expect(field("f.fatherPassport")).toHaveValue("N7654321");
    });
});

describe("accessibility and layout", () => {
    test("A11Y-001 every control has a label; the progress is announced; sections are a navigation list", async () => {
        const { user } = await verified();
        for (const step of [0, 1, 2]) {
            for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
                expect(control.labels?.length ?? 0, `${step}: ${control.id || control.name}`).toBeGreaterThan(0);
            }
            if (step === 0) fillBasic();
            if (step === 1) fillContact();
            await next(user);
        }
        expect(screen.getByRole("progressbar")).toHaveAccessibleName(/^\d+ of 18 required answers completed$/);
        expect(screen.getByRole("navigation", { name: en("form.sections") })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: en("step.passport") })).toHaveAttribute("aria-current", "step");
    });

    test("the step heading takes focus on a new section", async () => {
        const { user } = await verified();
        fillBasic();
        await next(user);
        expect(stepHeading("step.contact")).toHaveFocus();
    });

    test("MOBILE the stylesheet can't overflow a 320px screen: fluid controls, no fixed wide widths, columns only on wider screens", () => {
        const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(css).toMatch(/\.field input:not\(\[type="radio"\]\),\s*\.field select,\s*\.field textarea\s*\{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*min-width: 0;/);
        const base = css.split("@media")[0];
        for (const [, size] of base.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)) expect(Number(size)).toBeLessThanOrEqual(320);
        // Phones: one column of fields.
        expect(base).toMatch(/\.field-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
        expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*\.field-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
        expect(css).toMatch(/overflow-wrap: anywhere/);
        expect(css).toMatch(/button\.primary, button\.secondary \{[^}]*min-height: 48px/);
    });
});
