import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { App } from "../App";
import { emptyForm, isNotApplicableFor, toPayload, type CandidateFormData } from "../form/model";
import { requiredPaths, validateForm } from "../form/validation";
import { TRANSLATIONS } from "../i18n/translations";
import type { CandidateFormPayload, FormLoadResponse } from "../types/api";
import css from "../styles.css?raw";
import {
    backend, callsTo, CONTINUE, completeToReview, en, field, fillBasic, fillContact, fillVerify, next, prefill, queryField, setField, si, stepHeading, switchLanguage, verified,
    type Routes,
} from "./helpers";

// N/A variations, the Sinhala spouse label, the sticky notice, and the saved progress (Next saves
// a step to the server; opening the form again restores it). The backend is a stub: the server's
// own rules are tested in test/candidateFormDraft.test.js.

// A whole valid form, as the server would hold it.
function fullPayload(overrides: (data: CandidateFormData) => void = () => {}): CandidateFormPayload {
    const data = emptyForm();
    data.basic = { fullName: "SHAMAL", surname: "SATHSARA", otherNames: "N/A", sex: "MALE", civilStatus: "SINGLE", birthDate: "1990-05-01", birthPlace: "COLOMBO" };
    data.contact = { address: "12 MAIN STREET", city: "COLOMBO", district: "COLOMBO", dsDivision: "KOLONNAWA", gnDivision: "KOLONNAWA NORTH", alternativePhone: "N/A", email: "shamal@example.com" };
    data.passport = { issueDate: "2020-01-15", expiryDate: "2030-01-14" };
    data.qualifications = { jobCategory: "WELDER TIG", jobCategoryOther: "", experience: "5 YEARS", otherSkills1: "N/A", otherSkills2: "N/A", englishKnowledge: "GOOD" };
    data.measurements = { shirtSize: "M", waistSize: "32", shoeSize: "9" };
    data.family.father.name = "N/A";
    data.family.mother = { name: "KUMARI", surname: "PERERA", passportNumber: "N/A", birthDate: "1965-02-03" };
    data.family.child1 = "N/A";
    data.guardian = { name: "KAMAL PERERA", relationship: "UNCLE", nic: "901234567V", birthDate: "1960-01-01", phone: "0771234567", address: "45 LAKE ROAD" };
    overrides(data);
    return toPayload(data);
}
const PERSONAL = ["basic", "contact"] as const;
const WORK = ["passport", "qualifications", "measurements", "family", "guardian"] as const;

// The form as POST /form returns it for a candidate with `savedSteps` saved: the saved groups hold their answers.
function savedForm(savedSteps: ("personal" | "work")[], overrides: (data: CandidateFormData) => void = () => {}): FormLoadResponse {
    const full = fullPayload(overrides);
    const base = prefill();
    const answers = { ...base.answers } as Record<string, unknown>;
    for (const step of savedSteps) for (const group of step === "personal" ? PERSONAL : WORK) answers[group] = full[group];
    const savedGroups = new Set(savedSteps.flatMap((step) => (step === "personal" ? PERSONAL : WORK)));
    return { ...base, answers: answers as CandidateFormPayload, prefilled: base.prefilled.filter((path) => !savedGroups.has(path.split(".")[0] as never)), savedSteps, draftSavedAt: new Date().toISOString() };
}

// Verifies and continues to the form, which opens on `first` (a step heading).
async function open(routes: Routes = {}, first: "step.personal" | "step.work" | "step.review" = "step.personal", options: Parameters<typeof userEvent.setup>[0] = {}) {
    const calls = backend(routes);
    const view = render(<App />);
    const user = userEvent.setup(options);
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: en("verify.submit") }));
    await user.click(await screen.findByRole("button", { name: CONTINUE }));
    await screen.findByRole("heading", { level: 2, name: en(first) });
    return { user, calls, ...view };
}
const drafts = (calls: ReturnType<typeof backend>) => callsTo(calls, "draft");
const bodyOf = (call: { body: unknown }) => call.body as { step: string; answers: Record<string, Record<string, unknown>> };

describe("N/A variations", () => {
    test("every spelling counts as N/A in the fields that allow it, and is sent as N/A", () => {
        for (const spelling of ["N/A", "n/a", "N/a", "n/A", "NA", "na", "Na", "nA", "  na ", " N/A "]) {
            const data = emptyForm();
            data.basic.otherNames = spelling;
            data.contact.alternativePhone = spelling;
            data.family.father.name = spelling;
            data.family.mother.passportNumber = spelling;
            data.family.child1 = spelling;
            const sent = toPayload(data);
            expect([sent.basic.otherNames, sent.contact.alternativePhone, sent.family.father.name, sent.family.mother.passportNumber, sent.family.child1], spelling).toEqual(["N/A", "N/A", "N/A", "N/A", "N/A"]);
            const errors = validateForm(data);
            for (const path of ["basic.otherNames", "contact.alternativePhone", "family.mother.passportNumber"]) {
                expect(errors[path]?.key, `${spelling} ${path}`).not.toBe("v.notApplicableRefused");
            }
            expect(errors["contact.alternativePhone"], spelling).toBeUndefined();
            expect(errors["family.mother.passportNumber"], spelling).toBeUndefined();
        }
    });

    test("a parent or child answered NA does not apply, exactly like N/A: their other answers are not required", () => {
        const data = emptyForm();
        data.family.father.name = "na";
        data.family.child1 = "NA";
        const required = requiredPaths(data);
        expect(required).not.toContain("family.father.surname");
        expect(required).not.toContain("family.child2");
        data.family.child1 = "NIMAL";
        expect(requiredPaths(data)).toContain("family.child2");
    });

    test("elsewhere only n/a is refused, and a real answer such as Na is kept as typed", () => {
        const data = emptyForm();
        data.basic.surname = "n/a";
        data.guardian.name = "Na";
        data.basic.fullName = "NA";
        const errors = validateForm(data);
        expect(errors["basic.surname"]).toEqual({ key: "v.notApplicableRefused" });
        expect(errors["guardian.name"]?.key).not.toBe("v.notApplicableRefused");
        expect(errors["basic.fullName"]?.key).not.toBe("v.notApplicableRefused");
        const sent = toPayload(data);
        expect([sent.guardian.name, sent.basic.fullName]).toEqual(["Na", "NA"]);
        expect(isNotApplicableFor("basic.surname", "na")).toBe(false);
        expect(isNotApplicableFor("basic.otherNames", "na")).toBe(true);
    });

    test("required fields stay required, and the field's own rules still apply", () => {
        const data = emptyForm();
        data.contact.alternativePhone = "";
        expect(validateForm(data)["contact.alternativePhone"]).toEqual({ key: "v.required" });
        data.contact.alternativePhone = "not a phone";
        expect(validateForm(data)["contact.alternativePhone"]).toEqual({ key: "v.phoneInvalid" });
        data.basic.otherNames = "   ";
        expect(validateForm(data)["basic.otherNames"]).toEqual({ key: "v.required" });
    });

    test("in the form: NA, na and Na pass Next with no error and are saved as N/A", async () => {
        const { user, calls } = await verified();
        fillBasic();
        fillContact();
        setField("f.otherNames", "na");
        setField("f.city", "Na");
        setField("f.alternativePhone", "NA");
        await next(user);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(stepHeading("step.work")).toBeInTheDocument();
        const [save] = drafts(calls);
        expect(bodyOf(save).answers.basic.otherNames).toBe("N/A");
        expect(bodyOf(save).answers.contact.city).toBe("N/A");
        expect(bodyOf(save).answers.contact.alternativePhone).toBe("N/A");
    });

    test("the instruction is unchanged and still recommends only N/A", () => {
        expect(TRANSLATIONS.en["form.allRequired"]).toBe("All fields are required. If a field does not apply to you, enter 'N/A' where allowed.");
        expect(TRANSLATIONS.si["form.allRequired"]).toBe("සියලුම ක්ෂේත්‍ර අනිවාර්ය වේ. ඔබට අදාළ නොවන ක්ෂේත්‍ර සඳහා අවසර ඇති තැන්වල 'N/A' ලෙස ඇතුළත් කරන්න.");
    });
});

describe("the N/A notice stays in view", () => {
    test("it is its own block directly in the form (so it can stick for the whole form), outside the intro, and unchanged", async () => {
        await verified();
        const notice = screen.getByText(en("form.allRequired"));
        expect(notice).toHaveAttribute("id", "form-all-required");
        const block = notice.closest(".sticky-notice") as HTMLElement;
        expect(block).not.toBeNull();
        expect(block.parentElement).toHaveClass("candidate-form");
        expect(notice.closest(".form-intro")).toBeNull();
        expect(screen.getAllByText(en("form.allRequired"))).toHaveLength(1);
        // It comes before the steps and the fields, so it stays above them.
        const steps = screen.getByRole("navigation", { name: en("form.sections") });
        expect(block.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("the style keeps it sticky below the site header, in front of the fields, behind the header, with a solid background", () => {
        const rule = /\.sticky-notice\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(rule).toMatch(/position:\s*sticky/);
        expect(rule).toMatch(/top:\s*var\(--site-header-h/);
        expect(rule).toMatch(/background:\s*var\(--bg\)/);
        const zOf = (selector: RegExp) => Number(/z-index:\s*(\d+)/.exec(selector.exec(css)?.[1] ?? "")?.[1]);
        expect(zOf(/\.sticky-notice\s*\{([^}]*)\}/)).toBeLessThan(zOf(/\.site-header\s*\{([^}]*)\}/));
        expect(zOf(/\.sticky-notice\s*\{([^}]*)\}/)).toBeGreaterThan(0);
        // The steps list that sticks beside the form sits below the notice, not under it.
        expect(css).toMatch(/\.progress-block\s*\{[^}]*top:\s*calc\(var\(--site-header-h[^}]*var\(--form-notice-h/);
    });
});

describe("the Sinhala spouse label", () => {
    test("is exactly සහකරු හෝ සහකාරිය, only on that label", () => {
        expect(TRANSLATIONS.si["family.spouse"]).toBe("සහකරු හෝ සහකාරිය");
        expect(TRANSLATIONS.en["family.spouse"]).toBe("Spouse");
    });

    test("is the Spouse section heading in the Sinhala form (Married), and English is unchanged", async () => {
        const { user } = await verified();
        fillBasic("MARRIED");
        fillContact();
        await next(user);
        expect(screen.getByRole("heading", { level: 4, name: "Spouse" })).toBeInTheDocument();
        await switchLanguage(user, "සිංහල");
        const heading = screen.getByRole("heading", { level: 4, name: "සහකරු හෝ සහකාරිය" });
        expect(heading).toBeInTheDocument();
        // The field names and the rest of the section are untouched.
        expect(within(heading.closest("section")!).getByLabelText(new RegExp(`^${si("f.spouseName")}`))).toBeInTheDocument();
        expect(si("f.spouseName")).toBe("කලත්‍රයාගේ නම");
    });
});

describe("saving a step with Next", () => {
    test("a valid step is checked, saved (that step's sections only), and only then does the form move on", async () => {
        const { user, calls } = await verified();
        expect(drafts(calls)).toHaveLength(0);
        fillBasic();
        fillContact();
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
        const saves = drafts(calls);
        expect(saves).toHaveLength(1);
        const body = bodyOf(saves[0]);
        expect(body.step).toBe("personal");
        expect(Object.keys(body.answers).sort()).toEqual(["basic", "contact"]);
        expect(body.answers.basic.fullName).toBe("SHAMAL");
        expect((saves[0].init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
        // The identity is never part of a save.
        expect(JSON.stringify(body)).not.toMatch(/N1234567|901234567V|94771234567/);
    });

    test("the second step saves its own five sections", async () => {
        const { user, calls } = await verified();
        await completeToReview(user);
        const saves = drafts(calls).map(bodyOf);
        expect(saves.map((save) => save.step)).toEqual(["personal", "work"]);
        expect(Object.keys(saves[1].answers).sort()).toEqual([...WORK].sort());
        expect(saves[1].answers.family).toMatchObject({ child1: "N/A" });
    });

    test("a step that fails the form's checks is neither saved nor left", async () => {
        const { user, calls } = await verified();
        fillBasic();
        await next(user); // Contact is empty
        expect(drafts(calls)).toHaveLength(0);
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(screen.getAllByText(en("v.required")).length).toBeGreaterThan(0);
        expect(field("f.fullName")).toHaveValue("SHAMAL");
    });

    test("nothing is saved while typing, on leaving a field, or while the page just sits there", async () => {
        const { user, calls } = await verified();
        await user.type(field("f.fullName"), "shamal sathsara");
        fireEvent.blur(field("f.fullName"));
        setField("f.surname", "sathsara");
        fillContact();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(drafts(calls)).toHaveLength(0);
        await user.click(screen.getByRole("button", { name: en("form.next") }));
        expect(drafts(calls)).toHaveLength(0); // basic is still incomplete: not even Next saves
    });

    test("when the save fails the step stays, the answers stay, a message says so, and trying again saves and moves on", async () => {
        for (const failure of [{ status: 500, body: { message: "boom" } }, "network"] as const) {
            const { user, calls, unmount } = await open({ draft: (n) => (n === 1 ? failure : { status: 200, body: { savedSteps: ["personal"], savedAt: new Date().toISOString() } }) });
            fillBasic();
            fillContact();
            await next(user);
            expect(await screen.findByText(en("form.saveFailed"))).toBeInTheDocument();
            expect(stepHeading("step.personal")).toBeInTheDocument();
            expect(field("f.fullName")).toHaveValue("SHAMAL");
            expect(field("f.email")).toHaveValue("shamal@example.com");
            expect(screen.getByRole("button", { name: en("form.next") })).toBeEnabled();
            await next(user);
            expect(stepHeading("step.work")).toBeInTheDocument();
            expect(screen.queryByText(en("form.saveFailed"))).toBeNull();
            expect(drafts(calls)).toHaveLength(2);
            unmount();
        }
    });

    test("editing after a failed save clears the message; Previous and the step list are locked only while a save runs", async () => {
        const { user } = await open({ draft: { status: 500, body: {} } });
        fillBasic();
        fillContact();
        await next(user);
        expect(await screen.findByText(en("form.saveFailed"))).toBeInTheDocument();
        setField("f.fullName", "kamal");
        expect(screen.queryByText(en("form.saveFailed"))).toBeNull();
    });

    test("a double click saves once", async () => {
        const { user, calls } = await verified();
        fillBasic();
        fillContact();
        await user.dblClick(screen.getByRole("button", { name: en("form.next") }));
        await screen.findByRole("heading", { level: 2, name: en("step.work") });
        expect(drafts(calls)).toHaveLength(1);
    });

    test("while saving, Next says so and cannot be pressed again", async () => {
        let release: () => void = () => {};
        const { user } = await open();
        const real = globalThis.fetch;
        globalThis.fetch = (async (url: string, init: RequestInit) => {
            if (String(url).endsWith("/draft")) await new Promise<void>((resolve) => { release = resolve; });
            return real(url, init);
        }) as typeof fetch;
        try {
            fillBasic();
            fillContact();
            await user.click(screen.getByRole("button", { name: en("form.next") }));
            const busy = await screen.findByRole("button", { name: en("form.saving") });
            expect(busy).toBeDisabled();
            expect(busy).toHaveAttribute("aria-busy", "true");
            expect(stepHeading("step.personal")).toBeInTheDocument(); // not moved before the server confirms
            release();
            await screen.findByRole("heading", { level: 2, name: en("step.work") });
        } finally {
            globalThis.fetch = real;
        }
    });

    test("revisiting a saved step and pressing Next saves it again with the new answers", async () => {
        const { user, calls } = await verified();
        fillBasic();
        fillContact();
        await next(user);
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        setField("f.birthPlace", "kandy");
        await next(user);
        const saves = drafts(calls).map(bodyOf);
        expect(saves.map((save) => save.step)).toEqual(["personal", "personal"]);
        expect(saves[0].answers.basic.birthPlace).toBe("COLOMBO");
        expect(saves[1].answers.basic.birthPlace).toBe("KANDY");
    });

    test("the server's own objections are shown on the fields, nothing moves, and fixing them works", async () => {
        const { user } = await open({ draft: (n) => (n === 1 ? { status: 400, body: { message: "bad", errors: [{ field: "contact.email", message: "invalid" }] } } : { status: 200, body: { savedSteps: ["personal"], savedAt: new Date().toISOString() } }) });
        fillBasic();
        fillContact();
        await next(user);
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(await screen.findByText(en("v.invalidAnswer"))).toBeInTheDocument();
        setField("f.email", "other@example.com");
        await next(user);
        expect(stepHeading("step.work")).toBeInTheDocument();
    });

    test("an ended session goes back to verification; a submitted form to the closing screen", async () => {
        const ended = await open({ draft: { status: 401, body: { code: "VERIFICATION_REQUIRED" } } });
        fillBasic();
        fillContact();
        await next(ended.user);
        expect(await screen.findByRole("button", { name: en("verify.submit") })).toBeInTheDocument();
        ended.unmount();

        const submitted = await open({ draft: { status: 409, body: { code: "ALREADY_SUBMITTED" } } });
        fillBasic();
        fillContact();
        await next(submitted.user);
        await waitFor(() => expect(screen.queryByRole("button", { name: en("form.next") })).toBeNull());
        expect(screen.queryByRole("heading", { level: 2, name: en("step.personal") })).toBeNull();
    });

    test("the saved steps are not kept in the browser: nothing in storage or the address", async () => {
        const { user } = await verified();
        fillBasic();
        fillContact();
        await next(user);
        expect(Object.keys(window.localStorage).filter((key) => key !== "candidate-form-theme")).toEqual([]);
        expect(window.sessionStorage.length).toBe(0);
        expect(window.location.href).not.toMatch(/SHAMAL/i);
    });
});

describe("recovering saved progress", () => {
    test("with the Personal step saved, the form opens on Work & Family with Personal restored and reachable", async () => {
        const { user } = await open({ form: { status: 200, body: savedForm(["personal"]) } }, "step.work");
        expect(screen.getByText(en("form.restoredBanner"))).toBeInTheDocument();
        const list = within(screen.getByRole("navigation", { name: en("form.sections") }));
        expect(list.getByRole("button", { name: new RegExp(en("step.personal")) })).toBeEnabled();
        expect(list.getByRole("button", { name: new RegExp(en("step.work")) })).toBeEnabled();
        expect(list.getByRole("button", { name: new RegExp(en("step.review")) })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        expect(stepHeading("step.personal")).toBeInTheDocument();
        expect(field("f.fullName")).toHaveValue("SHAMAL");
        expect(field("f.address")).toHaveValue("12 MAIN STREET");
        expect(field("f.email")).toHaveValue("shamal@example.com");
        expect(field("f.otherNames")).toHaveValue("N/A");
    });

    test("with both steps saved it opens on the review with everything restored, and the submit sends the restored answers", async () => {
        const { user, calls } = await open({ form: { status: 200, body: savedForm(["personal", "work"]) } }, "step.review");
        expect(screen.getByText("SHAMAL")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        await screen.findByRole("heading", { level: 1, name: en("submitted.title") });
        const [submit] = callsTo(calls, "submit");
        const body = submit.body as { answers: CandidateFormPayload };
        expect(body.answers).toEqual(fullPayload());
        expect(drafts(calls)).toHaveLength(0); // restoring and submitting save nothing more
    });

    test("restored answers are not replaced by empty defaults: saving the restored step again sends them as they were", async () => {
        const { user, calls } = await open({ form: { status: 200, body: savedForm(["personal"]) } }, "step.work");
        // Work & Family is not saved: empty (nothing on record) and required, as on a first visit.
        expect(field("f.passportIssueDate")).toHaveValue("");
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        expect(field("f.fullName")).toHaveValue("SHAMAL");
        await next(user);
        await screen.findByRole("heading", { level: 2, name: en("step.work") });
        const [save] = drafts(calls).map(bodyOf);
        expect(save.step).toBe("personal");
        expect(save.answers.basic).toEqual(fullPayload().basic);
        expect(save.answers.contact).toEqual(fullPayload().contact);
    });

    test("a candidate with nothing saved starts on the first step with no welcome-back note (also from an older server)", async () => {
        const first = await open({ form: { status: 200, body: { ...prefill(), savedSteps: [], draftSavedAt: null } } });
        expect(screen.queryByText(en("form.restoredBanner"))).toBeNull();
        first.unmount();
        await open({ form: { status: 200, body: prefill() } }); // no savedSteps at all
        expect(screen.queryByText(en("form.restoredBanner"))).toBeNull();
        expect(queryField("f.fullName")).toBeInTheDocument();
    });

    test("what was typed but not saved with Next is not restored after a reload", async () => {
        const first = await open();
        await first.user.type(field("f.fullName"), "typed but never saved");
        expect(field("f.fullName")).toHaveValue("TYPED BUT NEVER SAVED");
        first.unmount();
        // The page was reloaded: the candidate verifies again and the server (nothing saved) answers.
        await open();
        expect(field("f.fullName")).toHaveValue("");
        expect(drafts(first.calls)).toHaveLength(0);
    });

    test("saved steps in Sinhala: the welcome-back note and step names follow the language", async () => {
        const { user } = await open({ form: { status: 200, body: savedForm(["personal"]) } }, "step.work");
        await switchLanguage(user, "සිංහල");
        expect(screen.getByText(si("form.restoredBanner"))).toBeInTheDocument();
    });

    test("both languages carry the new texts", () => {
        for (const key of ["form.saving", "form.saveFailed", "form.restoredBanner", "form.notSavedNotice"] as const) {
            expect(TRANSLATIONS.en[key], key).toBeTruthy();
            expect(TRANSLATIONS.si[key], key).toBeTruthy();
        }
        expect(TRANSLATIONS.en["form.notSavedNotice"]).toContain("Next");
    });
});
