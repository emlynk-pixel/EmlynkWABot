import { useCallback, useState } from "react";

// Light / dark mode. The choice is a per-browser convenience kept in
// localStorage; without it (private window, blocked storage) the dashboard
// opens in light mode, the Stitch default. The colours themselves are CSS
// tokens (index.css): switching only sets data-theme on <html>.
export type Theme = "light" | "dark";

export const THEME_KEY = "emlynk.admin.theme";

export function readStoredTheme(): Theme {
    try {
        return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch {
        return "light";
    }
}

export function applyTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
}

function storeTheme(theme: Theme): void {
    try {
        window.localStorage.setItem(THEME_KEY, theme);
    } catch {
        // not remembered; the current page still switches
    }
}

// Called once in main.tsx before the first render, so a reload doesn't flash
// the other theme.
export function initTheme(): Theme {
    const theme = readStoredTheme();
    applyTheme(theme);
    return theme;
}

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
    const toggle = useCallback(() => {
        setTheme((current) => {
            const next: Theme = current === "dark" ? "light" : "dark";
            applyTheme(next);
            storeTheme(next);
            return next;
        });
    }, []);
    return { theme, toggle };
}
