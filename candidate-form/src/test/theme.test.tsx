import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { getSession } from "../session/tokenStore";
import styles from "../styles.css?raw";
import { initialTheme, THEME_STORAGE_KEY } from "../theme/theme";
import { en, field, next, PASSPORT, setField, si, startsWith, switchLanguage, TOKEN, verified } from "./helpers";

// Light / Dark: only colours change, and the theme is the one thing kept in
// the browser.

const themeButton = (name: string) => within(screen.getByRole("group", { name: startsWith(en("theme.label")) })).getByRole("button", { name: startsWith(name) });
const html = () => document.documentElement;

// The colour tokens of one theme block of the stylesheet.
function tokens(selector: string): Record<string, string> {
    const start = styles.indexOf(selector);
    const block = styles.slice(start, styles.indexOf("}", start));
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

describe("theme", () => {
    test("THEME-ICON-001 / 002 / 005 icon-only: a sun and a moon button, named by aria-label and title, with no visible Light / Dark text", () => {
        render(<App />);
        const group = screen.getByRole("group", { name: en("theme.label") });
        const [light, dark] = within(group).getAllByRole("button");
        expect(light).toHaveAttribute("aria-label", "Use light theme");
        expect(light).toHaveAttribute("title", "Light theme");
        expect(dark).toHaveAttribute("aria-label", "Use dark theme");
        expect(dark).toHaveAttribute("title", "Dark theme");
        // Only the icons inside, hidden from screen readers (the aria-label names the button).
        for (const button of [light, dark]) {
            expect(button.textContent).toBe("");
            const icon = button.querySelector("svg");
            expect(icon).not.toBeNull();
            expect(icon).toHaveAttribute("aria-hidden", "true");
        }
        expect(light.querySelector("circle")).not.toBeNull(); // the sun's disc
        expect(dark.querySelector("circle")).toBeNull(); // the moon is one crescent path
        expect(group).not.toHaveTextContent(/Light|Dark/);
    });

    test("THEME-ICON-003 / 004 clicking the sun gives light, the moon gives dark; the active one is marked; keyboard works", async () => {
        render(<App />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Use dark theme" }));
        expect(html().dataset.theme).toBe("dark");
        expect(screen.getByRole("button", { name: "Use dark theme" })).toHaveClass("active");
        expect(screen.getByRole("button", { name: "Use light theme" })).not.toHaveClass("active");
        screen.getByRole("button", { name: "Use light theme" }).focus();
        await user.keyboard("{Enter}");
        expect(html().dataset.theme).toBe("light");
        expect(screen.getByRole("button", { name: "Use light theme" })).toHaveAttribute("aria-pressed", "true");
        await user.tab();
        expect(screen.getByRole("button", { name: "Use dark theme" })).toHaveFocus();
        await user.keyboard(" ");
        expect(html().dataset.theme).toBe("dark");
    });

    test("THEME-ICON-006 compact square buttons, a subtle hover and a focus ring; the old text-hiding rule is gone", () => {
        expect(styles).toMatch(/\.theme-switch button \{[^}]*width: 36px;[^}]*padding: 0;/);
        expect(styles).toMatch(/\.theme-switch button:hover:not\(\.active\) \{[^}]*background: var\(--notice-soft\)/);
        expect(styles).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\)/);
        expect(styles).not.toMatch(/theme-label/);
    });

    test("THEME-001 Light: the page is light and the Light button is pressed", async () => {
        render(<App />);
        const user = userEvent.setup();
        await user.click(themeButton(en("theme.useLight")));
        expect(html().dataset.theme).toBe("light");
        expect(themeButton(en("theme.useLight"))).toHaveAttribute("aria-pressed", "true");
        expect(themeButton(en("theme.useDark"))).toHaveAttribute("aria-pressed", "false");
    });

    test("THEME-002 Dark: the page turns dark, and the switch is labelled in the current language", async () => {
        render(<App />);
        const user = userEvent.setup();
        await user.click(themeButton(en("theme.useDark")));
        expect(html().dataset.theme).toBe("dark");
        expect(themeButton(en("theme.useDark"))).toHaveAttribute("aria-pressed", "true");
        await switchLanguage(user, "සිංහල");
        expect(within(screen.getByRole("group", { name: si("theme.label") })).getByRole("button", { name: startsWith(si("theme.useDark")) })).toHaveAttribute("aria-pressed", "true");
    });

    test("THEME-003 switching theme keeps the answers, the validation, the language, the step and the session", async () => {
        const { user } = await verified();
        setField("f.fullName", "shamal");
        await next(user); // the other required answers are missing
        await switchLanguage(user, "සිංහල");
        expect(screen.getAllByText(si("v.required")).length).toBeGreaterThan(0);
        await user.click(within(screen.getByRole("group", { name: si("theme.label") })).getByRole("button", { name: startsWith(si("theme.useDark")) }));
        expect(html().dataset.theme).toBe("dark");
        expect(screen.getByLabelText(startsWith(si("f.fullName")))).toHaveValue("SHAMAL");
        expect(screen.getAllByText(si("v.required")).length).toBeGreaterThan(0);
        expect(html().lang).toBe("si");
        expect(getSession()?.token).toBe(TOKEN);
        await user.click(within(screen.getByRole("group", { name: si("theme.label") })).getByRole("button", { name: startsWith(si("theme.useLight")) }));
        expect(screen.getByLabelText(startsWith(si("f.fullName")))).toHaveValue("SHAMAL");
    });

    test("THEME-004 the choice is remembered for the next visit", async () => {
        const first = render(<App />);
        await userEvent.setup().click(themeButton(en("theme.useDark")));
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
        first.unmount();
        delete html().dataset.theme;
        render(<App />);
        expect(html().dataset.theme).toBe("dark");
        expect(themeButton(en("theme.useDark"))).toHaveAttribute("aria-pressed", "true");
        expect(initialTheme()).toBe("dark");
    });

    test("THEME-005 only the theme is ever stored: no token, passport, WhatsApp number or answer", async () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const { user } = await verified();
        setField("f.fullName", "shamal");
        await user.click(themeButton(en("theme.useDark")));
        await user.click(themeButton(en("theme.useLight")));
        expect(new Set(setItem.mock.calls.map(([key]) => key))).toEqual(new Set([THEME_STORAGE_KEY]));
        expect(setItem.mock.calls.every(([, value]) => value === "light" || value === "dark")).toBe(true);
        expect(window.sessionStorage.length).toBe(0);
        expect([...Array(window.localStorage.length).keys()].map((i) => window.localStorage.key(i))).toEqual([THEME_STORAGE_KEY]);
        expect(document.cookie).toBe("");
        expect(JSON.stringify({ ...window.localStorage })).not.toMatch(new RegExp(`${TOKEN}|${PASSPORT}|SHAMAL`));
        expect(field("f.fullName")).toHaveValue("SHAMAL");
    });

    test("blocked browser storage: the form still works and follows the device", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
        expect(initialTheme()).toBe("light");
        render(<App />);
        expect(screen.getByRole("heading", { level: 1, name: en("verify.title") })).toBeInTheDocument();
    });

    test("both themes keep readable contrast (text at least 4.5:1 on its background)", () => {
        const light = tokens(":root {");
        const dark = tokens(':root[data-theme="dark"]');
        for (const [name, palette] of [["light", light], ["dark", dark]] as const) {
            for (const [text, background] of [["ink", "surface"], ["muted", "surface"], ["ink", "bg"], ["primary-ink", "primary"], ["error", "surface"], ["error", "error-soft"], ["success", "success-soft"], ["primary", "surface"]]) {
                expect(contrast(palette[text], palette[background]), `${name}: ${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });
});
