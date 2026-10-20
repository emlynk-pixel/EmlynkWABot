import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { parseAdminMobileNumbers } from "../config/env";
import { TRANSLATIONS, type MessageKey } from "../i18n/translations";
import { clearSession } from "../session/tokenStore";
import styles from "../styles.css?raw";
import { backend, callsTo, completeToReview, CONTINUE, continueButton, en, fillVerify, si, stepHeading, verified } from "./helpers";

// "Before you start": after verification and a successful form load, before the
// first editable step. Synthetic data; the backend is a stub.

afterEach(() => vi.unstubAllEnvs());

const RULES: MessageKey[] = [
    "guidelines.rule.accurate", "guidelines.rule.required", "guidelines.rule.na", "guidelines.rule.review", "guidelines.rule.personal", "guidelines.rule.locked",
];
const title = () => screen.findByRole("heading", { level: 1, name: new RegExp(`^${en("guidelines.title")}`) });

// Verifies and stops on the Guidelines page.
async function toGuidelines(routes: Parameters<typeof backend>[0] = {}) {
    const calls = backend(routes);
    render(<App />);
    const user = userEvent.setup();
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: en("verify.submit") }));
    return { user, calls };
}

describe("Before you start (Guidelines)", () => {
    test("GUIDELINES-001 it appears after a successful verification, with focus on its heading; it is not on the verification page", async () => {
        backend();
        render(<App />);
        expect(screen.queryByRole("heading", { name: new RegExp(en("guidelines.title")) })).toBeNull();
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: en("verify.submit") }));
        const heading = await title();
        expect(heading).toHaveAccessibleName(`${en("guidelines.title")}${si("guidelines.title")}`);
        expect(heading).toHaveFocus();
    });

    test("GUIDELINES-002 the editable form does not appear until Continue is pressed", async () => {
        const { calls } = await toGuidelines();
        await title();
        expect(screen.queryByRole("heading", { level: 2, name: en("step.personal") })).toBeNull();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.queryByRole("combobox")).toBeNull();
        expect(callsTo(calls, "form")).toHaveLength(1); // the form is loaded (and the submitted check done) behind it
        expect(callsTo(calls, "submit")).toHaveLength(0);
    });

    test("GUIDELINES-003 / 004 every instruction is shown in English AND Sinhala together, as a numbered list", async () => {
        await toGuidelines();
        await title();
        const list = screen.getByRole("list");
        expect(list.tagName).toBe("OL");
        const items = within(list).getAllByRole("listitem");
        expect(items).toHaveLength(RULES.length + 1);
        for (const key of [...RULES, "guidelines.intro" as const]) {
            expect(screen.getByText(TRANSLATIONS.en[key])).toHaveAttribute("lang", "en");
            expect(screen.getByText(TRANSLATIONS.si[key])).toHaveAttribute("lang", "si");
        }
        expect(screen.getByText(en("guidelines.rule.accurate"))).toHaveTextContent("Fill in your information carefully and make sure it is correct.");
        expect(screen.getByText(en("guidelines.rule.personal"))).toHaveTextContent("Do not share it with another person.");
        expect(screen.getByText(en("guidelines.rule.locked"))).toHaveTextContent(/Passport Number and NIC may be locked/);
        // No language switch needed: the page shows both whichever language is selected.
        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    });

    test("GUIDELINES-005 the one-time submission warning is shown in both languages, marked with a word (not colour alone)", async () => {
        await toGuidelines();
        await title();
        const warning = screen.getByRole("note");
        expect(warning).toHaveTextContent(en("guidelines.warning.title"));
        expect(warning).toHaveTextContent(si("guidelines.warning.title"));
        expect(warning).toHaveTextContent("You can submit this form only once. After submission, you cannot edit or submit it again.");
        expect(warning).toHaveTextContent(si("guidelines.warning.text"));
    });

    test("GUIDELINES-006 the N/A rule is shown in both languages", async () => {
        await toGuidelines();
        await title();
        expect(screen.getByText('If a field does not apply to you, enter "N/A" where allowed.')).toBeInTheDocument();
        expect(screen.getByText(si("guidelines.rule.na"))).toHaveTextContent("N/A");
    });

    test("GUIDELINES-007 the configured admin numbers (VITE_API_ADMIN_MOBILE_NUMBERS) are shown as plain text, with the matching help line", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", " 0771234567 , +94 71 234 5678 ");
        await toGuidelines();
        await title();
        expect(screen.getByText("0771234567")).toBeInTheDocument();
        expect(screen.getByText("+94 71 234 5678")).toBeInTheDocument();
        expect(screen.getByText(new RegExp(en("guidelines.numbers")))).toBeInTheDocument();
        expect(screen.getByText(en("guidelines.rule.helpNumbers"))).toBeInTheDocument();
        // Display only: no call, WhatsApp or other link.
        expect(screen.queryAllByRole("link")).toHaveLength(0);
    });

    test("GUIDELINES-008 with no numbers configured (unset, empty or only commas) there is no numbers section and no empty list", async () => {
        // Unset: the parser gives no numbers (the UI cases below use an explicit value, so a
        // developer's own .env.local cannot change the result).
        expect(parseAdminMobileNumbers(undefined)).toEqual([]);
        for (const value of ["", " , , "]) {
            vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", value);
            const { calls } = await toGuidelines();
            await title();
            expect(document.querySelector(".contact-numbers")).toBeNull();
            expect(screen.queryByText(new RegExp(en("guidelines.numbers")))).toBeNull();
            expect(screen.getByText(en("guidelines.rule.help"))).toBeInTheDocument();
            expect(screen.queryByText(en("guidelines.rule.helpNumbers"))).toBeNull();
            expect(calls.length).toBeGreaterThan(0);
            document.body.innerHTML = "";
            vi.unstubAllEnvs();
        }
    });

    test("GUIDELINES-009 Continue opens the first Candidate Form step with the prefill, and the Guidelines page is gone", async () => {
        const { user } = await toGuidelines();
        await title();
        await user.click(continueButton());
        expect(await screen.findByRole("heading", { level: 2, name: en("step.personal") })).toBeInTheDocument();
        expect(screen.getByLabelText(new RegExp(`^${en("f.surname")}`))).toHaveValue("PERERA");
        expect(screen.queryByRole("heading", { level: 1, name: new RegExp(`^${en("guidelines.title")}`) })).toBeNull();
        expect(continueButton).toThrow();
    });

    test("GUIDELINES-010 an already-submitted candidate never sees the Guidelines (verify 409, or form load 409): the existing submitted / Contact Admin screen wins", async () => {
        for (const routes of [{ verify: { status: 409, body: { message: "x", code: "ALREADY_SUBMITTED" } } }, { form: { status: 409, body: { message: "x", code: "ALREADY_SUBMITTED" } } }] as const) {
            await toGuidelines(routes);
            expect(await screen.findByRole("heading", { level: 1, name: en("contact.title") })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: CONTINUE })).toBeNull();
            expect(screen.queryByRole("heading", { name: new RegExp(en("guidelines.title")) })).toBeNull();
            document.body.innerHTML = "";
        }
        // A wrong candidate (generic 401) stays on verification: no Guidelines.
        await toGuidelines({ verify: { status: 401, body: { code: "VERIFICATION_FAILED" } } });
        expect(await screen.findByText(en("verify.failed"))).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: CONTINUE })).toBeNull();
    });

    test("GUIDELINES-010b after submitting, the thank-you screen is final: no Guidelines, no Continue, no form", async () => {
        const { user, calls } = await verified();
        expect(stepHeading("step.personal")).toBeInTheDocument();
        await completeToReview(user);
        await user.click(screen.getByRole("button", { name: en("review.save") }));
        await user.click(screen.getByRole("button", { name: en("review.confirmSubmit") }));
        expect(await screen.findByRole("heading", { name: en("submitted.title") })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: CONTINUE })).toBeNull();
        expect(screen.queryByRole("heading", { name: new RegExp(en("guidelines.title")) })).toBeNull();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(callsTo(calls, "submit")).toHaveLength(1);
    });

    test("GUIDELINES-011 a session that ended while on the Guidelines page sends Continue back to verification (no form, no crash)", async () => {
        const { user, calls } = await toGuidelines();
        await title();
        clearSession(); // as after a reload or the 60-minute expiry: the token lived in memory only
        await user.click(continueButton());
        expect(await screen.findByRole("heading", { name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByText(en("session.ended"))).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 2, name: en("step.personal") })).toBeNull();
        expect(callsTo(calls, "submit")).toHaveLength(0);
    });

    test("GUIDELINES-012 mobile layout: one column, a full-width Continue, numbers wrap, nothing forces horizontal scroll", () => {
        const rule = (selector: string) => styles.match(new RegExp(`(^|\\n)${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[2] ?? "";
        expect(rule("button.primary, button.secondary")).toMatch(/width:\s*100%/);
        expect(rule(".guidelines-list")).toMatch(/flex-direction:\s*column/);
        expect(rule(".contact-number")).toMatch(/word-break:\s*break-all/);
        expect(styles).not.toMatch(/\.guidelines[^{]*\{[^}]*(white-space:\s*nowrap|min-width:\s*\d{3,}px|width:\s*\d{3,}px)/);
    });
});
