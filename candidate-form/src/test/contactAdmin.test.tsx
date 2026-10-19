import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { parseAdminMobileNumbers } from "../config/env";
import { TRANSLATIONS } from "../i18n/translations";
import css from "../styles.css?raw";
import { backend, en, fillVerify, LINK_SECRET, NIC, PASSPORT, si, TOKEN, verified } from "./helpers";

// "Contact Admin": the fixed bilingual screen for access failures that retrying
// cannot fix, displaying configured admin mobile numbers.

const SAMPLE_NUMBERS = "0771234567, 0719876543";
afterEach(() => vi.unstubAllEnvs());

const submitVerify = async (user: ReturnType<typeof userEvent.setup>) => {
    await fillVerify(user);
    await user.click(screen.getByRole("button", { name: "Verify" }));
};
const ALREADY = { status: 409, body: { message: "x", code: "ALREADY_SUBMITTED" } } as const;
const GENERIC_401 = { status: 401, body: { message: "Server detail that must not be shown", code: "VERIFICATION_FAILED" } } as const;

// The full-screen state: English and Sinhala together, both visible.
const expectBilingualScreen = async () => {
    expect(await screen.findByRole("heading", { level: 1, name: en("contact.title") })).toBeInTheDocument();
    expect(screen.getByText(en("contact.text"))).toBeVisible();
    expect(screen.getByText(si("contact.title"))).toBeVisible();
    expect(screen.getByText(si("contact.text"))).toBeVisible();
};

describe("Contact Admin", () => {
    test("CONTACT-ADMIN-001 Already-submitted state shows English and Sinhala Contact Admin message", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", SAMPLE_NUMBERS);
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(screen.queryByLabelText(/^Passport Number/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    });

    test("CONTACT-ADMIN-002 One configured Admin mobile number renders correctly", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", "0771234567");
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(screen.getByText("Admin Contact Numbers")).toBeVisible();
        expect(screen.getByText("0771234567")).toBeVisible();
    });

    test("CONTACT-ADMIN-003 Multiple comma-separated Admin mobile numbers render correctly", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", "0771234567,0719876543,0765551234");
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(screen.getByText("Admin Contact Numbers")).toBeVisible();
        const numbers = screen.getAllByText(/^07\d{8}$/);
        expect(numbers.map((el) => el.textContent)).toEqual(["0771234567", "0719876543", "0765551234"]);
    });

    test("CONTACT-ADMIN-004 Whitespace around configured numbers is trimmed", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", "  0771234567   ,   0719876543  ");
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(screen.getByText("0771234567")).toBeVisible();
        expect(screen.getByText("0719876543")).toBeVisible();
        expect(screen.queryByText(/  0771234567/)).toBeNull();
    });

    test("CONTACT-ADMIN-005 Empty entries are ignored", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", "0771234567,, 0719876543 ,");
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        const numbers = screen.getAllByText(/^07\d{8}$/);
        expect(numbers.map((el) => el.textContent)).toEqual(["0771234567", "0719876543"]);
        expect(parseAdminMobileNumbers("0771234567,, 0719876543 ,")).toEqual(["0771234567", "0719876543"]);
    });

    test("CONTACT-ADMIN-006 Missing env variable does not crash", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", "");
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(screen.queryByText("Admin Contact Numbers")).toBeNull();
        expect(screen.queryByText("undefined")).toBeNull();
        expect(screen.queryByText("null")).toBeNull();
        expect(parseAdminMobileNumbers(undefined)).toEqual([]);
        expect(parseAdminMobileNumbers("")).toEqual([]);
        expect(parseAdminMobileNumbers("   ")).toEqual([]);
    });

    test("CONTACT-ADMIN-007 No WhatsApp button/link exists", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", SAMPLE_NUMBERS);
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.queryByRole("button", { name: /WhatsApp|Contact Admin/i })).toBeNull();
    });

    test("CONTACT-ADMIN-008 No wa.me URL exists in DOM", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", SAMPLE_NUMBERS);
        backend({ verify: ALREADY });
        render(<App />);
        await submitVerify(userEvent.setup());
        await expectBilingualScreen();
        expect(document.body.innerHTML).not.toContain("wa.me");
        expect(document.body.innerHTML).not.toContain("whatsapp");
    });

    test("CONTACT-ADMIN-009 No sensitive Candidate data appears in Contact Admin state", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", SAMPLE_NUMBERS);
        backend({ verify: GENERIC_401 });
        render(<App />);
        await submitVerify(userEvent.setup());
        expect(await screen.findByText(en("verify.failed"))).toBeInTheDocument();
        const help = screen.getByText(en("contact.title")).closest(".contact-admin") as HTMLElement;
        const block = help.textContent ?? "";
        expect(block).not.toMatch(/Server detail|another job|not on this job|not eligible|Job|JOB-/i);
        for (const value of [PASSPORT, NIC, LINK_SECRET, TOKEN]) expect(block).not.toContain(value);
        expect(document.body.textContent).not.toMatch(/Server detail|another job|not on this job|not eligible|JOB-/i);
        expect(document.body.textContent).not.toContain(LINK_SECRET);
    });

    test("CONTACT-ADMIN-010 Generic verification failure still shows appropriate Contact Admin information", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", "0771234567");
        backend({ verify: GENERIC_401 });
        render(<App />);
        await submitVerify(userEvent.setup());
        expect(await screen.findByText(en("verify.failed"))).toBeInTheDocument();
        expect(screen.getByLabelText(/^Passport Number/)).toBeInTheDocument();
        const help = screen.getByText(en("contact.title")).closest(".contact-admin") as HTMLElement;
        expect(within(help).getByText(si("contact.text"))).toBeVisible();
        expect(within(help).getByText("Admin Contact Numbers")).toBeVisible();
        expect(within(help).getByText("0771234567")).toBeVisible();
    });

    test("CONTACT-ADMIN-011 Valid Candidate Form flow is unchanged", async () => {
        vi.stubEnv("VITE_API_ADMIN_MOBILE_NUMBERS", SAMPLE_NUMBERS);
        await verified();
        expect(screen.queryByText(en("contact.title"))).toBeNull();
        expect(screen.queryByText("Admin Contact Numbers")).toBeNull();
        expect(screen.getByRole("heading", { level: 2, name: en("step.personal") })).toBeInTheDocument();
    });

    test("CONTACT-ADMIN-012 Mobile layout remains clean", () => {
        const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
        expect(rule(".contact-admin")).toMatch(/flex-direction:\s*column/);
        expect(rule(".contact-numbers")).toMatch(/display:\s*flex/);
        expect(rule(".contact-number")).toMatch(/tabular-nums/);
        expect(css).not.toMatch(/\.contact-(admin|numbers|compact)[^{]*\{[^}]*(white-space:\s*nowrap|min-width:\s*\d{3,})/);
    });

    test("the fixed texts are exactly the approved English and Sinhala", () => {
        expect(TRANSLATIONS.en["contact.title"]).toBe("We couldn't continue with this form link.");
        expect(TRANSLATIONS.en["contact.text"]).toBe("This link may already have been used, may have expired, or may not belong to your application. Please contact an administrator for assistance.");
        expect(TRANSLATIONS.si["contact.title"]).toBe("මෙම පෝරම සබැඳිය සමඟ ඉදිරියට යාමට නොහැක.");
        expect(TRANSLATIONS.si["contact.text"]).toBe("මෙම සබැඳිය මීට පෙර භාවිතා කර තිබිය හැක, කල් ඉකුත් වී තිබිය හැක, හෝ ඔබගේ අයදුම්පතට අදාළ නොවිය හැක. කරුණාකර සහාය සඳහා පරිපාලකයෙකු අමතන්න.");
    });
});
