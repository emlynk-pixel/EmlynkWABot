import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { getSession } from "../session/tokenStore";
import { emptyForm, toPayload } from "../form/model";
import { JOB_CATEGORIES, ENGLISH_LEVELS } from "../form/options";
import { toUpperEnglish } from "../form/uppercase";
import { validateForm } from "../form/validation";
import styles from "../styles.css?raw";
import {
    callsTo, completeToReview, en, field, NIC, fillBasic, fillContact, fillFamily, fillGuardian, fillMeasurements, fillPassport, next, PASSPORT, queryField, setField, si, startsWith,
    sectionHeading, stepHeading, switchLanguage, verified, WHATSAPP, type User,
} from "./helpers";

// The Candidate Form: prefill, sections, fields, rules, review and the one
// submission. The server's own rules are in test/candidateFormShare.test.js.

// Personal Details filled in, on Work & Family Details.
const goToWork = async (user: User, civilStatus = "SINGLE") => {
    fillBasic(civilStatus);
    fillContact();
    await next(user);
    await screen.findByRole("heading", { level: 2, name: startsWith(en("step.work")) });
};

describe("prefill and identity", () => {
    test("PREFILL-001 answers from the candidate's record are filled in and marked 'From your record'; the rest is empty", async () => {
        await verified();
        expect(screen.getByText(en("form.prefilledBanner"))).toBeInTheDocument();
        expect(field("f.surname")).toHaveValue("PERERA");
        expect(field("f.otherNames")).toHaveValue("KAMAL");
        expect(field("f.sex")).toHaveValue("MALE");
        expect(field("f.surname")).toHaveAccessibleDescription(startsWith(en("form.prefilledNote")));
        expect(field("f.fullName")).toHaveValue("");
        expect(field("f.fullName")).not.toHaveAccessibleDescription(startsWith(en("form.prefilledNote")));
    });

    test("PREFILL-002 the NIC (like the Passport and WhatsApp numbers) is the verified identity, read-only", async () => {
        const { user } = await verified();
        const nic = field("f.nic");
        expect(nic).toHaveValue(NIC);
        expect(nic).toHaveAttribute("readonly");
        await user.type(nic, "999");
        expect(nic).toHaveValue(NIC);
    });
});

describe("sections and fields", () => {
    const PERSONAL_FIELDS = ["f.fullName", "f.surname", "f.otherNames", "f.nic", "f.sex", "f.civilStatus", "f.birthDate", "f.birthPlace",
        "f.address", "f.city", "f.district", "f.dsDivision", "f.gnDivision", "f.whatsapp", "f.alternativePhone", "f.email"] as const;
    const WORK_FIELDS = ["f.passportNumber", "f.passportIssueDate", "f.passportExpiryDate", "f.jobCategory", "f.experience", "f.otherSkills1", "f.otherSkills2",
        "f.shirtSize", "f.waistSize", "f.shoeSize",
        "f.fatherName", "f.fatherSurname", "f.fatherPassport", "f.fatherBirthDate", "f.motherName", "f.motherSurname", "f.motherPassport", "f.motherBirthDate",
        "f.spouseName", "f.spouseSurname", "f.spousePassport", "f.spouseBirthDate", "f.child1", "f.child2", "f.child3",
        "f.guardianName", "f.guardianRelationship", "f.guardianNic", "f.guardianBirthDate", "f.guardianPhone", "f.guardianAddress"] as const;

    test("STEP-001 only four journey stages are shown: Verify (done), Personal Details, Work & Family Details, Review & Submit", async () => {
        await verified();
        const nav = screen.getByRole("navigation", { name: en("form.sections") });
        const items = within(nav).getAllByRole("listitem");
        expect(items.map((item) => item.textContent?.replace(/^[\d✓]+/, ""))).toEqual([en("step.verify"), en("step.personal"), en("step.work"), en("step.review")]);
        expect(items[0]).toHaveClass("done");
        expect(items[1]).toHaveClass("current");
        expect(within(items[1]).getByRole("button")).toHaveAttribute("aria-current", "step");
        expect(within(items[0]).queryByRole("button")).toBeNull(); // verification is not repeated
        expect(screen.getByText("Step 2 of 4")).toBeInTheDocument();
        expect(stepHeading("step.personal")).toBeInTheDocument();
    });

    test("STEP-002 / 003 / 010 Basic + Contact are on Personal Details; Passport & Qualifications, Measurements, Family and Guardian on Work & Family Details; no field is missing", async () => {
        const { user } = await verified();
        const present = (keys: readonly Parameters<typeof en>[0][]) => keys.forEach((key) => expect(field(key), key).toBeInTheDocument());
        present(PERSONAL_FIELDS);
        expect(sectionHeading("step.basic")).toBeInTheDocument();
        expect(sectionHeading("step.contact")).toBeInTheDocument();
        expect(queryField("f.passportIssueDate")).toBeNull(); // the next step is not on screen yet
        expect(queryField("f.guardianName")).toBeNull();
        fillBasic("MARRIED");
        fillContact();
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        for (const key of ["step.passport", "step.measurements", "step.family", "step.guardian"] as const) expect(sectionHeading(key), key).toBeInTheDocument();
        present(WORK_FIELDS);
        expect(screen.getByRole("group", { name: startsWith(en("f.englishKnowledge")) })).toBeInTheDocument();
        expect(queryField("f.fullName")).toBeNull();
        // 8 + 8 and 7 + 3 + 15 + 6 = the 47 fields of the former seven steps.
        expect(PERSONAL_FIELDS.length + WORK_FIELDS.length).toBe(47);
        // Only Personal Details, Work & Family Details and the review are steps: the sections are headings, not list items.
        expect(within(screen.getByRole("navigation", { name: en("form.sections") })).getAllByRole("listitem")).toHaveLength(4);
    });

    test("STEP-006 Previous and Next keep every value, including the prefill and a hidden spouse", async () => {
        const { user } = await verified();
        fillBasic("MARRIED");
        fillContact();
        setField("f.alternativePhone", "0771234567");
        await next(user);
        await fillPassport(user);
        setField("f.shirtSize", "M");
        await user.type(field("f.spouseName"), "kumari");
        await user.type(field("f.child1"), "nimal");
        fillGuardian();
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(field("f.fullName")).toHaveValue("SHAMAL");
        expect(field("f.surname")).toHaveValue("SATHSARA");
        expect(field("f.otherNames")).toHaveValue("KAMAL"); // from the record
        expect(field("f.email")).toHaveValue("shamal@example.com");
        expect(field("f.alternativePhone")).toHaveValue("0771234567");
        await next(user);
        expect(field("f.jobCategory")).toHaveValue("WELDER TIG");
        expect(field("f.shirtSize")).toHaveValue("M");
        expect(field("f.spouseName")).toHaveValue("KUMARI");
        expect(field("f.child1")).toHaveValue("NIMAL");
        expect(field("f.guardianPhone")).toHaveValue("0771234567");
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
        await goToWork(user);
        const options = within(field("f.jobCategory")).getAllByRole("option").map((option) => (option as HTMLOptionElement).value).filter(Boolean);
        expect(options).toEqual([
            "PLASTER", "BLOCK MASON", "TILER", "SHUTTERING CARPENTER", "BARBENDER", "GYPSUM WORKER", "ALUMINIUM WORKER", "WELDER TIG", "WELDER MIG", "WELDER ARC",
            "PLUMBER", "ELECTRICIAN", "JCB OPERATOR", "EXCAVATOR OPERATOR", "MOTOR GRADER OPERATOR", "BOBCAT OPERATOR", "WHEEL LOADER OPERATOR", "OTHER",
        ]);
        expect(options).toEqual([...JOB_CATEGORIES]);
    });

    test("FORM-NEW-006 / UPPER-005 OTHER opens a required Other Job Category, typed in capitals, sent only with OTHER", async () => {
        const { user } = await verified();
        await goToWork(user);
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
        await goToWork(user);
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
        await goToWork(user, "MARRIED");
        expect(field("f.spouseName")).toBeInTheDocument();
        await user.type(field("f.spouseName"), "kumari");
        await user.type(field("f.child1"), "nimal");

        // Back to Personal Details, change to Single: the spouse is hidden, the children stay.
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "SINGLE");
        await user.click(screen.getByRole("button", { name: en("step.work") }));
        expect(stepHeading("step.work")).toBeInTheDocument();
        expect(queryField("f.spouseName")).toBeNull();
        expect(field("f.child1")).toHaveValue("NIMAL");

        // Married again: what was typed is still there.
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "MARRIED");
        await user.click(screen.getByRole("button", { name: en("step.work") }));
        expect(field("f.spouseName")).toHaveValue("KUMARI");

        const single = emptyForm();
        single.basic.civilStatus = "DIVORCED";
        single.family.spouse.name = "KUMARI";
        expect(toPayload(single).family.spouse).toEqual({ name: null, surname: null, passportNumber: null, birthDate: null });
        single.basic.civilStatus = "MARRIED";
        expect(toPayload(single).family.spouse.name).toBe("KUMARI");
    });

    test("the family section is marked important; Child 1 is required (N/A for none), later children only after a real one", async () => {
        const { user } = await verified();
        await goToWork(user);
        expect(sectionHeading("step.family")).toHaveTextContent(en("form.important"));
        expect(screen.getByText(en("family.childrenNote"))).toBeInTheDocument();
        expect(field("f.child1")).toBeRequired();
        expect(field("f.child2")).not.toBeRequired();
        setField("f.child1", "nimal");
        expect(field("f.child2")).toBeRequired();
        expect(field("f.child3")).not.toBeRequired();
        setField("f.child2", "N/A");
        expect(field("f.child3")).not.toBeRequired();
        expect(sectionHeading("step.guardian")).toBeInTheDocument();
    });
});

describe("validation", () => {
    test("STEP-008 Next checks the whole step: Basic and Contact required answers, the first problem (in page order) focused; corrections clear the messages", async () => {
        const { user } = await verified();
        await next(user);
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(screen.getByText(en("form.fixErrors"))).toBeInTheDocument();
        // Every answer is required: full name, civil status, birth date, birth place, and all seven
        // contact answers (address, city, district, DS and GN division, alternative number, email).
        // The prefill has the surname, other names and sex.
        expect(screen.getAllByText(en("v.required"))).toHaveLength(11);
        expect(field("f.fullName")).toHaveAttribute("aria-invalid", "true");
        expect(field("f.email")).toHaveAttribute("aria-invalid", "true");
        await waitFor(() => expect(field("f.fullName")).toHaveFocus());
        fillBasic();
        expect(screen.getAllByText(en("v.required"))).toHaveLength(7); // the contact ones remain
        fillContact();
        expect(screen.queryByText(en("v.required"))).toBeNull();
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
    });

    test("STEP-008 a problem only in the Contact section is focused, and a problem in the later sections of Work & Family Details too", async () => {
        const { user } = await verified();
        fillBasic();
        await next(user);
        await waitFor(() => expect(field("f.address")).toHaveFocus()); // Basic is complete: the first problem is the first Contact field
        fillContact();
        await next(user);
        await fillPassport(user);
        await next(user); // the measurements come next in page order
        await waitFor(() => expect(field("f.shirtSize")).toHaveFocus());
        fillMeasurements();
        fillFamily();
        await next(user); // only the Guardian answers are missing
        expect(stepHeading("step.work")).toBeInTheDocument();
        await waitFor(() => expect(field("f.guardianName")).toHaveFocus());
        expect(screen.getAllByText(en("v.required"))).toHaveLength(6);
    });

    test("formats: email, phone, dates, passport expiry after issue", async () => {
        const { user } = await verified();
        setField("f.birthDate", "2999-01-01");
        await next(user);
        expect(screen.getByText(en("v.dateFuture"))).toBeInTheDocument();
        fillBasic();
        fillContact();
        setField("f.email", "not-an-email");
        setField("f.alternativePhone", "12");
        await next(user);
        expect(screen.getByText(en("v.emailInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("v.phoneInvalid"))).toBeInTheDocument();
        setField("f.email", "a@b.lk");
        setField("f.alternativePhone", "N/A");
        await next(user);
        await fillPassport(user);
        fillGuardian();
        setField("f.passportExpiryDate", "2019-01-01");
        await next(user);
        expect(screen.getByText(en("v.expiryBeforeIssue"))).toBeInTheDocument();
    });

    test("FORM-NEW-010 guardian name, NIC, phone and address are required and checked", async () => {
        const { user } = await verified();
        await goToWork(user);
        expect(sectionHeading("step.guardian")).toBeInTheDocument();
        await fillPassport(user);
        await next(user);
        for (const key of ["f.guardianName", "f.guardianRelationship", "f.guardianNic", "f.guardianBirthDate", "f.guardianPhone", "f.guardianAddress"] as const) {
            expect(field(key), key).toHaveAttribute("aria-invalid", "true");
            expect(field(key)).toHaveAccessibleDescription(new RegExp(en("v.required")));
        }
        setField("f.guardianNic", "abc");
        setField("f.guardianPhone", "phone");
        expect(screen.getByText(en("v.nicInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("v.phoneInvalid"))).toBeInTheDocument();
        fillGuardian();
        fillMeasurements();
        fillFamily();
        await next(user);
        expect(stepHeading("step.review")).toBeInTheDocument();
    });

    test("STEP-009 the spouse section follows Civil Status inside the combined step", async () => {
        const { user } = await verified();
        await goToWork(user, "SINGLE");
        expect(queryField("f.spouseName")).toBeNull();
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        await user.selectOptions(field("f.civilStatus"), "MARRIED");
        await next(user);
        expect(field("f.spouseName")).toBeInTheDocument();
        // Shown (Married) = required, like every shown answer.
        expect(field("f.spouseName")).toBeRequired();
        expect(field("f.spouseBirthDate")).toBeRequired();
    });

    test("STEP-011 LANG validation messages and step text follow the language without losing answers", async () => {
        const { user } = await verified();
        setField("f.fullName", "shamal");
        await next(user);
        expect(screen.getAllByText(en("v.required")).length).toBeGreaterThan(0);
        await switchLanguage(user, "සිංහල");
        expect(screen.getByRole("heading", { level: 2, name: startsWith(si("step.personal")) })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: startsWith(si("step.basic")) })).toBeInTheDocument();
        expect(within(screen.getByRole("navigation", { name: si("form.sections") })).getAllByRole("listitem").map((item) => item.textContent?.replace(/^[\d✓]+/, ""))).toEqual([si("step.verify"), si("step.personal"), si("step.work"), si("step.review")]);
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
        expect(within(card("review.verifiedIdentity")).getByText(NIC)).toBeInTheDocument();
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
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(field("f.email")).toHaveValue("shamal@example.com");
        await waitFor(() => expect(sectionHeading("step.contact")).toHaveFocus());
    });

    test("STEP-005 / 007 the review lists every section; Edit opens the combined step that holds it (no seven-step navigation)", async () => {
        const { user } = await verified();
        await completeToReview(user, { civilStatus: "MARRIED" });
        const sections = ["step.basic", "step.contact", "step.passport", "step.measurements", "step.family", "step.guardian"] as const;
        for (const key of sections) expect(screen.getByRole("region", { name: en(key) }), key).toBeInTheDocument();
        expect(within(screen.getByRole("region", { name: en("step.family") })).getByText(en("f.spouseName"))).toBeInTheDocument();
        const stepFor = { "step.basic": "step.personal", "step.contact": "step.personal", "step.passport": "step.work", "step.measurements": "step.work", "step.family": "step.work", "step.guardian": "step.work" } as const;
        for (const key of sections) {
            await user.click(screen.getByRole("button", { name: `Edit ${en(key)}` }));
            expect(stepHeading(stepFor[key]), key).toBeInTheDocument();
            await waitFor(() => expect(sectionHeading(key), key).toHaveFocus());
            expect(within(screen.getByRole("navigation", { name: en("form.sections") })).getAllByRole("listitem")).toHaveLength(4);
            await user.click(screen.getByRole("button", { name: en("step.review") }));
        }
    });

    test("FORM-NEW-012 / SUBMIT-001 Submit asks for confirmation first; 'Not yet' sends nothing", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        const confirm = screen.getByRole("alertdialog", { name: en("review.confirmTitle") });
        expect(confirm).toHaveAccessibleDescription(en("review.confirmText"));
        await user.click(within(confirm).getByRole("button", { name: en("review.confirmCancel") }));
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(callsTo(calls, "submit")).toHaveLength(0);
    });

    test("SUBMIT-002 confirming sends ONE request with the answers (never the identity), then thanks; the session ends", async () => {
        let release: () => void = () => {};
        const { user, calls } = await verified({}, {});
        const real = globalThis.fetch;
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
            if (String(url).endsWith("/submit")) await new Promise<void>((resolve) => { release = resolve; });
            return real(url, init);
        }));
        await completeToReview(user, { civilStatus: "SINGLE" });
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        // While it is sending the button is locked, so a double click can't send twice.
        const sending = screen.getByRole("button", { name: en("review.sending") });
        expect(sending).toBeDisabled();
        await user.click(sending);
        await act(async () => release());
        expect(await screen.findByRole("heading", { level: 1, name: en("submitted.title") })).toBeInTheDocument();
        const submits = callsTo(calls, "submit");
        expect(submits).toHaveLength(1);
        const body = submits[0].body as { answers: Record<string, Record<string, unknown>>; idempotencyKey: string };
        expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
        expect(body.answers.basic.fullName).toBe("SHAMAL");
        expect(body.answers.family.spouse).toEqual({ name: null, surname: null, passportNumber: null, birthDate: null });
        expect(JSON.stringify(body)).not.toMatch(new RegExp(`${PASSPORT}|94771234567|linkSecret|token`));
        expect("nic" in body.answers.basic).toBe(false);
        expect(getSession()).toBeNull();
        expect(screen.queryByRole("button", { name: en("review.save") })).toBeNull();
    });

    test("SUBMIT-003 a failed send is said plainly, keeps the answers, and a retry sends the same submission key", async () => {
        const { user, calls } = await verified({}, { submit: (n) => (n === 1 ? "network" : { status: 200, body: { submittedAt: new Date().toISOString() } }) });
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        expect(await screen.findByText(en("review.sendFailed"))).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 1, name: en("submitted.title") })).toBeNull();
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.basic")}` }));
        expect(field("f.fullName")).toHaveValue("SHAMAL");
        await user.click(screen.getByRole("button", { name: en("step.review") }));
        await user.click(screen.getByRole("button", { name: en("review.tryAgain") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        expect(await screen.findByRole("heading", { level: 1, name: en("submitted.title") })).toBeInTheDocument();
        const keys = callsTo(calls, "submit").map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
    });

    test("SUBMIT-004 already submitted (409): the Contact Admin screen", async () => {
        const { user } = await verified({}, { submit: { status: 409, body: { message: "x", code: "ALREADY_SUBMITTED" } } });
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        expect(await screen.findByRole("heading", { level: 1, name: en("contact.title") })).toBeInTheDocument();
    });

    test("SUBMIT-005 the server's field problems are marked on the fields, in the current language", async () => {
        const { user } = await verified({}, { submit: { status: 400, body: { message: "x", errors: [{ field: "contact.district", code: "invalid", message: "invalid" }] } } });
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        expect(await screen.findByText(en("review.problems"))).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: en("review.goTo").replace("{section}", en("step.personal")) }));
        expect(field("f.district")).toHaveAccessibleDescription(new RegExp(en("v.invalidAnswer")));
        setField("f.district", "gampaha");
        expect(field("f.district")).not.toHaveAttribute("aria-invalid");
    });

    test("SUBMIT-006 an ended session (401) goes back to verification", async () => {
        const { user } = await verified({}, { submit: { status: 401, body: { message: "x", code: "VERIFICATION_REQUIRED" } } });
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        expect(await screen.findByText(en("session.ended"))).toBeInTheDocument();
    });

    test("Save with missing answers lists the sections to fix, with links back", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: `Edit ${en("step.guardian")}` }));
        setField("f.guardianAddress", "");
        await user.click(screen.getByRole("button", { name: en("step.review") }));
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        expect(screen.getByText(en("review.problems"))).toBeInTheDocument();
        expect(screen.queryByRole("alertdialog")).toBeNull();
        await user.click(screen.getByRole("button", { name: en("review.goTo").replace("{section}", en("step.work")) }));
        expect(field("f.guardianAddress")).toHaveAttribute("aria-invalid", "true");
        expect(callsTo(calls, "submit")).toHaveLength(0);
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
        await user.type(field("f.email"), "Shamal.Sathsara@example.com");
        expect(field("f.email")).toHaveValue("Shamal.Sathsara@example.com");
        await user.type(field("f.alternativePhone"), "+94 77 123 4567");
        expect(field("f.alternativePhone")).toHaveValue("+94 77 123 4567");
    });

    test("identifiers and names elsewhere are capitalised too: family passports, the guardian's NIC", async () => {
        const { user } = await verified();
        await goToWork(user, "MARRIED");
        await user.type(field("f.fatherPassport"), "n7654321");
        expect(field("f.fatherPassport")).toHaveValue("N7654321");
        await user.type(field("f.guardianNic"), "901234567v");
        expect(field("f.guardianNic")).toHaveValue("901234567V");
    });
});

describe("accessibility and layout", () => {
    test("A11Y-001 every control has a label; the progress is announced; sections are a navigation list", async () => {
        const { user } = await verified();
        for (const step of [0, 1]) {
            for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
                expect(control.labels?.length ?? 0, `${step}: ${control.id || control.name}`).toBeGreaterThan(0);
            }
            if (step === 0) {
                fillBasic();
                fillContact();
                await next(user);
            }
        }
        expect(screen.getByRole("progressbar")).toHaveAccessibleName(/^\d+ of 39 required answers completed$/);
        expect(screen.getByRole("navigation", { name: en("form.sections") })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: en("step.work") })).toHaveAttribute("aria-current", "step");
    });

    test("the step heading takes focus on a new step", async () => {
        const { user } = await verified();
        fillBasic();
        fillContact();
        await next(user);
        expect(stepHeading("step.work")).toHaveFocus();
    });

    test("STEP-MOBILE the four-stage indicator is a compact row on phones and a list beside the form on wide screens", () => {
        const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
        const base = css.split("@media")[0];
        expect(base).toMatch(/\.step-list \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
        expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*\.step-list \{ display: flex; flex-direction: column/);
        expect(base).not.toMatch(/\.step-name \{[^}]*(position: absolute|clip:)/);
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
