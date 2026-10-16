import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { apiUrl } from "../config/env";
import { TRANSLATIONS, type MessageKey } from "../i18n/translations";
import { clearSession, getSession } from "../session/tokenStore";
import { backend, en, fillVerify, inMinutes, PASSPORT, si, startsWith, switchLanguage, TOKEN, verified, WHATSAPP } from "./helpers";

// Verification, the session and the language switch. The server's own rules
// are tested on the server (test/publicCandidateDetails.test.js).

describe("verification", () => {
    test("UI-001 the verification screen renders: title, both fields, the Verify button", () => {
        render(<App />);
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByLabelText(/^Passport Number/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^WhatsApp Number/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
    });

    test("UI-002 valid input sends one verify request with the trimmed values, in the body only, without credentials", async () => {
        const { calls } = await verified();
        expect(calls).toHaveLength(1);
        // The configured API origin (same origin when VITE_API_BASE_URL is empty).
        expect(calls[0].url).toBe(apiUrl("/api/public/candidate-details/verify"));
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ passportNumber: PASSPORT, whatsappNumber: WHATSAPP });
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
        expect(await screen.findByRole("heading", { level: 2, name: en("step.basic") })).toBeInTheDocument();
    });

    test("UI-004 a successful verification opens the Candidate Form at its first section", async () => {
        await verified();
        expect(screen.getByText(en("form.verifiedBanner"))).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1, name: en("form.title") })).toBeInTheDocument();
        expect(screen.getByText(en("form.stepOf").replace("{current}", "1").replace("{total}", "7"))).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
        expect(getSession()?.token).toBe(TOKEN);
        expect(getSession()?.identity).toEqual({ passportNumber: PASSPORT, whatsappNumber: WHATSAPP });
    });

    test("the verified passport is kept as the server compares it: capitals, no spaces or hyphens", async () => {
        backend();
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user, "n12-345 67");
        await user.click(screen.getByRole("button", { name: "Verify" }));
        await screen.findByRole("heading", { level: 2, name: en("step.basic") });
        expect(getSession()?.identity.passportNumber).toBe("N1234567");
    });

    test("UI-005 the token and the identity are kept in memory only: not in storage, cookies or the URL", async () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        await verified();
        const written = setItem.mock.calls.map(([key, value]) => `${key}=${value}`).join("\n");
        expect(written).not.toMatch(new RegExp(`${TOKEN}|${PASSPORT}|94771234567`));
        for (const storage of [window.localStorage, window.sessionStorage]) {
            for (let i = 0; i < storage.length; i++) expect(storage.key(i)).toBe("candidate-form-theme");
        }
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
});

describe("language", () => {
    test("LANG-001 the default language is English, and the page says so", () => {
        render(<App />);
        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "සිංහල" })).toHaveAttribute("aria-pressed", "false");
        expect(document.documentElement.lang).toBe("en");
    });

    test("LANG-002 / LANG-003 switching to Sinhala changes the labels, and switching back restores English", async () => {
        render(<App />);
        const user = userEvent.setup();
        await switchLanguage(user, "සිංහල");
        expect(document.documentElement.lang).toBe("si");
        expect(screen.getByRole("heading", { level: 1, name: si("verify.title") })).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toBeInTheDocument();
        expect(screen.getByRole("button", { name: si("verify.submit") })).toBeInTheDocument();
        await switchLanguage(user, "English");
        expect(screen.getByText(en("verify.lead"))).toBeInTheDocument();
    });

    test("LANG-004 the Passport and WhatsApp numbers typed are kept when the language changes", async () => {
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await switchLanguage(user, "සිංහල");
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveValue(PASSPORT);
        expect(screen.getByLabelText(startsWith(si("verify.whatsapp")))).toHaveValue(WHATSAPP);
    });

    test("LANG-006 a validation message changes language without clearing anything", async () => {
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user, "AB%12");
        await user.click(screen.getByRole("button", { name: "Verify" }));
        await switchLanguage(user, "සිංහල");
        expect(screen.getByText(si("verify.passportInvalid"))).toBeInTheDocument();
        expect(screen.queryByText(en("verify.passportInvalid"))).toBeNull();
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveValue("AB%12");
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveAttribute("aria-invalid", "true");
    });

    test("every English text has a Sinhala translation, written in Sinhala", () => {
        const keys = Object.keys(TRANSLATIONS.en) as MessageKey[];
        expect(Object.keys(TRANSLATIONS.si).sort()).toEqual([...keys].sort());
        for (const key of keys) expect(/[඀-෿]/.test(TRANSLATIONS.si[key]), key).toBe(true);
    });

    test("A11Y-002 the language switch works from the keyboard", async () => {
        render(<App />);
        const user = userEvent.setup();
        await user.tab();
        expect(screen.getByRole("button", { name: "English" })).toHaveFocus();
        await user.tab();
        expect(screen.getByRole("button", { name: "සිංහල" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(screen.getByRole("heading", { level: 1, name: si("verify.title") })).toBeInTheDocument();
        await user.tab({ shift: true });
        await user.keyboard(" ");
        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    });
});
