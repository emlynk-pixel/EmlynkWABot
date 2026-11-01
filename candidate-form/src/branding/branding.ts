import { useContext, createContext } from "react";
import type { Theme } from "../theme/theme";

// The form's title, logo and colours, edited in the admin under Settings >
// Candidate Form. The server has already refused colours that leave text
// unreadable (src/services/candidateFormBrandingService.js); this file only
// turns the three chosen colours into the form's full set of variables.
//
// Set through the CSSOM (style.setProperty), which the page's
// Content-Security-Policy allows; style-src forbids inline style attributes.

export type ThemeColors = { accent: string; background: string; surface: string };
// `logo` is the uploaded one (null: the EMLYNK logo). `showLogo` false hides the logo altogether.
export type Branding = { formTitle: string; logo: string | null; showLogo: boolean; custom: boolean; colors: Record<Theme, ThemeColors> };
export type BrandingState = { branding: Branding; ready: boolean };

export const DEFAULT_TITLE = "Candidate Form";

export const DEFAULT_BRANDING: Branding = {
    formTitle: DEFAULT_TITLE,
    logo: null,
    showLogo: true,
    custom: false,
    colors: {
        light: { accent: "#e7000b", background: "#f0f0f0", surface: "#ffffff" },
        dark: { accent: "#e7000b", background: "#1f242b", surface: "#262c34" },
    },
};

const HEX = /^#[0-9a-f]{6}$/i;
const BRAND_VARIABLES = ["--primary", "--primary-hover", "--primary-ink", "--primary-text", "--primary-soft", "--focus", "--bg", "--surface", "--surface-2"];

const channels = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));

function mix(from: string, to: string, amount: number): string {
    const target = channels(to);
    return `#${channels(from).map((value, index) => Math.round(value + (target[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
    const [r, g, b] = channels(hex).map((value) => value / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(first: string, second: string): number {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

// The accent as text: itself if it reads well on the surface, otherwise moved
// towards black or white until it does.
function readableAccent(accent: string, surface: string): string {
    const target = luminance(surface) > 0.5 ? "#000000" : "#ffffff";
    for (let amount = 0; amount <= 1; amount += 0.05) {
        const candidate = mix(accent, target, amount);
        if (contrast(candidate, surface) >= 4.5) return candidate;
    }
    return target;
}

export function brandingVariables({ accent, background, surface }: ThemeColors): Record<string, string> {
    const text = readableAccent(accent, surface);
    return {
        "--primary": accent,
        "--primary-hover": mix(accent, "#000000", 0.15),
        "--primary-ink": contrast("#ffffff", accent) >= contrast("#0a0a0a", accent) ? "#ffffff" : "#0a0a0a",
        "--primary-text": text,
        "--primary-soft": mix(surface, accent, 0.1),
        "--focus": text,
        "--bg": background,
        "--surface": surface,
        "--surface-2": mix(surface, background, 0.5),
    };
}

// Only anything saved in Settings is applied; otherwise the stylesheet's own
// tokens stand, and a theme change needs nothing from here.
export function applyBranding(branding: Branding, theme: Theme): void {
    const root = document.documentElement;
    if (!branding.custom) {
        BRAND_VARIABLES.forEach((name) => root.style.removeProperty(name));
        return;
    }
    Object.entries(brandingVariables(branding.colors[theme])).forEach(([name, value]) => root.style.setProperty(name, value));
}

const validColors = (value: unknown): value is ThemeColors => {
    const colors = value as ThemeColors | null;
    return [colors?.accent, colors?.background, colors?.surface].every((color) => typeof color === "string" && HEX.test(color));
};

// Whatever arrives from the network is checked before it reaches the page.
export function parseBranding(value: unknown): Branding {
    const body = (value ?? {}) as Partial<Branding>;
    const usable = typeof body.formTitle === "string" && body.formTitle.trim() !== "" && validColors(body.colors?.light) && validColors(body.colors?.dark);
    if (!usable || !body.colors) return DEFAULT_BRANDING;
    const logo = typeof body.logo === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(body.logo) ? body.logo : null;
    // Only an explicit false hides it, so an older server's reply keeps the logo.
    return { formTitle: body.formTitle as string, logo, showLogo: body.showLogo !== false, custom: body.custom === true, colors: body.colors };
}

export const BrandingContext = createContext<BrandingState>({ branding: DEFAULT_BRANDING, ready: true });
export const useBranding = () => useContext(BrandingContext);
