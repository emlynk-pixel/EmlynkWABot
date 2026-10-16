import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { DETAIL_FIELDS, emptyDetails, toPayload, validateDetails } from "../details/model";
import { TRANSLATIONS, type MessageKey } from "../i18n/translations";
import { clearSession, getSession } from "../session/tokenStore";
import styles from "../styles.css?raw";

// The public form end to end in a browser-like document. The backend is a
// stub: nothing leaves the test. Its own rules are tested on the server
// (test/publicCandidateDetails.test.js).

const en = (key: MessageKey) => TRANSLATIONS.en[key];
// A field by the start of its label (a label may end with " * (required)";
// the help button's name, "Help: …", never starts with the label).
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const si = (key: MessageKey) => TRANSLATIONS.si[key];

const TOKEN = "cf1~test-iv~test-ciphertext";
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

type Reply = { status: number; body?: unknown } | "network";

// Stubs fetch with one reply for the verify endpoint and records each request.
function backend(reply: Reply = { status: 200, body: { token: TOKEN, expiresAt: inMinutes(15) } }) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (reply === "network") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }));
    return calls;
}

async function fillVerify(user: ReturnType<typeof userEvent.setup>, passport = "N1234567", whatsapp = "+94771234567") {
    await user.type(screen.getByLabelText(/^(Passport Number|ගමන් බලපත්‍ර අංකය)/), passport);
    await user.type(screen.getByLabelText(/^(WhatsApp Number|WhatsApp අංකය)/), whatsapp);
}

async function verified(options: Parameters<typeof userEvent.setup>[0] = {}) {
    const calls = backend();
    render(<App />);
    const user = userEvent.setup(options);
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: en("verify.submit") }));
    await screen.findByRole("heading", { level: 1, name: en("details.title") });
    return { user, calls };
}

const switchTo = (user: ReturnType<typeof userEvent.setup>, name: "English" | "සිංහල") =>
    user.click(within(screen.getByRole("group", { name: "Language / භාෂාව" })).getByRole("button", { name }));

describe("verification", () => {
    test("UI-001 the verification screen renders: title, both fields, the Verify button, step 1 of 2", () => {
        render(<App />);
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByLabelText(/^Passport Number/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^WhatsApp Number/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
        expect(within(screen.getByRole("list", { name: en("steps.label") })).getByText(en("steps.verify")).closest("li")).toHaveAttribute("aria-current", "step");
    });

    test("UI-002 valid input sends one verify request with the trimmed values, in the body only, without credentials", async () => {
        const { calls } = await verified();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("/api/public/candidate-details/verify");
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ passportNumber: "N1234567", whatsappNumber: "+94771234567" });
        expect(calls[0].init.credentials).toBe("omit");
        expect(calls[0].url).not.toMatch(/N1234567|94771234567/);
    });

    test("invalid input is caught before anything is sent", async () => {
        const calls = backend();
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user, "AB%12", "0771234567");
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(screen.getByText(en("verify.passportInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("verify.whatsappInvalid"))).toBeInTheDocument();
        expect(screen.getByLabelText(/^Passport Number/)).toHaveAttribute("aria-invalid", "true");
        expect(calls).toHaveLength(0);
    });

    test("UI-003 a failed verification shows one generic message, never the server's own text", async () => {
        backend({ status: 401, body: { message: "Server detail that must not be shown", code: "VERIFICATION_FAILED" } });
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(await screen.findByText(en("verify.failed"))).toBeInTheDocument();
        expect(screen.queryByText(/Server detail/)).toBeNull();
        expect(getSession()).toBeNull();
    });

    test.each([
        [{ status: 429, body: { message: "Too many requests" } }, "verify.rateLimited"],
        [{ status: 503, body: { message: "Not available" } }, "verify.unavailable"],
        [{ status: 403, body: { message: "This request is not allowed." } }, "verify.unavailable"],
        [{ status: 400, body: { message: "Invalid input" } }, "verify.invalidInput"],
        [{ status: 500, body: { message: "PrismaClientKnownRequestError: P2024" } }, "error.generic"],
        ["network", "error.network"],
    ] as const)("verification state for %j", async (reply, key) => {
        backend(reply);
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(await screen.findByText(en(key))).toBeInTheDocument();
        expect(screen.queryByText(/Prisma|P2024/)).toBeNull();
    });

    test("loading: the button says Verifying… and the fields are locked while the request runs", async () => {
        let release: (value: Response) => void = () => {};
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(screen.getByRole("button", { name: en("verify.submitting") })).toBeDisabled();
        expect(screen.getByLabelText(/^Passport Number/)).toBeDisabled();
        await act(async () => release(new Response(JSON.stringify({ token: TOKEN, expiresAt: inMinutes(15) }), { status: 200 })));
        expect(await screen.findByRole("heading", { level: 1, name: en("details.title") })).toBeInTheDocument();
    });

    test("UI-004 a successful verification shows the Additional Details screen (step 2), and the typed values are gone", async () => {
        await verified();
        expect(screen.getByText(en("details.verified"))).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Passport Number/)).toBeNull();
        expect(within(screen.getByRole("list", { name: en("steps.label") })).getByText(en("steps.details")).closest("li")).toHaveAttribute("aria-current", "step");
        expect(getSession()?.token).toBe(TOKEN);
    });

    test("UI-005 the token is kept in memory only: not in localStorage, sessionStorage, cookies or the URL", async () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        await verified();
        expect(setItem).not.toHaveBeenCalled();
        expect(window.localStorage.length).toBe(0);
        expect(window.sessionStorage.length).toBe(0);
        expect(document.cookie).not.toContain(TOKEN);
        expect(window.location.href).not.toContain(TOKEN);
        expect(document.body.innerHTML).not.toContain(TOKEN);
    });

    test("UI-006 without a token (a reload, or the session expired) the candidate is back at verification", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await verified({ advanceTimers: vi.advanceTimersByTime });
        clearSession(); // what a reload or the expiry leaves: no token in memory
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByText(en("session.ended"))).toBeInTheDocument();
        // A fresh page load starts at verification, with nothing restored.
        render(<App />);
        expect(screen.getAllByRole("heading", { level: 1, name: en("verify.title") })).toHaveLength(2);
    });

    test("Finish ends the session and returns to verification", async () => {
        const { user } = await verified();
        await user.click(screen.getByRole("button", { name: en("details.finish") }));
        expect(getSession()).toBeNull();
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
    });
});

describe("language", () => {
    test("LANG-001 the default language is English, and the page says so", () => {
        render(<App />);
        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "සිංහල" })).toHaveAttribute("aria-pressed", "false");
        expect(document.documentElement.lang).toBe("en");
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
    });

    test("LANG-002 / LANG-003 switching to Sinhala changes the labels, and switching back restores English", async () => {
        render(<App />);
        const user = userEvent.setup();
        await switchTo(user, "සිංහල");
        expect(document.documentElement.lang).toBe("si");
        expect(screen.getByRole("heading", { level: 1, name: si("verify.title") })).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toBeInTheDocument();
        expect(screen.getByRole("button", { name: si("verify.submit") })).toBeInTheDocument();
        expect(screen.queryByText(en("verify.lead"))).toBeNull();
        await switchTo(user, "English");
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByText(en("verify.lead"))).toBeInTheDocument();
    });

    test("LANG-004 the Passport and WhatsApp numbers typed are kept when the language changes", async () => {
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await switchTo(user, "සිංහල");
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveValue("N1234567");
        expect(screen.getByLabelText(startsWith(si("verify.whatsapp")))).toHaveValue("+94771234567");
        await switchTo(user, "English");
        expect(screen.getByLabelText(/^Passport Number/)).toHaveValue("N1234567");
    });

    test("LANG-005 Additional Details entries are kept when the language changes", async () => {
        const { user } = await verified();
        await user.type(screen.getByLabelText(startsWith(en("field.nameAsInPassport"))), "Anusha De Soysa");
        await user.selectOptions(screen.getByLabelText(en("field.maritalStatus")), "MARRIED");
        await user.type(screen.getByLabelText(startsWith(en("field.wifeFullName"))), "Kumari");
        await user.click(screen.getAllByRole("radio", { name: en("option.yes") })[0]); // father alive
        await switchTo(user, "සිංහල");
        expect(screen.getByLabelText(startsWith(si("field.nameAsInPassport")))).toHaveValue("Anusha De Soysa");
        expect(screen.getByLabelText(si("field.maritalStatus"))).toHaveValue("MARRIED");
        expect(screen.getByRole("option", { name: si("marital.MARRIED") })).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(si("field.wifeFullName")))).toHaveValue("Kumari");
        expect(screen.getAllByRole("radio", { name: si("option.yes") })[0]).toBeChecked();
        expect(screen.getByRole("heading", { level: 1, name: si("details.title") })).toBeInTheDocument();
    });

    test("LANG-006 a validation message changes language without clearing anything", async () => {
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user, "AB%12", "+94771234567");
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(screen.getByText(en("verify.passportInvalid"))).toBeInTheDocument();
        await switchTo(user, "සිංහල");
        expect(screen.getByText(si("verify.passportInvalid"))).toBeInTheDocument();
        expect(screen.queryByText(en("verify.passportInvalid"))).toBeNull();
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveValue("AB%12");
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveAttribute("aria-invalid", "true");
    });

    test("every English message has a Sinhala translation, and no Sinhala text is left in English", () => {
        const keys = Object.keys(TRANSLATIONS.en) as MessageKey[];
        expect(Object.keys(TRANSLATIONS.si).sort()).toEqual([...keys].sort());
        for (const key of keys) {
            expect(TRANSLATIONS.si[key].trim(), key).not.toBe("");
            // Sizes, "WhatsApp", "UK" and examples may stay in Latin script; the sentence itself is Sinhala.
            expect(/[඀-෿]/.test(TRANSLATIONS.si[key]), key).toBe(true);
        }
    });
});

describe("the Additional Details form", () => {
    test("FORM-001 all 19 fields are there (wife fields once Married is chosen)", async () => {
        const { user } = await verified();
        await user.selectOptions(screen.getByLabelText(en("field.maritalStatus")), "MARRIED");
        expect(DETAIL_FIELDS).toHaveLength(19);
        for (const field of DETAIL_FIELDS) {
            const control = document.getElementById(field) ?? document.getElementById(`${field}-yes`);
            expect(control, field).not.toBeNull();
        }
        expect(Object.keys(toPayload(emptyDetails())).sort()).toEqual([...DETAIL_FIELDS].sort());
    });

    test("FORM-002 nothing else about the candidate is on the form: no NIC, nationality, passport dates, stages, allocation, jobs, documents or IDs", async () => {
        const { user } = await verified();
        await user.selectOptions(screen.getByLabelText(en("field.maritalStatus")), "MARRIED");
        const names = [...document.querySelectorAll("input, select, textarea")].map((control) => (control.getAttribute("name") ?? control.id).replace(/-(yes|no)$/, ""));
        expect(new Set(names)).toEqual(new Set(DETAIL_FIELDS));
        const text = document.body.textContent ?? "";
        for (const word of [/\bNIC\b/, /nationality/i, /expiry/i, /issue date/i, /\bstage/i, /allocat/i, /analyst/i, /document/i, /unique id/i, /job type/i]) {
            expect(text, String(word)).not.toMatch(word);
        }
    });

    test("FORM-003 wife fields only with Married; children hidden for Single; hidden entries are kept but never sent", async () => {
        const { user } = await verified();
        const marital = screen.getByLabelText(en("field.maritalStatus"));
        expect(screen.queryByLabelText(startsWith(en("field.wifeFullName")))).toBeNull();
        expect(screen.getByLabelText(en("field.child1Name"))).toBeInTheDocument();

        await user.selectOptions(marital, "MARRIED");
        const wife = screen.getByLabelText(startsWith(en("field.wifeFullName")));
        expect(wife).toBeRequired();
        await user.type(wife, "Kumari");
        await user.type(screen.getByLabelText(en("field.child1Name")), "Nimal");

        await user.selectOptions(marital, "SINGLE");
        expect(screen.queryByLabelText(startsWith(en("field.wifeFullName")))).toBeNull();
        expect(screen.queryByLabelText(en("field.child1Name"))).toBeNull();

        await user.selectOptions(marital, "MARRIED");
        expect(screen.getByLabelText(startsWith(en("field.wifeFullName")))).toHaveValue("Kumari");
        expect(screen.getByLabelText(en("field.child1Name"))).toHaveValue("Nimal");

        const single = { ...emptyDetails(), maritalStatus: "SINGLE", wifeFullName: "Kumari", child1Name: "Nimal" };
        expect(toPayload(single)).toMatchObject({ maritalStatus: "SINGLE", wifeFullName: null, child1Name: null });
        expect(validateDetails(single)).toEqual({});
        const divorced = { ...emptyDetails(), maritalStatus: "DIVORCED", wifeFullName: "Kumari", child1Name: "Nimal" };
        expect(toPayload(divorced)).toMatchObject({ wifeFullName: null, child1Name: "Nimal" });
    });

    test("the server's rules are checked on Save: parent name when alive, wife's name when married, children in order, dates; with a clear message", async () => {
        const { user } = await verified();
        await user.click(screen.getAllByRole("radio", { name: en("option.yes") })[0]); // father alive
        expect(screen.getByLabelText(startsWith(en("field.fatherFullName")))).toBeRequired();
        await user.selectOptions(screen.getByLabelText(en("field.maritalStatus")), "MARRIED");
        await user.type(screen.getByLabelText(en("field.child2Name")), "Kamala");
        await user.click(screen.getByRole("button", { name: en("details.save") }));
        expect(screen.getByText(en("details.fixErrors"))).toBeInTheDocument();
        expect(screen.getAllByText(en("v.required"))).toHaveLength(2);
        expect(screen.getByText(en("v.child2Order"))).toBeInTheDocument();
        expect(validateDetails({ ...emptyDetails(), birthday: "2999-01-01" }).birthday?.key).toBe("v.dateFuture");
        expect(validateDetails({ ...emptyDetails(), birthday: "1899-12-31" }).birthday?.key).toBe("v.dateTooEarly");
        expect(validateDetails({ ...emptyDetails(), birthday: "1996-02-30" }).birthday?.key).toBe("v.dateInvalid");
        // A parent who has passed away needs no name.
        expect(validateDetails({ ...emptyDetails(), fatherAlive: "no" })).toEqual({});

        // Fixing the fields clears the messages as the candidate types.
        await user.type(screen.getByLabelText(startsWith(en("field.fatherFullName"))), "Sunil");
        await user.type(screen.getByLabelText(startsWith(en("field.wifeFullName"))), "Kumari");
        await user.type(screen.getByLabelText(en("field.child1Name")), "Nimal");
        expect(screen.queryByText(en("v.required"))).toBeNull();
        await user.click(screen.getByRole("button", { name: en("details.save") }));
        expect(screen.getByText(en("details.checkPassed"))).toBeInTheDocument();
    });

    test("Save never pretends to save: nothing is sent, and the form says saving is not available yet", async () => {
        const { user, calls } = await verified();
        expect(screen.getByText(startsWith(en("details.saveNotice").slice(0, 30)))).toBeInTheDocument();
        await user.type(screen.getByLabelText(startsWith(en("field.nameAsInPassport"))), "Anusha");
        expect(screen.getByText(en("details.unsaved"))).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: en("details.save") }));
        expect(screen.getByText(en("details.checkPassed"))).toBeInTheDocument();
        expect(calls).toHaveLength(1); // only the verification
    });

    test("pant and shoe sizes: a listed size, or Other with the candidate's own", async () => {
        const { user } = await verified();
        await user.selectOptions(screen.getByLabelText(en("field.pantSize")), "34");
        expect(screen.getByLabelText(en("field.pantSize"))).toHaveValue("34");
        await user.selectOptions(screen.getByLabelText(en("field.shoeSize")), "__other");
        const own = screen.getByLabelText(en("field.shoeSizeOther"));
        await user.type(own, "EU 43");
        expect(own).toHaveValue("EU 43");
        await user.clear(own);
        await user.type(own, "#43");
        await user.click(screen.getByRole("button", { name: en("details.save") }));
        expect(screen.getByText(en("v.sizeInvalid"))).toBeInTheDocument();
    });

    test("FORM-004 the layout can't overflow a 320px screen: fluid controls, no fixed wide widths, columns only on wider screens", () => {
        const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
        // Form controls fill their column and can shrink.
        expect(css).toMatch(/\.field input:not\(\[type="radio"\]\),\s*\.field select,\s*\.field textarea\s*\{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*min-width: 0;/);
        // No width or min-width wider than the smallest phone, outside media queries.
        const base = css.split("@media")[0];
        for (const [, size] of base.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)) expect(Number(size)).toBeLessThanOrEqual(320);
        // Multi-column grids only inside min-width media queries.
        expect(base).not.toMatch(/grid-template-columns/);
        expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
        // Long words wrap.
        expect(css).toMatch(/overflow-wrap: anywhere/);
        // Touch targets.
        expect(css).toMatch(/button\.primary, button\.secondary \{[^}]*min-height: 48px/);
    });
});

describe("accessibility", () => {
    test("A11Y-001 every control has a label; errors are linked to their field", async () => {
        const { user } = await verified();
        await user.selectOptions(screen.getByLabelText(en("field.maritalStatus")), "MARRIED");
        for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
            expect(control.labels?.length ?? 0, control.id || control.name).toBeGreaterThan(0);
        }
        expect(screen.getByRole("group", { name: en("field.fatherAlive") })).toBeInTheDocument();
        await user.click(screen.getAllByRole("radio", { name: en("option.yes") })[0]);
        await user.click(screen.getByRole("button", { name: en("details.save") }));
        const father = screen.getByLabelText(startsWith(en("field.fatherFullName")));
        expect(father).toHaveAttribute("aria-invalid", "true");
        expect(father).toHaveAccessibleDescription(startsWith(en("v.required")));
    });

    test("help tips open from a labelled button and are linked to their field", async () => {
        render(<App />);
        const user = userEvent.setup();
        const help = screen.getByRole("button", { name: `Help: ${en("verify.passport")}` });
        expect(help).toHaveAttribute("aria-expanded", "false");
        await user.click(help);
        expect(help).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByLabelText(/^Passport Number/)).toHaveAccessibleDescription(en("verify.passportHelp"));
    });

    test("A11Y-002 the language switch works from the keyboard", async () => {
        render(<App />);
        const user = userEvent.setup();
        await user.tab(); // English
        expect(screen.getByRole("button", { name: "English" })).toHaveFocus();
        await user.tab(); // සිංහල
        expect(screen.getByRole("button", { name: "සිංහල" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(screen.getByRole("button", { name: "සිංහල" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("heading", { level: 1, name: si("verify.title") })).toBeInTheDocument();
        await user.tab({ shift: true });
        await user.keyboard(" ");
        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    });
});
