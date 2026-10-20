import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { buildMetaContentSecurityPolicy } from "../../csp";
import { setAt } from "../form/binding";
import { emptyForm, toPayload, type CandidateFormData } from "../form/model";
import { SHOE_SIZE_GUIDE, SHOE_SIZE_PRESETS, SHIRT_SIZES } from "../form/options";
import { NOT_APPLICABLE_FIELDS, requiredPaths, validateForm, visiblePaths } from "../form/validation";
import { TRANSLATIONS } from "../i18n/translations";
import styles from "../styles.css?raw";
import {
    callsTo, completeToReview, en, field, fillBasic, fillContact, fillFamily, fillGuardian, fillPassport, next, prefill, queryField, setField, si,
    stepHeading, switchLanguage, verified,
} from "./helpers";

// All answers required, "N/A" only where it is allowed, conditional sections,
// the size guides and the Sinhala font. Synthetic data; the backend is a stub.

const TODAY = "2026-10-20";

// A complete, valid form (every answer, N/A where allowed).
function validData(): CandidateFormData {
    const data = emptyForm();
    data.basic = { fullName: "SHAMAL SATHSARA", surname: "SATHSARA", otherNames: "N/A", sex: "MALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "COLOMBO" };
    data.contact = { address: "12 MAIN STREET", city: "COLOMBO", district: "COLOMBO", dsDivision: "KOLONNAWA", gnDivision: "KOLONNAWA NORTH", alternativePhone: "n/a", email: "a@example.com" };
    data.passport = { issueDate: "2020-01-15", expiryDate: "2030-01-14" };
    data.qualifications = { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "N/A", otherSkills1: "N/A", otherSkills2: "N/A", englishKnowledge: "GOOD" };
    data.measurements = { shirtSize: "M", waistSize: "32", shoeSize: "9" };
    data.family.father = { name: "N/A", surname: "", passportNumber: "", birthDate: "" };
    data.family.mother = { name: "KUMARI", surname: "PERERA", passportNumber: "N/A", birthDate: "1965-02-03" };
    data.family.child1 = "N/A";
    data.guardian = { name: "KAMAL PERERA", relationship: "UNCLE", nic: "901234567V", birthDate: "1960-01-01", phone: "0771234567", address: "45 LAKE ROAD" };
    return data;
}
const errorsOf = (data: CandidateFormData) => validateForm(data, TODAY);

// Nothing prefilled: every answer starts empty.
const EMPTY_PREFILL = prefill((answers) => {
    answers.basic.surname = null;
    answers.basic.otherNames = null;
    answers.basic.sex = null;
});
const editableControls = () => [...document.querySelectorAll<HTMLElement>(".step-panel input:not([readonly]):not([type=radio]), .step-panel select, .step-panel textarea")];

describe("all answers are required", () => {
    test("a complete form has no problems, and every visible answer is required (except later children with no earlier child)", () => {
        expect(errorsOf(validData())).toEqual({});
        const data = validData();
        const visible = visiblePaths(data);
        const optional = visible.filter((path) => !requiredPaths(data).includes(path));
        // Father = N/A (his other answers are not needed); Child 1 = N/A (no later children).
        expect(optional.sort()).toEqual(["family.child2", "family.child3", "family.father.birthDate", "family.father.passportNumber", "family.father.surname"]);
    });

    test("FORM-REQ-001 every visible editable answer blocks Next while empty (Personal Details, then Work & Family Details)", async () => {
        const { user } = await verified({}, { form: { status: 200, body: EMPTY_PREFILL } });
        await next(user);
        expect(stepHeading("step.personal")).toBeInTheDocument();
        const personal = editableControls();
        expect(personal.length).toBe(14);
        for (const control of personal) expect(control, control.id).toHaveAttribute("aria-invalid", "true");

        fillBasic();
        setField("f.otherNames", "N/A");
        fillContact();
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        // Every editable control on the step is invalid except the later children (Child 1 is still empty).
        const notBlocking = editableControls().filter((control) => control.getAttribute("aria-invalid") !== "true").map((control) => control.id);
        expect(notBlocking.sort()).toEqual(["family-child2", "family-child3"]);
        // English Knowledge (a group of choices) is required too.
        expect(screen.getByRole("group", { name: new RegExp(en("f.englishKnowledge")) })).toHaveAccessibleDescription(new RegExp(en("v.required")));
    });

    test("FORM-REQ-002 the required message is inline, under each field, linked to it, in the current language; the top says it once", async () => {
        const { user } = await verified({}, { form: { status: 200, body: EMPTY_PREFILL } });
        expect(screen.getByText(en("form.allRequired"))).toBeInTheDocument();
        await next(user);
        expect(field("f.birthPlace")).toHaveAccessibleDescription(new RegExp(en("v.required")));
        expect(field("f.city")).toHaveAccessibleDescription(new RegExp(en("v.required")));
        // Required mark is text (* and a hidden "required"), not colour alone.
        expect(screen.getByLabelText(new RegExp(`^${en("f.city")} \\* \\(required\\)`))).toBeInTheDocument();
        await switchLanguage(user, "සිංහල");
        expect(screen.getAllByText(si("v.required")).length).toBe(14);
        expect(screen.getByText(si("form.allRequired"))).toBeInTheDocument();
    });

    test("FORM-REQ-003 the first invalid answer in page order is focused (Personal Details: Full Name; Work & Family Details: Passport Issue Date)", async () => {
        const { user } = await verified({}, { form: { status: 200, body: EMPTY_PREFILL } });
        await next(user);
        await waitFor(() => expect(field("f.fullName")).toHaveFocus());
        fillBasic();
        setField("f.otherNames", "N/A");
        fillContact();
        await next(user);
        await next(user);
        await waitFor(() => expect(field("f.passportIssueDate")).toHaveFocus());
        // Fill everything but one measurement: that one is focused.
        await fillPassport(user);
        fillFamily();
        fillGuardian();
        setField("f.shirtSize", "M");
        setField("f.waistSize", "32");
        await next(user);
        await waitFor(() => expect(field("f.shoeSize")).toHaveFocus());
    });

    test("FORM-REQ-004 N/A (any letter case) is accepted where allowed, and sent as N/A", async () => {
        const data = validData();
        for (const path of NOT_APPLICABLE_FIELDS) {
            const base = structuredClone(data);
            if (path.startsWith("family.spouse.")) {
                base.basic.civilStatus = "MARRIED";
                base.family.spouse = { name: "NADEESHA", surname: "SILVA", passportNumber: "N/A", birthDate: "1992-07-08" };
            }
            for (const spelling of ["N/A", "n/a", "N/a", "n/A", " n/a "]) {
                expect(errorsOf(setAt(base, path, spelling)), `${path} = ${spelling}`).toEqual({});
            }
        }
        const sent = toPayload(validData());
        expect(sent.contact.alternativePhone).toBe("N/A"); // typed "n/a" in a field that is not capitalised
        expect([sent.basic.otherNames, sent.family.child1, sent.family.mother.passportNumber]).toEqual(["N/A", "N/A", "N/A"]);
    });

    test("FORM-REQ-004b in the form: n/a typed in the alternative number is accepted (no phone error)", async () => {
        const { user } = await verified();
        fillBasic();
        fillContact();
        setField("f.alternativePhone", "");
        await user.type(field("f.alternativePhone"), "n/a");
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
    });

    test("FORM-REQ-005 N/A is refused where a real answer is needed (names, places, address, sizes, the guardian, the spouse's name, dates)", async () => {
        const refused = [
            "basic.fullName", "basic.surname", "basic.birthPlace", "contact.address", "contact.district", "contact.dsDivision", "contact.gnDivision",
            "measurements.waistSize", "measurements.shoeSize", "guardian.name", "guardian.relationship", "guardian.address",
        ];
        for (const path of refused) {
            expect(NOT_APPLICABLE_FIELDS.has(path), path).toBe(false);
            const copy = structuredClone(validData());
            const [group, key] = path.split(".") as [keyof CandidateFormData, string];
            (copy[group] as Record<string, string>)[key] = "n/a";
            expect(errorsOf(copy)[path], path).toEqual({ key: "v.notApplicableRefused" });
        }
        // Formatted answers: N/A is never a NIC, phone, email or date.
        for (const [path, set] of [
            ["guardian.nic", (d: CandidateFormData) => { d.guardian.nic = "N/A"; }],
            ["guardian.phone", (d: CandidateFormData) => { d.guardian.phone = "N/A"; }],
            ["contact.email", (d: CandidateFormData) => { d.contact.email = "N/A"; }],
            ["guardian.birthDate", (d: CandidateFormData) => { d.guardian.birthDate = "N/A"; }],
            ["family.mother.birthDate", (d: CandidateFormData) => { d.family.mother.birthDate = "N/A"; }],
        ] as const) {
            const copy = structuredClone(validData());
            set(copy);
            expect(errorsOf(copy)[path], path).toBeDefined();
        }
        const married = structuredClone(validData());
        married.basic.civilStatus = "MARRIED";
        married.family.spouse = { name: "N/A", surname: "N/A", passportNumber: "N/A", birthDate: "1992-07-08" };
        expect(errorsOf(married)["family.spouse.name"]).toEqual({ key: "v.notApplicableRefused" });
        expect(errorsOf(married)["family.spouse.surname"]).toEqual({ key: "v.notApplicableRefused" });
        expect(errorsOf(married)["family.spouse.passportNumber"]).toBeUndefined();

        // In the form: the message is shown on the field, and Next is blocked.
        const { user } = await verified();
        fillBasic();
        fillContact();
        setField("f.birthPlace", "N/A");
        await next(user);
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(field("f.birthPlace")).toHaveAccessibleDescription(new RegExp(en("v.notApplicableRefused")));
        // The verified Passport Number and NIC are read-only: nothing to type there at all.
        expect(field("f.nic")).toHaveAttribute("readonly");
    });

    test("FORM-REQ-006 hidden or not-applicable sections never block: spouse unless Married, Other Job Category unless OTHER, a parent named N/A, children after N/A", () => {
        const data = validData();
        // Stale, invalid hidden answers: a spouse typed before switching to Single, an old "other" category.
        data.family.spouse = { name: "N/A", surname: "", passportNumber: "bad passport!!", birthDate: "not a date" };
        data.qualifications.jobCategoryOther = "N/A";
        expect(errorsOf(data)).toEqual({});
        const sent = toPayload(data);
        expect(sent.family.spouse).toEqual({ name: null, surname: null, passportNumber: null, birthDate: null });
        expect(sent.qualifications.jobCategoryOther).toBeNull();
        // Father = N/A: his surname, passport and birth date may stay empty.
        expect(requiredPaths(data)).not.toContain("family.father.birthDate");
        // Child 1 = N/A: Child 2 and 3 are not needed.
        expect(requiredPaths(data)).not.toContain("family.child2");
    });

    test("FORM-REQ-007 shown sections become required: Married -> spouse, OTHER -> Other Job Category, a real parent -> their details, a real child -> the next child", async () => {
        const data = validData();
        data.basic.civilStatus = "MARRIED";
        data.qualifications.jobCategory = "OTHER";
        data.family.father = { name: "SUNIL", surname: "", passportNumber: "", birthDate: "" };
        data.family.child1 = "NIMAL";
        const errors = errorsOf(data);
        for (const path of ["family.spouse.name", "family.spouse.surname", "family.spouse.passportNumber", "family.spouse.birthDate", "qualifications.jobCategoryOther",
            "family.father.surname", "family.father.passportNumber", "family.father.birthDate", "family.child2"]) {
            expect(errors[path], path).toEqual({ key: "v.required" });
        }
        expect(errors["family.child3"]).toBeUndefined();
        data.family.child2 = "KASUN";
        expect(errorsOf(data)["family.child3"]).toEqual({ key: "v.required" });

        // In the form: the required mark follows the condition.
        const { user } = await verified();
        fillBasic("MARRIED");
        fillContact();
        await next(user);
        expect(field("f.spouseName")).toBeRequired();
        expect(field("f.fatherSurname")).toBeRequired();
        setField("f.fatherName", "n/a");
        expect(field("f.fatherSurname")).not.toBeRequired();
        expect(field("f.fatherBirthDate")).not.toBeRequired();
        setField("f.jobCategory", "OTHER");
        expect(field("f.jobCategoryOther")).toBeRequired();
    });

    test("FORM-REQ-008 Submit re-checks the WHOLE form: an answer cleared after its step was passed blocks the submit, and nothing is sent", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        // Back to Personal Details through the step list (no Next), clear an answer, jump to the review.
        await user.click(screen.getByRole("button", { name: en("step.personal") }));
        setField("f.city", "");
        await user.click(screen.getByRole("button", { name: en("step.review") }));
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        expect(screen.getByText(en("review.problems"))).toBeInTheDocument();
        expect(screen.getByRole("button", { name: en("review.goTo").replace("{section}", en("step.personal")) })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: en("review.confirmSubmit") })).toBeNull();
        expect(callsTo(calls, "submit")).toHaveLength(0);
    });
});

describe("size guides", () => {
    const openWork = async () => {
        const { user } = await verified();
        fillBasic();
        fillContact();
        await next(user);
        return user;
    };

    test("SHOE-GUIDE-001 a Size guide link under Shoe Size opens a compact UK / EU table; Escape or Close closes it and returns to the link", async () => {
        const user = await openWork();
        const toggles = screen.getAllByRole("button", { name: en("guide.open") });
        expect(toggles).toHaveLength(2); // shirt and shoe
        const shoeToggle = toggles[1];
        expect(shoeToggle).toHaveAttribute("aria-expanded", "false");
        await user.click(shoeToggle);
        expect(shoeToggle).toHaveAttribute("aria-expanded", "true");
        const panel = screen.getByRole("region", { name: en("guide.shoe.title") });
        const rows = within(panel).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
        expect(rows).toEqual(SHOE_SIZE_GUIDE.map((row) => [row.uk, row.eu]));
        expect(within(panel).getByRole("columnheader", { name: en("guide.shoe.eu") })).toBeInTheDocument();
        expect(within(panel).getByText(en("guide.shoe.note"))).toBeInTheDocument();
        // Keyboard: Escape closes and puts focus back on the link.
        within(panel).getByRole("button", { name: en("guide.close") }).focus();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("region", { name: en("guide.shoe.title") })).toBeNull();
        expect(shoeToggle).toHaveFocus();
        await user.keyboard("{Enter}");
        await user.click(screen.getByRole("button", { name: en("guide.close") }));
        expect(screen.queryByRole("region", { name: en("guide.shoe.title") })).toBeNull();
    });

    test("SHOE-GUIDE-002 the stored shoe size keeps its meaning: the list is UK sizes, the guide never changes the answer, Other still takes any size", async () => {
        expect(SHOE_SIZE_GUIDE.map((row) => row.uk)).toEqual([...SHOE_SIZE_PRESETS]);
        expect(SHOE_SIZE_PRESETS).toEqual(["5", "6", "7", "8", "9", "10", "11", "12", "13"]);
        const user = await openWork();
        setField("f.shoeSize", "9");
        await user.click(screen.getAllByRole("button", { name: en("guide.open") })[1]);
        expect(field("f.shoeSize")).toHaveValue("9");
        const data = validData();
        expect(toPayload(data).measurements.shoeSize).toBe("9");
        data.measurements.shoeSize = "EU 43";
        expect(errorsOf(data)).toEqual({});
        expect(toPayload(data).measurements.shoeSize).toBe("EU 43");
    });

    test("SHIRT-GUIDE-001 a Size guide under Shirt Size names every size (XS to XXL), in the current language, with no invented measurements", async () => {
        const user = await openWork();
        await user.click(screen.getAllByRole("button", { name: en("guide.open") })[0]);
        const panel = screen.getByRole("region", { name: en("guide.shirt.title") });
        for (const size of SHIRT_SIZES) {
            expect(within(panel).getByText(size)).toBeInTheDocument();
            expect(within(panel).getByText(en(`shirt.${size}`))).toBeInTheDocument();
        }
        expect(panel.textContent).not.toMatch(/\d+\s*(cm|in|inch)/i);
        await switchLanguage(user, "සිංහල");
        expect(within(screen.getByRole("region", { name: si("guide.shirt.title") })).getByText(si("shirt.XXL"))).toBeInTheDocument();
    });
});

describe("Sinhala font", () => {
    test("FONT-001 Noto Sans Sinhala is self-hosted for Sinhala characters only, with swap and system fallbacks; nothing loads from another site", () => {
        const face = styles.match(/@font-face\s*\{[^}]*\}/)?.[0] ?? "";
        expect(face).toMatch(/font-family:\s*"Emlynk Sinhala"/);
        expect(face).toMatch(/src:\s*url\("\/fonts\/noto-sans-sinhala-sinhala-400-700\.woff2"\) format\("woff2"\)/);
        expect(face).toMatch(/unicode-range:[^;]*U\+0D81-0DF4/);
        expect(face).toMatch(/unicode-range:[^;]*U\+200C-200D/); // ZWJ / ZWNJ for conjuncts
        expect(face).toMatch(/font-display:\s*swap/);
        expect(face).toMatch(/font-weight:\s*400 700/);
        expect(styles).toMatch(/font-family:\s*"Emlynk Sinhala", system-ui,[^;]*"Noto Sans Sinhala", "Iskoola Pota", "Nirmala UI", "Sinhala Sangam MN", sans-serif;/);
        expect(styles).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import/);
        // The font file and its licence ship with the app (static/ is copied as-is).
        const shipped = Object.keys(import.meta.glob("../../static/fonts/*", { query: "?url", eager: true }));
        expect(shipped.sort()).toEqual(["../../static/fonts/OFL.txt", "../../static/fonts/noto-sans-sinhala-sinhala-400-700.woff2"]);
        // The page policy still allows fonts only from the app itself.
        expect(buildMetaContentSecurityPolicy("https://api.example.test")).toContain("font-src 'self'");
    });

    test("FONT-002 Sinhala texts render as Sinhala (conjuncts keep their zero-width joiner) and the required-field messages switch with the language", async () => {
        const sinhala = /[඀-෿]/;
        for (const key of ["form.allRequired", "v.required", "v.notApplicableRefused", "hint.na", "guide.shoe.title", "guide.shirt.title"] as const) {
            expect(TRANSLATIONS.si[key], key).toMatch(sinhala);
        }
        expect(TRANSLATIONS.si["v.required"]).toBe("මෙම ක්ෂේත්‍රය අනිවාර්ය වේ.");
        expect(TRANSLATIONS.si["form.allRequired"]).toBe("සියලුම ක්ෂේත්‍ර අනිවාර්ය වේ. ඔබට අදාළ නොවන ක්ෂේත්‍ර සඳහා අවසර ඇති තැන්වල 'N/A' ලෙස ඇතුළත් කරන්න.");
        expect(TRANSLATIONS.si["v.required"]).toContain("්‍ර"); // ක්‍ෂේත්‍ර: virama + ZWJ + RA (rakaransaya)
        const { user } = await verified({}, { form: { status: 200, body: EMPTY_PREFILL } });
        await switchLanguage(user, "සිංහල");
        await user.click(screen.getByRole("button", { name: si("form.next") }));
        expect(screen.getAllByText(si("v.required")).length).toBeGreaterThan(0);
        expect(screen.getByText(si("form.allRequired")).textContent).toContain("‍");
        expect(queryField("f.fullName")).toBeNull(); // the labels are in Sinhala now
    });
});

describe("unchanged flows", () => {
    test("FORM-REQ-010 (form side) a complete form still reaches the review and submits once, with N/A sent as N/A", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        await screen.findByRole("heading", { name: en("submitted.title") });
        const [sent] = callsTo(calls, "submit");
        const answers = (sent.body as { answers: ReturnType<typeof toPayload> }).answers;
        expect(answers.contact.alternativePhone).toBe("N/A");
        expect(answers.family.father.name).toBe("N/A");
        expect(answers.measurements).toEqual({ shirtSize: "M", waistSize: "32", shoeSize: "9" });
    });
});
