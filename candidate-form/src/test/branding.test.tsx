import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { brandingVariables, contrast, DEFAULT_BRANDING, parseBranding, type Branding } from "../branding/branding";
import { buildMetaContentSecurityPolicy } from "../../csp";
import { initialTheme, THEME_STORAGE_KEY } from "../theme/theme";
import styles from "../styles.css?raw";

// Settings > Candidate Form reaching the form, and the theme following the device.

const LOGO = "data:image/png;base64,iVBORw0KGgo=";
const CUSTOM: Branding = {
    formTitle: "Recruitment Form",
    logo: LOGO,
    showLogo: true,
    custom: true,
    colors: {
        light: { accent: "#1d4ed8", background: "#eef2ff", surface: "#ffffff" },
        dark: { accent: "#3b82f6", background: "#111827", surface: "#1f2937" },
    },
};
const root = () => document.documentElement;

function stubBranding(reply: () => Response | Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).endsWith("/branding") ? reply() : new Response("{}", { status: 404 }))));
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => {
    root().removeAttribute("style");
    delete root().dataset.theme;
    window.localStorage.clear();
    document.title = "";
    vi.unstubAllGlobals();
});

describe("branding", () => {
    test("saved branding shows the title and logo, sets the page title and colours", async () => {
        stubBranding(() => json(CUSTOM));
        const { container } = render(<App />);
        expect(await screen.findByText("Recruitment Form")).toBeInTheDocument();
        expect(container.querySelector(".brand-logo")).toHaveAttribute("src", LOGO);
        expect(document.title).toBe("Recruitment Form");
        expect(root().style.getPropertyValue("--primary")).toBe("#1d4ed8");
        expect(root().style.getPropertyValue("--bg")).toBe("#eef2ff");
    });

    test("nothing saved: the EMLYNK logo for each theme, and the stylesheet's own colours", async () => {
        stubBranding(() => json({ ...DEFAULT_BRANDING }));
        const { container } = render(<App />);
        await waitFor(() => expect(container.querySelector(".brand")).not.toHaveClass("brand-pending"));
        expect(screen.getByText("Candidate Form")).toBeInTheDocument();
        expect(screen.getAllByAltText("EMLYNK")).toHaveLength(2);
        expect(root().style.getPropertyValue("--primary")).toBe("");
    });

    test("showLogo false: no logo at all, neither the saved one nor the EMLYNK one, and the title stays", async () => {
        for (const logo of [LOGO, null]) {
            stubBranding(() => json({ ...CUSTOM, logo, showLogo: false }));
            const { container, unmount } = render(<App />);
            expect(await screen.findByText("Recruitment Form")).toBeInTheDocument();
            expect(container.querySelector(".brand")).not.toHaveClass("brand-pending");
            expect(container.querySelector(".brand-logo")).toBeNull();
            expect(screen.queryByAltText("EMLYNK")).toBeNull();
            unmount();
        }
    });

    test("a reply that doesn't mention showLogo keeps the logo", () => {
        const { showLogo: _omitted, ...older } = CUSTOM;
        expect(parseBranding(older).showLogo).toBe(true);
        expect(parseBranding({ ...CUSTOM, showLogo: false }).showLogo).toBe(false);
    });

    test.each([
        ["the server fails", () => new Response("{}", { status: 500 })],
        ["the network fails", () => Promise.reject(new TypeError("Failed to fetch"))],
        ["the reply is malformed", () => json({ formTitle: 7, colors: "red" })],
    ])("the form still works when %s", async (_name, reply) => {
        stubBranding(reply as () => Promise<Response>);
        const { container } = render(<App />);
        await waitFor(() => expect(container.querySelector(".brand")).not.toHaveClass("brand-pending"));
        expect(screen.getByText("Candidate Form")).toBeInTheDocument();
    });

    test("the header waits for the branding, so a default title never flashes", async () => {
        let release: (response: Response) => void = () => undefined;
        stubBranding(() => new Promise((resolve) => { release = resolve; }));
        const { container } = render(<App />);
        expect(container.querySelector(".brand")).toHaveClass("brand-pending");
        release(json(CUSTOM));
        await screen.findByText("Recruitment Form");
        expect(container.querySelector(".brand")).not.toHaveClass("brand-pending");
    });

    test("parseBranding refuses a logo that is not an inline image and a colour that is not a hex", () => {
        expect(parseBranding({ ...CUSTOM, logo: "https://example.test/logo.png" }).logo).toBeNull();
        expect(parseBranding({ ...CUSTOM, colors: { ...CUSTOM.colors, light: { ...CUSTOM.colors.light, accent: "red;}" } } })).toBe(DEFAULT_BRANDING);
    });

    test("any accent gets a readable label and readable text on its surface", () => {
        for (const accent of ["#ffeb3b", "#1d4ed8", "#e7000b", "#00bc7d", "#000000"]) {
            for (const surface of ["#ffffff", "#262c34"]) {
                const variables = brandingVariables({ accent, background: surface, surface });
                expect(contrast(variables["--primary-ink"], accent), `label on ${accent}`).toBeGreaterThanOrEqual(4.4);
                expect(contrast(variables["--primary-text"], surface), `${accent} text on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    test("the logo needs no change to the page's security policy", () => {
        expect(buildMetaContentSecurityPolicy("https://api.example.test")).toContain("img-src 'self' data:");
    });

    test("the design system's look: no gradients, and dark mode is the brand slate", () => {
        expect(styles).not.toMatch(/linear-gradient/);
        expect(styles).toMatch(/:root\[data-theme="dark"\] \{[^}]*--bg: #1f242b;[^}]*--surface: #262c34;/);
    });
});

describe("theme follows the device", () => {
    function device(dark: boolean) {
        const listeners = new Set<(event: { matches: boolean }) => void>();
        vi.stubGlobal("matchMedia", (query: string) => ({
            matches: dark && query.includes("dark"),
            addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
            removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
        }));
        return (matches: boolean) => listeners.forEach((listener) => listener({ matches }));
    }

    test("a dark device opens dark, and a light one opens light", () => {
        device(true);
        expect(initialTheme()).toBe("dark");
        device(false);
        expect(initialTheme()).toBe("light");
    });

    test("with no choice made, the form follows the device while open", async () => {
        const change = device(false);
        stubBranding(() => json(DEFAULT_BRANDING));
        render(<App />);
        await waitFor(() => expect(root().dataset.theme).toBe("light"));
        change(true);
        await waitFor(() => expect(root().dataset.theme).toBe("dark"));
    });

    test("a candidate's own choice wins over the device", async () => {
        window.localStorage.setItem(THEME_STORAGE_KEY, "light");
        const change = device(true);
        stubBranding(() => json(DEFAULT_BRANDING));
        render(<App />);
        await waitFor(() => expect(root().dataset.theme).toBe("light"));
        change(true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(root().dataset.theme).toBe("light");
    });
});
