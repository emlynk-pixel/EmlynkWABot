import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyTheme, hasSavedTheme, initialTheme, saveTheme, type Theme } from "./theme";

export type ThemeContextValue = { theme: Theme; setTheme: (theme: Theme) => void };

export const ThemeContext = createContext<ThemeContextValue | null>(null);

// The theme lives above every page, so switching it only changes colours:
// form answers, validation, the language and the session are untouched.
export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(initialTheme);

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    // Until the candidate picks a theme, the form follows the device, including when
    // the device changes while the form is open (a scheduled dark mode, say).
    useEffect(() => {
        const media = window.matchMedia?.("(prefers-color-scheme: dark)");
        if (!media) return undefined;
        const onChange = (event: MediaQueryListEvent) => {
            if (!hasSavedTheme()) setThemeState(event.matches ? "dark" : "light");
        };
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);

    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        saveTheme(next);
    }, []);

    const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
