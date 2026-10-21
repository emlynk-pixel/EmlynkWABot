import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { jobCategoryChoices, jobCategoryLabel } from "../form/options";
import { validateForm } from "../form/validation";
import { emptyForm } from "../form/model";
import { TRANSLATIONS } from "../i18n/translations";
import { callsTo, completeToReview, en, field, fillBasic, fillContact, next, prefill, setField, si, switchLanguage, verified } from "./helpers";

// The Candidate Form's job categories come from Settings > Job Types (sent with
// the form), plus "No Preferred Type" and OTHER (DYNAMIC-JOB-TYPE-003 / 006).
// Synthetic data; the backend is a stub.

const FROM_SERVER = (jobCategories: string[], overrides?: Parameters<typeof prefill>[0]) => ({ status: 200, body: { ...prefill(overrides), jobCategories } });

describe("job categories from Settings > Job Types", () => {
    test("DYNAMIC-JOB-TYPE-003 / 005 the choices are exactly what the server sends (a new type in its own spelling), then No Preferred Type, then Other", async () => {
        const { user } = await verified({}, { form: FROM_SERVER(["Crane Operator", "PLUMBER"]) });
        fillBasic();
        fillContact();
        await next(user);
        const select = field("f.jobCategory");
        expect(within(select).getAllByRole("option").map((o) => [(o as HTMLOptionElement).value, o.textContent])).toEqual([
            ["", expect.any(String)], ["Crane Operator", "Crane Operator"], ["PLUMBER", en("job.PLUMBER")], ["NO_PREFERENCE", "No Preferred Type"], ["OTHER", "Other"],
        ]);
        // Sinhala: translated where a translation exists, the type's own name otherwise.
        await switchLanguage(user, "සිංහල");
        const options = within(screen.getByLabelText(new RegExp(`^${si("f.jobCategory")}`))).getAllByRole("option").map((o) => o.textContent);
        expect(options).toContain("Crane Operator");
        expect(options).toContain(si("job.NO_PREFERENCE"));
        expect(si("job.NO_PREFERENCE")).toMatch(/[඀-෿]/);
    });

    test("DYNAMIC-JOB-TYPE-006 No Preferred Type can be chosen, is shown as its label on the review, and is sent as its code", async () => {
        const { user, calls } = await verified({}, { form: FROM_SERVER(["WELDER TIG", "PLUMBER"]) });
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("form.previous") }));
        setField("f.jobCategory", "NO_PREFERENCE");
        await next(user);
        expect(await screen.findByText("No Preferred Type")).toBeInTheDocument();
        expect(screen.queryByText("NO_PREFERENCE")).toBeNull();
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        await screen.findByRole("heading", { name: en("submitted.title") });
        expect((callsTo(calls, "submit")[0].body as { answers: { qualifications: { jobCategory: string } } }).answers.qualifications.jobCategory).toBe("NO_PREFERENCE");
    });

    test("a prefilled category that is no longer offered (deactivated since) must be chosen again; nothing invalid is sent", async () => {
        const { user } = await verified({}, { form: FROM_SERVER(["PLUMBER"], (a) => { a.qualifications.jobCategory = "GLAZIER"; }) });
        fillBasic();
        fillContact();
        await next(user);
        expect(field("f.jobCategory")).toHaveValue("");
        await next(user);
        expect(field("f.jobCategory")).toHaveAttribute("aria-invalid", "true");
    });

    test("the label helper and the checks use the given list", () => {
        expect(jobCategoryChoices(["A", "OTHER", "NO_PREFERENCE", "B"])).toEqual(["A", "B", "NO_PREFERENCE", "OTHER"]);
        expect(jobCategoryLabel("Crane Operator", TRANSLATIONS.en)).toBe("Crane Operator");
        expect(jobCategoryLabel("NO_PREFERENCE", TRANSLATIONS.en)).toBe("No Preferred Type");
        const data = emptyForm();
        data.qualifications.jobCategory = "Crane Operator";
        expect(validateForm(data, "2026-10-20", jobCategoryChoices(["Crane Operator"]))["qualifications.jobCategory"]).toBeUndefined();
        expect(validateForm(data, "2026-10-20", jobCategoryChoices(["PLUMBER"]))["qualifications.jobCategory"]).toEqual({ key: "v.required" });
    });
});
