import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { apiUrl } from "../config/env";
import { TRANSLATIONS, type MessageKey } from "../i18n/translations";
import { captureLinkSecret, getLinkSecret, setLinkSecretForTest } from "../session/linkSecret";
import { clearSession, getSession } from "../session/tokenStore";
import { backend, callsTo, en, fillVerify, LINK_SECRET, NIC, PASSPORT, si, startsWith, switchLanguage, TOKEN, verified } from "./helpers";

// The share link, verification, the session and the language switch. The
// server's own rules are tested on the server (test/publicCandidateDetails.test.js,
// test/candidateFormShare.test.js).

describe("the share link", () => {
    test("LINK-001 the secret is read from the URL fragment, kept in memory, and removed from the address bar", () => {
        setLinkSecretForTest(null);
        const replaceState = vi.fn();
        captureLinkSecret({ hash: `#k=${LINK_SECRET}`, pathname: "/", search: "" } as Location, { state: null, replaceState } as unknown as History);
        expect(getLinkSecret()).toBe(LINK_SECRET);
        expect(replaceState).toHaveBeenCalledWith(null, "", "/");
        expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    });

    test("LINK-002 a malformed fragment gives no secret (and is still removed)", () => {
        setLinkSecretForTest(null);
        const replaceState = vi.fn();
        captureLinkSecret({ hash: "#k=short", pathname: "/", search: "" } as Location, { state: null, replaceState } as unknown as History);
        expect(getLinkSecret()).toBeNull();
        expect(replaceState).toHaveBeenCalled();
    });

    test("LINK-003 without a link the form explains how to open it, and offers no verification", () => {
        setLinkSecretForTest(null);
        const calls = backend();
        render(<App />);
        expect(screen.getByRole("heading", { level: 1, name: en("link.missingTitle") })).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Passport Number/)).toBeNull();
        expect(calls).toHaveLength(0);
    });
});

describe("verification", () => {
    test("UI-001 the verification screen: title, Passport Number, NIC Number, Verify; no WhatsApp", () => {
        render(<App />);
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByLabelText(/^Passport Number/)).toBeInTheDocument();
        expect(screen.getByLabelText(/^NIC Number/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/WhatsApp/)).toBeNull();
        expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
    });

    test("UI-002 verify sends the link secret, passport and NIC in the body only, without credentials; then the form loads with the token", async () => {
        const { calls } = await verified();
        const [verify] = callsTo(calls, "verify");
        expect(verify.url).toBe(apiUrl("/api/public/candidate-details/verify"));
        expect(verify.body).toEqual({ linkSecret: LINK_SECRET, passportNumber: PASSPORT, nic: NIC });
        expect(verify.init.credentials).toBe("omit");
        expect(verify.url).not.toContain(LINK_SECRET);
        const [form] = callsTo(calls, "form");
        expect((form.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });

    test("invalid input is caught before anything is sent", async () => {
        const calls = backend();
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user, "AB%12", "12345");
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(screen.getByText(en("verify.passportInvalid"))).toBeInTheDocument();
        expect(screen.getByText(en("verify.nicInvalid"))).toBeInTheDocument();
        expect(screen.getByLabelText(/^NIC Number/)).toHaveAttribute("aria-invalid", "true");
        expect(calls).toHaveLength(0);
    });

    test("the NIC is capitalised as typed (a lower-case v is fine)", async () => {
        render(<App />);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText(/^NIC Number/), "901234567v");
        expect(screen.getByLabelText(/^NIC Number/)).toHaveValue("901234567V");
    });

    test("UI-003 a failed verification shows one generic message, never the server's own text", async () => {
        backend({ verify: { status: 401, body: { message: "Server detail that must not be shown", code: "VERIFICATION_FAILED" } } });
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
        backend({ verify: reply });
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(await screen.findByText(en(key))).toBeInTheDocument();
        expect(screen.queryByText(/Prisma|P2024/)).toBeNull();
    });

    test("an already submitted form: a neutral screen, no form", async () => {
        backend({ verify: { status: 409, body: { message: "This form has already been submitted.", code: "ALREADY_SUBMITTED" } } });
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(await screen.findByRole("heading", { level: 1, name: en("submitted.alreadyTitle") })).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Passport Number/)).toBeNull();
    });

    test("the form couldn't be loaded: an error with Try again, which loads it", async () => {
        let first = true;
        const calls = backend();
        const real = globalThis.fetch;
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
            if (String(url).endsWith("/form") && first) {
                first = false;
                throw new TypeError("Failed to fetch");
            }
            return real(url, init);
        }));
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await user.click(screen.getByRole("button", { name: "Verify" }));
        expect(await screen.findByRole("heading", { level: 1, name: en("form.loadFailedTitle") })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: en("form.retry") }));
        expect(await screen.findByRole("heading", { level: 2, name: en("step.personal") })).toBeInTheDocument();
        expect(callsTo(calls, "form")).toHaveLength(1);
    });

    test("UI-004 a successful verification opens the form with the verified identity, read-only", async () => {
        await verified();
        expect(screen.getByText(en("form.verifiedBanner"))).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(en("f.nic")))).toHaveValue(NIC);
        expect(screen.getByLabelText(startsWith(en("f.nic")))).toHaveAttribute("readonly");
        expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
        expect(getSession()?.token).toBe(TOKEN);
    });

    test("UI-005 the token, the link secret and the identity are kept in memory only: not in storage, cookies or the URL", async () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        await verified();
        const written = setItem.mock.calls.map(([key, value]) => `${key}=${value}`).join("\n");
        expect(written).not.toMatch(new RegExp(`${TOKEN}|${LINK_SECRET}|${PASSPORT}|${NIC}`));
        for (const storage of [window.localStorage, window.sessionStorage]) {
            for (let i = 0; i < storage.length; i++) expect(storage.key(i)).toBe("candidate-form-theme");
        }
        expect(document.cookie).not.toContain(TOKEN);
        expect(window.location.href).not.toContain(TOKEN);
        expect(window.location.href).not.toContain(LINK_SECRET);
        expect(document.body.innerHTML).not.toContain(TOKEN);
        expect(document.body.innerHTML).not.toContain(LINK_SECRET);
    });

    test("UI-006 without a token (a reload, or the session expired) the candidate is back at verification", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await verified({ advanceTimers: vi.advanceTimersByTime });
        clearSession();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
        expect(screen.getByText(en("session.ended"))).toBeInTheDocument();
    });
});

describe("language", () => {
    test("LANG-001 the default language is English, and the page says so", () => {
        render(<App />);
        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
        expect(document.documentElement.lang).toBe("en");
    });

    test("LANG-002 / LANG-003 switching to Sinhala changes the labels, and switching back restores English", async () => {
        render(<App />);
        const user = userEvent.setup();
        await switchLanguage(user, "සිංහල");
        expect(document.documentElement.lang).toBe("si");
        expect(screen.getByRole("heading", { level: 1, name: si("verify.title") })).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(si("verify.nic")))).toBeInTheDocument();
        await switchLanguage(user, "English");
        expect(screen.getByText(en("verify.lead"))).toBeInTheDocument();
    });

    test("LANG-004 the Passport and NIC numbers typed are kept when the language changes", async () => {
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user);
        await switchLanguage(user, "සිංහල");
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveValue(PASSPORT);
        expect(screen.getByLabelText(startsWith(si("verify.nic")))).toHaveValue(NIC);
    });

    test("LANG-006 a validation message changes language without clearing anything", async () => {
        render(<App />);
        const user = userEvent.setup();
        await fillVerify(user, "AB%12");
        await user.click(screen.getByRole("button", { name: "Verify" }));
        await switchLanguage(user, "සිංහල");
        expect(screen.getByText(si("verify.passportInvalid"))).toBeInTheDocument();
        expect(screen.getByLabelText(startsWith(si("verify.passport")))).toHaveValue("AB%12");
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
        await user.keyboard("{Enter}");
        expect(screen.getByRole("heading", { level: 1, name: si("verify.title") })).toBeInTheDocument();
    });
});
