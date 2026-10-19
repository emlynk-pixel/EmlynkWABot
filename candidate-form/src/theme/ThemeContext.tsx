import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyTheme, initialTheme, saveTheme, type Theme } from "./theme";

export type ThemeContextValue = { theme: Theme; setTheme: (theme: Theme) => void };

export const ThemeContext = createContext<ThemeContextValue | null>(null);

// The theme lives above every page, so switching it only changes colours:
// form answers, validation, the language and the session are untouched.
export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(initialTheme);

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        saveTheme(next);
    }, []);

    const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
