// Light / Dark. The theme is the ONE thing this form keeps in the browser:
// it is not sensitive. Nothing else (no token, passport, WhatsApp number or
// form answer) is ever written to localStorage, sessionStorage or cookies.

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = "candidate-form-theme";

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

// The saved choice, else the device's preference, else Light. Storage may be
// blocked (private mode, strict settings): then the form simply follows the
// device.
export function initialTheme(): Theme {
    try {
        const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (isTheme(saved)) return saved;
    } catch {
        // storage unavailable
    }
    try {
        if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
    } catch {
        // matchMedia unavailable
    }
    return "light";
}

export function saveTheme(theme: Theme): void {
    try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
        // storage unavailable: the choice lasts for this page only
    }
}

// The page's colours follow <html data-theme>. Called before the first
// render (main.tsx) so the page never flashes the wrong theme, and on change.
export function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
}
